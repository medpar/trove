import SwiftUI

/// Sidebar | list | reader. On iPhone it collapses to a stack that opens on "All items".
struct MainView: View {
    @Environment(Library.self) private var library
    @State private var router = Router()

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $router.columns, preferredCompactColumn: $router.compactColumn) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
        } content: {
            Group {
                switch router.destination {
                case .scope(let scope)?:
                    ItemListView(scope: scope).id(scope)
                case .feeds?:
                    FeedsView()
                case .shows?:
                    ShowsView()
                case nil:
                    ContentUnavailableView("Pick a list", systemImage: "sidebar.left", description: Text("Choose a collection, tag or filter in the sidebar."))
                }
            }
            .navigationSplitViewColumnWidth(min: 320, ideal: 400, max: 520)
        } detail: {
            NavigationStack(path: $router.detailPath) {
                Group {
                    if let id = router.selectedID {
                        ItemDetailView(id: id, seed: router.seed).id(id)
                    } else {
                        EmptyDetail(shows: router.destination == .shows)
                    }
                }
                .navigationDestination(for: Item.self) { item in
                    ItemDetailView(id: item.id, seed: item)
                }
            }
        }
        .environment(router)
        .overlay(alignment: .bottom) { ToastOverlay() }
        .sheet(item: Binding(get: { router.sheet?.isFullScreen == false ? router.sheet : nil }, set: { router.sheet = $0 })) { sheet in
            SheetHost(sheet: sheet)
                .environment(router)
                .environment(library)
        }
        .fullScreenCover(item: Binding(get: { router.sheet?.isFullScreen == true ? router.sheet : nil }, set: { router.sheet = $0 })) { sheet in
            SheetHost(sheet: sheet)
                .environment(router)
                .environment(library)
        }
        .onChange(of: router.selectedID) { _, _ in router.detailPath = [] }
        .task {
            try? await Task.sleep(for: .milliseconds(400))
            DevHooks.apply(router, library: library)
        }
        .environment(\.openURL, OpenURLAction { url in
            if router.handle(route: url) { return .handled }
            LinkOpener.open(url)
            return .handled
        })
    }
}

/// Everything presented as a sheet, in one place.
struct SheetHost: View {
    let sheet: Router.Sheet

    var body: some View {
        switch sheet {
        case .add(let text): AddItemView(initialText: text ?? "")
        case .ask(let question): AskView(initialQuestion: question)
        case .settings: SettingsView()
        case .edit(let item): EditItemView(item: item)
        case .image(let url): ImageViewer(url: url)
        case .snapshot(let item): SnapshotView(item: item)
        case .highlights(let item, let entries): HighlightsView(item: item, entries: entries)
        case .related(let item): RelatedView(item: item)
        case .manageFeeds: ManageFeedsView()
        }
    }
}

struct EmptyDetail: View {
    /// In Shows, episodes open in the Spotify or YouTube app rather than here.
    var shows = false

    var body: some View {
        VStack(spacing: 14) {
            Image("AppIconImage")
                .resizable()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .opacity(0.9)
            Text(shows ? "Pick up where you left off" : "Select something to read")
                .font(.headline)
            Text(shows ? "Episodes open in the Spotify or YouTube app, at the time you stopped." : "Articles, videos, posts and notes open here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
