import Foundation
import Observation
import UIKit

/// A short message at the bottom of the screen, optionally with one action.
struct Toast: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var systemImage: String?
    var actionLabel: String?
    var action: (@MainActor () -> Void)?
    var isError = false

    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
}

/// Collections form a tree by "/" in their names (web/components/sidebar.tsx).
struct CollectionNode: Identifiable, Hashable {
    var name: String
    var label: String
    var own: Int
    var total: Int
    var color: String
    var children: [CollectionNode]?
    var id: String { name }

    static func tree(_ facets: [Facet]) -> [CollectionNode] {
        final class Box { var node: CollectionNode; var kids: [Box] = []; init(_ n: CollectionNode) { node = n } }
        var byName: [String: Box] = [:]
        var roots: [Box] = []
        func box(_ name: String) -> Box {
            if let b = byName[name] { return b }
            let parts = name.split(separator: "/", omittingEmptySubsequences: false)
            let b = Box(CollectionNode(name: name, label: String(parts.last ?? "").trimmingCharacters(in: .whitespaces), own: 0, total: 0, color: "default"))
            byName[name] = b
            if parts.count > 1 { box(parts.dropLast().joined(separator: "/")).kids.append(b) } else { roots.append(b) }
            return b
        }
        for f in facets {
            let b = box(f.name)
            b.node.own = f.count
            b.node.color = f.color
        }
        func build(_ b: Box) -> CollectionNode {
            var n = b.node
            let kids = b.kids.map(build).sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
            n.total = n.own + kids.reduce(0) { $0 + $1.total }
            n.children = kids.isEmpty ? nil : kids
            return n
        }
        return roots.map(build).sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }
}

/// Shared library state: counts for the sidebar, the open lists, and every edit (applied optimistically).
@Observable final class Library {
    private(set) var api: APIClient?
    private(set) var stats: Stats?
    private(set) var collections: [CollectionNode] = []
    private(set) var statsError: String?
    var toast: Toast?

    @ObservationIgnored private var lists = NSHashTable<ItemListModel>.weakObjects()
    @ObservationIgnored private var onUnauthorized: (() -> Void)?
    @ObservationIgnored private var contents: [String: ItemContent] = [:]
    @ObservationIgnored private var contentOrder: [String] = []
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var statsTask: Task<Void, Never>?
    @ObservationIgnored private var statsRefresh: Task<Void, Never>?

    var isConnected: Bool { api != nil }
    var cachePrefix: String { api?.account.baseURL.host() ?? "" }

    func connect(_ api: APIClient, onUnauthorized: @escaping () -> Void) {
        self.api = api
        self.onUnauthorized = onUnauthorized
        Task { await restoreStats() }
    }

    func disconnect() {
        api = nil
        stats = nil
        collections = []
        contents = [:]
        contentOrder = []
        lists.removeAllObjects()
    }

    // MARK: Stats

    private func restoreStats() async {
        if stats == nil, let cached = await DiskCache.load(Stats.self, "\(cachePrefix)/stats") {
            setStats(cached)
        }
        await loadStats()
    }

    /// Concurrent callers share one request.
    func loadStats(fresh: Bool = false) async {
        if let running = statsTask, !fresh { return await running.value }
        let task = Task { await fetchStats(fresh: fresh) }
        statsTask = task
        await task.value
        statsTask = nil
    }

