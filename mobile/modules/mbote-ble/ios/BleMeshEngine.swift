import Foundation
import CoreBluetooth

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ORCHESTRATEUR du mesh BLE — Mbote (iOS)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Lance et supervise les deux organes du transport :
 *    1. PeripheralTransport (rôle périphérique : service GATT + advertising)
 *    2. CentralTransport    (rôle central : scan + connexions sortantes)
 *
 *  Chaque iPhone joue les DEUX rôles simultanément — c'est ce qui forme le
 *  maillage, y compris avec les téléphones Android (même UUID de service,
 *  même format de frames). Les paquets BitChat complets remontent en JS via
 *  `onPacket` ; la retransmission (TTL −1, gigue, dédup) est pilotée par le
 *  cœur TypeScript qui rappelle `send()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
final class BleMeshEngine: NSObject {

    private let emit: (String, [String: Any]) -> Void
    private let peripheral = PeripheralTransport()
    private let central = CentralTransport()

    private var running = false
    private var stateEmitted = ""
    private var sweepTimer: Timer?

    private var peerSince: [String: Date] = [:]
    private var peerRoles: [String: Set<String>] = [:]
    private var peerLastSeen: [String: Date] = [:]
    private var peerRssi: [String: Int] = [:]

    init(emit: @escaping (String, [String: Any]) -> Void) {
        self.emit = emit
        super.init()
        setupTransports()
    }

    private func setupTransports() {
        peripheral.onLog = { [weak self] msg in self?.log(msg) }
        peripheral.onCentralChanged = { [weak self] id, connected in
            self?.onPeerChanged(id, connected, role: "peripheral")
        }
        peripheral.onPacketComplete = { [weak self] data, peerId, rssi in
            self?.dispatchPacket(data, peerId: peerId, rssi: rssi)
        }

        central.onLog = { [weak self] msg in self?.log(msg) }
        central.onPeerChanged = { [weak self] id, connected in
            self?.onPeerChanged(id, connected, role: "central")
        }
        central.onPacketComplete = { [weak self] data, peerId, rssi in
            self?.dispatchPacket(data, peerId: peerId, rssi: rssi)
        }
    }

    private func log(_ msg: String) {
        emit("onLog", ["msg": msg])
    }

    private func setState(_ state: String, detail: String? = nil) {
        guard state != stateEmitted else { return }
        stateEmitted = state
        var payload: [String: Any] = ["state": state]
        if let detail = detail { payload["detail"] = detail }
        emit("onStateChanged", payload)
    }

    // MARK: - Cycle de vie

    func start(completion: @escaping (Bool) -> Void) {
        if running {
            completion(true)
            return
        }
        if CBManager.authorization == .denied || CBManager.authorization == .restricted {
            setState("permission_needed", detail: "bluetooth")
            completion(false)
            return
        }
        running = true
        setState("starting")
        log("Moteur BLE : démarrage…")
        peripheral.start()
        central.start()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.sweep()
        }
        RunLoop.main.add(timer, forMode: .common)
        sweepTimer = timer
        // poweredOn est asynchrone ; on considère « running » dès la demande
        setState("running")
        log("Moteur BLE : actif")
        completion(true)
    }

    func stop() {
        guard running else { return }
        running = false
        sweepTimer?.invalidate()
        sweepTimer = nil
        peripheral.stop()
        central.stop()
        peerSince.removeAll()
        peerRoles.removeAll()
        peerLastSeen.removeAll()
        peerRssi.removeAll()
        setState("stopped")
        log("Moteur BLE : arrêté")
    }

    // MARK: - Envoi

    /// Envoie un paquet BitChat complet à tous les pairs joignables
    /// (écriture GATT côté central, notify côté périphérique).
    func send(_ base64: String, completion: @escaping (Int) -> Void) {
        guard let data = Data(base64Encoded: base64, options: [.ignoreUnknownCharacters]),
              !data.isEmpty else {
            log("send : base64 invalide")
            completion(0)
            return
        }
        var delivered = 0
        delivered += central.writeAll(packet: data)
        delivered += peripheral.notifyAll(packet: data)
        completion(delivered)
    }

    // MARK: - Peers

    func peers() -> [[String: Any]] {
        let now = Date()
        var out: [[String: Any]] = []
        for (id, since) in peerSince {
            var roles = peerRoles[id] ?? []
            if central.isReady(id) { roles.insert("central") }
            if peripheral.isSubscribed(id) { roles.insert("peripheral") }
            out.append([
                "peerId": id,
                "rssi": peerRssi[id] ?? central.rssiOf(id),
                "roles": Array(roles),
                "since": Int(since.timeIntervalSince1970 * 1000),
                "lastSeen": Int((peerLastSeen[id] ?? now).timeIntervalSince1970 * 1000)
            ])
        }
        return out
    }

    // MARK: - Interne

    private func onPeerChanged(_ peerId: String, _ connected: Bool, role: String) {
        if connected {
            var roles = peerRoles[peerId] ?? []
            roles.insert(role)
            peerRoles[peerId] = roles
            if peerSince[peerId] == nil {
                peerSince[peerId] = Date()
                emit("onPeerConnected", ["peerId": peerId])
            }
        } else {
            var roles = peerRoles[peerId] ?? []
            roles.remove(role)
            peerRoles[peerId] = roles
            if roles.isEmpty {
                peerRoles.removeValue(forKey: peerId)
                peerSince.removeValue(forKey: peerId)
                peerRssi.removeValue(forKey: peerId)
                emit("onPeerDisconnected", ["peerId": peerId])
            }
        }
    }

    private func dispatchPacket(_ data: Data, peerId: String, rssi: Int) {
        peerLastSeen[peerId] = Date()
        if rssi != MeshBle.rssiUnknown { peerRssi[peerId] = rssi }
        let b64 = data.base64EncodedString()
        emit("onPacket", [
            "base64": b64,
            "rssi": rssi,
            "peerId": peerId
        ])
    }

    private func sweep() {
        peripheral.sweep()
        central.sweep()
    }
}
