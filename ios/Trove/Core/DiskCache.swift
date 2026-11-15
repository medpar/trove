import Foundation

/// Last-known responses (stats, first page of each list) so the app opens instantly, then refreshes.
nonisolated enum DiskCache {
    private static var directory: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "Data", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func file(_ key: String) -> URL {
        directory.appending(path: ImagePipeline.hash(key) + ".json")
    }

    @concurrent static func load<T: Decodable & Sendable>(_ type: T.Type, _ key: String) async -> T? {
        guard let data = try? Data(contentsOf: file(key)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    @concurrent static func save<T: Encodable & Sendable>(_ value: T, _ key: String) async {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: file(key), options: .atomic)
    }

    @concurrent static func clear() async {
        for f in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: f)
        }
    }
}
