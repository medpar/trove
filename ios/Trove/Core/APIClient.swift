import Foundation

/// How this device proves who it is: an API key (Bearer) or the web app's session cookie.
nonisolated enum Credential: Codable, Sendable, Equatable {
    case apiKey(String)
    case session(String)

    var isKey: Bool { if case .apiKey = self { true } else { false } }
}

nonisolated struct Account: Codable, Sendable, Equatable {
    var baseURL: URL
    var credential: Credential
    /// Name of the API key on the server (shown as "Via" on saves), when signed in with a key.
    var keyName: String?
}

nonisolated enum APIError: LocalizedError, Sendable, Equatable {
    case unauthorized
    case http(Int, String)
    case offline
    case network(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Your session ended. Sign in again."
        case .http(let code, let message): message.isEmpty ? "The server answered \(code)." : message
        case .offline: "You’re offline."
        case .network(let m): m
        case .decoding(let m): "Unexpected answer from the server (\(m))."
        }
    }
}

/// A tiny JSON tree for request bodies (Sendable, unlike [String: Any]).
nonisolated enum JSONValue: Encodable, Sendable, ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByIntegerLiteral, ExpressibleByNilLiteral {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

    init(stringLiteral value: String) { self = .string(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(nilLiteral: ()) { self = .null }
    init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }

    static func strings(_ list: [String]) -> JSONValue { .array(list.map { .string($0) }) }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }
}

/// Talks to a Trove server (web/app/api). Immutable and Sendable: networking and JSON decoding run off the main thread.
nonisolated final class APIClient: Sendable {
    let account: Account
    private let session: URLSession

    init(account: Account) {
        self.account = account
        session = APIClient.makeSession()
    }

    static func makeSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.timeoutIntervalForRequest = 60
        cfg.httpAdditionalHeaders = ["Accept": "application/json", "User-Agent": "Trove-iOS/1.0"]
        return URLSession(configuration: cfg)
    }

    // MARK: Requests

    func makeRequest(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 60) -> URLRequest {
        makeRequest("GET", path, query: query, timeout: timeout)
    }

    func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], json: JSONValue? = nil, timeout: TimeInterval = 60) -> URLRequest {
        var components = URLComponents(url: account.baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var req = URLRequest(url: components.url!, timeoutInterval: timeout)
        req.httpMethod = method
        authorize(&req)
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONEncoder().encode(json)
        }
        return req
    }

    func authorize(_ req: inout URLRequest) {
        switch account.credential {
        case .apiKey(let key): req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        case .session(let cookie): req.setValue("trove_session=\(cookie)", forHTTPHeaderField: "Cookie")
        }
    }

    @concurrent func send<T: Decodable & Sendable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let data = try await raw(req)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: type))
        }
    }

    func send<T: Decodable & Sendable>(_ req: URLRequest) async throws -> T {
        try await send(req, as: T.self)
    }

    @concurrent func raw(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await APIClient.perform(session, req)
        try APIClient.check(response, data)
        return data
    }

    @concurrent static func perform(_ session: URLSession, _ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.network("No response") }
            return (data, http)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            if [.notConnectedToInternet, .networkConnectionLost, .dataNotAllowed].contains(error.code) { throw APIError.offline }
            if error.code == .timedOut { throw APIError.network("The server took too long to answer.") }
            if [.cannotFindHost, .cannotConnectToHost, .dnsLookupFailed].contains(error.code) {
                throw APIError.network("Can’t reach \(req.url?.host() ?? "the server").")
            }
            throw APIError.network(error.localizedDescription)
        }
    }

    static func check(_ response: HTTPURLResponse, _ data: Data) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if response.statusCode == 401 { throw APIError.unauthorized }
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? ""
        throw APIError.http(response.statusCode, message)
    }

    // MARK: Sign in

    /// Accepts the web password or an API key: tries it as a key first (no rate limit), then as the password.
    @concurrent static func signIn(server: URL, secret: String) async throws -> Account {
        let session = makeSession()
        var me = URLRequest(url: server.appending(path: "/api/me"), timeoutInterval: 30)
        me.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        let (meData, meResponse) = try await perform(session, me)
        if meResponse.statusCode == 200 {
            let info = try? JSONDecoder().decode(MeInfo.self, from: meData)
            return Account(baseURL: server, credential: .apiKey(secret), keyName: info?.apiKeys?.first?.name)
        }
        if meResponse.statusCode != 401 {
            if meResponse.statusCode == 404 { throw APIError.network("That address doesn’t look like a Trove server.") }
            try check(meResponse, meData)
        }

        var login = URLRequest(url: server.appending(path: "/api/auth/login"), timeoutInterval: 30)
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "Content-Type")
        login.httpBody = try JSONEncoder().encode(["password": secret])
        let (data, response) = try await perform(session, login)
        switch response.statusCode {
        case 200:
            guard let cookie = sessionCookie(from: response, url: login.url!) else {
                throw APIError.network("Signed in, but the server sent no session.")
            }
            return Account(baseURL: server, credential: .session(cookie), keyName: nil)
        case 401:
            throw APIError.http(401, "That password or API key isn’t right.")
        default:
            try check(response, data)
            throw APIError.http(response.statusCode, "")
        }
    }

    static func sessionCookie(from response: HTTPURLResponse, url: URL) -> String? {
        var fields: [String: String] = [:]
        for (k, v) in response.allHeaderFields { if let k = k as? String, let v = v as? String { fields[k] = v } }
        if let c = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).first(where: { $0.name == "trove_session" }) {
            return c.value
        }
        let header = fields.first(where: { $0.key.lowercased() == "set-cookie" })?.value ?? ""
        guard let range = header.range(of: #"trove_session=([^;,\s]+)"#, options: .regularExpression) else { return nil }
        return String(header[range].dropFirst("trove_session=".count))
    }
}

