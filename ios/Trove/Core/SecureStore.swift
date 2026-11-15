import Foundation
import Security

/// Keeps the account (server + key or session) in the Keychain. Some sideloading containers don't grant
/// Keychain access, so it falls back to a file protected by iOS data protection.
nonisolated enum SecureStore {
    private static let service = "com.mariomedpar.trove"
    private static let accountKey = "account"

    private static var fallbackURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appending(path: "account.json")
    }

    static func loadAccount() -> Account? {
        let data = keychainRead() ?? (try? Data(contentsOf: fallbackURL))
        return data.flatMap { try? JSONDecoder().decode(Account.self, from: $0) }
    }

    static func saveAccount(_ account: Account) {
        guard let data = try? JSONEncoder().encode(account) else { return }
        if keychainWrite(data) {
            try? FileManager.default.removeItem(at: fallbackURL)
        } else {
            try? data.write(to: fallbackURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    static func clear() {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: accountKey]
        SecItemDelete(q as CFDictionary)
        try? FileManager.default.removeItem(at: fallbackURL)
    }

    private static func keychainRead() -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: accountKey,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    private static func keychainWrite(_ data: Data) -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: accountKey]
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return true }
        if status == errSecItemNotFound {
            return SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil) == errSecSuccess
        }
        return false
    }
}
