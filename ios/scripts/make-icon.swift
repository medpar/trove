// Draws Trove's app icon (the bookmark from web/public/icons/logo.svg) at 1024 px in the three
// variants iOS uses: light (any), dark and tinted. Run: swift scripts/make-icon.swift <out dir>
import AppKit
import CoreGraphics

let ember = CGColor(srgbRed: 0xD2 / 255, green: 0x4A / 255, blue: 0x12 / 255, alpha: 1)
let emberBright = CGColor(srgbRed: 0xEF / 255, green: 0x84 / 255, blue: 0x48 / 255, alpha: 1)
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

enum Variant: String, CaseIterable { case light = "AppIcon", dark = "AppIcon-Dark", tinted = "AppIcon-Tinted" }

func draw(_ v: Variant, size: Int = 1024) -> Data {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(size) / 100
    // SVG coordinates are top-down; flip so the path reads like the source.
    ctx.translateBy(x: 0, y: CGFloat(size))
    ctx.scaleBy(x: s, y: -s)

    switch v {
    case .light:
        ctx.setFillColor(ember)
        ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
    case .dark:
        // Dark icons sit on the system's dark backdrop: draw a deep tone of the brand color.
        ctx.setFillColor(CGColor(srgbRed: 0x1A / 255, green: 0x14 / 255, blue: 0x12 / 255, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
    case .tinted:
        ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
    }

    // Bookmark: M30 25 a5 5 0 0 1 5-5 h30 a5 5 0 0 1 5 5 v57 L50 66 30 82 z, scaled a touch for the icon grid.
    ctx.saveGState()
    ctx.translateBy(x: 50, y: 51)
    ctx.scaleBy(x: 1.06, y: 1.06)
    ctx.translateBy(x: -50, y: -51)
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 30, y: 25))
    p.addArc(tangent1End: CGPoint(x: 30, y: 20), tangent2End: CGPoint(x: 35, y: 20), radius: 5)
    p.addLine(to: CGPoint(x: 65, y: 20))
    p.addArc(tangent1End: CGPoint(x: 70, y: 20), tangent2End: CGPoint(x: 70, y: 25), radius: 5)
    p.addLine(to: CGPoint(x: 70, y: 82))
    p.addLine(to: CGPoint(x: 50, y: 66))
    p.addLine(to: CGPoint(x: 30, y: 82))
    p.closeSubpath()
    ctx.addPath(p)
    switch v {
    case .light: ctx.setFillColor(white)
    case .dark: ctx.setFillColor(emberBright)
    case .tinted: ctx.setFillColor(white)
    }
    ctx.fillPath()
    // The dot punches through to the background color.
    let dot = CGRect(x: 50 - 7.5, y: 40 - 7.5, width: 15, height: 15)
    switch v {
    case .light: ctx.setFillColor(ember)
    case .dark: ctx.setFillColor(CGColor(srgbRed: 0x1A / 255, green: 0x14 / 255, blue: 0x12 / 255, alpha: 1))
    case .tinted: ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
    }
    ctx.fillEllipse(in: dot)
    ctx.restoreGState()

    let image = ctx.makeImage()!
    let rep = NSBitmapImageRep(cgImage: image)
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.dropFirst().first ?? "."
for v in Variant.allCases {
    let url = URL(fileURLWithPath: out).appendingPathComponent("\(v.rawValue).png")
    try! draw(v).write(to: url)
    print("wrote", url.path)
}