// MARK: - Endpoints

nonisolated extension APIClient {
    func me() async throws -> MeInfo {
        try await send(makeRequest("/api/me"))
    }

    func stats(fresh: Bool = false) async throws -> Stats {
        try await send(makeRequest("/api/stats", query: fresh ? [.init(name: "fresh", value: "1")] : []))
    }

    func items(scope: Scope, query: String = "", sort: Sort = .newest, cursor: String? = nil, limit: Int = 40) async throws -> ItemPage {
        var q = scope.queryItems
        if !query.isEmpty { q.append(.init(name: "q", value: query)) }
        q.append(.init(name: "sort", value: sort.rawValue))
        q.append(.init(name: "limit", value: String(limit)))
        if let cursor { q.append(.init(name: "cursor", value: cursor)) }
        return try await send(makeRequest("/api/items", query: q))
    }

    /// Hybrid search: keyword matches plus items that mean the same thing.
    func search(_ query: String, limit: Int = 48) async throws -> SearchResult {
        try await send(makeRequest("/api/search", query: [.init(name: "q", value: query), .init(name: "limit", value: String(limit))]))
    }

    func item(_ id: String) async throws -> ItemContent {
        try await send(makeRequest("/api/items/\(id)", query: [.init(name: "content", value: "1")]))
    }

    func update(_ id: String, _ patch: [String: JSONValue]) async throws -> Item {
        try await send(makeRequest("PATCH", "/api/items/\(id)", json: .object(patch)), as: ItemEnvelope.self).item
    }

    func delete(_ id: String) async throws {
        _ = try await raw(makeRequest("DELETE", "/api/items/\(id)"))
    }

    func save(_ body: [String: JSONValue]) async throws -> SaveResult {
        try await send(makeRequest("POST", "/api/items", json: .object(body), timeout: 120))
    }

    func saveMany(_ bodies: [[String: JSONValue]]) async throws -> BatchSaveResult {
        try await send(makeRequest("POST", "/api/items", json: ["items": .array(bodies.map { .object($0) })], timeout: 240))
    }

    func addHighlight(_ id: String, text: String, note: String?) async throws -> Item {
        var body: [String: JSONValue] = ["text": .string(text)]
        if let note, !note.isEmpty { body["note"] = .string(note) }
        return try await send(makeRequest("POST", "/api/items/\(id)/highlights", json: .object(body)), as: ItemEnvelope.self).item
    }

    func related(_ id: String, limit: Int = 12) async throws -> [Item] {
        try await send(makeRequest("/api/items/\(id)/related", query: [.init(name: "limit", value: String(limit))]), as: ItemsEnvelope.self).items
    }

    func ask(_ question: String) async throws -> AskResult {
        try await send(makeRequest("POST", "/api/ask", json: ["question": .string(question)], timeout: 150))
    }

    func enrich(_ id: String) async throws -> EnrichResult {
        try await send(makeRequest("POST", "/api/enrich", json: ["id": .string(id)], timeout: 300))
    }

    func snapshotRequest(_ id: String) -> URLRequest {
        var req = makeRequest("/api/items/\(id)/snapshot")
        req.setValue("text/html", forHTTPHeaderField: "Accept")
        return req
    }

    // Feeds

    func feeds(_ feedId: String? = nil) async throws -> FeedsResult {
        try await send(makeRequest("/api/feeds", query: feedId.map { [.init(name: "feed", value: $0)] } ?? []))
    }

    func subscribe(url: String, collection: String?, autosave: Bool) async throws -> Feed {
        var body: [String: JSONValue] = ["url": .string(url), "autosave": .bool(autosave)]
        if let collection, !collection.isEmpty { body["collection"] = .string(collection) }
        return try await send(makeRequest("POST", "/api/feeds", json: .object(body), timeout: 60), as: FeedEnvelope.self).feed
    }

    func updateFeed(_ id: String, patch: [String: JSONValue]) async throws -> Feed {
        var body = patch
        body["id"] = .string(id)
        return try await send(makeRequest("PATCH", "/api/feeds", json: .object(body)), as: FeedEnvelope.self).feed
    }

    func unsubscribe(_ id: String) async throws {
        _ = try await raw(makeRequest("DELETE", "/api/feeds", query: [.init(name: "id", value: id)]))
    }
}
