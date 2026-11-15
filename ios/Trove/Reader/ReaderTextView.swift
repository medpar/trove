import SwiftUI
import UIKit

// MARK: - Image attachment

/// An image in the reader that loads lazily when it's about to be drawn and keeps no bitmap of its own:
/// the decoded image lives in the shared, size-limited cache, so long image-heavy pages stay light.
nonisolated final class ImageAttachment: NSTextAttachment, @unchecked Sendable {
    let source: URL
    let scale: CGFloat
    var showsPlay = false
    var maxHeightRatio: CGFloat = 1.35
    /// Always span the text width (header covers), instead of stopping at the image's natural size.
    var fillsWidth = false
    /// A header cover: shown as a banner at this height/width ratio (or flatter, to fit the screen), cropped from the center.
    var coverAspect: CGFloat?
    /// Tallest an image may be, in points: a share of the visible height, so landscape keeps the text in view.
    var maxHeightPoints: CGFloat = .greatestFiniteMagnitude

    private var cropAspect: CGFloat? {
        guard let coverAspect else { return nil }
        return min(coverAspect, max(0.25, maxHeightPoints / max(decodeWidth, 1)))
    }
    var fixedSize: CGSize?
    var cornerRadius: CGFloat = 10
    var baselineOffset: CGFloat = 0

    private(set) var aspect: CGFloat?
    private(set) var naturalWidth: CGFloat?
    private(set) var failed = false
    private var loading = false
    private(set) var decodeWidth: CGFloat = 0
    var characterIndex = NSNotFound
    weak var host: ReaderTextView?

    private static let blank: UIImage = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in }

    init(source: URL, scale: CGFloat) {
        self.source = source
        self.scale = scale
        super.init(data: nil, ofType: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var mode: ImagePipeline.Mode {
        if let fixedSize { return .fill(fixedSize) }
        if let cropAspect { return .crop(CGSize(width: max(decodeWidth, 1), height: (max(decodeWidth, 1) * cropAspect).rounded())) }
        return .fit(width: max(decodeWidth, 1))
    }

    var cachedImage: UIImage? {
        guard fixedSize != nil || decodeWidth > 0 else { return nil }
        return ImagePipeline.shared.cached(source, mode, scale: scale, cornerRadius: cornerRadius)
    }

    var isPlaceholder: Bool { fixedSize == nil && !failed && cachedImage == nil }

    override func attachmentBounds(for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect, glyphPosition position: CGPoint, characterIndex charIndex: Int) -> CGRect {
        characterIndex = charIndex
        if let fixedSize { return CGRect(x: 0, y: baselineOffset, width: fixedSize.width, height: fixedSize.height) }
        if failed { return CGRect(x: 0, y: 0, width: 1, height: 1) }
        let available = max(lineFrag.width, 40)
        decodeWidth = available.rounded(.down)
        if let cropAspect { return CGRect(x: 0, y: 0, width: available.rounded(), height: (available * cropAspect).rounded()) }
        var w = available
        if !fillsWidth, let nw = naturalWidth, nw < w { w = nw }
        let a = aspect ?? 0.5625
        var h = w * a
        let maxH = min(available * maxHeightRatio, maxHeightPoints)
        if h > maxH {
            h = maxH
            w = min(available, h / a)
        }
        return CGRect(x: 0, y: 0, width: w.rounded(), height: h.rounded())
    }

    override func image(forBounds imageBounds: CGRect, textContainer: NSTextContainer?, characterIndex charIndex: Int) -> UIImage? {
        characterIndex = charIndex
        if let img = cachedImage { return img }
        load()
        return Self.blank
    }

    func load() {
        guard !loading, !failed, fixedSize != nil || decodeWidth > 0 else { return }
        loading = true
        let source = source, mode = mode, scale = scale, radius = cornerRadius
        let box = WeakAttachment(self)
        Task { @MainActor in
            let image = await ImagePipeline.shared.image(source, mode, scale: scale, cornerRadius: radius)
            box.value?.finishLoad(image)
        }
    }

    @MainActor private func finishLoad(_ image: UIImage?) {
        loading = false
        guard let image else {
            failed = true
            host?.attachmentDidLoad(self, sizeChanged: fixedSize == nil)
            return
        }
        let oldAspect = aspect, oldNatural = naturalWidth
        if fixedSize == nil, cropAspect == nil {
            aspect = image.size.height / max(image.size.width, 1)
            naturalWidth = image.size.width
        }
        host?.attachmentDidLoad(self, sizeChanged: fixedSize == nil && cropAspect == nil && (oldAspect != aspect || oldNatural != naturalWidth))
    }
}

/// Lets a loading task refer back to its attachment without keeping it alive.
nonisolated struct WeakAttachment: @unchecked Sendable {
    weak var value: ImageAttachment?
    init(_ value: ImageAttachment) { self.value = value }
}

// MARK: - Layout manager

/// Draws what attributed text can't: rounded block backgrounds, quote bars, rules, image placeholders and play buttons.
nonisolated final class ReaderLayoutManager: NSLayoutManager {
    var hairline: CGFloat = 0.5

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first, storage.length > 0 else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        let all = NSRange(location: 0, length: storage.length)
        var drawn = Set<ObjectIdentifier>()

        storage.enumerateAttribute(.troveBlock, in: chars) { value, range, _ in
            guard let deco = value as? BlockDecoration, drawn.insert(ObjectIdentifier(deco)).inserted else { return }
            var full = NSRange()
            _ = storage.attribute(.troveBlock, at: range.location, longestEffectiveRange: &full, in: all)
            guard var rect = usedRect(forCharacters: full) else { return }
            rect.origin.x = 0
            rect.size.width = container.size.width
            rect = rect.insetBy(dx: 0, dy: -deco.padding).offsetBy(dx: origin.x, dy: origin.y)
            deco.fill.setFill()
            UIBezierPath(roundedRect: rect, cornerRadius: deco.radius).fill()
        }

        storage.enumerateAttribute(.troveQuote, in: chars) { value, range, _ in
            guard let deco = value as? BlockDecoration, drawn.insert(ObjectIdentifier(deco)).inserted else { return }
            var full = NSRange()
            _ = storage.attribute(.troveQuote, at: range.location, longestEffectiveRange: &full, in: all)
            guard let rect = usedRect(forCharacters: full) else { return }
            let bar = CGRect(x: origin.x + 2, y: origin.y + rect.minY + 2, width: 3, height: max(rect.height - 4, 4))
            deco.fill.setFill()
            UIBezierPath(roundedRect: bar, cornerRadius: 1.5).fill()
        }

        storage.enumerateAttribute(.troveRule, in: chars) { value, range, _ in
            guard value != nil, let rect = usedRect(forCharacters: range, fragment: true) else { return }
            let y = origin.y + rect.midY
            UIColor.separator.setFill()
            UIRectFill(CGRect(x: origin.x, y: y, width: container.size.width, height: hairline))
        }

        storage.enumerateAttribute(.troveMark, in: chars) { value, range, _ in
            guard let color = value as? UIColor else { return }
            color.setFill()
            for r in tightRects(forCharacters: range, in: storage) {
                UIBezierPath(roundedRect: r.offsetBy(dx: origin.x, dy: origin.y), cornerRadius: 4).fill()
            }
        }

        storage.enumerateAttribute(.troveSpoken, in: chars) { value, range, _ in
            guard value != nil else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            ReaderColors.spoken.setFill()
            enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { r, _ in
                UIBezierPath(roundedRect: r.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -2, dy: 0), cornerRadius: 4).fill()
            }
        }

        storage.enumerateAttribute(.attachment, in: chars) { value, range, _ in
            guard let a = value as? ImageAttachment, a.isPlaceholder, let rect = attachmentRect(at: range.location) else { return }
            UIColor.secondarySystemFill.setFill()
            UIBezierPath(roundedRect: rect.offsetBy(dx: origin.x, dy: origin.y), cornerRadius: a.cornerRadius).fill()
        }
    }

    override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, storage.length > 0 else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        storage.enumerateAttribute(.attachment, in: chars) { value, range, _ in
            guard let a = value as? ImageAttachment, a.showsPlay, let rect = attachmentRect(at: range.location) else { return }
            let r = rect.offsetBy(dx: origin.x, dy: origin.y)
            let d: CGFloat = 58
            let circle = CGRect(x: r.midX - d / 2, y: r.midY - d / 2, width: d, height: d)
            UIColor.black.withAlphaComponent(0.45).setFill()
            UIBezierPath(ovalIn: circle).fill()
            let tri = UIBezierPath()
            tri.move(to: CGPoint(x: circle.midX - 8, y: circle.midY - 12))
            tri.addLine(to: CGPoint(x: circle.midX + 14, y: circle.midY))
            tri.addLine(to: CGPoint(x: circle.midX - 8, y: circle.midY + 12))
            tri.close()
            UIColor.white.setFill()
            tri.fill()
        }
    }

    /// Per-line rects that hug the glyphs of a run (font ascender to descender), not the whole line height.
    private func tightRects(forCharacters range: NSRange, in storage: NSTextStorage) -> [CGRect] {
        guard let container = textContainers.first else { return [] }
        let font = (storage.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont) ?? UIFont.systemFont(ofSize: 17)
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var out: [CGRect] = []
        enumerateLineFragments(forGlyphRange: glyphs) { frag, _, _, lineGlyphs, _ in
            let part = NSIntersectionRange(lineGlyphs, glyphs)
            guard part.length > 0 else { return }
            var box = self.boundingRect(forGlyphRange: part, in: container)
            let baseline = frag.minY + self.location(forGlyphAt: part.location).y
            box.origin.y = baseline - font.ascender - 1.5
            box.size.height = font.ascender - font.descender + 3
            out.append(box.insetBy(dx: -2.5, dy: 0))
        }
        return out
    }

    /// Union of the used rects of the lines holding these characters (no paragraph spacing).
    private func usedRect(forCharacters range: NSRange, fragment: Bool = false) -> CGRect? {
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        guard glyphs.length > 0 else { return nil }
        var union: CGRect?
        enumerateLineFragments(forGlyphRange: glyphs) { rect, used, _, _, _ in
            let r = fragment ? rect : used
            union = union.map { $0.union(r) } ?? r
        }
        return union
    }

    func attachmentRect(at charIndex: Int) -> CGRect? {
        let glyph = glyphIndexForCharacter(at: charIndex)
        guard glyph < numberOfGlyphs else { return nil }
        let size = attachmentSize(forGlyphAt: glyph)
        guard size.width > 1, size.height > 1 else { return nil }
        let frag = lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let loc = location(forGlyphAt: glyph)
        return CGRect(x: frag.minX + loc.x, y: frag.minY + loc.y - size.height, width: size.width, height: size.height)
    }
}

