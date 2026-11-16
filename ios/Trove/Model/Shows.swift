import Foundation

// MARK: - Shows: what you watch and listen to on YouTube and Spotify (docs/shows.md)

/// Where an episode can be played.
nonisolated enum MediaPlatform: String, Codable, Hashable, Sendable {
    case yt, sp

    var name: String { self == .yt ? "YouTube" : "Spotify" }
    var other: MediaPlatform { self == .yt ? .sp : .yt }
}

/// One platform's copy of an episode.
nonisolated struct EpisodeCopy: Codable, Hashable, Sendable {
    var id: String
    var dur: Double?
    var title: String?
}

/// Your record of one episode, both platforms on it. Mirrors `Card` in web/lib/episodes.ts.
nonisolated struct EpisodeCard: Codable, Hashable, Sendable, Identifiable {
    enum Status: String, Codable, Sendable { case new, started, finished }

    /// Where you were last, on either platform.
    struct Resume: Codable, Hashable, Sendable {
        var p: MediaPlatform
        var pos: Double
        var dur: Double?
        /// Milliseconds since 1970.
        var at: Double
        /// `at` is only "by then": Trove found it already played (an import) and can't know when.
        var before: Bool?
    }

    var id: String
    var title: String
    var show: String?
    var series: String?
    var image: String?
    var released: String?
    var yt: EpisodeCopy?
    var sp: EpisodeCopy?
    var status: Status
    var pct: Double
    var finishedAt: Double?
    /// The finish date is only "by then" (already finished when Trove first saw it).
    var finishedBefore: Bool = false
    /// "yt", "sp", "both" or "manual".
    var doneOn: String?
    var resume: Resume?
    /// Seen on this platform with no position kept (YouTube's history does that for some videos).
    var seen: MediaPlatform?
    var notionUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, title, show, series, image, released, yt, sp, status, pct, finishedAt, finishedBefore, doneOn, resume, seen, notionUrl
    }

    subscript(_ p: MediaPlatform) -> EpisodeCopy? { p == .yt ? yt : sp }

    /// "id:…", "sp:…", "yt:…": what identifies this episode in any list.
    var refs: Set<String> {
        var out: Set<String> = []
        if !id.isEmpty { out.insert("id:\(id)") }
        if let sp { out.insert("sp:\(sp.id)") }
        if let yt { out.insert("yt:\(yt.id)") }
        return out
    }

    var finishedDate: Date? { finishedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// The same card as the server will return it after "Mark as finished" / "Not finished".
    func marked(finished: Bool) -> EpisodeCard {
        var c = self
        c.status = finished ? .finished : .new
        c.pct = finished ? 1 : 0
        c.finishedAt = finished ? Date.now.timeIntervalSince1970 * 1000 : nil
        c.finishedBefore = false
        c.doneOn = finished ? "manual" : nil
        c.resume = nil
        c.seen = nil
        return c
    }
}

nonisolated extension EpisodeCard {
    /// Lenient, so a newer server's cards still load. In an extension to keep the memberwise initializer.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.string(.title, default: "Untitled")
        show = c.optionalString(.show)
        series = c.optionalString(.series)
        image = c.optionalString(.image)
        released = c.optionalString(.released)
        yt = try? c.decodeIfPresent(EpisodeCopy.self, forKey: .yt)
        sp = try? c.decodeIfPresent(EpisodeCopy.self, forKey: .sp)
        status = (try? c.decodeIfPresent(Status.self, forKey: .status)) ?? .new
        pct = c.double(.pct) ?? 0
        finishedAt = c.double(.finishedAt)
        finishedBefore = (try? c.decodeIfPresent(Bool.self, forKey: .finishedBefore)) ?? false
        doneOn = c.optionalString(.doneOn)
        resume = try? c.decodeIfPresent(Resume.self, forKey: .resume)
        seen = c.optionalString(.seen).flatMap(MediaPlatform.init(rawValue:))
        notionUrl = c.optionalString(.notionUrl)
    }
}

/// One episode of a followed show: both copies paired, and your record once you played it. Mirrors `Row` in web/lib/shows.ts.
nonisolated struct ShowEpisode: Codable, Hashable, Sendable, Identifiable {
    var key: String
    var title: String
    var date: String?
    var dur: Double?
    var series: String?
    var image: String?
    var sp: EpisodeCopy?
    var yt: EpisodeCopy?
    var pairedBy: String?
    var card: EpisodeCard?

    var id: String { key }
}

