import Foundation

struct DeviceCandidate: Equatable {
  let id: String
  let kind: String
  let name: String
}

final class DeviceScanner {
  weak var sink: TransportEventSink?

  private let ble: BleTransport
  private let serial: SerialTransport
  private var timer: DispatchSourceTimer?
  private var lastSent: [DeviceCandidate] = []
  private var isPaused = false

  init(ble: BleTransport, serial: SerialTransport) {
    self.ble = ble
    self.serial = serial
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: .main)
    source.schedule(deadline: .now() + 2, repeating: 2)
    source.setEventHandler { [weak self] in
      self?.tick()
    }
    source.resume()
    timer = source
  }

  func pause() {
    isPaused = true
  }

  func resume() {
    isPaused = false
  }

  func scanNow() {
    let list = collect()
    lastSent = list
    sendDevices(list)
  }

  private func tick() {
    guard !isPaused else { return }
    let list = collect()
    guard list != lastSent else { return }
    lastSent = list
    sendDevices(list)
  }

  private func collect() -> [DeviceCandidate] {
    ble.currentCandidates() + serial.currentCandidates()
  }

  private func sendDevices(_ list: [DeviceCandidate]) {
    let devices = list.map { ["id": $0.id, "kind": $0.kind, "name": $0.name] }
    sink?.send(type: "devices", payload: ["devices": devices])
  }
}
