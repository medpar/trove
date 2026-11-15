import SwiftUI

struct SidebarView: View {
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @AppStorage("openCollections") private var openCollectionsRaw = ""
    @State private var showAllTags = false

    private var stats: Stats? { library.stats }

    var body: some View {
        @Bindable var router = router
        List(selection: $router.destination) {
            Section {
                row(.all, count: stats?.total)
                row(.unsorted, count: stats?.unsorted)
                row(.unread, count: stats?.unread)
                row(.favorites, count: stats?.favorites)
                if let n = stats?.highlights, n > 0 { row(.highlights, count: n) }
                if let n = stats?.notes, n > 0 { row(.notes, count: n) }
                if let n = stats?.reminders, n > 0 { row(.reminders, count: n) }
                Label("Feeds", systemImage: "dot.radiowaves.up.forward")
                    .tag(Destination.feeds)
                Label("Shows", systemImage: "headphones")
                    .tag(Destination.shows)
            }

            Section("Collections") {
                if library.collections.isEmpty {
                    Text(stats == nil ? "Loading…" : "Give any item a collection to start one.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .selectionDisabled()
                } else {
                    ForEach(library.collections) { node in
                        CollectionRow(node: node, open: openBinding)
                    }
                }
            }

            if let types = stats?.types, !types.isEmpty {
                Section("Types") {
                    ForEach(types.sorted { TypeInfo.rank($0.name) < TypeInfo.rank($1.name) }) { t in
                        row(.type(t.name), count: t.count)
                    }
                }
            }

            if let tags = stats?.tags, !tags.isEmpty {
                Section("Tags") {
                    ForEach(showAllTags ? tags : Array(tags.prefix(10))) { t in
                        Label(t.name, systemImage: "number")
                            .badge(t.count)
                            .tag(Destination.scope(.tag(t.name)))
                    }
                    if tags.count > 10 {
                        Button(showAllTags ? "Show fewer" : "Show all \(tags.count) tags") {
                            withAnimation(.snappy) { showAllTags.toggle() }
                        }
                        .font(.subheadline)
                        .foregroundStyle(Color.accentColor)
                        .selectionDisabled()
                    }
                }
            }

            if let s = stats, s.noTags > 0 || s.broken > 0 {
                Section("Tidy up") {
                    if s.noTags > 0 { row(.untagged, count: s.noTags) }
                    if s.broken > 0 { row(.broken, count: s.broken) }
                }
            }

            if let s = stats {
                Text("\(s.total.formatted()) items saved")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
                    .selectionDisabled()
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Trove")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { router.sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { router.sheet = .ask(nil) } label: { Label("Ask Trove", systemImage: "sparkles") }
                Button { router.sheet = .add(nil) } label: { Label("Add", systemImage: "plus") }
            }
        }
        .refreshable { await library.loadStats(fresh: true) }
        .task { if library.stats == nil { await library.loadStats() } }
        .overlay {
            if stats == nil, let error = library.statsError {
                ContentUnavailableView {
                    Label("Can’t reach Trove", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { Task { await library.loadStats() } }
                }
            }
        }
    }

    private func row(_ scope: Scope, count: Int?) -> some View {
        Label(scope.title, systemImage: scope.systemImage)
            .badge(count ?? 0)
            .tag(Destination.scope(scope))
    }

    private var openBinding: Binding<Set<String>> {
        Binding(
            get: { Set(openCollectionsRaw.split(separator: "\n").map(String.init)) },
            set: { openCollectionsRaw = $0.sorted().joined(separator: "\n") }
        )
    }
}

private struct CollectionRow: View {
    let node: CollectionNode
    @Binding var open: Set<String>

    var body: some View {
        if let children = node.children {
            DisclosureGroup(isExpanded: Binding(
                get: { open.contains(node.name) },
                set: { if $0 { open.insert(node.name) } else { open.remove(node.name) } }
            )) {
                ForEach(children) { CollectionRow(node: $0, open: $open) }
            } label: {
                label
            }
        } else {
            label
        }
    }

    private var label: some View {
        Label {
            Text(node.label)
        } icon: {
            Image(systemName: "folder")
                .foregroundStyle(NotionColor.color(node.color) ?? Color.accentColor)
        }
        .badge(node.total)
        .tag(Destination.scope(.collection(node.name)))
    }
}
