import CryptoKit
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Loads remote images with a bounded memory cache, a disk cache and downsampling at decode time,
/// so a list of hundreds of covers costs a few MB instead of hundreds.
nonisolated final class ImagePipeline: @unchecked Sendable {
    static let shared = ImagePipeline()

    enum Mode: Sendable, Hashable {
        /// Fill this many points (thumbnails, cards).
        case fill(CGSize)
        /// Fit this width in points, keeping the aspect ratio (reader images).
        case fit(width: CGFloat)
        /// Fill this size and crop the overflow from the center (video covers in the reader).
        case crop(CGSize)
    }

    private let memory = NSCache<NSString, UIImage>()
    private let session: URLSession
    private let directory: URL
    private let coordinator = FetchCoordinator()
    private let lock = NSLock()
    private var failures: [String: Date] = [:]
    static let diskLimit = 250 * 1024 * 1024

    private init() {
        memory.totalCostLimit = 48 * 1024 * 1024
        memory.countLimit = 500
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = 30
        cfg.httpMaximumConnectionsPerHost = 6
        cfg.httpAdditionalHeaders = ["Accept": "image/webp,image/avif,image/*;q=0.9,*/*;q=0.5", "User-Agent": "Trove-iOS/1.0"]
        session = URLSession(configuration: cfg)
        directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "Images", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    // MARK: Keys

    /// Notion serves files from signed URLs that change on every request; key them by path so the cache hits.
    static func stableKey(_ url: URL) -> String {
        let host = url.host() ?? ""
        if host.contains("amazonaws.com") || host.hasSuffix("notion.so") || host.contains("notionusercontent") || host.contains("notion-static") {
            return host + url.path()
        }
        return url.absoluteString
    }

    private func memoryKey(_ url: URL, _ mode: Mode, _ scale: CGFloat, _ radius: CGFloat) -> NSString {
        let m: String
        switch mode {
        case .fill(let s): m = "f\(Int(s.width * scale))x\(Int(s.height * scale))"
        case .fit(let w): m = "w\(Int(w * scale))"
        case .crop(let s): m = "c\(Int(s.width * scale))x\(Int(s.height * scale))"
        }
        return "\(Self.stableKey(url))#\(m)#\(Int(radius))" as NSString
    }

    // MARK: Public

    func cached(_ url: URL, _ mode: Mode, scale: CGFloat, cornerRadius: CGFloat = 0) -> UIImage? {
        memory.object(forKey: memoryKey(url, mode, scale, cornerRadius))
    }

    func image(_ url: URL, _ mode: Mode, scale: CGFloat, cornerRadius: CGFloat = 0) async -> UIImage? {
        let key = memoryKey(url, mode, scale, cornerRadius)
        if let hit = memory.object(forKey: key) { return hit }
        if recentlyFailed(url) { return nil }
        guard let data = await data(for: url), !Task.isCancelled else { return nil }
        guard let image = await Self.decode(data, mode: mode, scale: scale, cornerRadius: cornerRadius) else {
            markFailed(url)
            return nil
        }
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        memory.setObject(image, forKey: key, cost: cost)
        return image
    }

    func clearMemory() { memory.removeAllObjects() }

    func clearDisk() async {
        clearMemory()
        let dir = directory
        await Self.removeContents(of: dir)
    }

    func diskUsage() async -> Int {
        await Self.size(of: directory)
    }

    /// Keep the disk cache under its limit, oldest files first.
    func trimDisk() async {
        await Self.trim(directory, limit: Self.diskLimit)
    }

    @MainActor func installMemoryWarningHandler() {
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
            ImagePipeline.shared.clearMemory()
        }
    }

    // MARK: Loading

    private func data(for url: URL) async -> Data? {
        let stable = Self.stableKey(url)
        let file = directory.appending(path: Self.hash(stable))
        if let cached = await Self.read(file) { return cached }
        let session = self.session
        return await coordinator.fetch(stable) {
            do {
                let (data, response) = try await session.data(from: url)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else { return nil }
                try? data.write(to: file, options: .atomic)
                return data
            } catch {
                return nil
            }
        }
    }

    private func recentlyFailed(_ url: URL) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let at = failures[url.absoluteString] else { return false }
        return Date().timeIntervalSince(at) < 120
    }

    private func markFailed(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        failures[url.absoluteString] = Date()
    }

    // MARK: Decoding

    /// Decode straight to the size it will be shown at (ImageIO thumbnailing never decodes the full image).
    @concurrent static func decode(_ data: Data, mode: Mode, scale: CGFloat, cornerRadius: CGFloat) async -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        var w = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
        var h = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        if let o = (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue, o >= 5 { swap(&w, &h) }
        var maxPixel: Double = 1600
        if w > 0, h > 0 {
            let longest = max(w, h)
            let factor: Double
            switch mode {
            case .fill(let s), .crop(let s): factor = max(Double(s.width * scale) / w, Double(s.height * scale) / h)
            case .fit(let width): factor = Double(width * scale) / w
            }
            maxPixel = min(longest, max(8, (longest * factor).rounded(.up)))
        }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard var cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        if case .crop(let s) = mode, s.width > 0, s.height > 0 {
            let target = s.height / s.width
            let iw = CGFloat(cg.width), ih = CGFloat(cg.height)
            let rect = ih / iw > target
                ? CGRect(x: 0, y: ((ih - iw * target) / 2).rounded(), width: iw, height: (iw * target).rounded())
                : CGRect(x: ((iw - ih / target) / 2).rounded(), y: 0, width: (ih / target).rounded(), height: ih)
            if let cropped = cg.cropping(to: rect) { cg = cropped }
        }
        let image = UIImage(cgImage: cg, scale: scale, orientation: .up)
        guard cornerRadius > 0 else { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: image.size), cornerRadius: cornerRadius).addClip()
            image.draw(at: .zero)
        }
    }

    static func thumbnail(data: Data, maxPixel: Int) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return thumbnail(src, maxPixel: maxPixel)
    }

    static func thumbnail(fileURL: URL, maxPixel: Int) -> UIImage? {
        guard let src = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else { return nil }
        return thumbnail(src, maxPixel: maxPixel)
    }

    private static func thumbnail(_ src: CGImageSource, maxPixel: Int) -> UIImage? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary).map { UIImage(cgImage: $0) }
    }

    /// Re-encode as JPEG (used for HEIC photos), capped to maxPixel on the long side.
    static func jpeg(from data: Data, maxPixel: Int, quality: Double) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    // MARK: Disk helpers (off the main thread)

    static func hash(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    @concurrent static func read(_ file: URL) async -> Data? {
        try? Data(contentsOf: file, options: .mappedIfSafe)
    }

    @concurrent static func size(of dir: URL) async -> Int {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    @concurrent static func removeContents(of dir: URL) async {
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: f)
        }
    }

    @concurrent static func trim(_ dir: URL, limit: Int) async {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys)) ?? []
        var entries = files.compactMap { url -> (URL, Int, Date)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, v.fileSize ?? 0, v.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(0) { $0 + $1.1 }
        guard total > limit else { return }
        entries.sort { $0.2 < $1.2 }
        for (url, size, _) in entries where total > limit * 8 / 10 {
            try? FileManager.default.removeItem(at: url)
            total -= size
        }
    }
}

