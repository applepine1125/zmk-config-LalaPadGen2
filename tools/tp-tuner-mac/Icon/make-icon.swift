import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write("使い方: swift make-icon.swift <出力先.png>\n".data(using: .utf8)!)
  exit(1)
}

let outputPath = CommandLine.arguments[1]
let size = 1024

let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(
  data: nil,
  width: size,
  height: size,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  FileHandle.standardError.write("CGContext の作成に失敗しました\n".data(using: .utf8)!)
  exit(1)
}

let bounds = CGRect(x: 0, y: 0, width: size, height: size)

func drawBackground() {
  let cornerRadius = CGFloat(size) * 0.22
  let path = CGPath(roundedRect: bounds, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
  context.addPath(path)
  context.clip()

  let colors = [
    CGColor(red: 0.06, green: 0.08, blue: 0.20, alpha: 1),
    CGColor(red: 0.30, green: 0.20, blue: 0.60, alpha: 1),
  ] as CFArray
  guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: [0, 1]) else { return }
  context.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: size),
    end: CGPoint(x: size, y: 0),
    options: []
  )
  context.resetClip()
}

/*
 * LalaPad 左手のワイヤフレーム。config/boards/shields/lalapadgen2/lalapadgen2-layouts.dtsi の
 * 物理配列(100 = 1u)を使い、5 列 4 段のキー、親指キー、その下のトラックパッドを線で描く
 */
struct LayoutRect {
  let x: CGFloat
  let y: CGFloat
  let w: CGFloat
  let h: CGFloat
}

func leftHalfKeys() -> [LayoutRect] {
  var keys: [LayoutRect] = []
  for row in 0..<4 {
    for col in 0..<5 {
      keys.append(LayoutRect(x: CGFloat(col) * 100, y: CGFloat(row) * 100, w: 100, h: 100))
    }
  }
  keys.append(LayoutRect(x: 500, y: 300, w: 100, h: 100))
  return keys
}

let leftHalfTrackpad = LayoutRect(x: 0, y: 420, w: 500, h: 290)

func drawWireframe() {
  let layoutWidth: CGFloat = 600
  let layoutHeight: CGFloat = 710
  let scale = CGFloat(size) * 0.70 / max(layoutWidth, layoutHeight)
  let originX = (CGFloat(size) - layoutWidth * scale) / 2
  let originY = (CGFloat(size) - layoutHeight * scale) / 2
  let gap: CGFloat = 12

  func cgRect(_ r: LayoutRect, inset: CGFloat) -> CGRect {
    let x = originX + (r.x + inset) * scale
    let yTop = originY + (layoutHeight - r.y - inset) * scale
    let w = (r.w - inset * 2) * scale
    let h = (r.h - inset * 2) * scale
    return CGRect(x: x, y: yTop - h, width: w, height: h)
  }

  context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.92))
  context.setLineWidth(CGFloat(size) * 0.010)
  context.setLineJoin(.round)
  for key in leftHalfKeys() {
    let rect = cgRect(key, inset: gap / 2)
    let radius = rect.width * 0.18
    context.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
  }
  context.strokePath()

  let pad = cgRect(leftHalfTrackpad, inset: gap / 2)
  context.setLineWidth(CGFloat(size) * 0.014)
  context.addPath(CGPath(roundedRect: pad, cornerWidth: pad.height * 0.12, cornerHeight: pad.height * 0.12, transform: nil))
  context.strokePath()

  let fingertip = CGPoint(x: pad.midX + pad.width * 0.12, y: pad.midY - pad.height * 0.05)
  let arcRadius = pad.height * 0.22
  context.setLineWidth(CGFloat(size) * 0.014)
  context.setLineCap(.round)
  context.addArc(center: fingertip, radius: arcRadius, startAngle: .pi * 0.85, endAngle: .pi * 1.35, clockwise: false)
  context.strokePath()
  context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  context.addArc(center: fingertip, radius: pad.height * 0.07, startAngle: 0, endAngle: .pi * 2, clockwise: true)
  context.fillPath()
}

drawBackground()
drawWireframe()

guard let image = context.makeImage() else {
  FileHandle.standardError.write("画像の生成に失敗しました\n".data(using: .utf8)!)
  exit(1)
}

let outputURL = URL(fileURLWithPath: outputPath)
guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
  FileHandle.standardError.write("PNG の書き出し先を作成できませんでした\n".data(using: .utf8)!)
  exit(1)
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
  FileHandle.standardError.write("PNG の書き出しに失敗しました\n".data(using: .utf8)!)
  exit(1)
}

print("アイコンを書き出しました: \(outputPath)")
