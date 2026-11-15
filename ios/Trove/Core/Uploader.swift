import CryptoKit
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// A file picked from Photos or Files, staged in the app's temporary folder until it's uploaded.
nonisolated struct UploadFile: Sendable, Identifiable {
    let id = UUID()
    var url: URL
    var filename: String
    var mime: String
    var size: Int64
    var thumbnail: UIImage?

    var isImage: Bool { mime.hasPrefix("image/") }
    var isVideo: Bool { mime.hasPrefix("video/") }

    static func mime(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    /// Copy a picked file into our temp folder (security-scoped URLs from Files expire).
    static func stage(from source: URL, filename: String? = nil) throws -> UploadFile {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let name = filename ?? source.lastPathComponent
        let dir = FileManager.default.temporaryDirectory.appending(path: "uploads/\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appending(path: name)
        try FileManager.default.copyItem(at: source, to: dest)
        let size = (try? dest.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        let mime = mime(for: dest)
        let thumb = mime.hasPrefix("image/") ? ImagePipeline.thumbnail(fileURL: dest, maxPixel: 240) : nil
        return UploadFile(url: dest, filename: name, mime: mime, size: size, thumbnail: thumb)
    }

    /// Photos hands us bytes; HEIC is converted to JPEG so every Trove view can show it.
    static func stage(imageData data: Data, suggestedName: String) throws -> UploadFile {
        var bytes = data
        var name = suggestedName
        let type = CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceGetType($0) as String? } ?? ""
        if type == UTType.heic.identifier || type == UTType.heif.identifier || type.isEmpty {
            if let jpeg = ImagePipeline.jpeg(from: data, maxPixel: 4096, quality: 0.86) {
                bytes = jpeg
                name = (name as NSString).deletingPathExtension + ".jpg"
            }
        } else if let ext = UTType(type)?.preferredFilenameExtension {
            name = (name as NSString).deletingPathExtension + "." + ext
        }
        let dir = FileManager.default.temporaryDirectory.appending(path: "uploads/\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appending(path: name)
        try bytes.write(to: dest)
        return UploadFile(url: dest, filename: name, mime: mime(for: dest), size: Int64(bytes.count), thumbnail: ImagePipeline.thumbnail(data: bytes, maxPixel: 240))
    }

    func discard() {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}

/// Reports bytes sent for one upload task.
nonisolated final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let onProgress: @Sendable (Double) -> Void
    init(_ onProgress: @escaping @Sendable (Double) -> Void) { self.onProgress = onProgress }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

nonisolated extension APIClient {
    /// Files up to this size go in one request; bigger ones are staged in storage first (web/lib/files.ts).
    static let directLimit: Int64 = 4 * 1024 * 1024 - 64 * 1024

    /// Save a file into Trove (POST /api/files), staging big ones through POST /api/files/uploads.
    @concurrent func upload(_ file: UploadFile, fields: [String: String], progress: @escaping @Sendable (Double) -> Void) async throws -> SaveResult {
        let session = URLSession(configuration: .default)
        defer { session.finishTasksAndInvalidate() }
        if file.size <= APIClient.directLimit {
            let boundary = "trove-\(UUID().uuidString)"
            var body = Data()
            func field(_ name: String, _ value: String) {
                body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
            }
            for (k, v) in fields where !v.isEmpty { field(k, v) }
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(file.filename.replacingOccurrences(of: "\"", with: ""))\"\r\nContent-Type: \(file.mime)\r\n\r\n".data(using: .utf8)!)
            body.append(try Data(contentsOf: file.url))
            body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
            var req = makeRequest("POST", "/api/files", timeout: 300)
            req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            let (data, response) = try await session.upload(for: req, from: body, delegate: UploadProgress(progress))
            guard let http = response as? HTTPURLResponse else { throw APIError.network("No response") }
            try APIClient.check(http, data)
            return try JSONDecoder().decode(SaveResult.self, from: data)
        }

        // 1. Ask for an upload URL (or learn that this exact file is already saved).
        var ticketBody: [String: JSONValue] = [
            "filename": .string(file.filename), "size": .number(Double(file.size)), "content_type": .string(file.mime),
        ]
        if let sha = APIClient.sha256(of: file.url) { ticketBody["sha256"] = .string(sha) }
        for (k, v) in fields where !v.isEmpty { ticketBody[k] = .string(v) }
        let ticket: UploadTicket = try await send(makeRequest("POST", "/api/files/uploads", json: .object(ticketBody)))
        if ticket.duplicate == true, let item = ticket.item { return SaveResult(item: item, created: false) }
        guard let token = ticket.upload, let put = ticket.put, let putURL = URL(string: put.url) else {
            throw APIError.network("The server didn’t return an upload address.")
        }

        // 2. Send the bytes straight to storage.
        var putReq = URLRequest(url: putURL, timeoutInterval: 600)
        putReq.httpMethod = put.method ?? "PUT"
        for (k, v) in put.headers ?? [:] { putReq.setValue(v, forHTTPHeaderField: k) }
        let (putData, putResponse) = try await session.upload(for: putReq, fromFile: file.url, delegate: UploadProgress { progress($0 * 0.95) })
        guard let putHTTP = putResponse as? HTTPURLResponse else { throw APIError.network("No response from storage") }
        guard (200..<300).contains(putHTTP.statusCode) else {
            throw APIError.http(putHTTP.statusCode, String(data: putData, encoding: .utf8)?.prefix(160).description ?? "Upload failed")
        }

        // 3. Tell Trove to move it into Notion.
        var finish: [String: JSONValue] = ["upload": .string(token)]
        for (k, v) in fields where !v.isEmpty { finish[k] = .string(v) }
        let result: SaveResult = try await send(makeRequest("POST", "/api/files", json: .object(finish), timeout: 300))
        progress(1)
        return result
    }

    static func sha256(of url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
