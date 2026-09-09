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
  private var isReading = false

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
    let fd = open(id, O_RDWR | O_NOCTTY | O_NONBLOCK)
    guard fd >= 0 else {
      delegate?.serialTransportDidDisconnect(reason: "USB デバイスを開けませんでした: \(id)")
      return
    }

    let currentFlags = fcntl(fd, F_GETFL, 0)
    _ = fcntl(fd, F_SETFL, currentFlags & ~O_NONBLOCK)

    var options = termios()
    tcgetattr(fd, &options)
    cfmakeraw(&options)
    cfsetspeed(&options, speed_t(115200))
    options.c_cflag &= ~tcflag_t(CSIZE)
    options.c_cflag |= tcflag_t(CS8)
    options.c_cflag &= ~tcflag_t(PARENB)
    options.c_cflag &= ~tcflag_t(CSTOPB)
    options.c_cflag |= tcflag_t(CLOCAL | CREAD)
    tcsetattr(fd, TCSANOW, &options)

    _ = ioctl(fd, TIOCSDTR)

    fileDescriptor = fd
    let name = (id as NSString).lastPathComponent
    delegate?.serialTransportDidConnect(id: id, name: name)
    startReading(fd: fd)
  }

  func disconnect() {
    isReading = false
    if fileDescriptor >= 0 {
      close(fileDescriptor)
      fileDescriptor = -1
    }
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
      while self?.isReading == true {
        let count = read(fd, &buffer, buffer.count)
        if count > 0 {
          let chunk = Array(buffer[0..<count])
          let text = String(decoding: chunk, as: UTF8.self)
          DispatchQueue.main.async {
            self?.delegate?.serialTransportDidReceiveText(text)
          }
        } else if count == 0 {
          DispatchQueue.main.async {
            self?.handleDisconnected()
          }
          break
        } else {
          if errno == EAGAIN || errno == EINTR { continue }
          DispatchQueue.main.async {
            self?.handleDisconnected()
          }
          break
        }
      }
    }
  }

  private func handleDisconnected() {
    guard isReading || fileDescriptor >= 0 else { return }
    isReading = false
    if fileDescriptor >= 0 {
      close(fileDescriptor)
      fileDescriptor = -1
    }
    delegate?.serialTransportDidDisconnect(reason: "USB が切断されました")
  }
}
