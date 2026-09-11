import WebKit
import AppKit

protocol TransportEventSink: AnyObject {
  func send(type: String, payload: [String: Any])
}

final class WebBridge: NSObject {
  let webView: WKWebView

  private let ble = BleTransport()
  private let serial = SerialTransport()
  private lazy var scanner = DeviceScanner(ble: ble, serial: serial)
  private var connectedKind: String?
  private let onPageLoaded: () -> Void

  private static let consoleBridgeSource = """
  (function () {
    function send(level, args) {
      try {
        var text = Array.prototype.map.call(args, function (a) {
          try { return typeof a === 'string' ? a : JSON.stringify(a) } catch (e) { return String(a) }
        }).join(' ')
        window.webkit.messageHandlers.tpTuner.postMessage({ type: 'console', level: level, text: text })
      } catch (e) {}
    }
    var original = { log: console.log, warn: console.warn, error: console.error }
    console.log = function () { send('log', arguments); original.log.apply(console, arguments) }
    console.warn = function () { send('warn', arguments); original.warn.apply(console, arguments) }
    console.error = function () { send('error', arguments); original.error.apply(console, arguments) }
    window.addEventListener('error', function (e) {
      send('error', ['uncaught: ' + (e.message || e) + ' @' + (e.filename || '') + ':' + (e.lineno || 0)])
    })
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason
      send('error', ['unhandled rejection: ' + (r && r.stack ? r.stack : String(r))])
    })
  })();
  """

  init(onPageLoaded: @escaping () -> Void) {
    self.onPageLoaded = onPageLoaded

    let config = WKWebViewConfiguration()
    let consoleScript = WKUserScript(source: WebBridge.consoleBridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    config.userContentController.addUserScript(consoleScript)
    webView = WKWebView(frame: .zero, configuration: config)

    super.init()

    config.userContentController.add(self, name: "tpTuner")
    webView.navigationDelegate = self
    webView.uiDelegate = self

    ble.delegate = self
    serial.delegate = self
    scanner.sink = self
  }

  func start() {
    scanner.start()
  }

  func loadPage() {
    guard let resourceURL = Bundle.main.resourceURL else {
      FileHandle.standardError.write("リソースディレクトリが見つかりません\n".data(using: .utf8)!)
      return
    }
    let webDirectory = resourceURL.appendingPathComponent("web")
    let indexURL = webDirectory.appendingPathComponent("index.html")
    webView.loadFileURL(indexURL, allowingReadAccessTo: webDirectory)
  }

  func reload() {
    webView.reload()
  }

  private func handlePageMessage(type: String, json: [String: Any]) {
    switch type {
    case "listDevices":
      scanner.scanNow()
    case "connect":
      guard let id = json["id"] as? String else { return }
      if id.hasPrefix("/dev/") {
        serial.connect(id: id)
      } else {
        ble.connect(id: id)
      }
    case "disconnect":
      if connectedKind == "usb" {
        serial.disconnect()
      } else if connectedKind == "ble" {
        ble.disconnect()
      }
    case "write":
      guard let text = json["text"] as? String else { return }
      if connectedKind == "usb" {
        serial.write(text)
      } else if connectedKind == "ble" {
        ble.write(text)
      }
    case "studioWrite":
      guard let b64 = json["b64"] as? String, let data = Data(base64Encoded: b64) else { return }
      if connectedKind == "usb" {
        serial.studioWrite(data)
      } else if connectedKind == "ble" {
        ble.studioWrite(data)
      }
    case "studioOpen":
      guard let id = json["id"] as? String else { return }
      serial.studioOpen(id: id)
    case "studioClose":
      serial.studioClose()
    case "saveFile":
      guard let name = json["name"] as? String, let text = json["text"] as? String else { return }
      saveFile(name: name, text: text)
    case "presetsLoad":
      loadPresets()
    case "presetsSave":
      guard let text = json["text"] as? String else { return }
      savePresets(text: text)
    default:
      break
    }
  }

  private func presetsFileURL() -> URL {
    let supportDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return supportDir.appendingPathComponent("TpTuner/presets.json")
  }

  private func loadPresets() {
    let url = presetsFileURL()
    guard FileManager.default.fileExists(atPath: url.path) else {
      send(type: "presetsLoaded", payload: ["ok": true])
      return
    }
    do {
      let text = try String(contentsOf: url, encoding: .utf8)
      send(type: "presetsLoaded", payload: ["ok": true, "text": text])
    } catch {
      send(type: "presetsLoaded", payload: ["ok": false, "error": error.localizedDescription])
    }
  }

  private func savePresets(text: String) {
    let url = presetsFileURL()
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(text.utf8).write(to: url, options: .atomic)
      send(type: "presetsSaved", payload: ["ok": true])
    } catch {
      send(type: "presetsSaved", payload: ["ok": false, "error": error.localizedDescription])
    }
  }

