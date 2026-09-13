import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow!
  private var bridge: WebBridge!
  private let updater = Updater()
  private let isCheckMode = CommandLine.arguments.contains("--check")

  func applicationDidFinishLaunching(_ notification: Notification) {
    bridge = WebBridge { [weak self] in
      self?.handlePageLoaded()
    }

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "tp-tuner"
    window.center()
    window.contentView = bridge.webView
    window.delegate = self
    window.makeKeyAndOrderFront(nil)

    setupMenu()
    bridge.loadPage()
    bridge.start()

    NSApplication.shared.activate(ignoringOtherApps: true)

    if !isCheckMode {
      updater.checkAtLaunch()
    }
  }

  func windowWillClose(_ notification: Notification) {
    NSApplication.shared.terminate(nil)
  }

  private func handlePageLoaded() {
    guard isCheckMode else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
      let probe = "JSON.stringify({native: typeof window.tpTunerNative, status: (document.getElementById('status') || {}).textContent || ''})"
      self?.bridge.webView.evaluateJavaScript(probe) { result, error in
        let text = (result as? String) ?? "評価失敗: \(String(describing: error))"
        FileHandle.standardError.write("[check] \(text)\n".data(using: .utf8)!)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
      exit(0)
    }
  }

  private func setupMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    let checkUpdateItem = NSMenuItem(title: "更新を確認…", action: #selector(checkForUpdates), keyEquivalent: "")
    checkUpdateItem.target = self
    appMenu.addItem(checkUpdateItem)
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit tp-tuner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let fileMenuItem = NSMenuItem()
    let fileMenu = NSMenu(title: "File")
    let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
    reloadItem.target = self
    fileMenu.addItem(reloadItem)
    fileMenuItem.submenu = fileMenu
    mainMenu.addItem(fileMenuItem)

    NSApplication.shared.mainMenu = mainMenu
  }

  @objc private func reloadPage() {
    bridge.reload()
  }

  @objc private func checkForUpdates() {
    updater.checkFromMenu()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
