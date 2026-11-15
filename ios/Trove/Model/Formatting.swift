import SwiftUI

/// Content types: SF Symbols, plurals and order (web/components/ui.tsx TYPE_ORDER).
nonisolated enum TypeInfo {
    static let order = ["Article", "Video", "Post", "X bookmark", "Link", "Image", "Document", "Audio", "Repo", "Paper", "Product", "Note"]

    static func symbol(_ type: String) -> String {
        switch type {
        case "Article": "doc.text"
        case "Video": "play.rectangle"
        case "Post": "text.bubble"
        case "X bookmark": "bookmark"
        case "Link": "link"
        case "Image": "photo"
        case "Document": "doc"
        case "Audio": "waveform"
        case "Repo": "chevron.left.forwardslash.chevron.right"
        case "Paper": "graduationcap"
        case "Product": "bag"
        case "Note": "note.text"
        default: "link"
        }
    }

    static func plural(_ type: String) -> String {
        switch type {
        case "X bookmark": "X bookmarks"
        case "Audio": "Audio"
        case "Article", "Video", "Post", "Link", "Image", "Document", "Repo", "Paper", "Product", "Note": type + "s"
        default: type
        }
    }

    static func rank(_ type: String) -> Int { order.firstIndex(of: type) ?? order.count }
}

/// Notion select colors (web/components/ui.tsx NOTION_COLORS).
enum NotionColor {
    static func color(_ name: String) -> Color? {
        switch name {
        case "gray": Color(red: 0.61, green: 0.60, blue: 0.59)
        case "brown": Color(red: 0.64, green: 0.47, blue: 0.39)
        case "orange": Color(red: 0.85, green: 0.45, blue: 0.05)
        case "yellow": Color(red: 0.80, green: 0.57, blue: 0.18)
        case "green": Color(red: 0.27, green: 0.51, blue: 0.38)
        case "blue": Color(red: 0.20, green: 0.49, blue: 0.66)
        case "purple": Color(red: 0.56, green: 0.40, blue: 0.69)
        case "pink": Color(red: 0.76, green: 0.30, blue: 0.54)
        case "red": Color(red: 0.83, green: 0.30, blue: 0.28)
        default: nil
        }
    }
}

/// Brand tints for placeholder thumbnails (web PLATFORM_TINT).
enum PlatformTint {
    static func color(_ platform: String) -> Color? {
        switch platform {
        case "YouTube": Color(red: 1.0, green: 0.23, blue: 0.19)
        case "X": Color(white: 0.12)
        case "Reddit": Color(red: 1.0, green: 0.34, blue: 0.0)
        case "Bluesky": Color(red: 0.07, green: 0.52, blue: 1.0)
        case "Mastodon": Color(red: 0.39, green: 0.39, blue: 1.0)
        case "GitHub": Color(red: 0.43, green: 0.25, blue: 0.79)
        case "Hacker News": Color(red: 1.0, green: 0.4, blue: 0.0)
        case "LinkedIn": Color(red: 0.04, green: 0.4, blue: 0.76)
        case "Instagram": Color(red: 0.88, green: 0.19, blue: 0.42)
        case "Spotify": Color(red: 0.11, green: 0.73, blue: 0.33)
        case "Substack": Color(red: 1.0, green: 0.4, blue: 0.1)
        case "Pinterest": Color(red: 0.9, green: 0.0, blue: 0.14)
        default: nil
        }
    }
}

extension Color {
    static let ember = Color("AccentColor")
}

nonisolated enum Fmt {
    /// "now", "5m", "3h", "2d", then "12 Nov" or "12 Nov 2024".
    static func ago(_ date: Date, now: Date = .now) -> String {
        let s = now.timeIntervalSince(date)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        if s < 86400 * 7 { return "\(Int(s / 86400))d" }
        return shortDate(date, now: now)
    }

    static func shortDate(_ date: Date, now: Date = .now) -> String {
        let sameYear = Calendar.current.isDate(date, equalTo: now, toGranularity: .year)
        return date.formatted(sameYear ? .dateTime.day().month(.abbreviated) : .dateTime.day().month(.abbreviated).year())
    }

    static func longDate(_ date: Date) -> String {
        date.formatted(.dateTime.day().month(.abbreviated).year())
    }

    static func duration(_ seconds: Double?) -> String {
        guard let seconds, seconds > 0 else { return "" }
        let s = Int(seconds.rounded())
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? "\(h)h \(m)m" : String(format: "%d:%02d", m, sec)
    }

    static func compact(_ n: Double?) -> String {
        guard let n else { return "" }
        return Int(n).formatted(.number.notation(.compactName))
    }

    static func host(_ urlString: String) -> String {
        guard let host = URL(string: urlString)?.host() else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// Collapse whitespace and newlines so excerpts read as one line of prose.
    static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}

nonisolated extension Item {
    var isX: Bool { type == "X bookmark" }
    var isNote: Bool { type == "Note" }

    var displayTitle: String {
        if !title.isEmpty { return title }
        if !url.isEmpty { return url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "") }
        return "Untitled"
    }

    /// Where it came from: the site, or the @handle for X bookmarks.
    var host: String {
        if isX, let handle = author.split(separator: " ").last, handle.hasPrefix("@") { return String(handle) }
        if !domain.isEmpty { return domain.hasPrefix("www.") ? String(domain.dropFirst(4)) : domain }
        return Fmt.host(url)
    }

    /// The line under the title: the AI summary, else the excerpt (unless it only repeats the title).
    var blurb: String {
        let s = summary.isEmpty ? excerpt : summary
        let line = Fmt.oneLine(s)
        let t = Fmt.oneLine(title)
        if line.isEmpty || (!t.isEmpty && line.hasPrefix(t) && line.count < t.count + 12) { return "" }
        if !t.isEmpty, line.hasPrefix(t) { return String(line.dropFirst(t.count)).trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters)) }
        return line
    }

    /// Small badge text: duration, reading time or thread length.
    var lengthBadge: String? {
        if isX, let n = stats?.thread, n > 1 { return "Thread · \(Int(n))" }
        if let d = duration, d > 0 { return Fmt.duration(d) }
        if let r = readingTime, r > 0 { return "\(Int(r)) min" }
        return nil
    }

    var coverURL: URL? { cover.flatMap(URL.init(string:)) }
    var iconURL: URL? { icon.flatMap(URL.init(string:)) }
    var link: URL? { url.isEmpty ? nil : URL(string: url) }
    var notionLink: URL? { URL(string: notionUrl) }
    var faviconURL: URL? { Favicon.url(for: domain.isEmpty ? Fmt.host(url) : domain) }
    var publishedAt: Date? { TroveDate.parse(published) }
    var isBroken: Bool { status == "Broken" }
    var canArchive: Bool { !url.isEmpty && !isX && platform != "Upload" }
}

nonisolated enum Favicon {
    static func url(for domain: String, size: Int = 64) -> URL? {
        guard !domain.isEmpty else { return nil }
        var c = URLComponents(string: "https://www.google.com/s2/favicons")!
        c.queryItems = [.init(name: "domain", value: domain), .init(name: "sz", value: String(size))]
        return c.url
    }
}
