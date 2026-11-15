import SafariServices
import SwiftUI

/// Per-window navigation: what the sidebar shows, which item is open, and which sheet is up.
@Observable final class Router {
    var destination: Destination? = .scope(.all)
    var selectedID: String?
    var seed: Item?
    var compactColumn: NavigationSplitViewColumn = .content
    var columns: NavigationSplitViewVisibility = .all
    var sheet: Sheet?
    var detailPath: [Item] = []
    /// The Ask conversation, kept while the app runs.
    var askTurns: [AskTurn] = []

    struct AskTurn: Identifiable {
        let id = UUID()
        var question: String
        var result: AskResult?
        var error: String?
    }

    enum Sheet: Identifiable {
        case add(String?)
        case ask(String?)
        case settings
        case edit(Item)
        case image(URL)
        case snapshot(Item)
        case highlights(Item, [HighlightEntry])
        case related(Item)
        case manageFeeds

        var id: String {
            switch self {
            case .add: "add"
            case .ask: "ask"
            case .settings: "settings"
            case .edit(let i): "edit-\(i.id)"
            case .image(let u): "image-\(u.absoluteString)"
            case .snapshot(let i): "snapshot-\(i.id)"
            case .highlights(let i, _): "highlights-\(i.id)"
            case .related(let i): "related-\(i.id)"
            case .manageFeeds: "feeds"
            }
        }
    }

    func open(_ item: Item) {
        seed = item
        detailPath = []
        selectedID = item.id
        compactColumn = .detail
    }

    func show(_ destination: Destination) {
        self.destination = destination
        compactColumn = .content
    }

    /// trove://tag?v=…, trove://collection?v=… links from the reader.
    func handle(route url: URL) -> Bool {
        guard url.scheme == "trove", let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "v" })?.value else { return false }
        switch url.host() {
        case "tag": show(.scope(.tag(value)))
        case "collection": show(.scope(.collection(value)))
        default: return false
        }
        return true
    }
}

/// Opens web links in an in-app Safari sheet (or Safari itself, per Settings) from anywhere, sheets included.
enum LinkOpener {
    @MainActor static func open(_ url: URL) {
        let inApp = UserDefaults.standard.object(forKey: "openLinksInApp") as? Bool ?? true
        guard inApp, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            UIApplication.shared.open(url)
            return
        }
        guard let top = topViewController() else {
            UIApplication.shared.open(url)
            return
        }
        let cfg = SFSafariViewController.Configuration()
        cfg.entersReaderIfAvailable = false
        cfg.barCollapsingEnabled = true
        let vc = SFSafariViewController(url: url, configuration: cfg)
        vc.preferredControlTintColor = UIColor(named: "AccentColor")
        vc.dismissButtonStyle = .done
        top.present(vc, animated: true)
    }

    @MainActor static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }
}