    /// After edits: one refresh a moment later, however many edits happened (each refresh rescans Notion).
    func scheduleStatsRefresh() {
        statsRefresh?.cancel()
        statsRefresh = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await loadStats()
        }
    }

    private func fetchStats(fresh: Bool) async {
        guard let api else { return }
        do {
            let s = try await api.stats(fresh: fresh)
            setStats(s)
            statsError = nil
            await DiskCache.save(s, "\(cachePrefix)/stats")
        } catch {
            if handleAuth(error) { return }
            statsError = error.localizedDescription
        }
    }

    private func setStats(_ s: Stats) {
        guard s != stats else { return }
        stats = s
        collections = CollectionNode.tree(s.collections)
    }

    var collectionNames: [String] { (stats?.collections ?? []).map(\.name).sorted { $0.localizedStandardCompare($1) == .orderedAscending } }
    var tagNames: [String] { (stats?.tags ?? []).map(\.name) }

    // MARK: Lists

    func register(_ list: ItemListModel) { lists.add(list) }

    private func eachList(_ body: (ItemListModel) -> Void) {
        for list in lists.allObjects { body(list) }
    }

    /// Latest version of recently edited items, so an open reader follows edits made elsewhere.
    private(set) var revisions: [String: Item] = [:]

    /// Spread an updated item to every open list (and drop it where it no longer belongs).
    func propagate(_ item: Item) {
        eachList { $0.apply(item) }
        if var c = contents[item.id] {
            c.item = item
            contents[item.id] = c
        }
        if revisions.count > 40 { revisions.removeAll() }
        revisions[item.id] = item
    }

    // MARK: Content (archived Markdown), kept for the last few items so going back is instant

    func cachedContent(_ id: String) -> ItemContent? { contents[id] }

    func content(_ id: String) async throws -> ItemContent {
        guard let api else { throw APIError.unauthorized }
        do {
            let c = try await api.item(id)
            remember(c)
            return c
        } catch {
            _ = handleAuth(error)
            throw error
        }
    }

    private func remember(_ c: ItemContent) {
        contents[c.item.id] = c
        contentOrder.removeAll { $0 == c.item.id }
        contentOrder.append(c.item.id)
        while contentOrder.count > 8 { contents[contentOrder.removeFirst()] = nil }
    }

    // MARK: Edits

    /// Apply locally first, then save; on failure, put the old value back.
    @discardableResult
    func update(_ item: Item, server patch: [String: JSONValue], local: (inout Item) -> Void) async -> Item? {
        guard let api else { return nil }
        var optimistic = item
        local(&optimistic)
        propagate(optimistic)
        do {
            let saved = try await api.update(item.id, patch)
            propagate(saved)
            if patch.keys.contains(where: { ["tags", "collection", "favorite", "read", "note", "remind"].contains($0) }) {
                scheduleStatsRefresh()
            }
            return saved
        } catch {
            propagate(item)
            report(error, "Couldn’t save")
            return nil
        }
    }

    func setFavorite(_ item: Item, _ on: Bool) async {
        await update(item, server: ["favorite": .bool(on)]) { $0.favorite = on }
    }

    func setRead(_ item: Item, _ on: Bool) async {
        await update(item, server: ["read": .bool(on)]) { $0.read = on }
    }

    func setCollection(_ item: Item, _ collection: String?) async {
        await update(item, server: ["collection": .string(collection ?? "")]) { $0.collection = collection }
    }

    func setTags(_ item: Item, _ tags: [String]) async {
        await update(item, server: ["tags": .strings(tags)]) { $0.tags = tags }
    }

    func delete(_ item: Item) async -> Bool {
        guard let api else { return false }
        eachList { $0.remove(item.id) }
        do {
            try await api.delete(item.id)
            contents[item.id] = nil
            show(Toast(text: "Moved to Notion’s trash", systemImage: "trash"))
            scheduleStatsRefresh()
            return true
        } catch {
            eachList { $0.restore(item) }
            report(error, "Couldn’t delete")
            return false
        }
    }

    /// A new item from the add sheet, a feed or an upload: show it at the top of lists it belongs to.
    func didSave(_ item: Item, created: Bool) {
        if created { eachList { $0.insert(item) } } else { propagate(item) }
        scheduleStatsRefresh()
    }

    func addHighlight(_ item: Item, text: String, note: String?) async -> Item? {
        guard let api else { return nil }
        do {
            let updated = try await api.addHighlight(item.id, text: text, note: note)
            contents[item.id] = nil
            propagate(updated)
            show(Toast(text: note == nil ? "Highlight saved" : "Highlight and note saved", systemImage: "highlighter"))
            return updated
        } catch {
            report(error, "Couldn’t save the highlight")
            return nil
        }
    }

    // MARK: Messages

    func show(_ toast: Toast) {
        self.toast = toast
        toastTask?.cancel()
        let id = toast.id
        toastTask = Task {
            try? await Task.sleep(for: .seconds(toast.action == nil ? 2.6 : 4.5))
            guard !Task.isCancelled, self.toast?.id == id else { return }
            self.toast = nil
        }
    }

    func report(_ error: Error, _ prefix: String) {
        if handleAuth(error) || error is CancellationError { return }
        show(Toast(text: "\(prefix): \(error.localizedDescription)", systemImage: "exclamationmark.triangle", isError: true))
    }

    /// Returns true when the error means we must sign in again.
    @discardableResult
    func handleAuth(_ error: Error) -> Bool {
        guard let e = error as? APIError, e == .unauthorized else { return false }
        onUnauthorized?()
        return true
    }
}