nonisolated extension ShowEpisode {
    /// An episode from the Continue and Recently finished lists (web `cardRow`).
    init(card: EpisodeCard) {
        self.init(
            key: card.id, title: card.title, date: card.released, dur: card.sp?.dur ?? card.yt?.dur, series: card.series, image: card.image,
            sp: card.sp.map { EpisodeCopy(id: $0.id, dur: $0.dur, title: $0.title ?? card.title) },
            yt: card.yt.map { EpisodeCopy(id: $0.id, dur: $0.dur, title: $0.title ?? card.title) },
            pairedBy: nil, card: card
        )
    }

    var status: EpisodeCard.Status { card?.status ?? .new }
    var releasedAt: Date? { TroveDate.parse(date) }

    var imageURL: URL? {
        if let image, let url = URL(string: image) { return url }
        return yt.flatMap { URL(string: "https://i.ytimg.com/vi/\($0.id)/mqdefault.jpg") }
    }

    func copy(_ p: MediaPlatform) -> EpisodeCopy? { p == .yt ? yt : sp }

    /// The platform you were last on, else Spotify, else YouTube.
    var preferred: MediaPlatform {
        if let p = card?.resume?.p, copy(p) != nil { return p }
        return sp != nil ? .sp : .yt
    }

    /// Where to pick up on a platform: your last position there, or mapped from the other one (web `resumeOn`).
    func resume(on p: MediaPlatform) -> (pos: Double, exact: Bool) {
        guard let card, card.status == .started, let r = card.resume else { return (0, true) }
        if r.p == p { return (r.pos, true) }
        return EpisodeMath.mapPosition(r.pos, from: r.dur ?? card[r.p]?.dur, to: copy(p)?.dur ?? dur)
    }

    /// "15:03", or "≈15:10" when mapped from the other platform; nil at the start.
    func resumeLabel(on p: MediaPlatform) -> String? {
        let r = resume(on: p)
        guard r.pos >= 5 else { return nil }
        return (r.exact ? "" : "≈") + EpisodeMath.clock(r.pos)
    }

    /// Played but never stored (catalog episodes have no record until you play them): the event that creates one.
    func newEpisodeEvent(show: String?) -> [String: JSONValue]? {
        let p: MediaPlatform = sp != nil ? .sp : .yt
        guard let mine = copy(p) else { return nil }
        var e: [String: JSONValue] = [
            "p": .string(p.rawValue), "id": .string(mine.id), "at": .number((Date.now.timeIntervalSince1970 * 1000).rounded()),
            "title": .string(title), "src": "manual",
        ]
        if let show { e["show"] = .string(show) }
        if let d = mine.dur ?? dur { e["dur"] = .number(d) }
        if let date { e["released"] = .string(date) }
        if let twin = copy(p.other) {
            e["twin"] = ["p": .string(p.other.rawValue), "id": .string(twin.id), "by": .string(pairedBy ?? "catalog")]
        }
        return e
    }

    /// A record shown at once while the server stores the change.
    func provisionalCard(finished: Bool) -> EpisodeCard {
        EpisodeCard(
            id: "", title: title, show: nil, series: series, image: image, released: date, yt: yt, sp: sp,
            status: .new, pct: 0, finishedAt: nil, doneOn: nil, resume: nil, notionUrl: nil
        ).marked(finished: finished)
    }
}

/// A show you follow: a Spotify podcast and/or a YouTube channel. Mirrors `Show` in web/lib/shows.ts.
nonisolated struct FollowedShow: Codable, Hashable, Sendable, Identifiable {
    struct Spotify: Codable, Hashable, Sendable {
        var id: String
        var title: String?
    }
    struct YouTube: Codable, Hashable, Sendable {
        var channelId: String?
        var title: String?
    }
    struct Catalog: Codable, Hashable, Sendable {
        var at: Double?
        var episodes: Int?
        var error: String?
    }

    var id: String
    var title: String
    var image: String?
    var spotify: Spotify?
    var youtube: YouTube?
    var catalog: Catalog?

    var imageURL: URL? { image.flatMap(URL.init(string:)) }
}

/// GET /api/media/shows
nonisolated struct ShowsOverview: Codable, Sendable {
    var shows: [FollowedShow]
    /// In progress anywhere, latest first.
    var inProgress: [EpisodeCard]
    var finished: [EpisodeCard]

    enum CodingKeys: String, CodingKey {
        case shows, inProgress = "continue", finished
    }
}

