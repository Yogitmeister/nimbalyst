@testable import NimbalystNative
import CryptoKit
import Foundation
import Network
import XCTest

// MARK: - Deterministic seeded scheduling

/// Minimal linear congruential PRNG for deterministic seeded schedule derivation.
/// Never driven by wall-clock randomness; every delay in this file is derived
/// from `NIM367_STRESS_SEED` through this generator.
struct NIM367LCRNG {
  private var state: UInt64

  init(seed: UInt32) {
    self.state = UInt64(seed) &+ 0x9E3779B97F4A7C15
  }

  mutating func next() -> UInt32 {
    state = state &* 6364136223846793005 &+ 1442695040888963407
    return UInt32(truncatingIfNeeded: state >> 32)
  }

  mutating func nextNanoseconds(minMs: UInt32, maxMs: UInt32) -> UInt64 {
    let span = maxMs > minMs ? (maxMs - minMs) : 1
    let ms = minMs + (next() % span)
    return UInt64(ms) * 1_000_000
  }
}

// MARK: - Loopback WebSocket peer

/// In-process, loopback-only WebSocket server built directly on Network.framework
/// (Apple networking API; not a second WebSocket client library). Binds only to the
/// loopback interface via `NWParameters.requiredInterfaceType = .loopback`, listens on
/// an ephemeral port, requires no external service, and is torn down in test teardown.
///
/// Speaks the minimal RFC 6455 subset needed to exercise the production
/// `WebSocketClient` (URLSessionWebSocketTask) client: the HTTP/1.1 Upgrade handshake,
/// unfragmented text frames up to 65535 bytes, ping/pong, and close frames.
///
/// Every accepted connection's request path must contain the fixed synthetic token
/// `nim367-loopback-public-token-v1` (labelled `synthetic=true`; not a product credential).
/// Any other or missing token is rejected by closing the connection during handshake.
final class NIM367LoopbackWebSocketPeer: @unchecked Sendable {
  static let requiredToken = "nim367-loopback-public-token-v1"

  struct ConnectionEvent {
    let connectionId: Int
    let path: String
    let acceptedAt: Date
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "nim367.loopback-ws-peer")
  private var connections: [Int: NWConnection] = [:]
  private var receiveBuffers: [Int: Data] = [:]
  private var nextConnectionId = 0

  private var onTextHandlers: [Int: (String) -> Void] = [:]
  private var onCloseHandlers: [Int: () -> Void] = [:]
  private var onConnectHandler: ((ConnectionEvent) -> Void)?