  private func saveFile(name: String, text: String) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = name
    panel.canCreateDirectories = true
    panel.allowsOtherFileTypes = true
    if let dir = UserDefaults.standard.string(forKey: "lastSaveDirectory") {
      panel.directoryURL = URL(fileURLWithPath: dir, isDirectory: true)
    }
    panel.begin { [weak self] response in
      guard let self = self else { return }
      guard response == .OK, let url = panel.url else {
        self.send(type: "fileSaved", payload: ["ok": false, "cancelled": true])
        return
      }
      do {
        try text.write(to: url, atomically: true, encoding: .utf8)
        UserDefaults.standard.set(url.deletingLastPathComponent().path, forKey: "lastSaveDirectory")
        self.send(type: "fileSaved", payload: ["ok": true, "path": url.path])
      } catch {
        self.send(type: "fileSaved", payload: ["ok": false, "error": error.localizedDescription])
      }
    }
  }
}

extension WebBridge: WKScriptMessageHandler {
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    if type == "console" {
      let level = body["level"] as? String ?? "log"
      let text = body["text"] as? String ?? ""
      FileHandle.standardError.write("[page:\(level)] \(text)\n".data(using: .utf8)!)
      return
    }
    handlePageMessage(type: type, json: body)
  }
}

/* WKWebView は alert / confirm をアプリが実装しないと黙って閉じる(confirm は常に false)ので NSAlert で出す */
extension WebBridge: WKUIDelegate {
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "キャンセル")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }
}

extension WebBridge: WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    FileHandle.standardError.write("page loaded\n".data(using: .utf8)!)
    onPageLoaded()
  }
}

extension WebBridge: BleTransportDelegate {
  func bleTransportDidConnect(id: String, name: String) {
    connectedKind = "ble"
    scanner.pause()
    send(type: "connected", payload: ["id": id, "kind": "ble", "name": name])
  }

  func bleTransportDidDisconnect(reason: String) {
    connectedKind = nil
    scanner.resume()
    send(type: "disconnected", payload: ["reason": reason])
  }

  func bleTransportDidReceiveText(_ text: String) {
    send(type: "data", payload: ["text": text])
  }

  func bleTransportDidUpdateStatus(_ text: String) {
    send(type: "status", payload: ["text": text])
  }

  func bleTransportStudioReady(available: Bool) {
    send(type: "studioReady", payload: ["available": available])
  }

  func bleTransportStudioData(_ data: Data) {
    send(type: "studioData", payload: ["b64": data.base64EncodedString()])
  }

  func bleTransportStudioClosed(reason: String) {
    send(type: "studioClosed", payload: ["reason": reason])
  }
}

extension WebBridge: SerialTransportDelegate {
  func serialTransportDidConnect(id: String, name: String) {
    connectedKind = "usb"
    scanner.pause()
    send(type: "connected", payload: ["id": id, "kind": "usb", "name": name])
  }

  func serialTransportDidDisconnect(reason: String) {
    connectedKind = nil
    scanner.resume()
    send(type: "disconnected", payload: ["reason": reason])
  }

  func serialTransportDidReceiveText(_ text: String) {
    send(type: "data", payload: ["text": text])
  }

  func serialTransportDidUpdateStatus(_ text: String) {
    send(type: "status", payload: ["text": text])
  }

  func serialTransportStudioReady(available: Bool) {
    send(type: "studioReady", payload: ["available": available])
  }

  func serialTransportStudioData(_ data: Data) {
    send(type: "studioData", payload: ["b64": data.base64EncodedString()])
  }

  func serialTransportStudioClosed(reason: String) {
    send(type: "studioClosed", payload: ["reason": reason])
  }
}

extension WebBridge: TransportEventSink {
  func send(type: String, payload: [String: Any]) {
    var merged = payload
    merged["type"] = type
    guard let data = try? JSONSerialization.data(withJSONObject: merged, options: []) else {
      FileHandle.standardError.write("イベントの JSON 変換に失敗しました: \(type)\n".data(using: .utf8)!)
      return
    }
    let json = String(decoding: data, as: UTF8.self)
    let script = "window.tpTunerNative && window.tpTunerNative.onEvent(\(json));"
    DispatchQueue.main.async {
      self.webView.evaluateJavaScript(script) { _, error in
        if let error = error {
          FileHandle.standardError.write("evaluateJavaScript 失敗: \(error)\n".data(using: .utf8)!)
        }
      }
    }
  }
}
