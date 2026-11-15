import SwiftUI

/// Latest posts from the feeds you follow; saving one adds it to the library.
struct FeedsView: View {
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @State private var feeds: [Feed] = []
    @State private var entries: [FeedEntry] = []
    @State private var feedID: String?
    @State private var loading = true
    @State private var error: String?
    @State private var saved: [String: Item] = [:]
    @State private var saving: Set<String> = []

    var body: some View {
        Group {
            if loading && entries.isEmpty {
                SkeletonList()
            } else if let error, entries.isEmpty {
                ContentUnavailableView {
                    Label("Couldn’t load feeds", systemImage: "wifi.exclamationmark")
                } description: { Text(error) } actions: {
                    Button("Try Again") { Task { await load() } }.buttonStyle(.bordered)
                }
            } else if feeds.isEmpty {
                ContentUnavailableView {
                    Label("Follow sites, newsletters and channels", systemImage: "dot.radiowaves.up.forward")
                } description: {
                    Text("Add a blog, a Substack, a YouTube channel or any RSS feed. New posts wait here until you save them.")
                } actions: {
                    Button("Add a Feed") { router.sheet = .manageFeeds }.buttonStyle(.borderedProminent)
                }
            } else {
                list
            }
        }
        .navigationTitle(feedID.flatMap { id in feeds.first { $0.id == id }?.title } ?? "Feeds")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { router.sheet = .manageFeeds } label: { Label("Manage Feeds", systemImage: "slider.horizontal.3") }
            }
        }
        .task(id: feedID) { await load() }
        .refreshable { await load() }
        .onChange(of: router.sheet == nil) { _, closed in if closed { Task { await load() } } }
    }

    private var list: some View {
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        chip(nil, title: "All")
                        ForEach(feeds) { f in chip(f.id, title: f.title, error: f.error != nil) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
            }
            ForEach(entries) { entry in
                FeedEntryRow(entry: entry, saved: saved[entry.id] != nil, saving: saving.contains(entry.id)) { save(entry) }
                    .contentShape(Rectangle())
                    .onTapGesture { if let u = URL(string: entry.url) { LinkOpener.open(u) } }
                    .swipeActions(edge: .trailing) {
                        if saved[entry.id] == nil {
                            Button { save(entry) } label: { Label("Save", systemImage: "plus") }.tint(.accentColor)
                        }
                    }
                    .contextMenu {
                        if let item = saved[entry.id] {
                            Button { router.open(item) } label: { Label("Open in Trove", systemImage: "book") }
                        } else {
                            Button { save(entry) } label: { Label("Save to Trove", systemImage: "plus") }
                        }
                        if let u = URL(string: entry.url) {
                            Button { LinkOpener.open(u) } label: { Label("Open", systemImage: "safari") }
                            ShareLink(item: u) { Label("Share", systemImage: "square.and.arrow.up") }
                            Button { UIPasteboard.general.url = u } label: { Label("Copy Link", systemImage: "link") }
                        }
                    }
            }
        }
        .listStyle(.plain)
    }

    private func chip(_ id: String?, title: String, error: Bool = false) -> some View {
        let on = feedID == id
        return Button {
            withAnimation(.snappy) { feedID = id }
        } label: {
            HStack(spacing: 5) {
                Text(title).lineLimit(1)
                if error { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange) }
            }
            .font(.subheadline.weight(on ? .semibold : .regular))
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
            .foregroundStyle(on ? Color.white : Color.primary)
            .background(on ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color(.tertiarySystemFill)), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        guard let api = library.api else { return }
        loading = true
        defer { loading = false }
        do {
            let all = try await api.feeds(nil)
            feeds = all.feeds
            if let feedID {
                entries = try await api.feeds(feedID).entries
            } else {
                entries = all.entries
            }
            error = nil
        } catch is CancellationError {
        } catch {
            if library.handleAuth(error) { return }
            self.error = error.localizedDescription
        }
    }

    private func save(_ entry: FeedEntry) {
        guard let api = library.api, saved[entry.id] == nil, !saving.contains(entry.id) else { return }
        saving.insert(entry.id)
        let feed = feeds.first { $0.id == entry.feedId }
        Task {
            defer { saving.remove(entry.id) }
            do {
                var body: [String: JSONValue] = ["url": .string(entry.url), "source": "Feed", "via": .string(entry.feed)]
                if let c = feed?.collection { body["collection"] = .string(c) }
                let r = try await api.save(body)
                withAnimation(.snappy) { saved[entry.id] = r.item }
                library.didSave(r.item, created: r.created ?? true)
                library.show(Toast(text: r.created == false ? "Already in your library" : "Saved “\(String(r.item.displayTitle.prefix(40)))”", systemImage: "checkmark.circle.fill", actionLabel: "Open", action: { router.open(r.item) }))
            } catch {
                library.report(error, "Couldn’t save")
            }
        }
    }
}

