import XCTest
@testable import NimbalystNative

/// Tests for Phase 4: Settings, QR pairing, and push notifications.
/// Covers QR data parsing, push token message encoding, and settings state.
final class Phase4Tests: XCTestCase {

    // MARK: - External URL Routing

    func testExternalURLRoutingAllowsOnlyAuthCallback() throws {
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(try XCTUnwrap(URL(string: "nimbalyst://auth/callback?session_jwt=jwt"))),
            .authCallback
        )
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(try XCTUnwrap(URL(string: "nimbalyst://auth/unexpected"))),
            .unsupported
        )
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(try XCTUnwrap(URL(string: "https://auth/callback"))),
            .unsupported
        )
    }

    /// An externally opened pairing link only surfaces the in-app scanner. The
    /// route is a bare case carrying none of the URL's `data` payload, so nothing
    /// attacker-controlled is applied — the credential-exfiltration fix holds.
    func testExternalPairingLinkOnlyOpensInAppScanner() throws {
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(try XCTUnwrap(URL(string: "nimbalyst://pair?data=attacker-controlled"))),
            .openPairingScanner
        )
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(try XCTUnwrap(URL(string: "nimbalyst://pair"))),
            .openPairingScanner
        )
    }

    func testInAppScannerStillParsesPairingDeepLinkPayload() throws {
        let json = """
        {"seed":"scanner-seed","serverUrl":"wss://sync.example.com","userId":"scanner@example.com"}
        """
        let encoded = try XCTUnwrap(json.data(using: .utf8)?.base64EncodedString())
        let scannedValue = "nimbalyst://pair?data=\(encoded)"

        let result = try XCTUnwrap(QRPairingData.parse(scannedValue))

        XCTAssertEqual(result.seed, "scanner-seed")
        XCTAssertEqual(result.serverUrl, "wss://sync.example.com")
        XCTAssertEqual(result.userId, "scanner@example.com")
    }

    // MARK: - QR Pairing Data Parsing (v4 desktop format)

    func testParseV4DesktopPayload() {
        let futureMs = Int(Date().timeIntervalSince1970 * 1000) + 900_000 // 15 min from now
        let json = """
        {"version":4,"serverUrl":"wss://sync.nimbalyst.com","encryptionKeySeed":"abc123base64==","expiresAt":\(futureMs),"analyticsId":"posthog-id","syncEmail":"user@example.com"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.seed, "abc123base64==")
        XCTAssertEqual(result?.serverUrl, "wss://sync.nimbalyst.com")
        XCTAssertEqual(result?.userId, "user@example.com")
        XCTAssertEqual(result?.analyticsId, "posthog-id")
    }

    func testParseV4WithoutSyncEmail() {
        // When syncEmail is absent, analyticsId is used as userId
        let futureMs = Int(Date().timeIntervalSince1970 * 1000) + 900_000
        let json = """
        {"version":4,"serverUrl":"wss://sync.nimbalyst.com","encryptionKeySeed":"key123","expiresAt":\(futureMs),"analyticsId":"analytics-id-456"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.userId, "analytics-id-456")
        XCTAssertEqual(result?.analyticsId, "analytics-id-456")
    }

    func testParseExpiredQRCode() {
        let pastMs = Int(Date().timeIntervalSince1970 * 1000) - 60_000 // 1 min ago
        let json = """
        {"version":4,"serverUrl":"wss://sync.nimbalyst.com","encryptionKeySeed":"key","expiresAt":\(pastMs),"analyticsId":"id","syncEmail":"a@b.com"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseLegacyPayload() {
        let json = """
        {"seed":"abc123","serverUrl":"https://sync.nimbalyst.com","userId":"user-456"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.seed, "abc123")
        XCTAssertEqual(result?.serverUrl, "https://sync.nimbalyst.com")
        XCTAssertEqual(result?.userId, "user-456")
    }

    func testParseQRDataWithExtraFields() {
        let json = """
        {"seed":"key","serverUrl":"https://example.com","userId":"u1","extra":"ignored"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.seed, "key")
    }

    func testParseQRDataMissingSeedAndEncryptionKey() {
        let json = """
        {"serverUrl":"https://example.com","userId":"u1"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataMissingServerUrl() {
        let json = """
        {"seed":"key","userId":"u1"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataMissingAllUserIdentifiers() {
        // No syncEmail, userId, or analyticsId
        let json = """
        {"encryptionKeySeed":"key","serverUrl":"https://example.com"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataEmptySeed() {
        let json = """
        {"seed":"","serverUrl":"https://example.com","userId":"u1"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataInvalidJSON() {
        XCTAssertNil(QRPairingData.parse("not json"))
    }

    func testParseQRDataEmptyString() {
        XCTAssertNil(QRPairingData.parse(""))
    }

    func testParseQRDataURLAsPlainText() {
        XCTAssertNil(QRPairingData.parse("https://example.com"))
    }

    // MARK: - Push Token Registration Message

    func testRegisterPushTokenMessageEncoding() throws {
        let message = NotificationManager.makeRegisterTokenMessage(
            token: "abc123token",
            deviceId: "device-789"
        )
        let data = try JSONEncoder().encode(message)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "registerPushToken")
        XCTAssertEqual(json["token"] as? String, "abc123token")
        XCTAssertEqual(json["platform"] as? String, "ios")
        XCTAssertEqual(json["deviceId"] as? String, "device-789")
    }

    // MARK: - QR Pairing Data Equality

    func testQRPairingDataEquality() {
        let a = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)
        let b = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)
        let c = QRPairingData(seed: "x", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    // MARK: - AppState Unpair

    @MainActor
    func testUnpairClearsState() throws {
        let db = try DatabaseManager()
        let appState = AppState(databaseManager: db)

        XCTAssertTrue(appState.isPaired)
        XCTAssertNotNil(appState.databaseManager)

        appState.unpair()

        XCTAssertFalse(appState.isPaired)
        XCTAssertNil(appState.databaseManager)
    }

    // MARK: - Push Notification Defaults

    func testPushNotificationDefaultOff() {
        // Clean state: push should default to off
        UserDefaults.standard.removeObject(forKey: "pushNotificationsEnabled")
        let enabled = UserDefaults.standard.bool(forKey: "pushNotificationsEnabled")
        XCTAssertFalse(enabled)
    }

    func testPushNotificationPersistence() {
        UserDefaults.standard.set(true, forKey: "pushNotificationsEnabled")
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "pushNotificationsEnabled"))

        UserDefaults.standard.set(false, forKey: "pushNotificationsEnabled")
        XCTAssertFalse(UserDefaults.standard.bool(forKey: "pushNotificationsEnabled"))

        // Cleanup
        UserDefaults.standard.removeObject(forKey: "pushNotificationsEnabled")
    }

    // MARK: - Notification Tap Navigation (NIM-448)
    //
    // `navigateToNotificationSession` is the shared trigger both the iPhone
    // stack (MainNavigationView) and the iPad split view (IPadNavigationView)
    // observe via `notificationNavigationRequest`. These tests cover the
    // async polling logic directly; the two view-layer consumers are plain
    // SwiftUI wiring with no independent branching, mirroring the untested
    // `voiceNavigationRequest` / `navigateWhenSessionAvailable` pattern this
    // was modeled on.

    @MainActor
    func testNotificationNavigationResolvesImmediatelyWhenSessionAlreadySynced() async throws {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: "/Users/test/project", name: "project"))
        try db.upsertSession(Session(id: "session-1", projectId: "/Users/test/project", createdAt: 1, updatedAt: 1))
        let appState = AppState(databaseManager: db)

        await appState.navigateToNotificationSession("session-1")

        XCTAssertEqual(appState.notificationNavigationRequest, "session-1")
    }

    /// Regression test for the cold-launch race: a notification tap can arrive
    /// before the tapped session has synced into the local database (the index
    /// resync is still in flight). `navigateToNotificationSession` must wait
    /// for the row instead of giving up on the first miss.
    @MainActor
    func testNotificationNavigationWaitsForSessionThatArrivesMidPoll() async throws {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: "/Users/test/project", name: "project"))
        let appState = AppState(databaseManager: db)

        Task {
            try? await Task.sleep(nanoseconds: 250_000_000) // after >= 1 poll tick
            try? db.upsertSession(Session(id: "late-session", projectId: "/Users/test/project", createdAt: 1, updatedAt: 1))
        }

        await appState.navigateToNotificationSession("late-session")

        XCTAssertEqual(appState.notificationNavigationRequest, "late-session")
    }
}
