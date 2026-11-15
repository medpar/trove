import Foundation
import Observation

/// One list of items (a scope, optionally searched), paged as you scroll.
@Observable final class ItemListModel {
    enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    let scope: Scope
    private(set) var items: [Item] = []
    private(set) var phase: Phase = .idle
    private(set) var loadingMore = false
    private(set) var query = ""
    /// Set when results came from search by meaning, e.g. "Showing keyword matches only".
    private(set) var searchNote: String?
    private(set) var isSmartSearch = false
    /// Bumps whenever the list changes; cheaper to diff than the ids.
    private(set) var revision = 0
    var sort: Sort

    @ObservationIgnored private weak var library: Library?
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var index: [String: Int] = [:]

    init(scope: Scope, library: Library, sort: Sort = .newest) {
        self.scope = scope
        self.library = library
        self.sort = sort
        library.register(self)
    }

    private var cacheKey: String { "\(library?.cachePrefix ?? "")/list/\(scope.cacheKey)/\(sort.rawValue)" }
    var hasMore: Bool { cursor != nil }
    var isSearching: Bool { !query.isEmpty }

    // MARK: Loading

    /// First appearance: show the cached first page at once, then refresh it.
    func start() async {
        guard phase == .idle else { return }
        phase = .loading
        if query.isEmpty, items.isEmpty, let cached = await DiskCache.load(ItemPage.self, cacheKey), !cached.items.isEmpty {
            setItems(cached.items)
            cursor = cached.cursor
        }
        await reload()
    }

    func reload() async {
        generation += 1
        let gen = generation
        guard let api = library?.api else { return }
        if items.isEmpty { phase = .loading }
        let q = query
        do {
            if Self.isSmartQuery(q), scope == .all {
                let r = try await api.search(q)
                guard gen == generation else { return }
                isSmartSearch = r.mode == "hybrid"
                searchNote = r.note.map(Self.friendlyNote)
                cursor = nil
                setItems(r.items)
            } else {
                let page = try await api.items(scope: scope, query: q, sort: sort)
                guard gen == generation else { return }
                isSmartSearch = false
                searchNote = nil
                cursor = page.cursor
                setItems(page.items)
                if q.isEmpty { await DiskCache.save(page, cacheKey) }
            }
            phase = .loaded
        } catch is CancellationError {
            if gen == generation, items.isEmpty { phase = .idle }
        } catch {
            guard gen == generation else { return }
            if library?.handleAuth(error) == true { return }
            if items.isEmpty || !q.isEmpty {
                if !q.isEmpty { setItems([]) }
                phase = .failed(error.localizedDescription)
            } else {
                phase = .loaded
                library?.report(error, "Couldn’t refresh")
            }
        }
    }

    func search(_ text: String) async {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q != query else { return }
        query = q
        if q.isEmpty {
            searchNote = nil
            isSmartSearch = false
            phase = .loading
            if let cached = await DiskCache.load(ItemPage.self, cacheKey) {
                setItems(cached.items)
                cursor = cached.cursor
            }
        }
        await reload()
    }

    func setSort(_ s: Sort) async {
        guard s != sort else { return }
        sort = s
        setItems([])
        cursor = nil
        phase = .loading
        await reload()
    }

    /// Called as rows appear: fetch the next page when we're near the end.
    func loadMoreIfNeeded(_ item: Item) {
        guard let i = index[item.id], i >= items.count - 10, cursor != nil, !loadingMore else { return }
        Task { await loadMore() }
    }

    func loadMore() async {
        guard let api = library?.api, let cursor, !loadingMore else { return }
        loadingMore = true
        let gen = generation
        defer { if gen == generation { loadingMore = false } }
        do {
            let page = try await api.items(scope: scope, query: query, sort: sort, cursor: cursor)
            guard gen == generation else { return }
            self.cursor = page.cursor
            let fresh = page.items.filter { index[$0.id] == nil }
            setItems(items + fresh)
        } catch {
            if !(error is CancellationError) { library?.report(error, "Couldn’t load more") }
        }
    }

    // MARK: Edits from elsewhere

    func apply(_ item: Item) {
        guard let i = index[item.id] else { return }
        if !isSearching, !scope.contains(item) {
            var next = items
            next.remove(at: i)
            setItems(next)
        } else if items[i] != item {
            items[i] = item
        }
    }

    func remove(_ id: String) {
        guard let i = index[id] else { return }
        var next = items
        next.remove(at: i)
        setItems(next)
    }

    /// Undo a removal (failed delete).
    func restore(_ item: Item) {
        guard index[item.id] == nil, scope.contains(item) else { return }
        var next = items
        let at = next.firstIndex { $0.createdAt < item.createdAt } ?? next.count
        next.insert(item, at: sort == .newest ? at : next.count)
        setItems(next)
    }

    func insert(_ item: Item) {
        guard index[item.id] == nil, !isSearching, sort == .newest, scope.contains(item) else {
            apply(item)
            return
        }
        setItems([item] + items)
    }

    private func setItems(_ list: [Item]) {
        items = list
        revision &+= 1
        var idx: [String: Int] = [:]
        idx.reserveCapacity(list.count)
        for (i, it) in list.enumerated() { idx[it.id] = i }
        index = idx
    }

    // MARK: Query kind

    /// Plain-language queries use hybrid search (web/components/api.ts isSmartQuery).
    static func isSmartQuery(_ q: String) -> Bool {
        let t = q.trimmingCharacters(in: .whitespaces)
        guard t.count > 2, !t.lowercased().hasPrefix("http") else { return false }
        return t.range(of: #"(^|\s)(-?#|-\w|\w+:|")"#, options: .regularExpression) == nil
    }

    /// The server explains when search by meaning is off; say it in a few words.
    static func friendlyNote(_ note: String) -> String {
        let n = note.lowercased()
        if n.contains("allowance") || n.contains("neurons") || n.contains("quota") {
            return "Keyword matches only: search by meaning is paused until 00:00 UTC."
        }
        if n.contains("off") || n.contains("unavailable") { return "Keyword matches only." }
        return note
    }

    /// Worth offering "Ask Trove" for: a question or a few words.
    static func looksLikeQuestion(_ q: String) -> Bool {
        let t = q.trimmingCharacters(in: .whitespaces)
        return isSmartQuery(t) && (t.hasSuffix("?") || t.split(separator: " ").count >= 3)
    }
}
