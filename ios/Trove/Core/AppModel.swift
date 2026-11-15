import Foundation
import Observation

/// Who is signed in, and to which server.
@Observable final class AppModel {
    enum Phase: Equatable { case signedOut, signedIn }

    private(set) var phase: Phase = .signedOut
    private(set) var account: Account?
    let library = Library()
    /// Shown on the sign-in screen, e.g. after a session expires.
    var notice: String?

    static let defaultServer = "https://trove.mariomedpar.com"

    init() {
        if let dev = DevHooks.account {
            activate(dev)
        } else if DevHooks.value("SIGNEDOUT") == nil, let saved = SecureStore.loadAccount() {
            activate(saved)
        }
    }

    var serverHost: String { account?.baseURL.host() ?? "" }

    func signIn(server: String, secret: String) async throws {
        let url = try Self.normalize(server)
        let account = try await APIClient.signIn(server: url, secret: secret.trimmingCharacters(in: .whitespacesAndNewlines))
        SecureStore.saveAccount(account)
        UserDefaults.standard.set(url.absoluteString, forKey: "lastServer")
        notice = nil
        activate(account)
    }

    func signOut(notice: String? = nil) {
        SecureStore.clear()
        library.disconnect()
        account = nil
        self.notice = notice
        phase = .signedOut
        Task { await DiskCache.clear() }
    }

    private func activate(_ account: Account) {
        self.account = account
        library.connect(APIClient(account: account)) { [weak self] in
            self?.signOut(notice: "Your session ended. Sign in again.")
        }
        phase = .signedIn
    }

    static func normalize(_ input: String) throws -> URL {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { s = defaultServer }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host() != nil else { throw APIError.network("That server address isn’t valid.") }
        return url
    }
}
