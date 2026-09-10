import Foundation
#if canImport(Darwin)
import Darwin
#endif

protocol SerialTransportDelegate: AnyObject {
  func serialTransportDidConnect(id: String, name: String)
  func serialTransportDidDisconnect(reason: String)
  func serialTransportDidReceiveText(_ text: String)
  func serialTransportDidUpdateStatus(_ text: String)
  func serialTransportStudioReady(available: Bool)
  func serialTransportStudioData(_ data: Data)
  func serialTransportStudioClosed(reason: String)
}

final class SerialTransport {
  weak var delegate: SerialTransportDelegate?

  private var fileDescriptor: Int32 = -1
  private var connectedPath: String?
  private var isReading = false
  private let readStoppedSemaphore = DispatchSemaphore(value: 0)

  private var studioFileDescriptor: Int32 = -1
  private var studioPath: String?
  private var isStudioReading = false
  private let studioReadStoppedSemaphore = DispatchSemaphore(value: 0)

  func currentCandidates() -> [DeviceCandidate] {
    var globResult = glob_t()
    defer { globfree(&globResult) }
    var result: [DeviceCandidate] = []
    if glob("/dev/cu.usbmodem*", 0, nil, &globResult) == 0 {
      let count = Int(globResult.gl_matchc)
      for index in 0..<count {
        guard let pathPointer = globResult.gl_pathv[index] else { continue }
        let path = String(cString: pathPointer)
        let name = (path as NSString).lastPathComponent
        result.append(DeviceCandidate(id: path, kind: "usb", name: name))
      }
    }
    let summary = result.isEmpty ? "なし" : result.map { $0.id }.joined(separator: ", ")
    FileHandle.standardError.write("[usb] candidates=\(summary)\n".data(using: .utf8)!)
    return result
  }

  func connect(id: String) {
    if fileDescriptor >= 0 {
      if connectedPath == id { return }
      closeCurrentConnection(reason: "切断しました")
    }

    guard let fd = openPort(id) else {
      delegate?.serialTransportDidDisconnect(reason: "USB デバイスを開けませんでした: \(id)")
      return
    }

    fileDescriptor = fd
    connectedPath = id
    let name = (id as NSString).lastPathComponent
    delegate?.serialTransportDidConnect(id: id, name: name)
    startReading(fd: fd)
  }

  func disconnect() {
    guard fileDescriptor >= 0 else { return }
    closeCurrentConnection(reason: "切断しました")
  }

  func write(_ text: String) {
    guard fileDescriptor >= 0 else { return }
    let bytes = Array(text.utf8)
    var offset = 0
    bytes.withUnsafeBufferPointer { buffer in
      guard let base = buffer.baseAddress else { return }
      while offset < buffer.count {
        let written = Darwin.write(fileDescriptor, base.advanced(by: offset), buffer.count - offset)
        if written <= 0 { break }
        offset += written
      }
    }
  }

  func studioOpen(id: String) {
    if studioFileDescriptor >= 0 {
      if studioPath == id { return }
      closeStudioConnection(reason: "切断しました")
    }

    guard let fd = openPort(id) else {
      delegate?.serialTransportStudioReady(available: false)
      delegate?.serialTransportDidUpdateStatus("Studio 用の USB ポートを開けませんでした: \(id)")
      return
    }

    studioFileDescriptor = fd
    studioPath = id
    FileHandle.standardError.write("[studio] open \(id)\n".data(using: .utf8)!)
    delegate?.serialTransportStudioReady(available: true)
    delegate?.serialTransportDidUpdateStatus("Studio 用の USB ポートに接続しました")
    startStudioReading(fd: fd)
  }

  func studioClose() {
    guard studioFileDescriptor >= 0 else { return }
    closeStudioConnection(reason: "閉じました")
  }

  func studioWrite(_ data: Data) {
    guard studioFileDescriptor >= 0 else {
      delegate?.serialTransportDidUpdateStatus("Studio ポートが開いていません")
      return
    }
    let bytes = Array(data)
    var offset = 0
    bytes.withUnsafeBufferPointer { buffer in
      guard let base = buffer.baseAddress else { return }
      while offset < buffer.count {
        let written = Darwin.write(studioFileDescriptor, base.advanced(by: offset), buffer.count - offset)
        if written <= 0 { break }
        offset += written
      }
    }
    FileHandle.standardError.write("[studio] write \(data.count)B\n".data(using: .utf8)!)
  }