// MARK: - Text view

final class ReaderTextView: UITextView {
    let readerLayout: ReaderLayoutManager
    static let maxReadableWidth: CGFloat = 680
    private var spokenRange: NSRange?

    init() {
        let storage = NSTextStorage()
        let layout = ReaderLayoutManager()
        layout.allowsNonContiguousLayout = true
        layout.usesFontLeading = true
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        readerLayout = layout
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isScrollEnabled = true
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        backgroundColor = .systemBackground
        dataDetectorTypes = []
        adjustsFontForContentSizeCategory = false
        linkTextAttributes = [:]
        contentInsetAdjustmentBehavior = .automatic
        textContainerInset = UIEdgeInsets(top: 16, left: 20, bottom: 72, right: 20)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = max(20, ((bounds.width - Self.maxReadableWidth) / 2).rounded())
        if abs(textContainerInset.left - side) > 0.5 {
            textContainerInset = UIEdgeInsets(top: 16, left: side, bottom: 72, right: side)
        }
        updateImageCap()
    }

    private var imageCap: CGFloat = 0

    /// Images may take at most ~60% of what's visible (matters in landscape).
    private var currentImageCap: CGFloat {
        let visible = bounds.height > 0 ? bounds.height - adjustedContentInset.top - adjustedContentInset.bottom : (window?.windowScene?.screen.bounds.height ?? 800)
        return max(180, (visible * 0.6).rounded())
    }

