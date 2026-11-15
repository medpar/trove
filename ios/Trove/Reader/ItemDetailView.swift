import SwiftUI

/// The reading view: header, summary, note and the archived content, with the item's actions.
struct ItemDetailView: View {
    let id: String
    let seed: Item?

    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @Environment(\.displayScale) private var displayScale
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage("readerSize") private var readerSize: Double = 18
    @AppStorage("readerSerif") private var readerSerif = true
    @AppStorage("markReadAtEnd") private var markReadAtEnd = true

    @State private var item: Item?
    @State private var markdown: String?
    @State private var contentLoaded = false
    @State private var loadError: String?
    @State private var version = 0
    @State private var document: RenderedDocument?
    @State private var speech = SpeechController()
    @State private var noteFor: String?
    @State private var noteText = ""
    @State private var confirmDelete = false
    @State private var busy: String?
    @State private var progress: Double = 0
    @State private var savedProgress: Double = 0

    private struct RenderKey: Hashable {
        var item: Item?
        var version: Int
        var size: Double
        var serif: Bool
        var scale: CGFloat
        var typeSize: DynamicTypeSize
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            if let document, let item {
                ReaderView(
                    document: document,
                    documentID: item.id,
                    initialProgress: item.progress,
                    spoken: speech.spoken,
                    onProgress: trackProgress,
                    onLink: openLink,
                    onImage: { router.sheet = .image($0) },
                    onHighlight: { text, withNote in
                        if withNote {
                            noteText = ""
                            noteFor = text
                        } else {
                            Task { await library.addHighlight(item, text: text, note: nil) }
                        }
                    }
                )
                .ignoresSafeArea(edges: .bottom)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Couldn’t open this item", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Try Again") { Task { await load() } }.buttonStyle(.bordered)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            VStack(spacing: 10) {
                if document != nil, !contentLoaded, loadError == nil {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading the archived copy…").font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.regularMaterial, in: Capsule())
                    .transition(.opacity)
                }
                if speech.state != .idle { listenBar }
            }
            .padding(.bottom, 16)
            .animation(.snappy, value: speech.state)
            .animation(.easeOut, value: contentLoaded)
        }
        .background(Color(.systemBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task(id: id) {
            await load()
            await runDevAction()
        }
        .task(id: RenderKey(item: item, version: version, size: readerSize, serif: readerSerif, scale: displayScale, typeSize: dynamicTypeSize)) { await render() }
        .onChange(of: library.revisions[id]) { _, latest in
            if let latest, latest != item { item = latest }
        }
        .onDisappear {
            speech.stop()
            flushProgress()
        }
        .alert("Add a note to this highlight", isPresented: Binding(get: { noteFor != nil }, set: { if !$0 { noteFor = nil } })) {
            TextField("Your note", text: $noteText, axis: .vertical)
            Button("Cancel", role: .cancel) { noteFor = nil }
            Button("Save") {
                if let text = noteFor, let item { Task { await library.addHighlight(item, text: text, note: noteText) } }
                noteFor = nil
            }
        } message: {
            Text(String((noteFor ?? "").prefix(140)))
        }
        .confirmationDialog("Delete this item?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Move to Trash", role: .destructive) {
                guard let item else { return }
                Task {
                    if await library.delete(item) {
                        if router.selectedID == item.id {
                            router.selectedID = nil
                            router.compactColumn = .content
                        } else {
                            dismiss()
                        }
                    }
                }
            }
        } message: {
            Text("It goes to Notion’s trash, where you can restore it.")
        }
    }

    // MARK: Loading

    private func load() async {
        loadError = nil
        if let cached = library.cachedContent(id) {
            item = cached.item
            markdown = cached.markdown
            contentLoaded = true
            version += 1
        } else if item == nil {
            item = seed
        }
        savedProgress = item?.progress ?? 0
        do {
            let c = try await library.content(id)
            item = c.item
            markdown = c.markdown
            contentLoaded = true
            version += 1
            savedProgress = c.item.progress ?? 0
        } catch is CancellationError {
        } catch {
            if item == nil {
                loadError = error.localizedDescription
            } else if !contentLoaded {
                contentLoaded = true
                library.report(error, "Couldn’t load the archived copy")
            }
        }
    }