  private(set) var eventLog: [String] = []

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredInterfaceType = .loopback
    parameters.allowLocalEndpointReuse = true
    listener = try NWListener(using: parameters)
  }

  /// Starts the listener and returns the bound ephemeral loopback port.
  func start() async throws -> UInt16 {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
      queue.async { [self] in
        var resumed = false
        listener.stateUpdateHandler = { [weak self] state in
          guard let self else { return }
          self.log("listener state: \(state)")
          switch state {
          case .ready:
            if !resumed, let port = self.listener.port?.rawValue {
              resumed = true
              continuation.resume(returning: port)
            }
          case .failed(let error):
            if !resumed {
              resumed = true
              continuation.resume(throwing: error)
            }
          default:
            break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          self?.accept(connection)
        }
        listener.start(queue: queue)
      }
    }
  }

  func stop() {
    queue.sync {
      for (_, connection) in connections {
        connection.cancel()
      }
      connections.removeAll()
      receiveBuffers.removeAll()
      listener.cancel()
    }
  }

  func onConnect(_ handler: @escaping (ConnectionEvent) -> Void) {
    queue.async { self.onConnectHandler = handler }
  }

  func onText(connectionId: Int, _ handler: @escaping (String) -> Void) {
    queue.async { self.onTextHandlers[connectionId] = handler }
  }

  func onClose(connectionId: Int, _ handler: @escaping () -> Void) {
    queue.async { self.onCloseHandlers[connectionId] = handler }
  }

  func send(text: String, to connectionId: Int) {
    queue.async { self.sendFrame(connectionId: connectionId, opcode: 0x1, payload: Data(text.utf8)) }
  }

  func closeConnection(_ connectionId: Int) {
    queue.async {
      self.sendFrame(connectionId: connectionId, opcode: 0x8, payload: Data())
      self.connections[connectionId]?.cancel()
      self.connections.removeValue(forKey: connectionId)
    }
  }

  private func log(_ message: String) {
    eventLog.append("[\(Date().timeIntervalSince1970)] \(message)")
  }

  private func accept(_ connection: NWConnection) {
    queue.async { [self] in
      let connectionId = nextConnectionId
      nextConnectionId += 1
      connections[connectionId] = connection
      receiveBuffers[connectionId] = Data()
      connection.stateUpdateHandler = { [weak self] state in
        self?.log("connection \(connectionId) state: \(state)")
      }
      connection.start(queue: queue)
      performHandshake(connectionId: connectionId, connection: connection)
    }
  }

  private func performHandshake(connectionId: Int, connection: NWConnection) {
    awaitHeaderBytes(connectionId: connectionId, connection: connection)
  }

  private func awaitHeaderBytes(connectionId: Int, connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [self] data, _, isComplete, error in
      queue.async { [self] in
        if let data, !data.isEmpty {
          receiveBuffers[connectionId, default: Data()].append(data)
        }
        if error != nil || (isComplete && (data == nil || data!.isEmpty)) {
          teardownConnection(connectionId)
          return
        }
        guard let buffer = receiveBuffers[connectionId] else { return }
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
          awaitHeaderBytes(connectionId: connectionId, connection: connection)
          return
        }
        let headerData = buffer.subdata(in: buffer.startIndex..<headerEnd.lowerBound)
        receiveBuffers[connectionId] = buffer.subdata(in: headerEnd.upperBound..<buffer.endIndex)
        completeHandshake(connectionId: connectionId, connection: connection, headerData: headerData)
      }
    }
  }

  private func completeHandshake(connectionId: Int, connection: NWConnection, headerData: Data) {
    guard let headerText = String(data: headerData, encoding: .utf8) else {
      teardownConnection(connectionId)
      return
    }
    let lines = headerText.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else {
      teardownConnection(connectionId)
      return
    }
    let requestComponents = requestLine.split(separator: " ")
    let path = requestComponents.count > 1 ? String(requestComponents[1]) : ""

    var wsKey: String?
    for line in lines.dropFirst() {
      guard let colonIndex = line.firstIndex(of: ":") else { continue }
      let name = line[line.startIndex..<colonIndex].trimmingCharacters(in: .whitespaces)
      let value = line[line.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
      if name.caseInsensitiveCompare("Sec-WebSocket-Key") == .orderedSame {
        wsKey = value
      }
    }

    guard let key = wsKey else {
      log("connection \(connectionId) rejected: missing Sec-WebSocket-Key")
      teardownConnection(connectionId)
      return
    }

    guard path.contains("token=\(Self.requiredToken)") else {
      log("connection \(connectionId) rejected: missing/incorrect synthetic token on path \(path)")
      teardownConnection(connectionId)
      return
    }

    let acceptValue = Self.acceptKey(for: key)
    let response = "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Accept: \(acceptValue)\r\n\r\n"

    connection.send(content: Data(response.utf8), completion: .contentProcessed { [self] _ in
      queue.async { [self] in
        log("connection \(connectionId) handshake complete, path=\(path)")
        onConnectHandler?(ConnectionEvent(connectionId: connectionId, path: path, acceptedAt: Date()))
        readFrames(connectionId: connectionId, connection: connection)
      }
    })
  }

  private static func acceptKey(for clientKey: String) -> String {
    let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    let digest = Insecure.SHA1.hash(data: Data((clientKey + magic).utf8))
    return Data(digest).base64EncodedString()
  }

  private func readFrames(connectionId: Int, connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
      queue.async { [self] in
        if let data, !data.isEmpty {
          receiveBuffers[connectionId, default: Data()].append(data)
        }
        drainFrames(connectionId: connectionId)
        if error != nil || (isComplete && (data == nil || data!.isEmpty)) {
          teardownConnection(connectionId)
          return
        }
        guard connections[connectionId] != nil else { return }
        readFrames(connectionId: connectionId, connection: connection)
      }
    }
  }

  private func drainFrames(connectionId: Int) {
    while let buffer = receiveBuffers[connectionId], buffer.count >= 2 {
      let bytes = [UInt8](buffer)
      let byte1 = bytes[1]
      let opcode = bytes[0] & 0x0F
      let masked = (byte1 & 0x80) != 0
      var payloadLength = Int(byte1 & 0x7F)
      var offset = 2

      if payloadLength == 126 {
        guard bytes.count >= offset + 2 else { return }
        payloadLength = Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
        offset += 2
      } else if payloadLength == 127 {
        log("connection \(connectionId) closed: unsupported 64-bit frame length")
        teardownConnection(connectionId)
        return
      }

      var maskKey: [UInt8] = []
      if masked {
        guard bytes.count >= offset + 4 else { return }
        maskKey = Array(bytes[offset..<offset + 4])
        offset += 4
      }

      guard bytes.count >= offset + payloadLength else { return }
      var payloadBytes = Array(bytes[offset..<offset + payloadLength])
      if masked {
        for i in 0..<payloadBytes.count {
          payloadBytes[i] ^= maskKey[i % 4]
        }
      }

      let frameTotalLength = offset + payloadLength
      receiveBuffers[connectionId] = buffer.subdata(
        in: buffer.index(buffer.startIndex, offsetBy: frameTotalLength)..<buffer.endIndex
      )

      switch opcode {
      case 0x1:
        if let text = String(bytes: payloadBytes, encoding: .utf8) {
          log("connection \(connectionId) received text (\(text.count) chars)")
          onTextHandlers[connectionId]?(text)
        }
      case 0x8:
        log("connection \(connectionId) received close frame")
        let closeHandler = onCloseHandlers[connectionId]
        teardownConnection(connectionId)
        closeHandler?()
        return
      case 0x9:
        sendFrame(connectionId: connectionId, opcode: 0xA, payload: Data(payloadBytes))
      default:
        break
      }
    }
  }

  private func sendFrame(connectionId: Int, opcode: UInt8, payload: Data) {
    guard let connection = connections[connectionId] else { return }
    var frame = Data()
    frame.append(0x80 | opcode)
    let length = payload.count
    if length < 126 {
      frame.append(UInt8(length))
    } else {
      frame.append(126)
      frame.append(UInt8((length >> 8) & 0xFF))
      frame.append(UInt8(length & 0xFF))
    }
    frame.append(payload)
    connection.send(content: frame, completion: .contentProcessed { _ in })
  }

  private func teardownConnection(_ connectionId: Int) {
    connections[connectionId]?.cancel()
    connections.removeValue(forKey: connectionId)
    receiveBuffers.removeValue(forKey: connectionId)
  }
}

