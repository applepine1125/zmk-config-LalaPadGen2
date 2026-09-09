import CoreBluetooth
import Foundation

protocol BleTransportDelegate: AnyObject {
  func bleTransportDidConnect(id: String, name: String)
  func bleTransportDidDisconnect(reason: String)
  func bleTransportDidReceiveText(_ text: String)
  func bleTransportDidUpdateStatus(_ text: String)
}

final class BleTransport: NSObject {
  weak var delegate: BleTransportDelegate?

  private let serviceUUID = CBUUID(string: "2c28159e-1502-4858-8409-d7206655fd84")
  private let commandUUID = CBUUID(string: "2c28159e-1502-4858-8409-d7206655fd85")
  private let streamUUID = CBUUID(string: "2c28159e-1502-4858-8409-d7206655fd86")
  private let hidServiceUUID = CBUUID(string: "1812")

  private var centralManager: CBCentralManager!
  private var candidates: [String: CBPeripheral] = [:]
  private var connectedPeripheral: CBPeripheral?
  private var commandCharacteristic: CBCharacteristic?
  private var streamCharacteristic: CBCharacteristic?
  private var pendingConnectId: String?
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
    candidates = Dictionary(uniqueKeysWithValues: filtered.map { ($0.identifier.uuidString, $0) })
    return filtered.map { DeviceCandidate(id: $0.identifier.uuidString, kind: "ble", name: $0.name ?? "LalapadGen2") }
  }

  func connect(id: String) {
    pendingConnectId = id
    guard centralManager.state == .poweredOn else {
      delegate?.bleTransportDidUpdateStatus(statusMessage(for: centralManager.state))
      return
    }
    guard let peripheral = candidates[id] else {
      pendingConnectId = nil
      delegate?.bleTransportDidDisconnect(reason: "デバイスが見つかりません")
      return
    }
    peripheral.delegate = self
    centralManager.connect(peripheral, options: nil)
  }

  func disconnect() {
    pendingConnectId = nil
    if let peripheral = connectedPeripheral {
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
  }
}

extension BleTransport: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    FileHandle.standardError.write("[ble] state=\(central.state.rawValue)\n".data(using: .utf8)!)
    if central.state != lastReportedState {
      lastReportedState = central.state
      if central.state == .poweredOff || central.state == .unauthorized {
        delegate?.bleTransportDidUpdateStatus(statusMessage(for: central.state))
      }
    }
    if central.state == .poweredOn, let id = pendingConnectId {
      connect(id: id)
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectedPeripheral = peripheral
    peripheral.discoverServices([serviceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    pendingConnectId = nil
    delegate?.bleTransportDidDisconnect(reason: "接続に失敗しました: \(error?.localizedDescription ?? "不明なエラー")")
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    teardownConnection()
    pendingConnectId = nil
    let reason = error?.localizedDescription ?? "切断されました"
    delegate?.bleTransportDidDisconnect(reason: reason)
  }
}

extension BleTransport: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
      centralManager.cancelPeripheralConnection(peripheral)
      delegate?.bleTransportDidDisconnect(reason: "tp-tuner サービスがありません(ファームが古い)")
      return
    }
    peripheral.discoverCharacteristics([commandUUID, streamUUID], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard let characteristics = service.characteristics else {
      centralManager.cancelPeripheralConnection(peripheral)
      delegate?.bleTransportDidDisconnect(reason: "tp-tuner サービスがありません(ファームが古い)")
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
      centralManager.cancelPeripheralConnection(peripheral)
      delegate?.bleTransportDidDisconnect(reason: "tp-tuner サービスがありません(ファームが古い)")
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == streamUUID else { return }
    if let error = error {
      centralManager.cancelPeripheralConnection(peripheral)
      delegate?.bleTransportDidDisconnect(reason: "通知の購読に失敗しました: \(error.localizedDescription)")
      return
    }
    pendingConnectId = nil
    delegate?.bleTransportDidConnect(id: peripheral.identifier.uuidString, name: peripheral.name ?? "LalapadGen2")
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == streamUUID, let data = characteristic.value else { return }
    let text = String(decoding: data, as: UTF8.self)
    delegate?.bleTransportDidReceiveText(text)
  }
}
