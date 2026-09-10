import CoreBluetooth
import Foundation

protocol BleTransportDelegate: AnyObject {
  func bleTransportDidConnect(id: String, name: String)
  func bleTransportDidDisconnect(reason: String)
  func bleTransportDidReceiveText(_ text: String)
  func bleTransportDidUpdateStatus(_ text: String)
  func bleTransportStudioReady(available: Bool)
  func bleTransportStudioData(_ data: Data)
  func bleTransportStudioClosed(reason: String)
}

final class BleTransport: NSObject {
  weak var delegate: BleTransportDelegate?

  private let serviceUUID = CBUUID(string: "2c28159e-1502-4858-8409-d7206655fd84")
  private let commandUUID = CBUUID(string: "2c28159e-1502-4858-8409-d7206655fd85")
  private let streamUUID = CBUUID(string: "2c28159e-1502-4858-8409-d7206655fd86")
  private let hidServiceUUID = CBUUID(string: "1812")
  private let studioServiceUUID = CBUUID(string: "00000000-0196-6107-c967-c5cfb1c2482a")
  private let studioRpcUUID = CBUUID(string: "00000001-0196-6107-c967-c5cfb1c2482a")

  private var centralManager: CBCentralManager!
  private var candidates: [String: CBPeripheral] = [:]
  private var connectingPeripheral: CBPeripheral?
  private var connectedPeripheral: CBPeripheral?
  private var commandCharacteristic: CBCharacteristic?
  private var streamCharacteristic: CBCharacteristic?
  private var studioCharacteristic: CBCharacteristic?
  private var studioWriteQueue: [Data] = []
  private var isWritingStudio = false
  private var pendingConnectId: String?
  private var switchTargetId: String?
  private var pendingDisconnectReason: String?
  private var lastReportedState: CBManagerState?

  override init() {
    super.init()
    centralManager = CBCentralManager(delegate: self, queue: nil)
  }

  func currentCandidates() -> [DeviceCandidate] {
    guard centralManager.state == .poweredOn else { return [] }
    var peripherals = centralManager.retrieveConnectedPeripherals(withServices: [serviceUUID])
    if peripherals.isEmpty {
      peripherals = centralManager.retrieveConnectedPeripherals(withServices: [hidServiceUUID])
    }
    let filtered = peripherals.filter { ($0.name ?? "").lowercased().hasPrefix("lalapadgen2") }
    let summary = peripherals.map { "\($0.name ?? "?")/\($0.state.rawValue)" }.joined(separator: ",")
    log("candidates=\(summary.isEmpty ? "なし" : summary) filtered=\(filtered.count)")
    candidates = Dictionary(uniqueKeysWithValues: filtered.map { ($0.identifier.uuidString, $0) })
    return filtered.map { DeviceCandidate(id: $0.identifier.uuidString, kind: "ble", name: $0.name ?? "LalapadGen2") }
  }

  func connect(id: String) {
    if let existing = connectedPeripheral {
      if existing.identifier.uuidString == id { return }
      switchTargetId = id
      centralManager.cancelPeripheralConnection(existing)
      return
    }
    if let connecting = connectingPeripheral {
      if connecting.identifier.uuidString == id { return }
      switchTargetId = id
      centralManager.cancelPeripheralConnection(connecting)
      return
    }
    guard centralManager.state == .poweredOn else {
      pendingConnectId = id
      delegate?.bleTransportDidUpdateStatus(statusMessage(for: centralManager.state))
      return
    }
    guard let peripheral = candidates[id] else {
      delegate?.bleTransportDidDisconnect(reason: "デバイスが見つかりません")
      return
    }
    peripheral.delegate = self
    connectingPeripheral = peripheral
    log("connect \(peripheral.name ?? "?") state=\(peripheral.state.rawValue)")
    centralManager.connect(peripheral, options: nil)
  }

  private func log(_ text: String) {
    FileHandle.standardError.write("[ble] \(text)\n".data(using: .utf8)!)
  }

