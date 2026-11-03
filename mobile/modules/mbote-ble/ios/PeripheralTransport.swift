import Foundation
import CoreBluetooth

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Rôle PÉRIPHÉRIQUE (CBPeripheralManager) — Mbote BLE (iOS)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Publie le service Mbote :
 *    • WRITE  (F7C41D5B…) : les centraux voisins écrivent des frames
 *    • NOTIFY (F7C41D5C…) : push vers les centraux abonnés (CCCD implicite)
 *  Backpressure gérée via updateValue → peripheralManagerIsReady.
 * ─────────────────────────────────────────────────────────────────────────────
 */
final class PeripheralTransport: NSObject, CBPeripheralManagerDelegate {

    var onPacketComplete: ((Data, String, Int) -> Void)?
    var onCentralChanged: ((String, Bool) -> Void)?
    var onReady: (() -> Void)?
    var onLog: ((String) -> Void)?

    private var manager: CBPeripheralManager?
    private var writeChar: CBMutableCharacteristic?
    private var notifyChar: CBMutableCharacteristic?
    /// centraux abonnés (CCCD actif) : identifier.uuidString → central
    private var subscribers: [String: CBCentral] = [:]
    private var outbox: [(central: CBCentral, frame: Data)] = []
    private let reassembler = PacketReassembler { [weak self] data, peerId, rssi in
        self?.onPacketComplete?(data, peerId, rssi)
    }

    var subscriberIds: [String] { Array(subscribers.keys) }
    func isSubscribed(_ id: String) -> Bool { subscribers[id] != nil }

    func start() {
        guard manager == nil else { return }
        manager = CBPeripheralManager(
            delegate: self,
            queue: .main,
            options: [CBPeripheralManagerOptionRestoreIdentifierKey: "org.mbote.bitchat.peripheral"]
        )
    }

    func stop() {
        manager?.stopAdvertising()
        manager = nil
        subscribers.removeAll()
        outbox.removeAll()
        reassembler.clear()
    }

    // MARK: - CBPeripheralManagerDelegate

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            if peripheral.state == .poweredOff || peripheral.state == .unauthorized {
                onLog?("PeripheralManager: état \(peripheral.state.rawValue)")
            }
            return
        }
        let service = CBMutableService(type: MeshBle.serviceUUID, primary: true)
        let write = CBMutableCharacteristic(
            type: MeshBle.charWriteUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        let notify = CBMutableCharacteristic(
            type: MeshBle.charNotifyUUID,
            properties: [.notify, .read],
            value: nil,
            permissions: [.readable]
        )
        service.characteristics = [write, notify]
        peripheral.add(service)
        writeChar = write
        notifyChar = notify
        onLog?("PeripheralManager: service publié")

        // (re)démarre l'advertising (aussi après restauration d'état)
        if !peripheral.isAdvertising {
            peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [MeshBle.serviceUUID]])
        }
        onReady?()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
        onLog?("PeripheralManager: restauration d'état (arrière-plan)")
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error = error {
            onLog?("Advertising: erreur \(error.localizedDescription)")
        } else {
            onLog?("Advertising: démarré")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        request.value = Data()
        peripheral.respond(to: request, withResult: .success)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            if request.characteristic === writeChar, let data = request.value, !data.isEmpty {
                // pas de RSSI exposé côté serveur iOS → rssiUnknown
                reassembler.feed(
                    peerId: request.central.identifier.uuidString,
                    frame: data,
                    rssi: MeshBle.rssiUnknown
                )
            }
            peripheral.respond(to: request, withResult: .success)
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == MeshBle.charNotifyUUID else { return }
        let id = central.identifier.uuidString
        subscribers[id] = central
        onLog?("Central abonné \(id.prefix(8))")
        onCentralChanged?(id, true)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == MeshBle.charNotifyUUID else { return }
        let id = central.identifier.uuidString
        subscribers.removeValue(forKey: id)
        onLog?("Central désabonné \(id.prefix(8))")
        onCentralChanged?(id, false)
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        flushOutbox()
    }

    // MARK: - Envoi

    /// Pousse un paquet complet à un central abonné (fragmente selon sa MTU).
    func notify(packet: Data, to centralId: String) -> Int {
        guard let central = subscribers[centralId], let manager = manager,
              let notifyChar = notifyChar else { return 0 }
        let cap: Int
        if #available(iOS 9.0, *) {
            cap = MeshBle.valueCap(central.maximumUpdateValueLength)
        } else {
            cap = MeshBle.valueCap(MeshBle.defaultMTU)
        }
        let frames = Framer.fragment(packet, valueCap: cap)
        for frame in frames {
            outbox.append((central, frame))
        }
        flushOutbox()
        return frames.count
    }

    func notifyAll(packet: Data) -> Int {
        var total = 0
        for id in Array(subscribers.keys) {
            total += notify(packet: packet, to: id)
        }
        return total
    }

    private func flushOutbox() {
        guard let manager = manager, let notifyChar = notifyChar else { return }
        while !outbox.isEmpty {
            let (central, frame) = outbox[0]
            if manager.updateValue(frame, for: notifyChar, onSubscribedCentrals: [central]) {
                outbox.removeFirst()
            } else {
                return // buffer ATT plein — peripheralManagerIsReady relancera
            }
        }
    }

    func sweep() { reassembler.sweep() }
}
