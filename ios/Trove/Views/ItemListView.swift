import SwiftUI

enum ListLayout: String { case list, gallery }

struct ItemListView: View {
    let scope: Scope
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @State private var model: ItemListModel?
    @State private var query = DevHooks.initialQuery
    @State private var pendingDelete: Item?
    @State private var galleryWidth: CGFloat = 390
    @AppStorage("layout") private var layout: ListLayout = .list
    @AppStorage("sort") private var sort: Sort = .newest
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        content
            .navigationTitle(scope.title)
            .searchable(text: $query, prompt: scope == .all ? "Search or ask" : "Search \(scope.title)")
            .searchSuggestions { suggestions }
            .task {
                if model == nil { model = ItemListModel(scope: scope, library: library, sort: sort) }
                await model?.start()
            }
            .task(id: query) {
                guard let model else { return }
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(380)) }
                guard !Task.isCancelled else { return }
                await model.search(query)
            }
            .onChange(of: sort) { _, s in Task { await model?.setSort(s) } }
            .refreshable {
                async let list: Void = model?.reload() ?? ()
                async let counts: Void = library.loadStats(fresh: true)
                _ = await (list, counts)
            }
            .toolbar { toolbar }
            .addButton(compact: sizeClass == .compact && UIDevice.current.userInterfaceIdiom == .phone) { router.sheet = .add(nil) }
            .confirmationDialog("Delete this item?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { item in
                Button("Move to Trash", role: .destructive) { Task { await library.delete(item) } }
            } message: { item in
                Text("“\(item.displayTitle)” goes to Notion’s trash, where you can restore it.")
            }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if let model {
            if model.items.isEmpty {
                switch model.phase {
                case .failed(let message):
                    ContentUnavailableView {
                        Label(model.isSearching ? "Search failed" : "Couldn’t load", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await model.reload() } }
                            .buttonStyle(.bordered)
                    }
                case .loaded:
                    if model.isSearching {
                        searchEmpty(model)
                    } else {
                        ContentUnavailableView {
                            Label(emptyTitle, systemImage: scope.systemImage)
                        } description: {
                            Text(emptyMessage)
                        } actions: {
                            if scope == .all || scope == .unsorted {
                                Button("Save Something") { router.sheet = .add(nil) }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                    }
                default:
                    SkeletonList()
                }
            } else if layout == .gallery {
                gallery(model)
            } else {
                list(model)
            }
        } else {
            SkeletonList()
        }
    }

    private func list(_ model: ItemListModel) -> some View {
        List(selection: Binding(get: { router.selectedID }, set: { id in
            if let id, let item = model.items.first(where: { $0.id == id }) { router.open(item) } else { router.selectedID = id }
        })) {
            if model.isSearching { searchHeader(model) }
            ForEach(model.items) { item in
                ItemRow(item: item)
                    .equatable()
                    .tag(item.id)
                    .onAppear { model.loadMoreIfNeeded(item) }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button { Task { await library.setRead(item, !item.read) } } label: {
                            Label(item.read ? "Unread" : "Read", systemImage: item.read ? "circle" : "checkmark.circle")
                        }
                        .tint(.green)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { pendingDelete = item } label: { Label("Delete", systemImage: "trash") }
                            .tint(.red)
                        Button { Task { await library.setFavorite(item, !item.favorite) } } label: {
                            Label(item.favorite ? "Unfavorite" : "Favorite", systemImage: item.favorite ? "heart.slash" : "heart")
                        }
                        .tint(.pink)
                    }
                    .contextMenu {
                        ItemMenu(item: item, onDelete: { pendingDelete = item })
                    } preview: {
                        ItemPreview(item: item)
                    }
            }
            if model.loadingMore {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .animation(.default, value: model.revision)
    }

    private func gallery(_ model: ItemListModel) -> some View {
        let spacing: CGFloat = 14
        let available = max(galleryWidth - 32, 200)
        let cols = max(2, Int((available + spacing) / (168 + spacing)))
        let width = ((available - spacing * CGFloat(cols - 1)) / CGFloat(cols)).rounded(.down)
        return ScrollView {
                if model.isSearching {
                    VStack(alignment: .leading) { searchHeader(model) }
                        .padding(.horizontal, 16)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(width), spacing: spacing), count: cols), spacing: 22) {
                    ForEach(model.items) { item in
                        Button { router.open(item) } label: { ItemCard(item: item, width: width) }
                            .buttonStyle(.plain)
                            .onAppear { model.loadMoreIfNeeded(item) }
                            .contextMenu {
                                ItemMenu(item: item, onDelete: { pendingDelete = item })
                            } preview: {
                                ItemPreview(item: item)
                            }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                if model.loadingMore { ProgressView().padding() }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { galleryWidth = $0 }
    }

    // MARK: Search

    @ViewBuilder private func searchHeader(_ model: ItemListModel) -> some View {
        if ItemListModel.looksLikeQuestion(query) {
            Button { router.sheet = .ask(query) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 34, height: 34)
                        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ask Trove").font(.subheadline.weight(.semibold))
                        Text("“\(query)”").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .selectionDisabled()
        }
        if model.isSmartSearch || model.searchNote != nil {
            Label(model.searchNote ?? "Matches by meaning, best first", systemImage: model.isSmartSearch ? "sparkle.magnifyingglass" : "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
                .selectionDisabled()
        }
    }

    private func searchEmpty(_ model: ItemListModel) -> some View {
        ContentUnavailableView {
            Label("No results", systemImage: "magnifyingglass")
        } description: {
            Text("Nothing matches “\(query)”.")
        } actions: {
            if ItemListModel.isSmartQuery(query) {
                Button { router.sheet = .ask(query) } label: { Label("Ask Trove instead", systemImage: "sparkles") }
                    .buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder private var suggestions: some View {
        if query.isEmpty {
            Label("Favorites", systemImage: "heart").searchCompletion("is:fav ")
            Label("Unread", systemImage: "circle").searchCompletion("is:unread ")
            Label("Videos", systemImage: "play.rectangle").searchCompletion("type:video ")
            Label("Articles", systemImage: "doc.text").searchCompletion("type:article ")
            Label("With highlights", systemImage: "highlighter").searchCompletion("highlights:true ")
            ForEach(library.tagNames.prefix(5), id: \.self) { tag in
                Label(tag, systemImage: "number").searchCompletion("#\(tag) ")
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { router.sheet = .ask(nil) } label: { Label("Ask Trove", systemImage: "sparkles") }
            Menu {
                Picker("Layout", selection: $layout) {
                    Label("List", systemImage: "list.bullet").tag(ListLayout.list)
                    Label("Gallery", systemImage: "square.grid.2x2").tag(ListLayout.gallery)
                }
                .pickerStyle(.inline)
                Picker(selection: $sort) {
                    ForEach(Sort.allCases) { Text($0.label).tag($0) }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
                .pickerStyle(.menu)
            } label: {
                Label("View Options", systemImage: "ellipsis")
            }
        }
    }

    private var emptyTitle: String {
        switch scope {
        case .all: "Nothing saved yet"
        case .unread: "All caught up"
        case .favorites: "No favorites yet"
        case .unsorted: "Everything is filed"
        case .broken: "No broken links"
        default: "Nothing here"
        }
    }

    private var emptyMessage: String {
        switch scope {
        case .all: "Save links, notes, photos and files here or from the Share sheet, Telegram, email and the browser extension."
        case .unread: "You’ve read everything you saved for later."
        case .favorites: "Tap the heart on anything you love."
        case .unsorted: "Every item has a collection."
        default: "Items you save here will show up in this list."
        }
    }
}

// MARK: - Shared item actions

/// Actions for one item: used by context menus in lists and grids.
struct ItemMenu: View {
    let item: Item
    var onDelete: () -> Void
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router

    var body: some View {
        Section {
            if let link = item.link {
                Button { LinkOpener.open(link) } label: { Label("Open Original", systemImage: "safari") }
                ShareLink(item: link) { Label("Share", systemImage: "square.and.arrow.up") }
                Button { UIPasteboard.general.url = link } label: { Label("Copy Link", systemImage: "link") }
            }
        }
        Section {
            Button { Task { await library.setFavorite(item, !item.favorite) } } label: {
                Label(item.favorite ? "Remove Favorite" : "Favorite", systemImage: item.favorite ? "heart.slash" : "heart")
            }
            Button { Task { await library.setRead(item, !item.read) } } label: {
                Label(item.read ? "Mark as Unread" : "Mark as Read", systemImage: item.read ? "circle" : "checkmark.circle")
            }
            Button { router.sheet = .edit(item) } label: { Label("Edit Details…", systemImage: "slider.horizontal.3") }
        }
        Section {
            Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
        }
    }
}

/// The long-press preview: cover, title and the first lines of context.
struct ItemPreview: View {
    let item: Item

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let url = item.coverURL {
                RemoteImage(url: url, size: CGSize(width: 320, height: 180)) { Color(.tertiarySystemFill) }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(item.displayTitle).font(.headline).lineLimit(3)
                if !item.blurb.isEmpty {
                    Text(item.blurb).font(.subheadline).foregroundStyle(.secondary).lineLimit(4)
                }
                MetaLine(item: item)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
            .padding(.top, item.coverURL == nil ? 14 : 0)
        }
        .frame(width: 320)
    }
}

extension View {
    /// The add button: next to the search field at the bottom on iPhone (iOS 26), in the top bar on iPad.
    @ViewBuilder func addButton(compact: Bool, _ action: @escaping () -> Void) -> some View {
        let button = Button(action: action) { Label("Add", systemImage: "plus") }
            .keyboardShortcut("n", modifiers: .command)
        if !compact {
            toolbar { ToolbarItem(placement: .primaryAction) { button } }
        } else if #available(iOS 26, *) {
            toolbar {
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) { button }
            }
        } else {
            toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()
                    button
                }
            }
        }
    }
}