    func install(_ doc: RenderedDocument) {
        textStorage.setAttributedString(doc.text)
        spokenRange = nil
        imageCap = currentImageCap
        let cap = imageCap
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, _, _ in
            guard let a = value as? ImageAttachment else { return }
            a.host = self
            if a.fixedSize == nil { a.maxHeightPoints = cap }
        }
    }

    /// After a rotation or resize, re-cap image heights and lay them out again.
    private func updateImageCap() {
        let cap = currentImageCap
        guard abs(cap - imageCap) > 1, textStorage.length > 0 else { return }
        imageCap = cap
        var touched = false
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, _, _ in
            guard let a = value as? ImageAttachment, a.fixedSize == nil else { return }
            a.maxHeightPoints = cap
            touched = true
        }
        if touched { readerLayout.invalidateLayout(forCharacterRange: NSRange(location: 0, length: textStorage.length), actualCharacterRange: nil) }
    }

    /// An image finished loading: lay it out at its real size, keeping what you're reading in place.
    func attachmentDidLoad(_ a: ImageAttachment, sizeChanged: Bool) {
        guard let index = locate(a) else { return }
        let range = NSRange(location: index, length: 1)
        if sizeChanged {
            let before = readerLayout.attachmentRect(at: index)
            let visibleTop = contentOffset.y + adjustedContentInset.top
            readerLayout.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
            readerLayout.ensureLayout(forCharacterRange: range)
            if let before, before.maxY + textContainerInset.top < visibleTop, let after = readerLayout.attachmentRect(at: index) {
                contentOffset.y += after.height - before.height
            }
        }
        readerLayout.invalidateDisplay(forCharacterRange: range)
    }

    private func locate(_ a: ImageAttachment) -> Int? {
        let i = a.characterIndex
        if i != NSNotFound, i < textStorage.length, textStorage.attribute(.attachment, at: i, effectiveRange: nil) as AnyObject? === a { return i }
        var found: Int?
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, range, stop in
            if value as AnyObject? === a { found = range.location; stop.pointee = true }
        }
        return found
    }

    func highlight(_ range: NSRange) {
        guard NSMaxRange(range) <= textStorage.length else { return }
        textStorage.addAttribute(.troveMark, value: ReaderColors.mark, range: range)
    }

    /// Paint the sentence being read aloud and keep it on screen.
    func setSpoken(_ range: NSRange?) {
        if let old = spokenRange, NSMaxRange(old) <= textStorage.length {
            textStorage.removeAttribute(.troveSpoken, range: old)
            readerLayout.invalidateDisplay(forCharacterRange: old)
        }
        spokenRange = range
        guard let range, NSMaxRange(range) <= textStorage.length else { return }
        textStorage.addAttribute(.troveSpoken, value: true, range: range)
        readerLayout.invalidateDisplay(forCharacterRange: range)
        let glyphs = readerLayout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = readerLayout.boundingRect(forGlyphRange: glyphs, in: textContainer)
        rect.origin.y += textContainerInset.top
        let visible = CGRect(x: 0, y: contentOffset.y + adjustedContentInset.top, width: bounds.width, height: bounds.height - adjustedContentInset.top - adjustedContentInset.bottom)
        if !visible.insetBy(dx: 0, dy: 60).contains(CGPoint(x: visible.midX, y: rect.midY)) {
            let target = max(-adjustedContentInset.top, min(rect.minY - visible.height * 0.3, contentSize.height - bounds.height + adjustedContentInset.bottom))
            setContentOffset(CGPoint(x: 0, y: target), animated: true)
        }
    }

    var progress: Double {
        let h = contentSize.height
        guard h > 0 else { return 0 }
        let seen = contentOffset.y + bounds.height - adjustedContentInset.bottom
        return max(0, min(100, seen / h * 100))
    }

    func scroll(toProgress p: Double) {
        readerLayout.ensureLayout(for: textContainer)
        layoutIfNeeded()
        let h = contentSize.height
        let target = h * p / 100 - bounds.height * 0.66
        let maxY = max(-adjustedContentInset.top, h - bounds.height + adjustedContentInset.bottom)
        contentOffset.y = max(-adjustedContentInset.top, min(target, maxY))
    }
}

