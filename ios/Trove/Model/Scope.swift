import Foundation

/// What a list shows. Mirrors `Scope` in web/components/types.ts.
nonisolated enum Scope: Hashable, Codable, Sendable {
    case all, unsorted, unread, favorites, highlights, notes, reminders, broken, untagged
    case collection(String)
    case tag(String)
    case type(String)

    var title: String {
        switch self {
        case .all: "All items"
        case .unsorted: "Unsorted"
        case .unread: "Read later"
        case .favorites: "Favorites"
        case .highlights: "Highlights"
        case .notes: "With notes"
        case .reminders: "Reminders"
        case .broken: "Broken links"
        case .untagged: "Untagged"
        case .collection(let c): c.split(separator: "/").last.map { String($0).trimmingCharacters(in: .whitespaces) } ?? c
        case .tag(let t): "#\(t)"
        case .type(let t): TypeInfo.plural(t)
        }
    }

    var systemImage: String {
        switch self {
        case .all: "tray.full"
        case .unsorted: "tray"
        case .unread: "bookmark"
        case .favorites: "heart"
        case .highlights: "highlighter"
        case .notes: "note.text"
        case .reminders: "alarm"
        case .broken: "exclamationmark.triangle"
        case .untagged: "tag.slash"
        case .collection: "folder"
        case .tag: "number"
        case .type(let t): TypeInfo.symbol(t)
        }
    }

    /// Query parameters for GET /api/items (see web/app/api/items/route.ts).
    var queryItems: [URLQueryItem] {
        switch self {
        case .all: []
        case .unsorted: [.init(name: "collection", value: "unsorted")]
        case .unread: [.init(name: "unread", value: "1")]
        case .favorites: [.init(name: "favorite", value: "1")]
        case .highlights: [.init(name: "highlights", value: "1")]
        case .notes: [.init(name: "notes", value: "1")]
        case .reminders: [.init(name: "reminders", value: "1")]
        case .broken: [.init(name: "broken", value: "1")]
        case .untagged: [.init(name: "notag", value: "1")]
        case .collection(let c): [.init(name: "collection", value: c)]
        case .tag(let t): [.init(name: "tag", value: t)]
        case .type(let t): [.init(name: "type", value: t)]
        }
    }

    var cacheKey: String {
        switch self {
        case .collection(let c): "collection:\(c)"
        case .tag(let t): "tag:\(t)"
        case .type(let t): "type:\(t)"
        default: "\(self)"
        }
    }

    /// Whether an item still belongs here after an edit (so lists drop items you just filed away).
    func contains(_ item: Item) -> Bool {
        switch self {
        case .all: true
        case .unsorted: item.collection == nil
        case .unread: !item.read
        case .favorites: item.favorite
        case .highlights: item.highlights > 0
        case .notes: !item.note.isEmpty
        case .reminders: item.remind != nil
        case .broken: item.status == "Broken"
        case .untagged: item.tags.isEmpty
        case .collection(let c): item.collection == c || (item.collection?.hasPrefix(c + "/") ?? false)
        case .tag(let t): item.tags.contains(t)
        case .type(let t): item.type == t || (t == "Post" && item.type == "X bookmark")
        }
    }
}

nonisolated enum Sort: String, CaseIterable, Codable, Sendable, Identifiable {
    case newest, oldest, title, titleDesc = "title_desc", site, published
    var id: String { rawValue }
    var label: String {
        switch self {
        case .newest: "Newest first"
        case .oldest: "Oldest first"
        case .title: "Title A–Z"
        case .titleDesc: "Title Z–A"
        case .site: "Site"
        case .published: "Date published"
        }
    }
}

/// What the sidebar can select.
nonisolated enum Destination: Hashable, Codable, Sendable {
    case scope(Scope)
    case feeds
    case shows
}
