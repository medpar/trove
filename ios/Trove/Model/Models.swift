import Foundation

// MARK: - Items

/// One saved thing: a link, article, video, post, repo, note or file. Mirrors `Item` in web/lib/store.ts.
nonisolated struct Item: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var url: String
    var title: String
    var excerpt: String
    var domain: String
    var type: String
    var platform: String
    var collection: String?
    var tags: [String]
    var cover: String?
    var icon: String?
    var author: String
    var published: String?
    var created: String
    var favorite: Bool
    var read: Bool
    var note: String
    var status: String?
    var highlights: Int
    var readingTime: Double?
    var duration: Double?
    var remind: String?
    var source: String?
    var via: String
    var notionUrl: String
    var summary: String
    var progress: Double?
    var archive: String?
    var snapshot: Bool
    var stats: XStats?

    /// Parsed once at decode time: rows sort and format by it constantly.
    var createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, url, title, excerpt, domain, type, platform, collection, tags, cover, icon, author, published, created
        case favorite, read, note, status, highlights, readingTime, duration, remind, source, via, notionUrl, summary
        case progress, archive, snapshot, stats
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = c.string(.url)
        title = c.string(.title)
        excerpt = c.string(.excerpt)
        domain = c.string(.domain)
        type = c.string(.type, default: "Link")
        platform = c.string(.platform, default: "Web")
        collection = c.optionalString(.collection)
        tags = (try? c.decodeIfPresent([String].self, forKey: .tags)) ?? []
        cover = c.optionalString(.cover)
        icon = c.optionalString(.icon)
        author = c.string(.author)
        published = c.optionalString(.published)
        created = c.string(.created)
        favorite = (try? c.decodeIfPresent(Bool.self, forKey: .favorite)) ?? false
        read = (try? c.decodeIfPresent(Bool.self, forKey: .read)) ?? false
        note = c.string(.note)
        status = c.optionalString(.status)
        highlights = Int(c.double(.highlights) ?? 0)
        readingTime = c.double(.readingTime)
        duration = c.double(.duration)
        remind = c.optionalString(.remind)
        source = c.optionalString(.source)
        via = c.string(.via)
        notionUrl = c.string(.notionUrl)
        summary = c.string(.summary)
        progress = c.double(.progress)
        archive = c.optionalString(.archive)
        snapshot = (try? c.decodeIfPresent(Bool.self, forKey: .snapshot)) ?? false
        stats = try? c.decodeIfPresent(XStats.self, forKey: .stats)
        createdAt = TroveDate.parse(created) ?? .distantPast
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(url, forKey: .url)
        try c.encode(title, forKey: .title)
        try c.encode(excerpt, forKey: .excerpt)
        try c.encode(domain, forKey: .domain)
        try c.encode(type, forKey: .type)
        try c.encode(platform, forKey: .platform)
        try c.encodeIfPresent(collection, forKey: .collection)
        try c.encode(tags, forKey: .tags)
        try c.encodeIfPresent(cover, forKey: .cover)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encode(author, forKey: .author)
        try c.encodeIfPresent(published, forKey: .published)
        try c.encode(created, forKey: .created)
        try c.encode(favorite, forKey: .favorite)
        try c.encode(read, forKey: .read)
        try c.encode(note, forKey: .note)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encode(highlights, forKey: .highlights)
        try c.encodeIfPresent(readingTime, forKey: .readingTime)
        try c.encodeIfPresent(duration, forKey: .duration)
        try c.encodeIfPresent(remind, forKey: .remind)
        try c.encodeIfPresent(source, forKey: .source)
        try c.encode(via, forKey: .via)
        try c.encode(notionUrl, forKey: .notionUrl)
        try c.encode(summary, forKey: .summary)
        try c.encodeIfPresent(progress, forKey: .progress)
        try c.encodeIfPresent(archive, forKey: .archive)
        try c.encode(snapshot, forKey: .snapshot)
        try c.encodeIfPresent(stats, forKey: .stats)
    }
}

nonisolated struct XStats: Codable, Hashable, Sendable {
    var likes: Double?
    var reposts: Double?
    var views: Double?
    var thread: Double?
}

// MARK: - Stats (sidebar counts)

nonisolated struct Facet: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var color: String
    var count: Int
    var id: String { name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        color = (try? c.decodeIfPresent(String.self, forKey: .color)) ?? "default"
        count = Int((try? c.decodeIfPresent(Double.self, forKey: .count)) ?? 0)
    }

    init(name: String, color: String = "default", count: Int) {
        self.name = name
        self.color = color
        self.count = count
    }
}