  private func openPort(_ path: String) -> Int32? {
    let fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
    guard fd >= 0 else { return nil }

    var options = termios()
    if tcgetattr(fd, &options) != 0 {
      FileHandle.standardError.write("[usb] tcgetattr に失敗しました: \(path)\n".data(using: .utf8)!)
    }
    cfmakeraw(&options)
    cfsetspeed(&options, speed_t(115200))
    options.c_cflag &= ~tcflag_t(CSIZE)
    options.c_cflag |= tcflag_t(CS8)
    options.c_cflag &= ~tcflag_t(PARENB)
    options.c_cflag &= ~tcflag_t(CSTOPB)
    options.c_cflag |= tcflag_t(CLOCAL | CREAD)
    if tcsetattr(fd, TCSANOW, &options) != 0 {
      FileHandle.standardError.write("[usb] tcsetattr に失敗しました: \(path)\n".data(using: .utf8)!)
    }

    if ioctl(fd, TIOCSDTR) != 0 {
      FileHandle.standardError.write("[usb] DTR の設定に失敗しました: \(path)\n".data(using: .utf8)!)
    }

    return fd
  }

  private func startReading(fd: Int32) {
    isReading = true
    let queue = DispatchQueue(label: "tp-tuner.serial.read")
    queue.async { [weak self] in
      var buffer = [UInt8](repeating: 0, count: 256)
      var disconnectedByPeer = false
      while self?.isReading == true {
        var pollfds = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let ready = poll(&pollfds, 1, 200)
        if ready < 0 {
          if errno == EINTR { continue }
          disconnectedByPeer = true
          break
        }
        if ready == 0 { continue }

        let count = read(fd, &buffer, buffer.count)
        if count > 0 {
          let chunk = Array(buffer[0..<count])
          let text = String(decoding: chunk, as: UTF8.self)
          DispatchQueue.main.async {
            self?.delegate?.serialTransportDidReceiveText(text)
          }
        } else if count == 0 {
          disconnectedByPeer = true
          break
        } else {
          if errno == EAGAIN || errno == EINTR { continue }
          disconnectedByPeer = true
          break
        }
      }
      self?.readStoppedSemaphore.signal()
      if disconnectedByPeer {
        DispatchQueue.main.async {
          self?.handlePeerDisconnected()
        }
      }
    }
  }

  private func handlePeerDisconnected() {
    guard fileDescriptor >= 0 else { return }
    closeCurrentConnection(reason: "USB が切断されました")
  }

  private func closeCurrentConnection(reason: String) {
    isReading = false
    _ = readStoppedSemaphore.wait(timeout: .now() + 1)
    if fileDescriptor >= 0 {
      close(fileDescriptor)
      fileDescriptor = -1
    }
    connectedPath = nil
    if studioFileDescriptor >= 0 {
      closeStudioConnection(reason: reason)
    }
    delegate?.serialTransportDidDisconnect(reason: reason)
  }

  private func startStudioReading(fd: Int32) {
    isStudioReading = true
    let queue = DispatchQueue(label: "tp-tuner.serial.studio.read")
    queue.async { [weak self] in
      var buffer = [UInt8](repeating: 0, count: 256)
      var disconnectedByPeer = false
      while self?.isStudioReading == true {
        var pollfds = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let ready = poll(&pollfds, 1, 200)
        if ready < 0 {
          if errno == EINTR { continue }
          disconnectedByPeer = true
          break
        }
        if ready == 0 { continue }

        let count = read(fd, &buffer, buffer.count)
        if count > 0 {
          let data = Data(buffer[0..<count])
          FileHandle.standardError.write("[studio] indicate \(count)B\n".data(using: .utf8)!)
          DispatchQueue.main.async {
            self?.delegate?.serialTransportStudioData(data)
          }
        } else if count == 0 {
          disconnectedByPeer = true
          break
        } else {
          if errno == EAGAIN || errno == EINTR { continue }
          disconnectedByPeer = true
          break
        }
      }
      self?.studioReadStoppedSemaphore.signal()
      if disconnectedByPeer {
        DispatchQueue.main.async {
          self?.handleStudioPeerDisconnected()
        }
      }
    }
  }

  private func handleStudioPeerDisconnected() {
    guard studioFileDescriptor >= 0 else { return }
    closeStudioConnection(reason: "Studio ポートが切断されました")
  }

  private func closeStudioConnection(reason: String) {
    isStudioReading = false
    _ = studioReadStoppedSemaphore.wait(timeout: .now() + 1)
    if studioFileDescriptor >= 0 {
      close(studioFileDescriptor)
      studioFileDescriptor = -1
    }
    studioPath = nil
    FileHandle.standardError.write("[studio] close \(reason)\n".data(using: .utf8)!)
    delegate?.serialTransportStudioClosed(reason: reason)
  }
}