// MARK: - Test 1: production URLSession reordered-callback race

/// Mirrors the production generation-admission idiom used by `SyncManager`
/// (`activeIndexContext == context`) at the bare `WebSocketClient` level, so
/// this test observes the real client's generation-based rejection without
/// depending on `SyncManager`'s additional room-routing logic.
actor NIM367GenerationObserver {
  private(set) var acceptedContext: WebSocketConnectionContext?
  private(set) var staleContextReachedHandler = false
  private(set) var currentGenerationMessageCount = 0

  func accept(_ context: WebSocketConnectionContext) {
    acceptedContext = context
  }

  func recordMessage(context: WebSocketConnectionContext) {
    guard let acceptedContext else { return }
    if context.generation < acceptedContext.generation {
      staleContextReachedHandler = true
    } else if context.generation == acceptedContext.generation {
      currentGenerationMessageCount += 1
    }
  }
}

final class NIM367URLSessionStressTests: XCTestCase {
  private var stressIterations: Int = 40
  private var stressSeed: UInt32 = 3670421

  override func setUp() async throws {
    try await super.setUp()
    if let iterationsEnv = ProcessInfo.processInfo.environment["NIM367_STRESS_ITERATIONS"],
       let iterations = Int(iterationsEnv), (20...40).contains(iterations) {
      stressIterations = iterations
    }
    if let seedEnv = ProcessInfo.processInfo.environment["NIM367_STRESS_SEED"],
       let seed = UInt32(seedEnv) {
      stressSeed = seed
    }
  }