// MARK: - SwiftUI bridge

struct ReaderView: UIViewRepresentable {
    let document: RenderedDocument
    let documentID: String
    var initialProgress: Double?
    var spoken: NSRange?
    var onProgress: (Double) -> Void
    var onLink: (URL) -> Void
    var onImage: (URL) -> Void
    var onHighlight: (String, Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ReaderTextView {
        let view = ReaderTextView()
        view.delegate = context.coordinator
        context.coordinator.textView = view
        // Taps on images open the viewer (text items only report links reliably).
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: ReaderTextView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if c.installedID != documentID || c.installed !== document {
            let sameItem = c.installedID == documentID
            let offset = view.contentOffset
            c.installedID = documentID
            c.installed = document
            view.install(document)
            if sameItem {
                view.layoutIfNeeded()
                view.contentOffset = offset
            } else if let p = DevHooks.readerScroll ?? initialProgress, p > 3, p < 97 {
                DispatchQueue.main.async { view.scroll(toProgress: p) }
            } else {
                view.contentOffset = CGPoint(x: 0, y: -view.adjustedContentInset.top)
            }
        }
        if c.spoken != spoken {
            c.spoken = spoken
            view.setSpoken(spoken)
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: ReaderView
        weak var textView: ReaderTextView?
        var installedID: String?
        var installed: RenderedDocument?
        var spoken: NSRange?
        private var lastReported: Double = -10

        init(_ parent: ReaderView) { self.parent = parent }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let tv = textView, tv.selectedRange.length == 0, tv.textStorage.length > 0 else { return }
            var p = g.location(in: tv)
            p.x -= tv.textContainerInset.left
            p.y -= tv.textContainerInset.top
            let layout = tv.readerLayout
            let glyph = layout.glyphIndex(for: p, in: tv.textContainer, fractionOfDistanceThroughGlyph: nil)
            let index = layout.characterIndexForGlyph(at: glyph)
            guard index < tv.textStorage.length,
                  let image = tv.textStorage.attribute(.attachment, at: index, effectiveRange: nil) as? ImageAttachment,
                  image.fixedSize == nil, !image.showsPlay,
                  let rect = layout.attachmentRect(at: index), rect.insetBy(dx: -4, dy: -4).contains(p) else { return }
            parent.onImage(image.source)
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard let tv = textView, tv.isTracking || tv.isDecelerating || tv.isDragging else { return }
            let p = tv.progress
            if abs(p - lastReported) >= 1 {
                lastReported = p
                parent.onProgress(p)
            }
        }

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            switch textItem.content {
            case .link(let url):
                return UIAction { [weak self] _ in self?.parent.onLink(url) }
            case .textAttachment(let a):
                guard let image = a as? ImageAttachment, image.fixedSize == nil else { return nil }
                return UIAction { [weak self] _ in self?.parent.onImage(image.source) }
            default:
                return defaultAction
            }
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard range.length > 2 else { return UIMenu(children: suggestedActions) }
            let text = (textView.textStorage.string as NSString).substring(with: range)
                .replacingOccurrences(of: "\u{FFFC}", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count > 2 else { return UIMenu(children: suggestedActions) }
            let highlight = UIAction(title: "Highlight", image: UIImage(systemName: "highlighter")) { [weak self] _ in
                self?.textView?.highlight(range)
                self?.textView?.selectedRange = NSRange(location: range.location, length: 0)
                self?.parent.onHighlight(text, false)
            }
            let note = UIAction(title: "Highlight with Note", image: UIImage(systemName: "note.text.badge.plus")) { [weak self] _ in
                self?.textView?.highlight(range)
                self?.parent.onHighlight(text, true)
            }
            return UIMenu(children: [highlight, note] + suggestedActions)
        }
    }
}
