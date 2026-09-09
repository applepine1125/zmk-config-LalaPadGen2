import Foundation
#if canImport(Darwin)
import Darwin
#endif

protocol SerialTransportDelegate: AnyObject {
  func serialTransportDidConnect(id: String, name: String)
  func serialTransportDidDisconnect(reason: String)
  func serialTransportDidReceiveText(_ text: String)
}

final class SerialTransport {
  weak var delegate: SerialTransportDelegate?

  private var fileDescriptor: Int32 = -1
  private var connectedPath: String?
  private var isReading = false
  private let readStoppedSemaphore = DispatchSemaphore(value: 0)

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

    let fd = open(id, O_RDWR | O_NOCTTY | O_NONBLOCK)
    guard fd >= 0 else {
      delegate?.serialTransportDidDisconnect(reason: "USB デバイスを開けませんでした: \(id)")
      return
    }

    var options = termios()
    if tcgetattr(fd, &options) != 0 {
      FileHandle.standardError.write("[usb] tcgetattr に失敗しました: \(id)\n".data(using: .utf8)!)
    }
    cfmakeraw(&options)
    cfsetspeed(&options, speed_t(115200))
    options.c_cflag &= ~tcflag_t(CSIZE)
    options.c_cflag |= tcflag_t(CS8)
    options.c_cflag &= ~tcflag_t(PARENB)
    options.c_cflag &= ~tcflag_t(CSTOPB)
    options.c_cflag |= tcflag_t(CLOCAL | CREAD)
    if tcsetattr(fd, TCSANOW, &options) != 0 {
      FileHandle.standardError.write("[usb] tcsetattr に失敗しました: \(id)\n".data(using: .utf8)!)
    }

    if ioctl(fd, TIOCSDTR) != 0 {
      FileHandle.standardError.write("[usb] DTR の設定に失敗しました: \(id)\n".data(using: .utf8)!)
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
    delegate?.serialTransportDidDisconnect(reason: reason)
  }
}
