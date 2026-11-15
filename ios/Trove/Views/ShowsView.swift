import SwiftUI

/// Shows: what's in progress on Spotify and YouTube (Continue), and each followed show with every episode
/// paired across both, by series (web/components/shows.tsx). Episodes continue in the Spotify or YouTube app.
struct ShowsView: View {
    static let continueTab = "continue"

    @Environment(Library.self) private var library
    @AppStorage("showsTab") private var tab = ShowsView.continueTab
    @State private var model: ShowsModel?
    @State private var query = DevHooks.initialQuery
    @State private var series: String? = DevHooks.value("SERIES")
    @State private var filter = DevHooks.value("FILTER").flatMap(EpisodeFilter.init(rawValue:)) ?? .all
    @State private var devHooksRan = false

    private var onContinue: Bool { tab == Self.continueTab }

    var body: some View {
        content
            .navigationTitle("Shows")
            .searchable(text: $query, prompt: "Find an episode")
            .toolbar { toolbar }
            .task {
                let model = makeModel()
                await model.start()
            }
            .task(id: tab) {
                let model = makeModel()
                if onContinue { model.close() } else { await open(tab, model) }
                await runDevHooks(model)
            }
            .refreshable { await model?.refresh() }
            .onChange(of: tab) { _, _ in
                series = nil
                filter = .all
            }
            .onChange(of: model?.liveShowIDs) { _, ids in
                // The show was unfollowed (on the web): back to Continue.
                if let ids, !onContinue, !ids.contains(tab) { tab = Self.continueTab }
            }
    }

    private func makeModel() -> ShowsModel {
        if let model { return model }
        let m = ShowsModel(library: library)
        model = m
        return m
    }

    /// Simulator checks (DevHooks, never in release builds): PLAY=<episode key> opens it as a tap does,
    /// MARK=<episode key> marks it finished (or not finished).
    private func runDevHooks(_ model: ShowsModel) async {
        guard !devHooksRan, let key = DevHooks.value("PLAY") ?? DevHooks.value("MARK") else { return }
        devHooksRan = true
        try? await Task.sleep(for: .seconds(2))
        let listed = (model.overview.map { $0.inProgress + $0.finished } ?? []).map(ShowEpisode.init(card:))
        guard let row = ((model.detail?.episodes ?? []) + listed).first(where: { $0.key == key || $0.card?.id == key }) else { return }
        if DevHooks.value("PLAY") != nil { open(row, on: row.preferred) } else { await model.setFinished(row, row.status != .finished) }
    }

    private func open(_ id: String, _ model: ShowsModel) async {
        await model.open(id)
        // A show followed a moment ago builds its episode list in the background: check back until it's there.
        while !Task.isCancelled, let d = model.detail, d.show.id == id, d.catalog == nil {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            await model.loadDetail(id)
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if let model, let overview = model.overview {
            list(model, overview)
        } else if let model, case .failed(let message) = model.overviewPhase {
            ContentUnavailableView {
                Label("Couldn’t load your shows", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.refresh() } }.buttonStyle(.bordered)
            }
        } else {
            SkeletonList()
        }
    }

