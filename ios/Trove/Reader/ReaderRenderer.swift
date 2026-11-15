import UIKit

extension NSAttributedString.Key {
    /// A rounded background behind a whole block (code, callout, summary, note). Value: BlockDecoration.
    nonisolated static let troveBlock = NSAttributedString.Key("troveBlock")
    /// A bar left of a quote. Value: BlockDecoration (one instance per run of quote lines).
    nonisolated static let troveQuote = NSAttributedString.Key("troveQuote")
    /// A horizontal rule drawn through the middle of its line. Value: NSNumber(true).
    nonisolated static let troveRule = NSAttributedString.Key("troveRule")
    /// Marks the spoken word while listening.
    nonisolated static let troveSpoken = NSAttributedString.Key("troveSpoken")
    /// A rounded background hugging the glyphs (inline code, highlights). Value: UIColor.
    nonisolated static let troveMark = NSAttributedString.Key("troveMark")
}

nonisolated final class BlockDecoration: NSObject, @unchecked Sendable {
    let fill: UIColor
    let radius: CGFloat
    let padding: CGFloat
    init(fill: UIColor, radius: CGFloat = 10, padding: CGFloat = 10) {
        self.fill = fill
        self.radius = radius
        self.padding = padding
    }
}

nonisolated struct HighlightEntry: Sendable, Hashable {
    var text: String
    var note: String?
}

nonisolated struct ReaderStyle: Sendable, Hashable {
    var size: CGFloat = 18
    var serif = true
    var scale: CGFloat = 3
}

/// The rendered page: header (cover, title, properties) + archived content, ready for a UITextView.
nonisolated final class RenderedDocument: @unchecked Sendable {
    let text: NSAttributedString
    let bodyStart: Int
    let highlights: [HighlightEntry]
    let hasBody: Bool

    init(text: NSAttributedString, bodyStart: Int, highlights: [HighlightEntry], hasBody: Bool) {
        self.text = text
        self.bodyStart = bodyStart
        self.highlights = highlights
        self.hasBody = hasBody
    }

    /// What "Listen" reads: the body (or everything when there's no archived text), minus attachments.
    var speakableText: (text: String, offset: Int) {
        let ns = text.string as NSString
        let start = hasBody ? bodyStart : 0
        let body = ns.substring(from: start)
        return (body.replacingOccurrences(of: "\u{FFFC}", with: " "), start)
    }
}

nonisolated enum ReaderColors {
    static func dynamic(_ light: UIColor, _ dark: UIColor) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }
    static let accent = dynamic(UIColor(red: 0xD2 / 255, green: 0x4A / 255, blue: 0x12 / 255, alpha: 1), UIColor(red: 0xEF / 255, green: 0x84 / 255, blue: 0x48 / 255, alpha: 1))
    static let accentSoft = dynamic(UIColor(red: 1, green: 0.957, blue: 0.933, alpha: 1), UIColor(red: 0x37 / 255, green: 0x20 / 255, blue: 0x16 / 255, alpha: 1))
    static let mark = dynamic(UIColor(red: 1, green: 0.91, blue: 0.57, alpha: 0.85), UIColor(red: 0.37, green: 0.29, blue: 0.05, alpha: 0.9))
    static let spoken = dynamic(UIColor(red: 0xD2 / 255, green: 0x4A / 255, blue: 0x12 / 255, alpha: 0.14), UIColor(red: 0xEF / 255, green: 0x84 / 255, blue: 0x48 / 255, alpha: 0.24))
    static let codeFill = dynamic(UIColor(red: 0.955, green: 0.955, blue: 0.965, alpha: 1), UIColor(red: 0.13, green: 0.13, blue: 0.145, alpha: 1))
    static let inlineCode = dynamic(UIColor(red: 0.93, green: 0.93, blue: 0.945, alpha: 1), UIColor(red: 0.18, green: 0.18, blue: 0.2, alpha: 1))
    static let calloutFill = dynamic(UIColor(red: 0.955, green: 0.955, blue: 0.965, alpha: 1), UIColor(red: 0.13, green: 0.13, blue: 0.145, alpha: 1))
    static let quoteBar = UIColor.tertiaryLabel
}