nonisolated struct Stats: Codable, Sendable, Equatable {
    var total = 0
    var library = 0
    var x = 0
    var unsorted = 0
    var favorites = 0
    var unread = 0
    var notes = 0
    var highlights = 0
    var broken = 0
    var reminders = 0
    var noTags = 0
    var collections: [Facet] = []
    var tags: [Facet] = []
    var types: [Facet] = []
    var platforms: [Facet] = []

    enum CodingKeys: String, CodingKey {
        case total, library, x, unsorted, favorites, unread, notes, highlights, broken, reminders, noTags, collections, tags, types, platforms
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func n(_ k: CodingKeys) -> Int { Int((try? c.decodeIfPresent(Double.self, forKey: k)) ?? 0) }
        func f(_ k: CodingKeys) -> [Facet] { (try? c.decodeIfPresent([Facet].self, forKey: k)) ?? [] }
        total = n(.total); library = n(.library); x = n(.x); unsorted = n(.unsorted); favorites = n(.favorites)
        unread = n(.unread); notes = n(.notes); highlights = n(.highlights); broken = n(.broken); reminders = n(.reminders)
        noTags = n(.noTags)
        collections = f(.collections); tags = f(.tags); types = f(.types); platforms = f(.platforms)
    }
}

// MARK: - Responses

nonisolated struct ItemPage: Codable, Sendable {
    var items: [Item]
    var cursor: String?
}

nonisolated struct SearchResult: Decodable, Sendable {
    var items: [Item]
    var mode: String?
    var note: String?
}

nonisolated struct ItemContent: Decodable, Sendable {
    var item: Item
    var markdown: String?
}

nonisolated struct ItemEnvelope: Decodable, Sendable {
    var item: Item
}

nonisolated struct ItemsEnvelope: Decodable, Sendable {
    var items: [Item]
}

nonisolated struct SaveResult: Decodable, Sendable {
    var item: Item
    var created: Bool?
}

nonisolated struct BatchSaveResult: Decodable, Sendable {
    struct Entry: Decodable, Sendable {
        var item: Item?
        var created: Bool?
        var error: String?
    }
    var results: [Entry]
}

nonisolated struct AskResult: Decodable, Sendable {
    var answer: String
    var sources: [Item]
}

nonisolated struct EnrichResult: Decodable, Sendable {
    var item: Item
    var skipped: [String]?
    var errors: [String]?
}

nonisolated struct OKResult: Decodable, Sendable {
    var ok: Bool?
}

nonisolated struct ErrorBody: Decodable, Sendable {
    var error: String?
}

/// GET /api/me: what this server offers. Every field is optional so older servers still sign in.
nonisolated struct MeInfo: Decodable, Sendable {
    struct Key: Decodable, Sendable { var name: String }
    struct NotionLinks: Decodable, Sendable { var library: String? }
    struct Configured: Decodable, Sendable { var configured: Bool?; var bot: String?; var address: String? }
    var publicUrl: String?
    var notion: NotionLinks?
    var apiKeys: [Key]?
    var telegram: Configured?
    var email: Configured?
    var backup: String?
}

// MARK: - Feeds

nonisolated struct Feed: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var url: String
    var title: String
    var site: String?
    var collection: String?
    var autosave: Bool?
    var error: String?
    var count: Int?
}

nonisolated struct FeedEntry: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var feedId: String
    var feed: String
    var title: String
    var url: String
    var date: String?
    var summary: String
    var image: String?
    var author: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        feedId = c.string(.feedId)
        feed = c.string(.feed)
        title = c.string(.title)
        url = c.string(.url)
        date = c.optionalString(.date)
        summary = c.string(.summary)
        image = c.optionalString(.image)
        author = c.string(.author)
    }
}

nonisolated struct FeedsResult: Decodable, Sendable {
    var feeds: [Feed]
    var entries: [FeedEntry]
}

nonisolated struct FeedEnvelope: Decodable, Sendable {
    var feed: Feed
}

// MARK: - Uploads

nonisolated struct UploadTicket: Decodable, Sendable {
    struct Put: Decodable, Sendable {
        var method: String?
        var url: String
        var headers: [String: String]?
    }
    var upload: String?
    var put: Put?
    var duplicate: Bool?
    var item: Item?
    var created: Bool?
}

// MARK: - Decoding helpers

nonisolated extension KeyedDecodingContainer {
    func string(_ key: Key, default value: String = "") -> String {
        if let s = try? decodeIfPresent(String.self, forKey: key) { return s }
        return value
    }

    func optionalString(_ key: Key) -> String? {
        guard let s = try? decodeIfPresent(String.self, forKey: key), !s.isEmpty else { return nil }
        return s
    }

    func double(_ key: Key) -> Double? {
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? decodeIfPresent(String.self, forKey: key) { return Double(s) }
        return nil
    }
}

/// ISO 8601 parsing for Notion's timestamps ("2026-11-15T14:29:00.000Z", "...+00:00") and plain dates.
nonisolated enum TroveDate {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    nonisolated(unsafe) private static let day: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        return f
    }()

    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return fractional.date(from: s) ?? plain.date(from: s) ?? day.date(from: String(s.prefix(10)))
    }

    static func dayString(_ date: Date) -> String {
        day.string(from: date)
    }
}