    private func list(_ model: ShowsModel, _ overview: ShowsOverview) -> some View {
        List {
            if !overview.shows.isEmpty {
                Section {
                    showChips(overview.shows)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                }
            }
            if let p = model.status?.needsSignIn {
                Section { signInAlert(p) }
            }
            if onContinue {
                continueSections(model, overview)
            } else {
                showSections(model)
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: model.revision)
    }

    @ViewBuilder private func continueSections(_ model: ShowsModel, _ overview: ShowsOverview) -> some View {
        if overview.inProgress.isEmpty && overview.finished.isEmpty {
            Section {
                ContentUnavailableView {
                    Label("Never lose your place in a podcast", systemImage: "headphones")
                } description: {
                    Text("What you play on YouTube and Spotify shows up here with where you stopped, on any device. Follow shows and connect phone sync in Trove on the web.")
                } actions: {
                    Button("Open Settings on the Web", action: openWebSettings).buttonStyle(.bordered)
                }
                .listRowSeparator(.hidden)
            }
        } else {
            let current = matching(overview.inProgress.map(ShowEpisode.init(card:)))
            let done = matching(overview.finished.map(ShowEpisode.init(card:)))
            if !current.isEmpty {
                Section("In progress") {
                    ForEach(current) { episode($0, model, showName: true) }
                }
            }
            if !done.isEmpty {
                Section("Recently finished") {
                    ForEach(done) { episode($0, model, showName: true) }
                }
            }
            if current.isEmpty && done.isEmpty {
                Section { note("No episodes match “\(query)”.") }
            }
            if let text = syncNote(model.status) {
                Section { note(text) }
            }
        }
    }

    @ViewBuilder private func showSections(_ model: ShowsModel) -> some View {
        if let detail = model.detail, detail.show.id == tab {
            Section {
                ShowHeader(detail: detail, counts: model.counts)
                    .listRowSeparator(.hidden)
                if model.series.count > 1 {
                    seriesChips(model.series, total: model.counts.total)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                }
            }
            let rows = visible(detail.episodes)
            Section {
                ForEach(rows) { episode($0, model, showSeries: series == nil) }
            }
            if rows.isEmpty {
                Section { note(detail.catalog == nil ? "Episodes appear here in a minute or two." : "No episodes match.") }
            }
        } else if case .failed(let message) = model.detailPhase {
            Section {
                ContentUnavailableView {
                    Label("Couldn’t load this show", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message).lineLimit(6)
                } actions: {
                    Button("Try Again") { Task { await model.loadDetail(tab) } }.buttonStyle(.bordered)
                }
                .listRowSeparator(.hidden)
            }
        } else {
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 48)
                    .listRowSeparator(.hidden)
            }
        }
    }

    private func episode(_ row: ShowEpisode, _ model: ShowsModel, showName: Bool = false, showSeries: Bool = true) -> some View {
        EpisodeRow(row: row, showName: showName, showSeries: showSeries, busy: model.busy.contains(row.key)) { open(row, on: $0) }
            .contentShape(Rectangle())
            .onTapGesture { open(row, on: row.preferred) }
            .swipeActions(edge: .trailing) {
                if row.status == .finished {
                    Button { mark(row, false, model) } label: { Label("Not Finished", systemImage: "arrow.uturn.backward") }.tint(.gray)
                } else {
                    Button { mark(row, true, model) } label: { Label("Finished", systemImage: "checkmark") }.tint(.green)
                }
            }
            .contextMenu { menu(row, model) }
    }

    @ViewBuilder private func menu(_ row: ShowEpisode, _ model: ShowsModel) -> some View {
        Section {
            ForEach([MediaPlatform.sp, .yt], id: \.self) { p in
                if row.copy(p) != nil {
                    Button { open(row, on: p) } label: {
                        Label(row.resumeLabel(on: p).map { "Resume in \(p.name) at \($0)" } ?? "Open in \(p.name)", systemImage: p == .yt ? "play.rectangle" : "headphones")
                    }
                }
            }
        }
        Section {
            if row.status == .finished {
                Button { mark(row, false, model) } label: { Label("Mark as Not Finished", systemImage: "arrow.uturn.backward") }
            } else {
                Button { mark(row, true, model) } label: { Label("Mark as Finished", systemImage: "checkmark.circle") }
            }
        }
        Section {
            if let link = MediaLink.episode(row, on: row.preferred) {
                ShareLink(item: link) { Label("Share", systemImage: "square.and.arrow.up") }
                Button { UIPasteboard.general.url = link } label: { Label("Copy Link", systemImage: "link") }
            }
            if let notion = row.card?.notionUrl.flatMap(URL.init(string:)) {
                Button { MediaLink.open(notion) } label: { Label("Open in Notion", systemImage: "arrow.up.forward.square") }
            }
        }
    }

    // MARK: Pieces

    private func showChips(_ shows: [FollowedShow]) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ShowChip(title: "Continue", selected: onContinue) { select(Self.continueTab) }
                        .id(Self.continueTab)
                    ForEach(shows) { show in
                        ShowChip(title: show.title, image: show.imageURL, selected: tab == show.id) { select(show.id) }
                            .id(show.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
            .onAppear { proxy.scrollTo(tab, anchor: .center) }
            .onChange(of: tab) { _, id in withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) } }
        }
    }

    private func seriesChips(_ list: [ShowDetail.Series], total: Int) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ShowChip(title: "All", detail: "\(total)", prominent: false, selected: series == nil) { pickSeries(nil) }
                    ForEach(list) { s in
                        ShowChip(title: s.name, detail: s.finished > 0 ? "\(s.finished)/\(s.count)" : "\(s.count)", prominent: false, selected: series == s.name) { pickSeries(s.name) }
                            .id(s.name)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }
            .onAppear { if let series { proxy.scrollTo(series, anchor: .center) } }
        }
    }

    private func signInAlert(_ p: MediaPlatform) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
            Text("\(p.name) needs a fresh sign-in for phone sync.")
            Spacer(minLength: 0)
            Button("Reconnect", action: openWebSettings)
                .fontWeight(.semibold)
                .buttonStyle(.borderless)
        }
        .font(.subheadline)
        .foregroundStyle(Color.accentColor)
        .padding(12)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        .listRowSeparator(.hidden)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .listRowSeparator(.hidden)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if !onContinue {
                Menu {
                    Picker("Show", selection: $filter) {
                        ForEach(EpisodeFilter.allCases) { Label($0.label, systemImage: $0.symbol).tag($0) }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Label("Filter", systemImage: filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
            Button { Task { await model?.syncNow() } } label: {
                if model?.syncing == true {
                    ProgressView()
                } else {
                    Label("Sync Spotify and YouTube", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .disabled(model == nil || model?.syncing == true)
        }
    }

    // MARK: Helpers

    private func select(_ id: String) {
        withAnimation(.snappy) { tab = id }
    }

    private func pickSeries(_ name: String?) {
        withAnimation(.snappy) { series = name }
    }

    private func open(_ row: ShowEpisode, on p: MediaPlatform) {
        if let url = MediaLink.episode(row, on: p) { MediaLink.open(url) }
    }

    private func mark(_ row: ShowEpisode, _ finished: Bool, _ model: ShowsModel) {
        Task { await model.setFinished(row, finished) }
    }

    private var words: [Substring] { query.split(whereSeparator: \.isWhitespace) }

    /// Continue and Recently finished, narrowed by the search (title or show).
    private func matching(_ rows: [ShowEpisode]) -> [ShowEpisode] {
        let words = words
        guard !words.isEmpty else { return rows }
        return rows.filter { r in words.allSatisfy { r.title.localizedStandardContains($0) || (r.card?.show?.localizedStandardContains($0) ?? false) } }
    }

    /// The open show's episodes in the picked series and status, narrowed by the search.
    private func visible(_ rows: [ShowEpisode]) -> [ShowEpisode] {
        let words = words
        return rows.filter { r in
            if let series, (r.series ?? "Other") != series { return false }
            if filter != .all, r.status.rawValue != filter.rawValue { return false }
            return words.allSatisfy { r.title.localizedStandardContains($0) }
        }
    }

    private func syncNote(_ status: MediaSyncStatus?) -> String? {
        guard let status else { return nil }
        let names = status.connected.map(\.name)
        guard !names.isEmpty else { return "Phone sync is off. Connect Spotify and YouTube in Trove on the web to count what you play in their apps." }
        let when = status.lastSync.map { " " + $0.formatted(.relative(presentation: .named)) } ?? ""
        return "Synced from \(names.joined(separator: " and "))\(when)"
    }

    private func openWebSettings() {
        guard let base = library.api?.account.baseURL,
              var c = URLComponents(url: base.appending(path: "settings"), resolvingAgainstBaseURL: false) else { return }
        c.fragment = "shows"
        if let url = c.url { LinkOpener.open(url) }
    }
}

enum EpisodeFilter: String, CaseIterable, Identifiable {
    case all, new, started, finished

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "All Episodes"
        case .new: "Not Started"
        case .started: "In Progress"
        case .finished: "Finished"
        }
    }

    var symbol: String {
        switch self {
        case .all: "list.bullet"
        case .new: "circle"
        case .started: "circle.lefthalf.filled"
        case .finished: "checkmark.circle"
        }
    }
}

// MARK: - Rows

/// One episode: where you stopped, and buttons that continue it in the Spotify or YouTube app.
struct EpisodeRow: View {
    let row: ShowEpisode
    var showName = false
    var showSeries = true
    var busy = false
    let onOpen: (MediaPlatform) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(row.status == .finished ? .secondary : .primary)
                    .lineLimit(3)
                let meta = meta
                if !meta.isEmpty {
                    Text(meta)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let card = row.card {
                    switch card.status {
                    case .started:
                        Text(EpisodeMath.progressLine(card))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(Color.accentColor)
                            .lineLimit(2)
                            .padding(.top, 1)
                    case .finished:
                        // Not a Label: in a List row it would shift the separator to the text.
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                            Text(EpisodeMath.finishedLine(card))
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.green)
                        .padding(.top, 1)
                    case .new:
                        EmptyView()
                    }
                }
                HStack(spacing: 8) {
                    ForEach([MediaPlatform.sp, .yt], id: \.self) { p in
                        if row.copy(p) != nil {
                            PlatformButton(platform: p, time: row.resumeLabel(on: p), highlighted: row.status == .started && row.preferred == p) { onOpen(p) }
                        }
                    }
                    if busy { ProgressView().controlSize(.small) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RemoteImage(url: row.imageURL, size: CGSize(width: Self.thumb, height: Self.thumb), cornerRadius: 11) {
                Color(.tertiarySystemFill)
            }
            .overlay(alignment: .bottomLeading) {
                if row.status == .started, let pct = row.card?.pct { progressBar(pct) }
            }
            .opacity(row.status == .finished ? 0.7 : 1)
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
    }

    private static let thumb: CGFloat = 66

    /// How much you've heard, along the bottom of the cover.
    private func progressBar(_ pct: Double) -> some View {
        let width = Self.thumb - 10
        return Capsule()
            .fill(.black.opacity(0.4))
            .frame(width: width, height: 4)
            .overlay(alignment: .leading) {
                Capsule().fill(Color.accentColor).frame(width: max(4, width * min(1, max(0, pct))))
            }
            .padding(5)
            .accessibilityHidden(true)
    }

    private var meta: String {
        var parts: [String] = []
        if showName, let show = row.card?.show { parts.append(show) }
        if showSeries, let series = row.series { parts.append(series) }
        if let length = EpisodeMath.length(row.dur) { parts.append(length) }
        if let date = row.releasedAt { parts.append(Fmt.shortDate(date)) }
        return parts.joined(separator: " · ")
    }
}

/// Continue on one platform: its logo, and the time it starts at when you're partway through.
struct PlatformButton: View {
    let platform: MediaPlatform
    let time: String?
    var highlighted = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                PlatformLogo(platform: platform)
                if let time {
                    Text(time).font(.caption.weight(.semibold)).monospacedDigit()
                }
            }
            .padding(.horizontal, time == nil ? 9 : 10)
            .frame(minHeight: 28)
            .foregroundStyle(highlighted ? Color.accentColor : Color.secondary)
            .background(highlighted ? Color.accentColor.opacity(0.14) : Color(.tertiarySystemFill), in: Capsule())
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(time.map { "Resume in \(platform.name) at \($0)" } ?? "Open in \(platform.name)")
    }
}

/// The YouTube and Spotify marks, drawn (no image assets).
struct PlatformLogo: View {
    let platform: MediaPlatform
    var size: CGFloat = 15

    var body: some View {
        Canvas { context, canvas in
            let k = canvas.width / 24
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * k, y: y * k) }
            switch platform {
            case .yt:
                let body = Path(roundedRect: CGRect(x: 1.5 * k, y: 4.5 * k, width: 21 * k, height: 15 * k), cornerRadius: 4.5 * k)
                context.fill(body, with: .color(Color(red: 1, green: 0, blue: 0.2)))
                var play = Path()
                play.move(to: point(10, 8.6))
                play.addLine(to: point(10, 15.4))
                play.addLine(to: point(15.6, 12))
                play.closeSubpath()
                context.fill(play, with: .color(.white))
            case .sp:
                context.fill(Path(ellipseIn: CGRect(x: k, y: k, width: 22 * k, height: 22 * k)), with: .color(Color(red: 0.118, green: 0.843, blue: 0.376)))
                var waves = Path()
                waves.move(to: point(6.6, 9.4))
                waves.addCurve(to: point(17.6, 10.4), control1: point(10.3, 8.3), control2: point(14.5, 8.6))
                waves.move(to: point(7.3, 12.6))
                waves.addCurve(to: point(16.2, 13.5), control1: point(10.3, 11.8), control2: point(13.7, 12.1))
                waves.move(to: point(8, 15.6))
                waves.addCurve(to: point(14.8, 16.3), control1: point(10.3, 15), control2: point(12.9, 15.2))
                context.stroke(waves, with: .color(.black), style: StrokeStyle(lineWidth: 1.7 * k, lineCap: .round))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A followed show (top row) or one of its series (second row, quieter).
private struct ShowChip: View {
    let title: String
    var detail: String?
    var image: URL?
    var prominent = true
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let image {
                    RemoteImage(url: image, size: CGSize(width: 18, height: 18), cornerRadius: 4) { Color(.tertiarySystemFill) }
                }
                Text(title).lineLimit(1)
                if let detail {
                    Text(detail).monospacedDigit().opacity(selected ? 0.8 : 0.6)
                }
            }
            .font((prominent ? Font.subheadline : .footnote).weight(selected ? .semibold : .regular))
            .padding(.leading, image == nil ? (prominent ? 13 : 11) : 7)
            .padding(.trailing, prominent ? 13 : 11)
            .padding(.vertical, prominent ? 7 : 6)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var foreground: Color {
        guard selected else { return prominent ? .primary : .secondary }
        return prominent ? .white : .accentColor
    }

    private var background: Color {
        guard selected else { return Color(.tertiarySystemFill) }
        return prominent ? .accentColor : .accentColor.opacity(0.14)
    }
}

/// The open show: cover, counts, and links to it in the Spotify and YouTube apps.
private struct ShowHeader: View {
    let detail: ShowDetail
    let counts: ShowsModel.Counts

    var body: some View {
        HStack(spacing: 12) {
            RemoteImage(url: detail.show.imageURL, size: CGSize(width: 56, height: 56), cornerRadius: 12) {
                ZStack {
                    Color(.tertiarySystemFill)
                    Image(systemName: "headphones").foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(detail.show.title).font(.headline).lineLimit(2)
                Text(summary)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 14) {
                    if let id = detail.show.spotify?.id, let url = MediaLink.spotifyShow(id) { link(.sp, url) }
                    if let id = detail.show.youtube?.channelId, let url = MediaLink.youTubeChannel(id) { link(.yt, url) }
                    if detail.catalog?.error != nil {
                        Label("Some sources failed", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
    }

    private var summary: String {
        guard let catalog = detail.catalog else { return "Building the episode list: both platforms, paired, with series from the YouTube playlists…" }
        var parts = ["\(counts.total) episodes"]
        if let paired = catalog.paired, paired > 0 { parts.append("\(paired) on both") }
        parts.append("\(counts.finished) finished")
        if counts.started > 0 { parts.append("\(counts.started) in progress") }
        if let at = catalog.at { parts.append("updated \(Fmt.ago(Date(timeIntervalSince1970: at / 1000)))") }
        return parts.joined(separator: " · ")
    }

    private func link(_ p: MediaPlatform, _ url: URL) -> some View {
        Button { MediaLink.open(url) } label: {
            HStack(spacing: 5) {
                PlatformLogo(platform: p, size: 14)
                Text(p.name)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(Color.secondary)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Open in \(p.name)")
    }
}

// MARK: - Links

/// Episode and show links: the platforms' own universal links (with the time to start at), so they open in
/// the Spotify or YouTube app when it's installed, else on the web.
nonisolated enum MediaLink {
    static func episode(_ p: MediaPlatform, id: String, at pos: Double = 0) -> URL? {
        let t = Int(pos)
        switch p {
        case .yt: return URL(string: "https://www.youtube.com/watch?v=\(id)\(t >= 5 ? "&t=\(t)s" : "")")
        case .sp: return URL(string: "https://open.spotify.com/episode/\(id)\(t >= 5 ? "?t=\(t)" : "")")
        }
    }

    /// Where you stopped on that platform (mapped from the other one when you were last there).
    static func episode(_ row: ShowEpisode, on p: MediaPlatform) -> URL? {
        guard let copy = row.copy(p) else { return nil }
        return episode(p, id: copy.id, at: row.resume(on: p).pos)
    }

    static func spotifyShow(_ id: String) -> URL? { URL(string: "https://open.spotify.com/show/\(id)") }
    static func youTubeChannel(_ id: String) -> URL? { URL(string: "https://www.youtube.com/channel/\(id)") }

    @MainActor static func open(_ url: URL) {
        Task {
            if await UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { return }
            LinkOpener.open(url)
        }
    }
}
