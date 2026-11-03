import Foundation
import CoreBluetooth

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Rôle CENTRAL (CBCentralManager) — Mbote BLE (iOS)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • Scan par service Mbote (aucune position impliquée)
 *  • Connexion → découverte du service → abonnement NOTIFY
 *  • Écritures .withoutResponse avec backpressure via
 *    canSendWriteWithoutResponse + peripheralIsReady(toSendWriteWithoutResponse:)
 * ─────────────────────────────────────────────────────────────────────────────
 */
final class CentralTransport: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {

    var onPacketComplete: ((Data, String, Int) -> Void)?
    var onPeerChanged: ((String, Bool) -> Void)?
    var onReady: (() -> Void)?
    var onLog: ((String) -> Void)?

    private var manager: CBCentralManager?
    private var connecting = Set<String>()
    /// peerId (identifier.uuidString) → périphérique
    private var peripherals: [String: CBPeripheral] = [:]
    private var writeChars: [String: CBCharacteristic] = [:]
    private var notifyChars: [String: CBCharacteristic] = [:]
    private var readyPeers = Set<String>()
    private var rssiCache: [String: Int] = [:]
    private var outbox: [String: [Data]] = [:]
    private let reassembler = PacketReassembler { [weak self] data, peerId, rssi in
        self?.onPacketComplete?(data, peerId, rssi)
    }

    var connectedIds: [String] { Array(peripherals.keys) }
    func isReady(_ id: String) -> Bool { readyPeers.contains(id) }
    func rssiOf(_ id: String) -> Int { rssiCache[id] ?? MeshBle.rssiUnknown }
    func mtuOf(_ id: String) -> Int {
        guard let p = peripherals[id] else { return MeshBle.defaultMTU }
        return max(MeshBle.defaultMTU, p.maximumWriteValueLength(for: .withoutResponse) + 3)
    }

    func start() {
        guard manager == nil else { return }
        manager = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionRestoreIdentifierKey: "org.mbote.bitchat.central"]
        )
    }

    func stop() {
        for p in peripherals.values { manager?.cancelPeripheralConnection(p) }
        manager = nil
        peripherals.removeAll()
        writeChars.removeAll()
        notifyChars.removeAll()
        readyPeers.removeAll()
        outbox.removeAll()
        reassembler.clear()
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state == .poweredOff || central.state == .unauthorized {
                onLog?("CentralManager: état \(central.state.rawValue)")
            }
            return
        }
        central.scanForPeripherals(
            withServices: [MeshBle.serviceUUID],
            options: nil
        )
        onLog?("CentralManager: scan actif")
        onReady?()
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        onLog?("CentralManager: restauration d'état (arrière-plan)")
        if let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
            for p in restored {
                peripherals[p.identifier.uuidString] = p
                p.delegate = self
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let id = peripheral.identifier.uuidString
        if peripherals[id] != nil || connecting.contains(id) { return }
        if peripherals.count + connecting.count >= MeshBle.maxPeers { return }

        connecting.insert(id)
        rssiCache[id] = RSSI.intValue
        onLog?("Découverte \(id.prefix(8)) rssi \(RSSI.intValue)")
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        let id = peripheral.identifier.uuidString
        connecting.remove(id)
        peripherals[id] = peripheral
        peripheral.delegate = self
        onLog?("Connecté \(id.prefix(8)) — découverte du service…")
        peripheral.discoverServices([MeshBle.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier.uuidString
        connecting.remove(id)
        onLog?("Connexion échouée \(id.prefix(8)) — \(error?.localizedDescription ?? "?")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier.uuidString
        peripherals.removeValue(forKey: id)
        writeChars.removeValue(forKey: id)
        notifyChars.removeValue(forKey: id)
        readyPeers.remove(id)
        outbox.removeValue(forKey: id)
        onLog?("Déconnecté \(id.prefix(8))")
        onPeerChanged?(id, false)
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == MeshBle.serviceUUID }) else {
            onLog?("Service Mbote absent sur \(peripheral.identifier.uuidString.prefix(8))")
            manager?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics(
            [MeshBle.charWriteUUID, MeshBle.charNotifyUUID],
            for: service
        )
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let id = peripheral.identifier.uuidString
        guard let write = service.characteristics?.first(where: { $0.uuid == MeshBle.charWriteUUID }),
              let notify = service.characteristics?.first(where: { $0.uuid == MeshBle.charNotifyUUID }) else {
            onLog?("Caractéristiques absentes sur \(id.prefix(8))")
            manager?.cancelPeripheralConnection(peripheral)
            return
        }
        writeChars[id] = write
        notifyChars[id] = notify
        peripheral.setNotifyValue(true, for: notify)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let id = peripheral.identifier.uuidString
        if let error = error {
            onLog?("Abonnement échoué \(id.prefix(8)) — \(error.localizedDescription)")
            return
        }
        guard characteristic.uuid == MeshBle.charNotifyUUID, characteristic.isNotifying else { return }
        readyPeers.insert(id)
        onLog?("Pair prêt \(id.prefix(8)) (mtu \(mtuOf(id)))")
        onPeerChanged?(id, true)
        flush(peerId: id)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == MeshBle.charNotifyUUID, error == nil,
              let data = characteristic.value, !data.isEmpty else { return }
        let id = peripheral.identifier.uuidString
        reassembler.feed(peerId: id, frame: data, rssi: rssiOf(id))
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        flush(peerId: peripheral.identifier.uuidString)
    }

    // MARK: - Envoi

    /// Écrit un paquet complet vers un pair (fragmenté selon sa MTU).
    func write(peerId: String, packet: Data) -> Int {
        guard let peripheral = peripherals[peerId],
              let writeChar = writeChars[peerId],
              readyPeers.contains(peerId) else { return 0 }
        let frames = Framer.fragment(packet, valueCap: MeshBle.valueCap(mtuOf(peerId)))
        outbox[peerId, default: []].append(contentsOf: frames)
        flush(peerId: peerId)
        return frames.count
    }

    func writeAll(packet: Data) -> Int {
        var total = 0
        for id in readyPeers {
            total += write(peerId: id, packet: packet)
        }
        return total
    }

    private func flush(peerId: String) {
        guard let peripheral = peripherals[peerId],
              let writeChar = writeChars[peerId] else { return }
        var queue = outbox[peerId] ?? []
        while !queue.isEmpty {
            // iOS 9+ : backpressure explicite ; peripheralIsReady relancera flush
            guard peripheral.canSendWriteWithoutResponse else { break }
            let frame = queue.removeFirst()
            peripheral.writeValue(frame, for: writeChar, type: .withoutResponse)
        }
        outbox[peerId] = queue
    }

    func sweep() { reassembler.sweep() }
}