  private func studioLog(_ text: String) {
    FileHandle.standardError.write("[studio] \(text)\n".data(using: .utf8)!)
  }

  func studioWrite(_ data: Data) {
    guard let peripheral = connectedPeripheral, studioCharacteristic != nil else {
      delegate?.bleTransportDidUpdateStatus("Studio RPC が利用できません")
      return
    }
    let maxLength = max(peripheral.maximumWriteValueLength(for: .withResponse), 1)
    var offset = 0
    while offset < data.count {
      let end = min(offset + maxLength, data.count)
      studioWriteQueue.append(data.subdata(in: offset..<end))
      offset = end
    }
    studioLog("write \(data.count)B queued=\(studioWriteQueue.count)")
    flushStudioWriteQueue(peripheral: peripheral)
  }

  private func flushStudioWriteQueue(peripheral: CBPeripheral) {
    guard !isWritingStudio, !studioWriteQueue.isEmpty, let characteristic = studioCharacteristic else { return }
    isWritingStudio = true
    let chunk = studioWriteQueue.removeFirst()
    peripheral.writeValue(chunk, for: characteristic, type: .withResponse)
  }

  func disconnect() {
    pendingConnectId = nil
    switchTargetId = nil
    if let peripheral = connectedPeripheral {
      centralManager.cancelPeripheralConnection(peripheral)
    } else if let peripheral = connectingPeripheral {
      centralManager.cancelPeripheralConnection(peripheral)
    }
  }

  func write(_ text: String) {
    guard let peripheral = connectedPeripheral, let characteristic = commandCharacteristic else { return }
    let data = Data(text.utf8)
    let writeType: CBCharacteristicWriteType = characteristic.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
    peripheral.writeValue(data, for: characteristic, type: writeType)
  }

  private func statusMessage(for state: CBManagerState) -> String {
    switch state {
    case .poweredOff:
      return "Bluetooth がオフになっています。システム設定でオンにしてください"
    case .unauthorized:
      return "Bluetooth の使用が許可されていません。システム設定 > プライバシーとセキュリティ > Bluetooth で tp-tuner を許可してください"
    default:
      return "Bluetooth を初期化しています"
    }
  }

  private func teardownConnection() {
    connectedPeripheral = nil
    commandCharacteristic = nil
    streamCharacteristic = nil
    studioCharacteristic = nil
    studioWriteQueue.removeAll()
    isWritingStudio = false
  }
}

