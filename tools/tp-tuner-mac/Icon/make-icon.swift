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

func drawTrackpad() -> CGRect {
  let width = CGFloat(size) * 0.60
  let height = width * 0.66
  let rect = CGRect(
    x: (CGFloat(size) - width) / 2,
    y: (CGFloat(size) - height) / 2 + CGFloat(size) * 0.03,
    width: width,
    height: height
  )
  let cornerRadius = height * 0.14
  let path = CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)

  context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.92))
  context.setLineWidth(CGFloat(size) * 0.028)
  context.setLineJoin(.round)
  context.addPath(path)
  context.strokePath()

  return rect
}

func drawFingerGesture(in rect: CGRect) {
  let shortSide = min(rect.width, rect.height)
  let center = CGPoint(x: rect.minX + rect.width * 0.60, y: rect.minY + rect.height * 0.50)
  let arcRadius = shortSide * 0.20

  context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.85))
  context.setLineWidth(CGFloat(size) * 0.026)
  context.setLineCap(.round)
  context.addArc(
    center: center,
    radius: arcRadius,
    startAngle: .pi * 0.72,
    endAngle: .pi * 1.28,
    clockwise: false
  )
  context.strokePath()

  let fingertipRadius = shortSide * 0.075
  let fingertipCenter = CGPoint(
    x: center.x + arcRadius * cos(.pi * 1.28),
    y: center.y + arcRadius * sin(.pi * 1.28)
  )
  context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  context.addArc(center: fingertipCenter, radius: fingertipRadius, startAngle: 0, endAngle: .pi * 2, clockwise: true)
  context.fillPath()
}

drawBackground()
let trackpadRect = drawTrackpad()
drawFingerGesture(in: trackpadRect)

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
