import SwiftUI

/// A list row: title, one line of context, and where it's from; the cover on the right.
struct ItemRow: View, Equatable {
    let item: Item
    @ScaledMetric(relativeTo: .body) private var thumb: CGFloat = 84

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayTitle)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                let blurb = item.blurb
                if !blurb.isEmpty {
                    Text(blurb)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                MetaLine(item: item)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Thumbnail(item: item, size: CGSize(width: min(thumb, 92), height: (min(thumb, 92) * 0.76).rounded()))
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    static func == (a: ItemRow, b: ItemRow) -> Bool { a.item == b.item }
}

struct MetaLine: View {
    let item: Item
    var showsFavicon = true

    var body: some View {
        HStack(spacing: 5) {
            if showsFavicon { FaviconView(item: item, size: 14) }
            Text(item.host.isEmpty ? item.type : item.host)
                .lineLimit(1)
                .layoutPriority(1)
            if let badge = item.lengthBadge {
                Text("·")
                Text(badge).monospacedDigit().lineLimit(1)
            }
            Text("·")
            Text(Fmt.ago(item.createdAt)).lineLimit(1)
            if item.isBroken {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .accessibilityLabel("Broken link")
            }
            if item.highlights > 0 {
                Image(systemName: "highlighter")
                    .accessibilityLabel("\(item.highlights) highlights")
            }
            if item.favorite {
                Image(systemName: "heart.fill")
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Favorite")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .imageScale(.small)
    }
}

/// The cover, or a tile with the site's icon when there's none.
struct Thumbnail: View {
    let item: Item
    let size: CGSize
    var corner: CGFloat = 10

    init(item: Item, size: CGSize, corner: CGFloat = 10) {
        self.item = item
        self.size = size
        self.corner = corner
    }

    init(item: Item, side: CGFloat, corner: CGFloat = 10) {
        self.init(item: item, size: CGSize(width: side, height: side), corner: corner)
    }

    var body: some View {
        let url = item.coverURL ?? (item.isX ? item.iconURL : nil)
        ZStack(alignment: .bottomTrailing) {
            if let url {
                RemoteImage(url: url, size: size, cornerRadius: corner) {
                    FallbackTile(item: item, size: size)
                }
            } else {
                FallbackTile(item: item, size: size)
                    .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
            }
            if item.type == "Video", let d = item.duration, d > 0 {
                Text(Fmt.duration(d))
                    .font(.system(size: 10, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(.black.opacity(0.62), in: Capsule())
                    .padding(4)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
        .frame(width: size.width, height: size.height)
        .accessibilityHidden(true)
    }
}

struct FallbackTile: View {
    let item: Item
    let size: CGSize

    init(item: Item, size: CGSize) {
        self.item = item
        self.size = size
    }

    init(item: Item, side: CGFloat) {
        self.init(item: item, size: CGSize(width: side, height: side))
    }

    var body: some View {
        let side = min(size.width, size.height)
        ZStack {
            (PlatformTint.color(item.platform)?.opacity(0.13) ?? Color(.tertiarySystemFill))
            if item.isNote || item.host.isEmpty {
                Image(systemName: TypeInfo.symbol(item.type))
                    .font(.system(size: side * 0.36, weight: .medium))
                    .foregroundStyle(.secondary)
            } else {
                FaviconView(item: item, size: (side * 0.42).rounded())
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

struct FaviconView: View {
    let item: Item
    let size: CGFloat

    var body: some View {
        let url = item.isX ? (item.iconURL ?? item.faviconURL) : item.faviconURL
        RemoteImage(url: url, size: CGSize(width: size, height: size), cornerRadius: item.isX ? size / 2 : size * 0.22) {
            Image(systemName: TypeInfo.symbol(item.type))
                .font(.system(size: size * 0.7))
                .foregroundStyle(.tertiary)
                .frame(width: size, height: size)
        }
    }
}

/// A gallery card: cover on top, title and source below.
struct ItemCard: View {
    let item: Item
    let width: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            let h = (width * 0.68).rounded()
            ZStack {
                if let url = item.coverURL ?? (item.isX ? item.iconURL : nil) {
                    RemoteImage(url: url, size: CGSize(width: width, height: h), cornerRadius: 14) {
                        FallbackTile(item: item, size: CGSize(width: width, height: h))
                    }
                } else {
                    FallbackTile(item: item, size: CGSize(width: width, height: h))
                        .frame(width: width, height: h)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .frame(width: width, height: h)
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
            Text(item.displayTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            MetaLine(item: item)
        }
        .frame(width: width)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Placeholder rows while the first page loads.
struct SkeletonList: View {
    var body: some View {
        List(0..<9, id: \.self) { i in
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 4).frame(height: 14).frame(maxWidth: [260, 200, 240][i % 3])
                    RoundedRectangle(cornerRadius: 4).frame(height: 11).frame(maxWidth: [220, 180, 150][i % 3])
                    RoundedRectangle(cornerRadius: 4).frame(width: 120, height: 9)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                RoundedRectangle(cornerRadius: 10).frame(width: 84, height: 64)
            }
            .foregroundStyle(Color(.tertiarySystemFill))
            .padding(.vertical, 6)
            .listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .allowsHitTesting(false)
        .accessibilityLabel("Loading")
    }
}

/// The message capsule at the bottom of the window.
struct ToastOverlay: View {
    @Environment(Library.self) private var library

    var body: some View {
        ZStack {
            if let toast = library.toast {
                HStack(spacing: 10) {
                    if let icon = toast.systemImage {
                        Image(systemName: icon)
                            .foregroundStyle(toast.isError ? .orange : Color.accentColor)
                    }
                    Text(toast.text)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                    if let label = toast.actionLabel, let action = toast.action {
                        Button(label) {
                            library.toast = nil
                            action()
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
                .shadow(color: .black.opacity(0.14), radius: 16, y: 6)
                .padding(.horizontal, 20)
                .padding(.bottom, 64)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onTapGesture { library.toast = nil }
                .id(toast.id)
            }
        }
        .animation(.spring(duration: 0.35, bounce: 0.2), value: library.toast)
        .sensoryFeedback(trigger: library.toast) { _, new in
            guard let new else { return nil }
            return new.isError ? .error : .success
        }
    }
}