extension BleTransport: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    FileHandle.standardError.write("[ble] state=\(central.state.rawValue)\n".data(using: .utf8)!)
    if central.state != .poweredOn, connectedPeripheral != nil || connectingPeripheral != nil {
      connectingPeripheral = nil
      switchTargetId = nil
      teardownConnection()
      delegate?.bleTransportDidDisconnect(reason: "Bluetooth が停止したため切断されました")
      delegate?.bleTransportStudioClosed(reason: "Bluetooth が停止したため切断されました")
    }
    if central.state != lastReportedState {
      lastReportedState = central.state
      if central.state == .poweredOff || central.state == .unauthorized {
        delegate?.bleTransportDidUpdateStatus(statusMessage(for: central.state))
      }
    }
    if central.state == .poweredOn, let id = pendingConnectId {
      pendingConnectId = nil
      connect(id: id)
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectingPeripheral = nil
    connectedPeripheral = peripheral
    log("didConnect \(peripheral.name ?? "?")")
    peripheral.discoverServices([serviceUUID, studioServiceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connectingPeripheral = nil
    log("didFailToConnect \(error?.localizedDescription ?? "-")")
    if let id = switchTargetId {
      switchTargetId = nil
      connect(id: id)
      return
    }
    let reason = "接続に失敗しました: \(error?.localizedDescription ?? "不明なエラー")"
    delegate?.bleTransportDidDisconnect(reason: reason)
    delegate?.bleTransportStudioClosed(reason: reason)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    teardownConnection()
    let reason = pendingDisconnectReason ?? error?.localizedDescription ?? "切断されました"
    pendingDisconnectReason = nil
    log("didDisconnect \(reason)")
    delegate?.bleTransportDidDisconnect(reason: reason)
    delegate?.bleTransportStudioClosed(reason: reason)
    if let id = switchTargetId {
      switchTargetId = nil
      connect(id: id)
    }
  }
}

extension BleTransport: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    log("services=\((peripheral.services ?? []).map { $0.uuid.uuidString }.joined(separator: ",")) error=\(error?.localizedDescription ?? "-")")
    if let studioService = peripheral.services?.first(where: { $0.uuid == studioServiceUUID }) {
      peripheral.discoverCharacteristics([studioRpcUUID], for: studioService)
    } else {
      studioLog("ready=false (service なし)")
      delegate?.bleTransportStudioReady(available: false)
    }
    guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
      pendingDisconnectReason = "tp-tuner サービスがありません(ファームが古い)"
      centralManager.cancelPeripheralConnection(peripheral)
      return
    }
    peripheral.discoverCharacteristics([commandUUID, streamUUID], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    if service.uuid == studioServiceUUID {
      guard let characteristic = service.characteristics?.first(where: { $0.uuid == studioRpcUUID }) else {
        studioLog("ready=false (characteristic なし)")
        delegate?.bleTransportStudioReady(available: false)
        return
      }
      studioCharacteristic = characteristic
      peripheral.setNotifyValue(true, for: characteristic)
      return
    }
    guard let characteristics = service.characteristics else {
      pendingDisconnectReason = "tp-tuner サービスがありません(ファームが古い)"
      centralManager.cancelPeripheralConnection(peripheral)
      return
    }
    for characteristic in characteristics {
      if characteristic.uuid == commandUUID {
        commandCharacteristic = characteristic
      } else if characteristic.uuid == streamUUID {
        streamCharacteristic = characteristic
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }
    if streamCharacteristic == nil {
      pendingDisconnectReason = "tp-tuner サービスがありません(ファームが古い)"
      centralManager.cancelPeripheralConnection(peripheral)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    if characteristic.uuid == studioRpcUUID {
      if let error = error {
        studioLog("ready=false error=\(error.localizedDescription)")
        studioCharacteristic = nil
        delegate?.bleTransportStudioReady(available: false)
        return
      }
      studioLog("ready=\(characteristic.isNotifying)")
      delegate?.bleTransportStudioReady(available: characteristic.isNotifying)
      return
    }
    guard characteristic.uuid == streamUUID else { return }
    log("notify state=\(characteristic.isNotifying) error=\(error?.localizedDescription ?? "-")")
    if let error = error {
      pendingDisconnectReason = "通知の購読に失敗しました: \(error.localizedDescription)"
      centralManager.cancelPeripheralConnection(peripheral)
      return
    }
    delegate?.bleTransportDidConnect(id: peripheral.identifier.uuidString, name: peripheral.name ?? "LalapadGen2")
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if characteristic.uuid == studioRpcUUID {
      guard let data = characteristic.value else { return }
      studioLog("indicate \(data.count)B")
      delegate?.bleTransportStudioData(data)
      return
    }
    guard characteristic.uuid == streamUUID, let data = characteristic.value else { return }
    let text = String(decoding: data, as: UTF8.self)
    log("rx \(data.count)B \(text.prefix(60).replacingOccurrences(of: "\n", with: "⏎"))")
    delegate?.bleTransportDidReceiveText(text)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == studioRpcUUID else { return }
    isWritingStudio = false
    if let error = error {
      studioLog("write error \(error.localizedDescription)")
      studioWriteQueue.removeAll()
      delegate?.bleTransportDidUpdateStatus("Studio RPC の書き込みに失敗しました: \(error.localizedDescription)")
      return
    }
    flushStudioWriteQueue(peripheral: peripheral)
  }
}
