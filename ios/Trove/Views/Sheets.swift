import SwiftUI
import WebKit

// MARK: - Highlights

struct HighlightsView: View {
    let item: Item
    let entries: [HighlightEntry]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if entries.isEmpty {
                    ContentUnavailableView {
                        Label("No highlights yet", systemImage: "highlighter")
                    } description: {
                        Text("Select text while reading and choose Highlight. Highlights from the browser extension show up here too.")
                    }
                } else {
                    List(entries, id: \.self) { h in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .top, spacing: 12) {
                                RoundedRectangle(cornerRadius: 1.5)
                                    .fill(Color(ReaderColors.mark))
                                    .frame(width: 3)
                                Text(h.text)
                                    .font(.system(.body, design: .serif))
                                    .textSelection(.enabled)
                            }
                            if let note = h.note, !note.isEmpty {
                                Label(note, systemImage: "note.text")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .padding(.leading, 15)
                            }
                        }
                        .padding(.vertical, 6)
                        .contextMenu {
                            Button { UIPasteboard.general.string = h.text } label: { Label("Copy", systemImage: "doc.on.doc") }
                            ShareLink(item: "“\(h.text)”\n— \(item.displayTitle)\(item.url.isEmpty ? "" : "\n\(item.url)")") { Label("Share", systemImage: "square.and.arrow.up") }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Highlights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) }
                if !entries.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: entries.map { "“\($0.text)”" + ($0.note.map { "\n\($0)" } ?? "") }.joined(separator: "\n\n") + "\n\n— \(item.displayTitle)") {
                            Label("Share All", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Related

struct RelatedView: View {
    let item: Item
    @Environment(Library.self) private var library
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var items: [Item]?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let items {
                    if items.isEmpty {
                        ContentUnavailableView("Nothing related yet", systemImage: "point.3.connected.trianglepath.dotted", description: Text("Related items appear once this item has been indexed for search by meaning."))
                    } else {
                        List(items) { other in
                            Button {
                                dismiss()
                                if router.selectedID != nil { router.detailPath.append(other) } else { router.open(other) }
                            } label: { ItemRow(item: other) }
                            .buttonStyle(.plain)
                        }
                        .listStyle(.plain)
                    }
                } else if let error {
                    ContentUnavailableView("Couldn’t load related items", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Related")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .task {
                do { items = try await library.api?.related(item.id) ?? [] } catch { self.error = error.localizedDescription }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Web archive

struct SnapshotView: View {
    let item: Item
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                if let api = library.api {
                    SnapshotWebView(request: api.snapshotRequest(item.id), loading: $loading)
                        .ignoresSafeArea(edges: .bottom)
                }
                if loading { ProgressView() }
            }
            .navigationTitle("Web Archive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) }
                if let link = item.link {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { LinkOpener.open(link) } label: { Label("Original", systemImage: "safari") }
                    }
                }
            }
        }
    }
}

struct SnapshotWebView: UIViewRepresentable {
    let request: URLRequest
    @Binding var loading: Bool

    func makeCoordinator() -> Coordinator { Coordinator(loading: $loading) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.load(request)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loading: Binding<Bool>
        init(loading: Binding<Bool>) { self.loading = loading }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading.wrappedValue = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading.wrappedValue = false }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loading.wrappedValue = false }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.navigationType == .linkActivated, let url = action.request.url {
                await MainActor.run { LinkOpener.open(url) }
                return .cancel
            }
            return .allow
        }
    }
}

// MARK: - Image viewer

struct ImageViewer: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let image {
                    ZoomableImage(image: image).ignoresSafeArea()
                } else {
                    ProgressView().tint(.white)
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) }
                if let image {
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("Image", image: Image(uiImage: image))) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .task {
                let width = UIScreen.main.bounds.width * 2
                image = await ImagePipeline.shared.image(url, .fit(width: width), scale: scale)
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// Pinch and double-tap to zoom, backed by UIScrollView for smooth native zooming.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.maximumZoomScale = 5
        scroll.minimumZoomScale = 1
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.backgroundColor = .clear
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        view.isUserInteractionEnabled = true
        scroll.addSubview(view)
        context.coordinator.imageView = view
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(tap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        DispatchQueue.main.async {
            guard scroll.zoomScale == 1 else { return }
            context.coordinator.imageView?.frame = scroll.bounds
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let scroll = g.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let p = g.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}