    private func render() async {
        guard let item else { return }
        // The reader's own size setting, scaled like body text for people who use larger (or smaller) Dynamic Type.
        let size = min(UIFontMetrics(forTextStyle: .body).scaledValue(for: CGFloat(readerSize)), CGFloat(readerSize) * 1.8)
        let style = ReaderStyle(size: size.rounded(), serif: readerSerif, scale: displayScale)
        let doc = await ReaderRenderer.render(item: item, markdown: contentLoaded ? markdown : nil, style: style)
        guard !Task.isCancelled else { return }
        document = doc
    }

    private func set(_ updated: Item?) {
        if let updated { item = updated }
    }

    /// Debug-only: drive actions from launch hooks to check their UI in the simulator.
    private func runDevAction() async {
        guard let action = DevHooks.value("ACTION"), let item else { return }
        try? await Task.sleep(for: .milliseconds(900))
        switch action {
        case "favorite": toggleFavorite()
        case "read": toggleRead()
        case "listen":
            if let s = document?.speakableText { speech.play(text: s.text, offset: s.offset) }
        case "highlight":
            if let doc = document, doc.hasBody {
                let ns = doc.text.string as NSString
                let start = min(doc.bodyStart + 40, ns.length - 1)
                let text = ns.substring(with: NSRange(location: start, length: min(60, ns.length - start)))
                _ = await library.addHighlight(item, text: text, note: nil)
                await load()
            }
        case "delete": confirmDelete = true
        default: break
        }
    }

    // MARK: Progress

    private func trackProgress(_ p: Double) {
        progress = p
        guard let item, contentLoaded, document?.hasBody == true else { return }
        let done = p >= 97
        if abs(p - savedProgress) >= 10 || (done && savedProgress < 97) {
            savedProgress = p
            let markRead = done && !item.read && markReadAtEnd
            var patch: [String: JSONValue] = ["progress": .number(p.rounded())]
            if markRead { patch["read"] = .bool(true) }
            Task {
                if markRead {
                    set(await library.update(item, server: patch) { $0.read = true; $0.progress = p.rounded() })
                } else if let api = library.api {
                    _ = try? await api.update(item.id, patch)
                }
            }
        }
    }

    private func flushProgress() {
        guard let item, let api = library.api, contentLoaded, progress > 0, abs(progress - savedProgress) >= 2 else { return }
        let p = progress.rounded()
        Task { _ = try? await api.update(item.id, ["progress": .number(p)]) }
    }

    // MARK: Actions

    private func openLink(_ url: URL) {
        if router.handle(route: url) { return }
        LinkOpener.open(url)
    }

    private func toggleFavorite() {
        guard let item else { return }
        Task { set(await library.update(item, server: ["favorite": .bool(!item.favorite)]) { $0.favorite.toggle() }) }
    }

    private func toggleRead() {
        guard let item else { return }
        Task { set(await library.update(item, server: ["read": .bool(!item.read)]) { $0.read.toggle() }) }
    }