/// Turns Notion-flavored Markdown (one block per line, tabs for nesting, a few HTML-ish tags) into attributed text.
nonisolated struct ReaderRenderer {
    let item: Item
    let style: ReaderStyle
    private var fonts: [String: UIFont] = [:]

    init(item: Item, style: ReaderStyle) {
        self.item = item
        self.style = style
    }

    /// `loaded` is false while the archived copy is still on its way (the header renders first).
    @concurrent static func render(item: Item, markdown: String?, loaded: Bool, style: ReaderStyle) async -> RenderedDocument {
        var r = ReaderRenderer(item: item, style: style)
        return r.document(markdown: markdown ?? "", loaded: loaded)
    }

    // MARK: Document

    private mutating func document(markdown: String, loaded: Bool) -> RenderedDocument {
        let out = NSMutableAttributedString()
        var (body, highlights) = Self.clean(markdown, note: item.note)
        header(into: out, bodyHasImage: !loaded || body.contains("![") || body.contains("<image"))
        let bodyStart = out.length
        if item.isX, body.hasPrefix("[**"), Self.firstLine(body).contains("@") {
            body = Self.dropFirstLine(body)
        }
        if !item.isX, Self.firstLine(body).trimmingCharacters(in: .whitespaces) == item.title.trimmingCharacters(in: .whitespaces), !item.title.isEmpty {
            body = Self.dropFirstLine(body)
        }
        let rendered = blocks(body)
        let hasBody = rendered.length > 0
        if hasBody {
            out.append(rule())
            out.append(rendered)
        } else if !item.excerpt.isEmpty, item.summary.isEmpty || item.excerpt != item.summary {
            out.append(rule())
            out.append(paragraph(inline(item.excerpt.replacingOccurrences(of: "\n", with: "\u{2028}"), font: bodyFont())))
        }
        trimTrailingNewline(out)
        for h in highlights { mark(h.text, in: out, from: bodyStart) }
        return RenderedDocument(text: out, bodyStart: bodyStart, highlights: highlights, hasBody: hasBody)
    }

    // MARK: Header

    private mutating func header(into out: NSMutableAttributedString, bodyHasImage: Bool) {
        let mediaTypes = ["X bookmark", "Post", "Image"]
        let showsCover = item.coverURL != nil && !mediaTypes.contains(item.type) && !["Note", "Audio"].contains(item.type)
        // Pins, posts and images whose archived text has no picture: show the cover at its own shape.
        if mediaTypes.contains(item.type), !bodyHasImage, let cover = item.coverURL {
            let a = ImageAttachment(source: cover, scale: style.scale)
            let s = NSMutableAttributedString(attachment: a)
            s.addAttribute(.paragraphStyle, value: para(after: style.size * 0.9, lineHeight: 1, alignment: .center), range: NSRange(location: 0, length: s.length))
            out.append(s)
            out.append(newline())
        }
        if showsCover, let cover = item.coverURL {
            let a = ImageAttachment(source: cover, scale: style.scale)
            a.showsPlay = item.type == "Video"
            a.fillsWidth = true
            a.coverAspect = 9.0 / 16.0
            let s = NSMutableAttributedString(attachment: a)
            if item.type == "Video", let link = item.link { s.addAttribute(.link, value: link, range: NSRange(location: 0, length: s.length)) }
            s.addAttribute(.paragraphStyle, value: para(after: style.size * 0.9, lineHeight: 1), range: NSRange(location: 0, length: s.length))
            out.append(s)
            out.append(newline())
        }

        // Source: favicon + site, linked to the original.
        if !item.host.isEmpty || !item.url.isEmpty {
            let line = NSMutableAttributedString()
            let small = sans(style.size * 0.74, weight: .semibold)
            if let fav = item.isX ? item.iconURL : item.faviconURL {
                let icon = ImageAttachment(source: fav, scale: style.scale)
                icon.fixedSize = CGSize(width: small.pointSize * 1.15, height: small.pointSize * 1.15)
                icon.cornerRadius = item.isX ? small.pointSize * 0.6 : 3
                icon.baselineOffset = small.descender * 0.9
                line.append(NSAttributedString(attachment: icon))
                line.append(NSAttributedString(string: "  "))
            }
            let host = item.isX ? (item.author.isEmpty ? item.host : item.author) : (item.host.isEmpty ? item.url : item.host)
            var attrs: [NSAttributedString.Key: Any] = [.font: small, .foregroundColor: item.isX ? UIColor.label : UIColor.secondaryLabel, .kern: 0.2]
            if let link = item.link { attrs[.link] = link }
            line.append(NSAttributedString(string: host, attributes: attrs))
            line.addAttribute(.paragraphStyle, value: para(after: style.size * 0.35), range: NSRange(location: 0, length: line.length))
            out.append(line)
            out.append(newline())
        }

        // Title (X bookmarks show the post itself instead).
        if !item.isX {
            let titleFont = serifOrSans(style.size * 1.5, weight: .bold)
            let t = NSMutableAttributedString(string: item.displayTitle, attributes: [.font: titleFont, .foregroundColor: UIColor.label])
            let p = para(after: style.size * 0.45, lineHeight: 1.12)
            t.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: t.length))
            out.append(t)
            out.append(newline())
        }

        // Byline: author · published · length
        var meta: [String] = []
        if !item.isX, !item.author.isEmpty { meta.append(item.author) }
        if let d = item.publishedAt { meta.append(Fmt.longDate(d)) }
        if let len = item.lengthBadge { meta.append(item.type == "Video" || item.type == "Audio" ? len : len.replacingOccurrences(of: " min", with: " min read")) }
        if !meta.isEmpty {
            let m = NSMutableAttributedString(string: meta.joined(separator: "  ·  "), attributes: [.font: sans(style.size * 0.76), .foregroundColor: UIColor.secondaryLabel])
            m.addAttribute(.paragraphStyle, value: para(after: style.size * 0.55), range: NSRange(location: 0, length: m.length))
            out.append(m)
            out.append(newline())
        }

        // Collection and tags, tappable.
        if item.collection != nil || !item.tags.isEmpty {
            let chips = NSMutableAttributedString()
            let f = sans(style.size * 0.76, weight: .medium)
            if let c = item.collection {
                chips.append(symbol("folder.fill", font: f, color: .secondaryLabel))
                chips.append(NSAttributedString(string: "\u{00A0}" + c.replacingOccurrences(of: "/", with: " › "), attributes: [.font: f, .link: Self.route("collection", c), .foregroundColor: UIColor.secondaryLabel]))
            }
            for tag in item.tags {
                if chips.length > 0 { chips.append(NSAttributedString(string: "   ", attributes: [.font: f])) }
                chips.append(NSAttributedString(string: "#\(tag)", attributes: [.font: f, .link: Self.route("tag", tag), .foregroundColor: ReaderColors.accent]))
            }
            chips.addAttribute(.paragraphStyle, value: para(after: style.size * 0.7, lineHeight: 1.35), range: NSRange(location: 0, length: chips.length))
            out.append(chips)
            out.append(newline())
        }

        if item.isBroken {
            let text = item.snapshot || item.archive != nil ? "The original page is gone. Your archived copy is safe." : "The original page is gone."
            out.append(box(icon: "exclamationmark.triangle.fill", iconColor: .systemOrange, text: inline(text, font: sans(style.size * 0.84)), fill: ReaderColors.calloutFill))
        }
        if !item.summary.isEmpty {
            out.append(box(icon: "sparkles", iconColor: ReaderColors.accent, text: inline(item.summary, font: sans(style.size * 0.86)), fill: ReaderColors.accentSoft))
        }
        if !item.note.isEmpty {
            out.append(box(icon: "note.text", iconColor: .secondaryLabel, text: inline(item.note.replacingOccurrences(of: "\n", with: "\u{2028}"), font: serifOrSans(style.size * 0.9)), fill: ReaderColors.calloutFill))
        }
    }

    static func route(_ kind: String, _ value: String) -> URL {
        var c = URLComponents()
        c.scheme = "trove"
        c.host = kind
        c.queryItems = [URLQueryItem(name: "v", value: value)]
        return c.url!
    }

    // MARK: Cleaning

    /// Drop Trove's own footer, raw JSON, the Highlights section (returned separately) and a Note that repeats the item's note.
    static func clean(_ md: String, note: String) -> (String, [HighlightEntry]) {
        var lines = md.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var highlights: [HighlightEntry] = []
        if let h = lines.firstIndex(where: { $0.range(of: #"^#{1,3}\s+Highlights\s*$"#, options: .regularExpression) != nil }) {
            highlights = parseHighlights(Array(lines[(h + 1)...]))
            lines.removeSubrange(h...)
        }
        var out: [String] = []
        var skipping = false
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)
            if skipping {
                if t.hasPrefix("</details>") { skipping = false }
                i += 1
                continue
            }
            if t.hasPrefix("<details") {
                let next = i + 1 < lines.count ? lines[i + 1] : ""
                if (t + next).contains("Raw data") { skipping = !t.contains("</details>"); i += 1; continue }
            }
            let plain = stripTags(t)
            if plain.hasPrefix("Saved with Trove") || plain.hasPrefix("Saved by Trove") || plain.hasPrefix("**Saved with Trove") { i += 1; continue }
            if t == "<empty-block/>" { i += 1; continue }
            out.append(line)
            i += 1
        }
        // A "## Note" that only repeats the note shown above.
        let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !n.isEmpty, let h = out.firstIndex(where: { $0.range(of: #"^#{1,3}\s+Note\s*$"#, options: .regularExpression) != nil }) {
            let rest = out[(h + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if rest.hasPrefix(n) || n.hasPrefix(rest) {
                let consumed = rest.hasPrefix(n) ? String(rest.dropFirst(n.count)) : ""
                out.removeSubrange(h...)
                if !consumed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(contentsOf: consumed.components(separatedBy: "\n")) }
            }
        }
        while let last = out.last, ["", "---", "***"].contains(last.trimmingCharacters(in: .whitespaces)) { out.removeLast() }
        while let first = out.first, ["", "---"].contains(first.trimmingCharacters(in: .whitespaces)) { out.removeFirst() }
        return (out.joined(separator: "\n"), highlights)
    }

    /// Quotes from the "## Highlights" section, each with the note written under it (web/components/reader.tsx).
    static func parseHighlights(_ lines: [String]) -> [HighlightEntry] {
        var out: [HighlightEntry] = []
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t.hasPrefix("#") { continue }
            if t.hasPrefix(">") {
                let q = String(t.drop(while: { $0 == ">" })).trimmingCharacters(in: .whitespaces)
                if !q.isEmpty { out.append(HighlightEntry(text: unescape(stripTags(q)))) }
            } else if !out.isEmpty {
                let n = unescape(stripTags(t))
                out[out.count - 1].note = [out[out.count - 1].note, n].compactMap { $0 }.joined(separator: " ")
            }
        }
        return out
    }

    static func firstLine(_ s: String) -> String {
        stripTags(String(s.prefix { $0 != "\n" }))
    }

    static func dropFirstLine(_ s: String) -> String {
        guard let i = s.firstIndex(of: "\n") else { return "" }
        return String(s[s.index(after: i)...])
    }

    private static let tagRE = try! NSRegularExpression(pattern: #"</?[A-Za-z][A-Za-z0-9_-]*(\s[^<>]*)?/?>"#)

    static func stripTags(_ s: String) -> String {
        guard s.contains("<") else { return s }
        return tagRE.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
    }

    static func unescape(_ s: String) -> String {
        guard s.contains("\\") else { return s }
        var out = ""
        var escaping = false
        for ch in s {
            if escaping { out.append(ch); escaping = false } else if ch == "\\" { escaping = true } else { out.append(ch) }
        }
        return out
    }

    static func attr(_ name: String, in tag: String) -> String? {
        guard let r = tag.range(of: "\(name)=\"") else { return nil }
        let rest = tag[r.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[..<end]).replacingOccurrences(of: "&amp;", with: "&")
    }

    // MARK: Blocks

    private mutating func blocks(_ md: String) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let lines = md.components(separatedBy: "\n")
        var numbers: [Int: Int] = [:]
        var quoteDeco: BlockDecoration?
        var i = 0

        func resetLists(below level: Int = -1) { numbers = numbers.filter { $0.key <= level } }

        while i < lines.count {
            let raw = lines[i]
            let level = raw.prefix { $0 == "\t" }.count
            var line = String(raw.dropFirst(level))
            let t = line.trimmingCharacters(in: .whitespaces)
            i += 1
            if t.isEmpty { continue }
            if !t.hasPrefix(">") { quoteDeco = nil }

            // Code fence
            if t.hasPrefix("```") {
                var code: [String] = []
                while i < lines.count {
                    let l = String(lines[i].dropFirst(min(level, lines[i].prefix { $0 == "\t" }.count)))
                    i += 1
                    if l.trimmingCharacters(in: .whitespaces).hasPrefix("```") { break }
                    code.append(l)
                }
                resetLists()
                out.append(codeBlock(code.joined(separator: "\u{2028}")))
                continue
            }
            if t == "$$" {
                var eq: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    i += 1
                    if l == "$$" { break }
                    eq.append(l)
                }
                out.append(codeBlock(eq.joined(separator: "\u{2028}")))
                continue
            }
            // Callout (single or multi-line)
            if t.hasPrefix("<callout") {
                var content = t
                while !content.contains("</callout>"), i < lines.count {
                    content += "\u{2028}" + lines[i].trimmingCharacters(in: .whitespaces)
                    i += 1
                }
                let icon = Self.attr("icon", in: t)
                var inner = content
                if let open = inner.firstIndex(of: ">") { inner = String(inner[inner.index(after: open)...]) }
                inner = inner.replacingOccurrences(of: "</callout>", with: "")
                inner = inner.trimmingCharacters(in: CharacterSet(charactersIn: "\u{2028} "))
                let text = NSMutableAttributedString()
                if let icon, !icon.hasPrefix("http") { text.append(NSAttributedString(string: icon + "  ", attributes: [.font: bodyFont()])) }
                text.append(inline(inner, font: bodyFont(scale: 0.94)))
                out.append(box(text: text, fill: ReaderColors.calloutFill))
                continue
            }
            // HTML table
            if t.hasPrefix("<table") {
                var html = t
                while !html.contains("</table>"), i < lines.count {
                    html += lines[i].trimmingCharacters(in: .whitespaces)
                    i += 1
                }
                out.append(table(Self.htmlRows(html), header: html.contains("header-row=\"true\"")))
                continue
            }
            // Pipe table
            if t.hasPrefix("|"), t.hasSuffix("|") {
                var rows: [[String]] = [Self.pipeCells(t)]
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard l.hasPrefix("|") else { break }
                    i += 1
                    if l.range(of: #"^\|[\s:|-]+\|$"#, options: .regularExpression) != nil { continue }
                    rows.append(Self.pipeCells(l))
                }
                out.append(table(rows, header: rows.count > 1))
                continue
            }
            // Toggles: keep the summary as a bold line, show what's inside.
            if t.hasPrefix("<details") || t == "</details>" || t.hasPrefix("</summary") { continue }
            if t.hasPrefix("<summary>") {
                let s = t.replacingOccurrences(of: "<summary>", with: "").replacingOccurrences(of: "</summary>", with: "")
                out.append(paragraph(inline("▸ **\(s)**", font: bodyFont()), after: style.size * 0.4))
                continue
            }
            // Layout-only tags
            if t.range(of: #"^</?(columns|column|table_of_contents|synced_block|synced_block_reference)\b[^>]*>$"#, options: .regularExpression) != nil { continue }
            // Media and links
            if let media = mediaBlock(t) {
                resetLists()
                out.append(media)
                continue
            }
            // Image on its own line
            if t.hasPrefix("!["), let close = t.range(of: "](") , t.hasSuffix(")") {
                let alt = String(t[t.index(t.startIndex, offsetBy: 2)..<close.lowerBound])
                let src = String(t[close.upperBound..<t.index(before: t.endIndex)])
                if let url = URL(string: src.trimmingCharacters(in: .whitespaces)) {
                    resetLists()
                    out.append(image(url, caption: Self.unescape(alt)))
                    continue
                }
            }
            // Divider
            if t == "---" || t == "***" || t == "___" {
                resetLists()
                out.append(rule())
                continue
            }
            // Headings
            if t.hasPrefix("#") {
                let hashes = t.prefix { $0 == "#" }.count
                if hashes <= 6, t.dropFirst(hashes).first == " " {
                    resetLists()
                    out.append(heading(String(t.dropFirst(hashes + 1)), level: hashes))
                    continue
                }
            }
            // Quote
            if t.hasPrefix(">") {
                let text = String(t.drop(while: { $0 == ">" })).trimmingCharacters(in: .whitespaces)
                let deco = quoteDeco ?? BlockDecoration(fill: ReaderColors.quoteBar)
                quoteDeco = deco
                out.append(quote(text, deco: deco))
                continue
            }
            // Lists
            if let bullet = Self.listMarker(t) {
                line = String(t.dropFirst(bullet.consumed))
                resetLists(below: level)
                var marker: String
                switch bullet.kind {
                case .bullet: marker = level % 2 == 0 ? "•" : "◦"
                case .todo(let done): marker = done ? "☑︎" : "☐"
                case .number:
                    let n = (numbers[level] ?? 0) + 1
                    numbers[level] = n
                    marker = "\(n)."
                }
                out.append(listItem(line, marker: marker, level: level))
                continue
            }
            resetLists()
            // <page>, <database>, <mention-…> lines become links; everything else is a paragraph.
            out.append(paragraph(inline(t, font: bodyFont())))
        }
        trimTrailingNewline(out)
        return out
    }

    private enum ListKind { case bullet, number, todo(Bool) }

    private static func listMarker(_ t: String) -> (kind: ListKind, consumed: Int)? {
        if t.hasPrefix("- [ ] ") { return (.todo(false), 6) }
        if t.hasPrefix("- [x] ") || t.hasPrefix("- [X] ") { return (.todo(true), 6) }
        if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") { return (.bullet, 2) }
        let digits = t.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count < 4, t.dropFirst(digits.count).hasPrefix(". ") { return (.number, digits.count + 2) }
        return nil
    }

    static func pipeCells(_ line: String) -> [String] {
        line.trimmingCharacters(in: CharacterSet(charactersIn: "| ")).components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static let rowRE = try! NSRegularExpression(pattern: #"<tr[^>]*>(.*?)</tr>"#, options: [.dotMatchesLineSeparators])
    private static let cellRE = try! NSRegularExpression(pattern: #"<t[dh][^>]*>(.*?)</t[dh]>"#, options: [.dotMatchesLineSeparators])

    static func htmlRows(_ html: String) -> [[String]] {
        let ns = html as NSString
        return rowRE.matches(in: html, range: NSRange(location: 0, length: ns.length)).map { row in
            let r = ns.substring(with: row.range(at: 1))
            let rns = r as NSString
            return cellRE.matches(in: r, range: NSRange(location: 0, length: rns.length)).map { rns.substring(with: $0.range(at: 1)).trimmingCharacters(in: .whitespaces) }
        }
    }

    // MARK: Block builders

    private mutating func heading(_ text: String, level: Int) -> NSAttributedString {
        let sizes: [CGFloat] = [1.42, 1.24, 1.1, 1.0, 0.95, 0.9]
        let f = sans(style.size * sizes[min(level, 6) - 1], weight: level <= 2 ? .bold : .semibold)
        let s = inline(text, font: f)
        s.addAttribute(.paragraphStyle, value: para(before: style.size * (level <= 2 ? 1.25 : 0.9), after: style.size * 0.45, lineHeight: 1.15), range: NSRange(location: 0, length: s.length))
        s.append(newline())
        return s
    }

    private mutating func quote(_ text: String, deco: BlockDecoration) -> NSAttributedString {
        let s = inline(text, font: bodyFont(), color: .secondaryLabel)
        let p = para(after: style.size * 0.5, head: 18, first: 18)
        s.addAttributes([.paragraphStyle: p, .troveQuote: deco], range: NSRange(location: 0, length: s.length))
        s.append(newline(.troveQuote, deco))
        return s
    }

    private mutating func listItem(_ text: String, marker: String, level: Int) -> NSAttributedString {
        let f = bodyFont()
        let indent = CGFloat(level) * style.size * 1.3
        let markerWidth = style.size * 1.45
        let s = NSMutableAttributedString(string: marker + "\t", attributes: [.font: f, .foregroundColor: UIColor.secondaryLabel])
        s.append(inline(text, font: f))
        let p = para(after: style.size * 0.32, head: indent + markerWidth, first: indent, tabs: [NSTextTab(textAlignment: .left, location: indent + markerWidth)])
        s.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: s.length))
        s.append(newline())
        return s
    }

    private mutating func codeBlock(_ code: String) -> NSAttributedString {
        let f = UIFont.monospacedSystemFont(ofSize: style.size * 0.78, weight: .regular)
        let deco = BlockDecoration(fill: ReaderColors.codeFill, radius: 10, padding: 12)
        let s = NSMutableAttributedString(string: code.isEmpty ? " " : code, attributes: [.font: f, .foregroundColor: UIColor.label])
        let p = para(before: style.size * 0.9, after: style.size * 1.2, head: 14, first: 14, tail: -14, lineHeight: 1.25)
        s.addAttributes([.paragraphStyle: p, .troveBlock: deco], range: NSRange(location: 0, length: s.length))
        s.append(newline(.troveBlock, deco))
        return s
    }

    private mutating func box(icon: String? = nil, iconColor: UIColor = .secondaryLabel, text: NSAttributedString, fill: UIColor) -> NSAttributedString {
        let deco = BlockDecoration(fill: fill, radius: 12, padding: 12)
        let s = NSMutableAttributedString()
        if let icon {
            let f = (text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont) ?? sans(style.size * 0.86)
            s.append(symbol(icon, font: f, color: iconColor))
            s.append(NSAttributedString(string: "  ", attributes: [.font: f]))
        }
        s.append(text)
        let p = para(before: style.size * 0.75, after: style.size * 1.15, head: 14, first: 14, tail: -14, lineHeight: 1.3)
        s.addAttributes([.paragraphStyle: p, .troveBlock: deco], range: NSRange(location: 0, length: s.length))
        s.append(newline(.troveBlock, deco))
        return s
    }

    private mutating func table(_ rows: [[String]], header: Bool) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let deco = BlockDecoration(fill: ReaderColors.codeFill, radius: 10, padding: 10)
        for (n, row) in rows.enumerated() where !row.allSatisfy(\.isEmpty) {
            let f = sans(style.size * 0.82, weight: header && n == 0 ? .semibold : .regular)
            let line = NSMutableAttributedString()
            for (k, cell) in row.enumerated() {
                if k > 0 { line.append(NSAttributedString(string: "   ·   ", attributes: [.font: f, .foregroundColor: UIColor.tertiaryLabel])) }
                line.append(inline(cell, font: f))
            }
            line.append(NSAttributedString(string: n == rows.count - 1 ? "\n" : "\u{2028}", attributes: [.font: f]))
            out.append(line)
        }
        let p = para(before: style.size * 0.8, after: style.size * 1.1, head: 12, first: 12, tail: -12, lineHeight: 1.35)
        out.addAttributes([.paragraphStyle: p, .troveBlock: deco], range: NSRange(location: 0, length: out.length))
        return out
    }

    private mutating func image(_ url: URL, caption: String) -> NSAttributedString {
        let a = ImageAttachment(source: url, scale: style.scale)
        let s = NSMutableAttributedString(attachment: a)
        s.addAttribute(.paragraphStyle, value: para(before: style.size * 0.4, after: caption.isEmpty ? style.size * 0.9 : style.size * 0.3, lineHeight: 1, alignment: .center), range: NSRange(location: 0, length: s.length))
        s.append(newline())
        if !caption.isEmpty, caption.count < 300 {
            let c = NSMutableAttributedString(string: caption, attributes: [.font: sans(style.size * 0.72), .foregroundColor: UIColor.secondaryLabel])
            c.addAttribute(.paragraphStyle, value: para(after: style.size * 1.0, alignment: .center), range: NSRange(location: 0, length: c.length))
            c.append(newline())
            s.append(c)
        }
        return s
    }

    /// <video>, <audio>, <embed>, <pdf>, <file>, <bookmark>, <page>, <database> lines.
    private mutating func mediaBlock(_ t: String) -> NSAttributedString? {
        guard t.hasPrefix("<") else { return nil }
        let tag = String(t.dropFirst().prefix { $0.isLetter || $0 == "-" || $0 == "_" })
        let src = Self.attr("src", in: t) ?? Self.attr("url", in: t)
        guard let src, let url = URL(string: src) else { return nil }
        let inner = Self.stripTags(t).trimmingCharacters(in: .whitespaces)
        let file = url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent
        let host = Fmt.host(src)
        let (icon, label): (String, String)
        switch tag {
        case "video":
            icon = "play.rectangle.fill"
            label = host.contains("youtube") || host.contains("youtu.be") ? "Watch on YouTube" : host.contains("vimeo") ? "Watch on Vimeo" : "Play video"
        case "audio": (icon, label) = ("waveform", "Play audio")
        case "embed": (icon, label) = ("rectangle.on.rectangle", inner.isEmpty ? host : inner)
        case "pdf": (icon, label) = ("doc.richtext", inner.isEmpty ? file : inner)
        case "file": (icon, label) = ("doc", inner.isEmpty ? file : inner)
        case "bookmark": (icon, label) = ("link", inner.isEmpty ? src.replacingOccurrences(of: "https://", with: "") : inner)
        case "page", "database": (icon, label) = (tag == "page" ? "doc.text" : "tablecells", inner.isEmpty ? "Notion page" : inner)
        case "image":
            return image(url, caption: inner)
        default: return nil
        }
        let f = sans(style.size * 0.86, weight: .medium)
        let text = NSMutableAttributedString(string: label, attributes: [.font: f, .link: url, .foregroundColor: ReaderColors.accent])
        if !host.isEmpty, !["page", "database", "bookmark"].contains(tag), !label.lowercased().contains(host) {
            text.append(NSAttributedString(string: "  ·  " + host, attributes: [.font: sans(style.size * 0.76), .foregroundColor: UIColor.secondaryLabel]))
        }
        return box(icon: icon, iconColor: ReaderColors.accent, text: text, fill: ReaderColors.calloutFill)
    }

    private mutating func paragraph(_ s: NSMutableAttributedString, after: CGFloat? = nil) -> NSAttributedString {
        guard s.length > 0, !s.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return NSAttributedString() }
        s.addAttribute(.paragraphStyle, value: para(after: after ?? style.size * 0.78), range: NSRange(location: 0, length: s.length))
        s.append(newline())
        return s
    }

    private func rule() -> NSAttributedString {
        let p = NSMutableParagraphStyle()
        p.minimumLineHeight = style.size * 1.4
        p.maximumLineHeight = style.size * 1.4
        p.paragraphSpacing = style.size * 0.5
        return NSAttributedString(string: "\u{200B}\n", attributes: [.font: UIFont.systemFont(ofSize: 4), .paragraphStyle: p, .troveRule: true])
    }

    private func newline(_ key: NSAttributedString.Key? = nil, _ value: Any? = nil) -> NSAttributedString {
        var attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: style.size)]
        if let key, let value { attrs[key] = value }
        return NSAttributedString(string: "\n", attributes: attrs)
    }

    private func trimTrailingNewline(_ s: NSMutableAttributedString) {
        while s.length > 0, s.string.hasSuffix("\n") { s.deleteCharacters(in: NSRange(location: s.length - 1, length: 1)) }
    }

    private func symbol(_ name: String, font: UIFont, color: UIColor) -> NSAttributedString {
        let cfg = UIImage.SymbolConfiguration(font: font, scale: .small)
        guard let img = UIImage(systemName: name, withConfiguration: cfg)?.withTintColor(color, renderingMode: .alwaysOriginal) else { return NSAttributedString() }
        let a = NSTextAttachment(image: img)
        a.bounds = CGRect(x: 0, y: (font.capHeight - img.size.height) / 2, width: img.size.width, height: img.size.height)
        return NSAttributedString(attachment: a)
    }

    /// Find a highlight's text in the body and paint it.
    private func mark(_ needle: String, in s: NSMutableAttributedString, from start: Int) {
        let n = needle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard n.count > 8 else { return }
        let probe = String(n.prefix(160))
        let ns = s.string as NSString
        let r = ns.range(of: probe, options: [], range: NSRange(location: start, length: ns.length - start))
        if r.location != NSNotFound { s.addAttribute(.troveMark, value: ReaderColors.mark, range: r) }
    }

    // MARK: Inline

    private static let spanRE = try! NSRegularExpression(pattern: #"<span\b([^>]*)>|</span>"#)
    private static let mentionPageRE = try! NSRegularExpression(pattern: #"<mention-page[^>]*url="([^"]+)"[^>]*>(.*?)</mention-page>"#)
    private static let mentionDateRE = try! NSRegularExpression(pattern: #"<mention-date[^>]*start="([^"]+)"[^>]*/?>(?:</mention-date>)?"#)
    private static let linkDetector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Inline Markdown (bold, italic, code, links, strikethrough) with Notion's color spans, as attributed text.
    mutating func inline(_ source: String, font: UIFont, color: UIColor = .label) -> NSMutableAttributedString {
        var s = source
        if s.contains("<") {
            s = s.replacingOccurrences(of: "<br>", with: "\u{2028}").replacingOccurrences(of: "<br/>", with: "\u{2028}").replacingOccurrences(of: "<br />", with: "\u{2028}")
            s = Self.mentionPageRE.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "[$2]($1)")
            s = Self.mentionDateRE.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "$1")
            s = Self.markSpans(s)
            s = Self.stripTags(s)
        }
        let out = NSMutableAttributedString()
        let options = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        if let parsed = try? AttributedString(markdown: s, options: options) {
            for run in parsed.runs {
                if run.imageURL != nil { continue }
                let text = String(parsed[run.range].characters)
                let intent = run.inlinePresentationIntent ?? []
                var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: color]
                if intent.contains(.code) {
                    attrs[.font] = UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.86, weight: intent.contains(.stronglyEmphasized) ? .semibold : .regular)
                    attrs[.troveMark] = ReaderColors.inlineCode
                } else {
                    attrs[.font] = variant(font, bold: intent.contains(.stronglyEmphasized), italic: intent.contains(.emphasized))
                }
                if intent.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if let link = run.link {
                    attrs[.link] = link
                    attrs[.foregroundColor] = color == .label ? ReaderColors.accent : color
                }
                out.append(NSAttributedString(string: text, attributes: attrs))
            }
        } else {
            out.append(NSAttributedString(string: Self.unescape(s), attributes: [.font: font, .foregroundColor: color]))
        }
        Self.applyGrayMarkers(out)
        Self.autolink(out)
        return out
    }

    /// Gray spans become private-use markers that survive Markdown parsing; other spans are dropped.
    private static func markSpans(_ s: String) -> String {
        guard s.contains("<span") || s.contains("</span>") else { return s }
        let ns = s as NSString
        var out = ""
        var last = 0
        var stack: [Bool] = []
        for m in spanRE.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let tag = ns.substring(with: m.range)
            if tag == "</span>" {
                if stack.popLast() == true { out += "\u{E001}" }
            } else {
                let gray = tag.contains("gray")
                stack.append(gray)
                if gray { out += "\u{E000}" }
            }
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    private static func applyGrayMarkers(_ s: NSMutableAttributedString) {
        guard s.string.contains("\u{E000}") else { return }
        var ns = s.string as NSString
        var open = ns.range(of: "\u{E000}", options: .backwards)
        while open.location != NSNotFound {
            let after = open.location + 1
            let close = ns.range(of: "\u{E001}", options: [], range: NSRange(location: after, length: ns.length - after))
            let end = close.location == NSNotFound ? ns.length : close.location
            s.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: NSRange(location: after, length: end - after))
            if close.location != NSNotFound { s.deleteCharacters(in: close) }
            s.deleteCharacters(in: open)
            ns = s.string as NSString
            open = ns.range(of: "\u{E000}", options: .backwards)
        }
        ns = s.string as NSString
        var stray = ns.range(of: "\u{E001}")
        while stray.location != NSNotFound {
            s.deleteCharacters(in: stray)
            ns = s.string as NSString
            stray = ns.range(of: "\u{E001}")
        }
    }

    private static func autolink(_ s: NSMutableAttributedString) {
        let str = s.string
        guard str.contains("http") || str.contains("www.") else { return }
        for m in linkDetector.matches(in: str, range: NSRange(location: 0, length: (str as NSString).length)) {
            guard let url = m.url, s.attribute(.link, at: m.range.location, effectiveRange: nil) == nil else { continue }
            s.addAttributes([.link: url, .foregroundColor: ReaderColors.accent], range: m.range)
        }
    }

    // MARK: Fonts & paragraphs

    private mutating func cachedFont(_ key: String, _ make: () -> UIFont) -> UIFont {
        if let f = fonts[key] { return f }
        let f = make()
        fonts[key] = f
        return f
    }

    mutating func bodyFont(scale: CGFloat = 1) -> UIFont {
        serifOrSans(style.size * scale)
    }

    mutating func serifOrSans(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let serif = style.serif
        return cachedFont("b\(size)\(weight.rawValue)\(serif)") {
            let base = UIFont.systemFont(ofSize: size, weight: weight)
            guard serif, let d = base.fontDescriptor.withDesign(.serif) else { return base }
            return UIFont(descriptor: d, size: size)
        }
    }

    mutating func sans(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        cachedFont("s\(size)\(weight.rawValue)") { UIFont.systemFont(ofSize: size, weight: weight) }
    }

    private mutating func variant(_ font: UIFont, bold: Bool, italic: Bool) -> UIFont {
        guard bold || italic else { return font }
        return cachedFont("v\(font.fontName)\(font.pointSize)\(bold)\(italic)") {
            var traits = font.fontDescriptor.symbolicTraits
            if bold { traits.insert(.traitBold) }
            if italic { traits.insert(.traitItalic) }
            guard let d = font.fontDescriptor.withSymbolicTraits(traits) else { return font }
            return UIFont(descriptor: d, size: font.pointSize)
        }
    }

    private func para(before: CGFloat = 0, after: CGFloat = 0, head: CGFloat = 0, first: CGFloat = 0, tail: CGFloat = 0,
                      lineHeight: CGFloat = 1.38, alignment: NSTextAlignment = .natural, tabs: [NSTextTab]? = nil) -> NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.paragraphSpacingBefore = before
        p.paragraphSpacing = after
        p.headIndent = head
        p.firstLineHeadIndent = first
        p.tailIndent = tail
        p.lineHeightMultiple = lineHeight
        p.alignment = alignment
        p.lineBreakStrategy = .standard
        p.hyphenationFactor = 0.2
        if let tabs { p.tabStops = tabs }
        return p
    }
}