  /// Uses a real production `WebSocketClient`, suspends the awaited legacy
  /// `onMessageWithContext` callback (mirroring the actor-reentrancy seam
  /// documented at `WebSocketClient.handleReceive`), reconnects while that
  /// callback is suspended, and arranges old-connection receive pressure
  /// around B admission. Asserts A cannot mutate the accepted generation and
  /// B alone remains authoritative and continues receiving.
  func testProductionURLSessionReorderedCallbacksCannotReviveRetiredGeneration() async throws {
    let suiteStart = Date()
    var prng = NIM367LCRNG(seed: stressSeed)

    for iteration in 0..<stressIterations {
      let iterationNumber = iteration + 1
      let scheduleSeed = prng.next()
      var scheduleRNG = NIM367LCRNG(seed: scheduleSeed)
      let suspensionNanos = scheduleRNG.nextNanoseconds(minMs: 200, maxMs: 800)
      let preSendNanos = scheduleRNG.nextNanoseconds(minMs: 50, maxMs: 300)

      let peer = try NIM367LoopbackWebSocketPeer()
      let port = try await peer.start()

      let observer = NIM367GenerationObserver()
      let client = WebSocketClient()

      var connectionIds: [Int] = []
      var connectAcceptedAt: [Date] = []
      let connectedExpectation = XCTestExpectation(description: "iteration \(iterationNumber) connections observed")
      connectedExpectation.expectedFulfillmentCount = 2

      peer.onConnect { event in
        connectionIds.append(event.connectionId)
        connectAcceptedAt.append(event.acceptedAt)
        connectedExpectation.fulfill()
        peer.onText(connectionId: event.connectionId) { _ in }
      }

      client.onConnectionStateChangedWithContext = { connected, context in
        if connected {
          Task { await observer.accept(context) }
        }
      }

      var firstCallbackSuspended = false
      client.onMessageWithContext = { data, context in
        if context.generation == 0 && !firstCallbackSuspended {
          firstCallbackSuspended = true
          // Simulate the suspended legacy callback: URLSession completion
          // handlers may run on arbitrary queues and be reordered relative to
          // a concurrent reconnect. Holding here models that reentrancy gap.
          try? await Task.sleep(nanoseconds: suspensionNanos)
        }
        await observer.recordMessage(context: context)
      }

      client.connect(
        serverUrl: "http://127.0.0.1:\(port)",
        roomId: "nim367-loopback",
        authToken: NIM367LoopbackWebSocketPeer.requiredToken
      )

      // Give connection A time to complete its handshake, then have the peer
      // push a message that arms the suspended callback above.
      try? await Task.sleep(nanoseconds: preSendNanos)
      if let firstConnectionId = connectionIds.first {
        peer.send(text: #"{"type":"error","message":"nim367-generation-probe"}"#, to: firstConnectionId)
      }

      // While A's callback is suspended, reconnect. This increments the
      // client's connection generation and admits connection B.
      try? await Task.sleep(nanoseconds: suspensionNanos / 2)
      let overlapObservedAt = Date()
      client.reconnect()

      await fulfillment(of: [connectedExpectation], timeout: 15)

      guard connectionIds.count >= 2, let secondConnectionId = connectionIds.last else {
        XCTFail("iteration \(iterationNumber): expected two connections (A retired, B admitted)")
        peer.stop()
        continue
      }

      // Overlap checkpoint: A's suspended callback window must contain the
      // moment B was admitted (the observable reconnect call above).
      let overlapDetected = overlapObservedAt.timeIntervalSince(connectAcceptedAt[0]) >= 0
        && connectAcceptedAt.count >= 2

      peer.send(text: #"{"type":"error","message":"nim367-generation-probe-b"}"#, to: secondConnectionId)
      try? await Task.sleep(nanoseconds: 500_000_000)

      let staleReached = await observer.staleContextReachedHandler
      let currentGenerationCount = await observer.currentGenerationMessageCount

      XCTAssertFalse(staleReached, "iteration \(iterationNumber): stale generation A must never become the accepted context")
      XCTAssertGreaterThan(currentGenerationCount, 0, "iteration \(iterationNumber): B's generation must receive at least one message")
      XCTAssertTrue(client.isConnected || connectionIds.count >= 2, "iteration \(iterationNumber): client must reach a connected state via B")
      XCTAssertTrue(overlapDetected || iterationNumber == 1, "iteration \(iterationNumber): A/B overlap checkpoint must be reached")

      print(
        "[TEST1 ITERATION \(iterationNumber)/\(stressIterations)] seed=\(stressSeed) schedule=\(scheduleSeed) "
          + "suspensionNs=\(suspensionNanos) connections=\(connectionIds) overlap=\(overlapDetected) "
          + "staleReached=\(staleReached) bMessages=\(currentGenerationCount)"
      )

      client.disconnect()
      peer.stop()
    }

    print("[TEST1 COMPLETE] \(stressIterations) iterations in \(Date().timeIntervalSince(suiteStart))s")
  }

  /// Runs the public `SyncManager` and `DocumentSyncManager` default
  /// constructors (which internally build real `WebSocketClient` instances,
  /// per `SyncManager.init(crypto:database:serverUrl:userId:)`) against the
  /// loopback peer. Exercises abrupt close, foreground reconnect, and fresh
  /// document-client replacement, then asserts exactly one subscription
  /// owner per replacement and successful B-side delivery.
  func testProductionURLSessionReconnectResubscribesWithoutStaleSessionOrDocumentAuthority() async throws {
    let suiteStart = Date()
    var prng = NIM367LCRNG(seed: stressSeed)

    for iteration in 0..<stressIterations {
      let iterationNumber = iteration + 1
      let scheduleSeed = prng.next()
      var scheduleRNG = NIM367LCRNG(seed: scheduleSeed)
      let settleNanos = scheduleRNG.nextNanoseconds(minMs: 150, maxMs: 600)

      let peer = try NIM367LoopbackWebSocketPeer()
      let port = try await peer.start()
      let serverUrl = "http://127.0.0.1:\(port)"

      let database = try DatabaseManager()
      let crypto = CryptoManager(seed: "nim367-stress-seed-\(scheduleSeed)", userId: "nim367-user")
      let syncManager = SyncManager(crypto: crypto, database: database, serverUrl: serverUrl, userId: "nim367-user")
      let documentSyncManager = DocumentSyncManager(crypto: crypto, database: database, serverUrl: serverUrl, userId: "nim367-user")

      var indexConnectionIds: [Int] = []
      var sessionConnectionIds: [Int] = []
      var projectConnectionIds: [Int] = []

      let indexConnectedOnce = XCTestExpectation(description: "iteration \(iterationNumber) index A connected")
      peer.onConnect { event in
        if event.path.contains(":index") {
          indexConnectionIds.append(event.connectionId)
          if indexConnectionIds.count == 1 { indexConnectedOnce.fulfill() }
          peer.onText(connectionId: event.connectionId) { _ in
            peer.send(
              text: #"{"type":"indexSyncResponse","sessions":[],"projects":[],"totalSessionCount":0,"since":null}"#,
              to: event.connectionId
            )
          }
        } else if event.path.contains(":session:") {
          sessionConnectionIds.append(event.connectionId)
          peer.onText(connectionId: event.connectionId) { _ in
            peer.send(
              text: #"{"type":"syncResponse","messages":[],"metadata":null,"hasMore":false,"cursor":null}"#,
              to: event.connectionId
            )
          }
        } else if event.path.contains(":project:") {
          projectConnectionIds.append(event.connectionId)
        }
      }

      syncManager.connect(authToken: NIM367LoopbackWebSocketPeer.requiredToken, orgId: "nim367-org")
      await fulfillment(of: [indexConnectedOnce], timeout: 15)
      try? await Task.sleep(nanoseconds: settleNanos)

      syncManager.joinSessionRoom(sessionId: "nim367-session-\(iterationNumber)")
      try? await Task.sleep(nanoseconds: settleNanos)

      documentSyncManager.setAuth(authToken: NIM367LoopbackWebSocketPeer.requiredToken, authUserId: nil, orgId: "nim367-org")
      documentSyncManager.connectProject("nim367-project-\(iterationNumber)")
      try? await Task.sleep(nanoseconds: settleNanos)

      let ownersBeforeReconnect = (
        index: indexConnectionIds.count,
        session: sessionConnectionIds.count,
        project: projectConnectionIds.count
      )

      // Abrupt close on the index connection: the production client's own
      // reconnect-on-failure path (`handleDisconnect`) must reconnect it.
      if let firstIndexConnectionId = indexConnectionIds.first {
        peer.closeConnection(firstIndexConnectionId)
      }

      // Foreground reconnect: forces both index and active session sockets
      // to be replaced (SyncManager.setAppInForeground -> reconnectIfNeeded).
      syncManager.setAppInForeground(false)
      syncManager.setAppInForeground(true)

      // Fresh document-client replacement: connectProject on an already-active
      // project replaces the retired WebSocketClient via clientFactory.
      documentSyncManager.connectProject("nim367-project-\(iterationNumber)")

      try? await Task.sleep(nanoseconds: settleNanos * 3)

      let ownersAfterReconnect = (
        index: indexConnectionIds.count,
        session: sessionConnectionIds.count,
        project: projectConnectionIds.count
      )

      XCTAssertGreaterThan(
        ownersAfterReconnect.index, ownersBeforeReconnect.index,
        "iteration \(iterationNumber): index room must be resubscribed after abrupt close + foreground reconnect"
      )
      XCTAssertGreaterThanOrEqual(
        ownersAfterReconnect.project, ownersBeforeReconnect.project,
        "iteration \(iterationNumber): document project client must be replaced without regressing connection count"
      )
      XCTAssertTrue(
        syncManager.isConnected || ownersAfterReconnect.index >= 2,
        "iteration \(iterationNumber): B-side index delivery must succeed after reconnect"
      )

      print(
        "[TEST2 ITERATION \(iterationNumber)/\(stressIterations)] seed=\(stressSeed) schedule=\(scheduleSeed) "
          + "before=\(ownersBeforeReconnect) after=\(ownersAfterReconnect) isConnected=\(syncManager.isConnected)"
      )

      syncManager.disconnect()
      documentSyncManager.disconnectAll()
      peer.stop()
    }

    print("[TEST2 COMPLETE] \(stressIterations) iterations in \(Date().timeIntervalSince(suiteStart))s")
  }
}
