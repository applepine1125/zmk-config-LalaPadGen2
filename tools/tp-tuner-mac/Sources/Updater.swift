import AppKit

final class Updater {
  private let repoOwner = "applepine1125"
  private let repoName = "zmk-config-LalaPadGen2"
  private let tagPattern = try! NSRegularExpression(pattern: "^tp-tuner-b(\\d+)$")

  private var currentBuild: Int {
    Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") ?? 0
  }

  func checkAtLaunch() {
    guard currentBuild > 0 else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      self?.check(silent: true)
    }
  }

  @objc func checkFromMenu() {
    check(silent: false)
  }

  private func check(silent: Bool) {
    let listURL = URL(string: "https://api.github.com/repos/\(repoOwner)/\(repoName)/releases?per_page=20")!
    var request = URLRequest(url: listURL)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("TpTuner-Updater", forHTTPHeaderField: "User-Agent")

    URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      guard let self else { return }

      if let error {
        self.handleCheckFailure(silent: silent, reason: error.localizedDescription)
        return
      }
      guard let data, let releases = try? JSONDecoder().decode([GhRelease].self, from: data) else {
        self.handleCheckFailure(silent: silent, reason: "リリース情報の解析に失敗しました")
        return
      }

      var best: (build: Int, release: GhRelease)?
      for release in releases {
        let fullRange = NSRange(release.tagName.startIndex..., in: release.tagName)
        guard let match = self.tagPattern.firstMatch(in: release.tagName, range: fullRange),
          let numberRange = Range(match.range(at: 1), in: release.tagName),
          let build = Int(release.tagName[numberRange])
        else { continue }
        if best == nil || build > best!.build {
          best = (build, release)
        }
      }

      guard let best, best.build > self.currentBuild else {
        if !silent {
          DispatchQueue.main.async { self.showUpToDateAlert() }
        }
        return
      }

      guard let asset = best.release.assets.first(where: { $0.name.hasSuffix(".zip") }) else {
        self.handleCheckFailure(silent: silent, reason: "更新アセットが見つかりません")
        return
      }

      DispatchQueue.main.async {
        self.confirmAndUpdate(build: best.build, asset: asset)
      }
    }.resume()
  }

  private func handleCheckFailure(silent: Bool, reason: String) {
    guard !silent else { return }
    DispatchQueue.main.async {
      let alert = NSAlert()
      alert.messageText = "更新の確認に失敗しました"
      alert.informativeText = reason
      alert.runModal()
    }
  }

  private func showUpToDateAlert() {
    let alert = NSAlert()
    alert.messageText = "最新版です"
    alert.informativeText = "現在のバージョンが最新です(build \(currentBuild))"
    alert.runModal()
  }

  private func confirmAndUpdate(build: Int, asset: GhAsset) {
    let alert = NSAlert()
    alert.messageText = "新しいバージョンがあります"
    alert.informativeText = "新しいバージョン(build \(build))があります。更新しますか?"
    alert.addButton(withTitle: "更新する")
    alert.addButton(withTitle: "あとで")
    guard alert.runModal() == .alertFirstButtonReturn, let url = URL(string: asset.browserDownloadURL) else { return }
    downloadAndInstall(from: url)
  }

  private func downloadAndInstall(from url: URL) {
    URLSession.shared.downloadTask(with: url) { [weak self] location, _, error in
      guard let self else { return }
      do {
        guard let location else { throw error ?? UpdaterError.downloadFailed }
        try self.install(downloadedZip: location)
      } catch {
        DispatchQueue.main.async { self.showInstallError(error) }
      }
    }.resume()
  }

  private func install(downloadedZip: URL) throws {
    let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("tp-tuner-update-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: workDir) }

    let zipPath = workDir.appendingPathComponent("update.zip")
    try FileManager.default.moveItem(at: downloadedZip, to: zipPath)
    try run("/usr/bin/ditto", ["-x", "-k", zipPath.path, workDir.path])

    let extractedApps = try FileManager.default.contentsOfDirectory(at: workDir, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "app" }
    guard let newAppURL = extractedApps.first else {
      throw UpdaterError.appNotFoundInArchive
    }
    try run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newAppURL.path])

    let currentBundleURL = Bundle.main.bundleURL
    let backupURL = currentBundleURL.deletingLastPathComponent()
      .appendingPathComponent(currentBundleURL.lastPathComponent + ".old")
    try? FileManager.default.removeItem(at: backupURL)
    try FileManager.default.moveItem(at: currentBundleURL, to: backupURL)

    do {
      try FileManager.default.moveItem(at: newAppURL, to: currentBundleURL)
    } catch {
      try? FileManager.default.moveItem(at: backupURL, to: currentBundleURL)
      throw error
    }
    try? FileManager.default.removeItem(at: backupURL)

    DispatchQueue.main.async {
      NSWorkspace.shared.open(currentBundleURL)
      NSApplication.shared.terminate(nil)
    }
  }

  private func showInstallError(_ error: Error) {
    let alert = NSAlert()
    alert.messageText = "更新に失敗しました"
    alert.informativeText = (error as? UpdaterError)?.description ?? error.localizedDescription
    alert.runModal()
  }

  @discardableResult
  private func run(_ path: String, _ arguments: [String]) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw UpdaterError.commandFailed(path, process.terminationStatus)
    }
    return process.terminationStatus
  }
}

private struct GhAsset: Decodable {
  let name: String
  let browserDownloadURL: String

  private enum CodingKeys: String, CodingKey {
    case name
    case browserDownloadURL = "browser_download_url"
  }
}

private struct GhRelease: Decodable {
  let tagName: String
  let assets: [GhAsset]

  private enum CodingKeys: String, CodingKey {
    case tagName = "tag_name"
    case assets
  }
}

private enum UpdaterError: Error, CustomStringConvertible {
  case downloadFailed
  case appNotFoundInArchive
  case commandFailed(String, Int32)

  var description: String {
    switch self {
    case .downloadFailed: return "ダウンロードに失敗しました"
    case .appNotFoundInArchive: return "アーカイブ内にアプリが見つかりません"
    case .commandFailed(let path, let status): return "\(path) が失敗しました(status \(status))"
    }
  }
}
