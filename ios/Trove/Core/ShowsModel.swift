import Foundation
import Observation

/// Shows: episodes in progress on Spotify and YouTube, and the episodes of the followed show that's open
/// (web/components/shows.tsx). Only the open show's episodes stay in memory; every list is cached on disk.
@Observable final class ShowsModel {
    enum Phase: Equatable { case loading, loaded, failed(String) }

    struct Counts: Equatable {
        var total = 0
        var finished = 0
        var started = 0
    }

    private(set) var overview: ShowsOverview?
    private(set) var overviewPhase: Phase = .loading
    /// Ids of the followed shows as the server last listed them (not from the disk cache).
    private(set) var liveShowIDs: [String]?
    private(set) var detail: ShowDetail?
    private(set) var detailPhase: Phase = .loading
    /// The open show's series and counts, recounted here so marking an episode updates them at once.
    private(set) var series: [ShowDetail.Series] = []
    private(set) var counts = Counts()
    private(set) var status: MediaSyncStatus?
    private(set) var syncing = false
    /// Episodes (row keys) being marked.
    private(set) var busy: Set<String> = []
    /// Bumps when episodes move between lists, to animate it.
    private(set) var revision = 0

    @ObservationIgnored private weak var library: Library?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var openID: String?
    /// Opening Shows pulls your phone's Spotify and YouTube progress, at most every 10 minutes.
    private static var lastAutoSync = Date.distantPast

    init(library: Library) {
        self.library = library
    }

    private var api: APIClient? { library?.api }
    private var overviewKey: String { "\(library?.cachePrefix ?? "")/shows" }
    private func detailKey(_ id: String) -> String { "\(library?.cachePrefix ?? "")/shows/\(id)" }

    // MARK: Loading

    /// First appearance: the cached lists at once, then fresh ones, then a sync if the last one is old.
    func start() async {
        guard !started else { return }
        started = true
        if overview == nil, let cached = await DiskCache.load(ShowsOverview.self, overviewKey) {
            overview = cached
        }
        await loadOverview()
        await syncIfStale()
    }

    func refresh() async {
        async let lists: Void = loadOverview()
        if let id = openID { await loadDetail(id) }
        await lists
        if let s = try? await api?.mediaSyncStatus() { status = s }
    }

    private func loadOverview() async {
        guard let api else { return }
        do {
            let o = try await api.mediaShows()
            overview = o
            liveShowIDs = o.shows.map(\.id)
            overviewPhase = .loaded
            await DiskCache.save(o, overviewKey)
        } catch is CancellationError {
        } catch {
            if library?.handleAuth(error) == true { return }
            if overview == nil {
                overviewPhase = .failed(error.localizedDescription)
            } else {
                overviewPhase = .loaded
                library?.report(error, "Couldn’t refresh")
            }
        }
    }

    /// Shows one followed show: cached episodes at once, then fresh ones.
    func open(_ id: String) async {
        openID = id
        if detail?.show.id != id {
            let cached = await DiskCache.load(ShowDetail.self, detailKey(id))
            guard openID == id else { return }
            setDetail(cached)
            detailPhase = .loading
        }
        await loadDetail(id)
    }

    /// Back to Continue: let go of the show's episodes.
    func close() {
        openID = nil
        setDetail(nil)
    }

    func loadDetail(_ id: String) async {
        guard let api else { return }
        do {
            let d = try await api.mediaShow(id)
            guard openID == id else { return }
            setDetail(d)
            detailPhase = .loaded
            await DiskCache.save(d, detailKey(id))
        } catch is CancellationError {
        } catch {
            guard openID == id else { return }
            if library?.handleAuth(error) == true { return }
            if detail == nil {
                detailPhase = .failed(error.localizedDescription)
            } else {
                detailPhase = .loaded
                library?.report(error, "Couldn’t refresh")
            }
        }
    }