/// GET /api/media/shows/:id
nonisolated struct ShowDetail: Codable, Sendable {
    struct Catalog: Codable, Hashable, Sendable {
        var at: Double?
        var error: String?
        var spotify: Int?
        var youtube: Int?
        var paired: Int?
    }
    struct Series: Codable, Hashable, Sendable, Identifiable {
        var name: String
        var count: Int
        var finished: Int
        var started: Int
        var id: String { name }
    }

    var show: FollowedShow
    /// Nil while the episode list is still being built after following.
    var catalog: Catalog?
    var series: [Series]
    var episodes: [ShowEpisode]
}

/// GET /api/media/connect: the sign-ins that let the server read your phone's progress.
nonisolated struct MediaSyncStatus: Codable, Sendable {
    struct Side: Codable, Sendable {
        var connected: Bool?
        var at: Double?
        var ok: Bool?
        var error: String?
        var needsSignIn: Bool?
    }
    var spotify: Side
    var youtube: Side

    var connected: [MediaPlatform] { (spotify.connected == true ? [.sp] : []) + (youtube.connected == true ? [.yt] : []) }

    var lastSync: Date? {
        let at = max(spotify.at ?? 0, youtube.at ?? 0)
        return at > 0 ? Date(timeIntervalSince1970: at / 1000) : nil
    }

    /// The sign-in that stopped working, if any.
    var needsSignIn: MediaPlatform? {
        if spotify.needsSignIn == true { return .sp }
        if youtube.needsSignIn == true { return .yt }
        return nil
    }
}

/// POST /api/media/sync?wait=1
nonisolated struct MediaSyncResult: Decodable, Sendable {
    struct Side: Decodable, Sendable {
        var events: Int?
        var error: String?
    }
    var spotify: Side?
    var youtube: Side?
    var updated: Int?
}

nonisolated struct EpisodeCardEnvelope: Decodable, Sendable {
    var card: EpisodeCard
}

nonisolated struct EpisodeCardsEnvelope: Decodable, Sendable {
    var cards: [EpisodeCard]
}

// MARK: - Times and words

nonisolated enum EpisodeMath {
    /// A position on one copy as a position on the other: the same time when both have the same length,
    /// else proportional (extension/lib/progress.js `mapPosition`).
    static func mapPosition(_ pos: Double, from: Double?, to: Double?) -> (pos: Double, exact: Bool) {
        guard let from, let to, from > 0, to > 0 else { return (pos, false) }
        if abs(from - to) <= max(20, 0.015 * max(from, to)) { return (min(pos, to), true) }
        return ((pos / from * to).rounded(), false)
    }

    /// 3723 -> "1:02:03", 95 -> "1:35"
    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%d:%02d", m, r)
    }

    /// 3150 -> "53 min", 9105 -> "2 h 32 min", 3606 -> "1 h"
    static func length(_ seconds: Double?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let minutes = Int((seconds / 60).rounded())
        if minutes >= 60 { return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min" }
        return "\(max(1, minutes)) min"
    }

    /// "2h", or "before 15 Nov" when Trove only knows it had happened by then (found already played).
    static func when(_ ms: Double, before: Bool) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        return before ? "before \(date.formatted(.dateTime.day().month(.abbreviated)))" : Fmt.ago(date)
    }

    /// "42% · at 1:04:28 of 2:31:45 on Spotify · 2h", or "Seen on YouTube" when it kept no position.
    static func progressLine(_ card: EpisodeCard) -> String {
        if let seen = card.seen, card.resume == nil, card.pct < 0.02 { return "Seen on \(seen.name)" }
        var s = "\(Int((card.pct * 100).rounded()))%"
        if let r = card.resume {
            s += " · at \(clock(r.pos))"
            if let d = r.dur, d > 0 { s += " of \(clock(d))" }
            s += " on \(r.p.name) · \(when(r.at, before: r.before == true))"
        }
        return s
    }

    /// "Finished on Spotify · 3d", or "· before 15 Nov" when it was already finished when Trove first looked.
    static func finishedLine(_ card: EpisodeCard) -> String {
        var s = "Finished"
        if let on = card.doneOn.flatMap(MediaPlatform.init(rawValue:)) { s += " on \(on.name)" }
        if let at = card.finishedAt { s += " · \(when(at, before: card.finishedBefore))" }
        return s
    }
}