private struct FeedEntryRow: View {
    let entry: FeedEntry
    let saved: Bool
    let saving: Bool
    let onSave: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.title.isEmpty ? entry.url : entry.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(3)
                let summary = Fmt.oneLine(ReaderRenderer.stripTags(entry.summary))
                if !summary.isEmpty {
                    Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 5) {
                    RemoteImage(url: Favicon.url(for: Fmt.host(entry.url)), size: CGSize(width: 14, height: 14), cornerRadius: 3) {
                        Image(systemName: "dot.radiowaves.up.forward").font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                    Text(entry.feed).lineLimit(1)
                    if let d = TroveDate.parse(entry.date) {
                        Text("·")
                        Text(Fmt.ago(d))
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(spacing: 10) {
                if let img = entry.image.flatMap(URL.init(string:)) {
                    RemoteImage(url: img, size: CGSize(width: 66, height: 66), cornerRadius: 11) { Color(.tertiarySystemFill) }
                }
                Button(action: onSave) {
                    Group {
                        if saving {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: saved ? "checkmark.circle.fill" : "plus.circle")
                                .font(.title3)
                                .foregroundStyle(saved ? Color.green : Color.accentColor)
                                .contentTransition(.symbolEffect(.replace))
                        }
                    }
                    .frame(width: 34, height: 34)
                }
                .buttonStyle(.borderless)
                .disabled(saved || saving)
                .accessibilityLabel(saved ? "Saved" : "Save to Trove")
            }
        }
        .padding(.vertical, 6)
    }
}

/// Follow a new feed, and change or remove the ones you follow.
struct ManageFeedsView: View {
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var feeds: [Feed] = []
    @State private var url = ""
    @State private var collection: String?
    @State private var autosave = false
    @State private var adding = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Site, Substack, YouTube channel or feed URL", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(add)
                    NavigationLink {
                        CollectionPicker(selection: $collection, allowsNone: true, noneLabel: "None")
                    } label: {
                        LabeledContent("Save into", value: collection ?? "None")
                    }
                    Toggle("Save new posts automatically", isOn: $autosave)
                    Button(action: add) {
                        HStack {
                            Text("Follow")
                            if adding { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(url.trimmingCharacters(in: .whitespaces).isEmpty || adding)
                } header: {
                    Text("Follow")
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                }

                if !feeds.isEmpty {
                    Section("Following") {
                        ForEach(feeds) { feed in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(feed.title).font(.body.weight(.medium)).lineLimit(1)
                                    if feed.error != nil {
                                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                                    }
                                }
                                Text(feed.url.replacingOccurrences(of: "https://", with: "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                Toggle("Auto-save", isOn: Binding(get: { feed.autosave ?? false }, set: { on in toggle(feed, on) }))
                                    .font(.subheadline)
                            }
                            .padding(.vertical, 2)
                        }
                        .onDelete { idx in idx.map { feeds[$0] }.forEach(remove) }
                    }
                }
            }
            .navigationTitle("Feeds")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .task { await load() }
        }
    }

    private func load() async {
        guard let api = library.api else { return }
        feeds = (try? await api.feeds(nil).feeds) ?? feeds
        if feeds.isEmpty { focused = true }
    }

    private func add() {
        let u = url.trimmingCharacters(in: .whitespaces)
        guard !u.isEmpty, let api = library.api else { return }
        adding = true
        error = nil
        Task {
            defer { adding = false }
            do {
                let feed = try await api.subscribe(url: u, collection: collection, autosave: autosave)
                if !feeds.contains(where: { $0.id == feed.id }) { withAnimation { feeds.append(feed) } }
                url = ""
                library.show(Toast(text: "Following \(feed.title)", systemImage: "dot.radiowaves.up.forward"))
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func toggle(_ feed: Feed, _ on: Bool) {
        guard let api = library.api, let i = feeds.firstIndex(of: feed) else { return }
        feeds[i].autosave = on
        Task {
            do { _ = try await api.updateFeed(feed.id, patch: ["autosave": .bool(on)]) } catch {
                if let j = feeds.firstIndex(where: { $0.id == feed.id }) { feeds[j].autosave = !on }
                library.report(error, "Couldn’t update the feed")
            }
        }
    }

    private func remove(_ feed: Feed) {
        guard let api = library.api else { return }
        feeds.removeAll { $0.id == feed.id }
        Task {
            do { try await api.unsubscribe(feed.id) } catch {
                feeds.append(feed)
                library.report(error, "Couldn’t unfollow")
            }
        }
    }
}