/// Coalesces concurrent downloads of the same image.
actor FetchCoordinator {
    private var tasks: [String: Task<Data?, Never>] = [:]

    func fetch(_ key: String, _ work: @escaping @Sendable () async -> Data?) async -> Data? {
        if let running = tasks[key] { return await running.value }
        let task = Task { await work() }
        tasks[key] = task
        let value = await task.value
        tasks[key] = nil
        return value
    }
}

// MARK: - SwiftUI

/// A remote image at a known size. Releases its bitmap when scrolled away; the shared cache keeps what fits.
struct RemoteImage<Placeholder: View>: View {
    let url: URL?
    let size: CGSize
    var cornerRadius: CGFloat = 0
    @ViewBuilder var placeholder: () -> Placeholder

    @Environment(\.displayScale) private var scale
    @State private var loaded: UIImage?
    @State private var loadedURL: URL?

    var body: some View {
        let cached = url.flatMap { ImagePipeline.shared.cached($0, .fill(size), scale: scale) }
        let shown = (loadedURL == url ? loaded : nil) ?? cached
        ZStack {
            if let shown {
                Image(uiImage: shown)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            } else {
                placeholder()
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .task(id: url) {
            guard let url, cached == nil else { return }
            let image = await ImagePipeline.shared.image(url, .fill(size), scale: scale)
            guard !Task.isCancelled, let image else { return }
            withAnimation(.easeOut(duration: 0.18)) {
                loaded = image
                loadedURL = url
            }
        }
        .onDisappear {
            loaded = nil
            loadedURL = nil
        }
    }
}
