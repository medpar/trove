import Foundation
import SwiftUI

/// Launch hooks for screenshot checks in the simulator: on in Debug, or in an optimized test build with
/// SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEVHOOKS; compiled out of the release IPA.
/// Set with SIMCTL_CHILD_TROVE_DEV_* when launching through `xcrun simctl launch`.
enum DevHooks {
    #if DEBUG || DEVHOOKS
    private static let env = ProcessInfo.processInfo.environment
    static func value(_ key: String) -> String? { env["TROVE_DEV_\(key)"].flatMap { $0.isEmpty ? nil : $0 } }
    #else
    static func value(_ key: String) -> String? { nil }
    #endif

    /// A test account for the local dev proxy (ios/DevProxy), used instead of the saved one.
    static var account: Account? {
        guard let server = value("SERVER"), let url = URL(string: server), let key = value("KEY") else { return nil }
        return Account(baseURL: url, credential: .apiKey(key), keyName: "Dev proxy")
    }

    static var initialQuery: String { value("SEARCH") ?? "" }
    static var readerScroll: Double? { value("SCROLL").flatMap(Double.init) }

    @MainActor static func apply(_ router: Router, library: Library) {
        // Shows: SHOW=<followed show id> (or "continue"); SERIES, FILTER (new|started|finished), PLAY and MARK
        // (an episode key) are read by ShowsView.
        if let show = value("SHOW") { UserDefaults.standard.set(show, forKey: "showsTab") }
        if let dest = value("DEST") {
            if dest == "feeds" { router.destination = .feeds }
            else if dest == "shows" { router.destination = .shows }
            else if dest.hasPrefix("collection:") { router.destination = .scope(.collection(String(dest.dropFirst(11)))) }
            else if dest.hasPrefix("tag:") { router.destination = .scope(.tag(String(dest.dropFirst(4)))) }
            else if dest.hasPrefix("type:") { router.destination = .scope(.type(String(dest.dropFirst(5)))) }
            else if dest == "favorites" { router.destination = .scope(.favorites) }
            else if dest == "unread" { router.destination = .scope(.unread) }
        }
        if value("COLUMN") == "sidebar" {
            router.destination = nil
            router.compactColumn = .sidebar
        }
        if value("COLUMNS") == "all" { router.columns = .all }
        if let id = value("OPEN") {
            router.selectedID = id
            router.compactColumn = .detail
        }
        if value("ORIENT") == "landscape",
           let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { _ in }
        }
        if let image = value("IMAGE").flatMap(URL.init(string:)) { router.sheet = .image(image) }
        if let text = value("TOAST") {
            let delay = value("TOASTDELAY").flatMap(Double.init) ?? 0
            Task {
                try? await Task.sleep(for: .seconds(delay))
                library.show(Toast(text: text, systemImage: "checkmark.circle.fill", actionLabel: "Open", action: {}))
            }
        }
        switch value("SHEET") {
        case "add": router.sheet = .add(value("TEXT"))
        case "ask": router.sheet = .ask(value("ASK"))
        case "settings": router.sheet = .settings
        case "feeds": router.sheet = .manageFeeds
        case "edit", "snapshot", "related", "highlights":
            if let id = value("EDIT"), let kind = value("SHEET") {
                Task {
                    guard let c = try? await library.content(id) else { return }
                    switch kind {
                    case "snapshot": router.sheet = .snapshot(c.item)
                    case "related": router.sheet = .related(c.item)
                    case "highlights": router.sheet = .highlights(c.item, ReaderRenderer.clean(c.markdown ?? "", note: c.item.note).1)
                    default: router.sheet = .edit(c.item)
                    }
                }
            }
        default: break
        }
    }
}