    private func enrich(_ what: String) {
        guard let item, let api = library.api else { return }
        busy = what
        Task {
            defer { busy = nil }
            do {
                let r = try await api.enrich(item.id)
                library.propagate(r.item)
                self.item = r.item
                if what == "summary", r.item.summary.isEmpty {
                    library.show(Toast(text: r.skipped?.first.map { "No summary: \($0)" } ?? "Nothing to summarize", systemImage: "sparkles"))
                } else if what == "archive", !r.item.snapshot, r.item.archive == nil {
                    library.show(Toast(text: r.errors?.first.map { "Couldn’t archive: \($0)" } ?? "This page couldn’t be archived", systemImage: "building.columns", isError: true))
                } else {
                    library.show(Toast(text: what == "summary" ? "Summary ready" : "Page archived", systemImage: what == "summary" ? "sparkles" : "building.columns"))
                }
            } catch {
                library.report(error, "Failed")
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if let item {
            if sizeClass == .compact {
                ToolbarItemGroup(placement: .topBarTrailing) { moreMenu(item) }
                ToolbarItemGroup(placement: .bottomBar) {
                    readButton(item)
                    favoriteButton(item)
                    editButton(item)
                    Spacer()
                    shareButton(item)
                    openButton(item)
                }
            } else {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    readButton(item)
                    favoriteButton(item)
                    editButton(item)
                    shareButton(item)
                    openButton(item)
                    moreMenu(item)
                }
            }
        }
    }

    private func readButton(_ item: Item) -> some View {
        Button(action: toggleRead) {
            Label(item.read ? "Mark as Unread" : "Mark as Read", systemImage: item.read ? "checkmark.circle.fill" : "checkmark.circle")
                .contentTransition(.symbolEffect(.replace))
        }
        .tint(item.read ? .green : nil)
    }

    private func favoriteButton(_ item: Item) -> some View {
        Button(action: toggleFavorite) {
            Label(item.favorite ? "Remove Favorite" : "Favorite", systemImage: item.favorite ? "heart.fill" : "heart")
                .contentTransition(.symbolEffect(.replace))
        }
        .symbolEffect(.bounce, value: item.favorite)
        .sensoryFeedback(.impact(weight: .light), trigger: item.favorite)
    }

    private func editButton(_ item: Item) -> some View {
        Button { router.sheet = .edit(item) } label: { Label("Edit Details", systemImage: "tag") }
    }

    @ViewBuilder private func shareButton(_ item: Item) -> some View {
        if let link = item.link ?? item.notionLink {
            ShareLink(item: link, subject: Text(item.displayTitle)) { Label("Share", systemImage: "square.and.arrow.up") }
        }
    }

    @ViewBuilder private func openButton(_ item: Item) -> some View {
        if let link = item.link {
            Button { LinkOpener.open(link) } label: { Label("Open Original", systemImage: "safari") }
                .keyboardShortcut("o", modifiers: .command)
        }
    }

    private func moreMenu(_ item: Item) -> some View {
        Menu {
            Section {
                ControlGroup {
                    Button { readerSize = max(14, readerSize - 1) } label: { Label("Smaller", systemImage: "textformat.size.smaller") }
                    Button { readerSize = min(28, readerSize + 1) } label: { Label("Larger", systemImage: "textformat.size.larger") }
                }
                Toggle(isOn: $readerSerif) { Label("Serif Font", systemImage: "character.book.closed") }
                if let doc = document, doc.text.length > 0 {
                    Button {
                        let s = doc.speakableText
                        speech.play(text: s.text, offset: s.offset)
                    } label: { Label(speech.state == .idle ? "Listen" : "Pause Listening", systemImage: "headphones") }
                }
            }
            Section {
                let count = document?.highlights.count ?? item.highlights
                Button { router.sheet = .highlights(item, document?.highlights ?? []) } label: {
                    Label(count > 0 ? "Highlights (\(count))" : "Highlights", systemImage: "highlighter")
                }
                Button { router.sheet = .related(item) } label: { Label("Related Items", systemImage: "point.3.connected.trianglepath.dotted") }
                if item.snapshot {
                    Button { router.sheet = .snapshot(item) } label: { Label("Web Archive", systemImage: "building.columns") }
                }
                if let wayback = item.archive.flatMap(URL.init(string:)) {
                    Button { LinkOpener.open(wayback) } label: { Label("Wayback Machine", systemImage: "clock.arrow.circlepath") }
                }
                if item.summary.isEmpty {
                    Button { enrich("summary") } label: { Label(busy == "summary" ? "Summarizing…" : "Summarize", systemImage: "sparkles") }
                        .disabled(busy != nil)
                }
                if item.canArchive, !item.snapshot {
                    Button { enrich("archive") } label: { Label(busy == "archive" ? "Archiving…" : "Archive This Page", systemImage: "arrow.down.doc") }
                        .disabled(busy != nil)
                }
            }
            Section {
                if let link = item.link {
                    Button { UIPasteboard.general.url = link; library.show(Toast(text: "Link copied", systemImage: "link")) } label: { Label("Copy Link", systemImage: "link") }
                }
                if let notion = item.notionLink {
                    Button { UIApplication.shared.open(notion) } label: { Label("Open in Notion", systemImage: "arrow.up.forward.app") }
                }
                Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
    }

    private var listenBar: some View {
        HStack(spacing: 16) {
            Image(systemName: "headphones")
                .foregroundStyle(Color.accentColor)
            Button { speech.cycleRate() } label: {
                Text(speech.rate == 1 ? "1×" : "\(speech.rate.formatted(.number.precision(.fractionLength(0...2))))×")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .frame(minWidth: 40)
            }
            Button {
                if let s = document?.speakableText { speech.play(text: s.text, offset: s.offset) }
            } label: {
                Image(systemName: speech.state == .playing ? "pause.fill" : "play.fill")
                    .font(.title3)
                    .contentTransition(.symbolEffect(.replace))
            }
            .accessibilityLabel(speech.state == .playing ? "Pause" : "Resume")
            Button { speech.stop() } label: { Image(systemName: "xmark").font(.subheadline.weight(.semibold)) }
                .accessibilityLabel("Stop listening")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 5)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