    private func setDetail(_ d: ShowDetail?) {
        detail = d
        var counts = Counts(total: d?.episodes.count ?? 0)
        var stats: [String: ShowDetail.Series] = [:]
        var order: [String: Int] = [:]
        for r in d?.episodes ?? [] {
            let name = r.series ?? "Other"
            if stats[name] == nil {
                stats[name] = ShowDetail.Series(name: name, count: 0, finished: 0, started: 0)
                order[name] = order.count
            }
            stats[name]?.count += 1
            switch r.card?.status {
            case .finished?:
                stats[name]?.finished += 1
                counts.finished += 1
            case .started?:
                stats[name]?.started += 1
                counts.started += 1
            default: break
            }
        }
        // Biggest first, "Other" last, ties in order of appearance (newest episodes first), as on the web.
        series = stats.values.sorted { a, b in
            if (a.name == "Other") != (b.name == "Other") { return b.name == "Other" }
            if a.count != b.count { return a.count > b.count }
            return order[a.name, default: 0] < order[b.name, default: 0]
        }
        self.counts = counts
    }

    // MARK: Sync

    private func syncIfStale() async {
        guard let api, let s = try? await api.mediaSyncStatus() else { return }
        status = s
        let last = s.lastSync ?? .distantPast
        guard !s.connected.isEmpty, Date.now.timeIntervalSince(last) > 600, Date.now.timeIntervalSince(Self.lastAutoSync) > 600 else { return }
        Self.lastAutoSync = .now
        guard (try? await api.mediaSync(wait: false)) != nil else { return }
        // The server syncs in the background; look again once it has had time to.
        try? await Task.sleep(for: .seconds(25))
        guard !Task.isCancelled else { return }
        await refresh()
    }

    /// Reads your Spotify and YouTube progress now and says how it went.
    func syncNow() async {
        guard let api, !syncing else { return }
        syncing = true
        defer { syncing = false }
        do {
            let r = try await api.mediaSync(wait: true)
            var parts: [String] = []
            var failed = false
            for (p, side) in [(MediaPlatform.sp, r.spotify), (.yt, r.youtube)] {
                guard let side else { continue }
                if let error = side.error {
                    parts.append("\(p.name): \(error)")
                    failed = true
                } else {
                    parts.append("\(p.name) ✓")
                }
            }
            let text = parts.isEmpty
                ? "Connect Spotify and YouTube in Trove’s settings on the web to sync your phone"
                : "\(parts.joined(separator: " · ")) · \(r.updated ?? 0) updated"
            library?.show(Toast(text: text, systemImage: failed ? "exclamationmark.triangle" : "arrow.triangle.2.circlepath", isError: failed))
        } catch {
            library?.report(error, "Sync failed")
        }
        await refresh()
    }

    // MARK: Marking

    /// Mark as finished or not, shown at once and undone if the server refuses.
    func setFinished(_ row: ShowEpisode, _ finished: Bool) async {
        guard let api, !busy.contains(row.key) else { return }
        busy.insert(row.key)
        defer { busy.remove(row.key) }
        let before = row.card
        apply(before?.marked(finished: finished) ?? row.provisionalCard(finished: finished), to: row)
        do {
            var id = before?.id
            if id == nil, let event = row.newEpisodeEvent(show: detail?.show.title) {
                id = try await api.createEpisode(event)?.id
            }
            guard let id else { throw APIError.network("Trove couldn’t store this episode.") }
            let card = try await api.markEpisode(id, finished: finished)
            apply(card, to: row)
            library?.show(Toast(text: finished ? "Marked as finished" : "Marked as not finished", systemImage: finished ? "checkmark.circle.fill" : "arrow.uturn.backward"))
        } catch {
            apply(before, to: row)
            library?.report(error, "Couldn’t update the episode")
        }
    }

    /// Puts a changed record everywhere the episode is listed (or takes a provisional one out again).
    private func apply(_ card: EpisodeCard?, to row: ShowEpisode) {
        var ids = card?.refs ?? []
        if let sp = row.sp { ids.insert("sp:\(sp.id)") }
        if let yt = row.yt { ids.insert("yt:\(yt.id)") }
        if let c = row.card { ids.formUnion(c.refs) }
        let refs = ids
        let same = { (c: EpisodeCard) in !c.refs.isDisjoint(with: refs) }

        if var d = detail {
            for i in d.episodes.indices where d.episodes[i].key == row.key || d.episodes[i].card.map(same) == true {
                d.episodes[i].card = card
            }
            setDetail(d)
        }
        if var o = overview {
            o.inProgress.removeAll(where: same)
            o.finished.removeAll(where: same)
            if let card {
                if card.status == .started { o.inProgress.insert(card, at: 0) }
                if card.status == .finished { o.finished.insert(card, at: 0) }
            }
            overview = o
        }
        revision += 1
    }
}
