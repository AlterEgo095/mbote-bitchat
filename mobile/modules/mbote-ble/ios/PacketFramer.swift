import Foundation
import CoreBluetooth

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Constantes du transport BLE Mbote (miroir exact de la facade TypeScript)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Frame BLE (une écriture GATT = une frame) :
 *    magic(1) 'M' | version(1) 0x01 | packetId(4 BE) | fragIndex(1) |
 *    fragCount(1) | fragLen(2 BE) | fragment…
 * ─────────────────────────────────────────────────────────────────────────────
 */
enum MeshBle {
    static let magic: UInt8 = 0x4D // 'M'
    static let frameVersion: UInt8 = 0x01
    static let frameHeader = 10
    static let maxFragments = 64
    static let reassemblyTimeout: TimeInterval = 8
    static let defaultMTU = 185
    static let maxPeers = 8
    static let rssiUnknown = 127

    static let serviceUUID = CBUUID(string: "F7C41D5A-9C6B-4E4F-8D2A-3B1E0C5A6D7F")
    static let charWriteUUID = CBUUID(string: "F7C41D5B-9C6B-4E4F-8D2A-3B1E0C5A6D7F")
    static let charNotifyUUID = CBUUID(string: "F7C41D5C-9C6B-4E4F-8D2A-3B1E0C5A6D7F")

    /// Taille utile d'une valeur GATT pour un MTU donné (opcode ATT = 3 octets)
    static func valueCap(_ mtu: Int) -> Int { max(20, mtu - 3) }
}

/// Découpe un paquet BitChat complet en frames BLE (packetId partagé).
enum Framer {
    private static var counter: UInt32 = 0

    static func nextPacketId() -> UInt32 {
        counter = (counter &+ 1) & 0x7fff_ffff
        return counter
    }

    static func fragment(_ data: Data, valueCap: Int) -> [Data] {
        let chunkSize = max(1, valueCap - MeshBle.frameHeader)
        let fragCount = max(1, (data.count + chunkSize - 1) / chunkSize)
        precondition(fragCount <= MeshBle.maxFragments, "paquet trop grand pour le transport BLE")
        let packetId = nextPacketId()
        var frames: [Data] = []
        frames.reserveCapacity(fragCount)
        var offset = 0
        for index in 0..<fragCount {
            let len = min(chunkSize, data.count - offset)
            var frame = Data(capacity: MeshBle.frameHeader + len)
            frame.append(MeshBle.magic)
            frame.append(MeshBle.frameVersion)
            var pid = packetId.bigEndian
            withUnsafeBytes(of: &pid) { frame.append(contentsOf: $0) }
            frame.append(UInt8(index))
            frame.append(UInt8(fragCount))
            var l = UInt16(len).bigEndian
            withUnsafeBytes(of: &l) { frame.append(contentsOf: $0) }
            frame.append(data.subdata(in: offset..<(offset + len)))
            frames.append(frame)
            offset += len
        }
        return frames
    }
}

/// Réassemble les frames BLE en paquets BitChat complets.
/// Doublons inter-pairs tolérés : le cœur TS déduplique par empreinte.
final class PacketReassembler {
    private final class Assembly {
        var total = -1
        let firstSeen = Date()
        var parts: [Int: Data] = [:]
    }

    private var pending: [String: Assembly] = [:]
    private let onPacket: (Data, String, Int) -> Void

    init(onPacket: @escaping (Data, String, Int) -> Void) {
        self.onPacket = onPacket
    }

    func feed(peerId: String, frame: Data, rssi: Int) {
        let bytes = [UInt8](frame)
        guard bytes.count >= MeshBle.frameHeader,
              bytes[0] == MeshBle.magic,
              bytes[1] == MeshBle.frameVersion else { return }

        let packetId = (UInt32(bytes[2]) << 24) | (UInt32(bytes[3]) << 16) |
            (UInt32(bytes[4]) << 8) | UInt32(bytes[5])
        let fragIndex = Int(bytes[6])
        let fragCount = Int(bytes[7])
        let fragLen = (Int(bytes[8]) << 8) | Int(bytes[9])

        guard fragCount > 0, fragCount <= MeshBle.maxFragments, fragIndex < fragCount,
              bytes.count >= MeshBle.frameHeader + fragLen else { return }

        let key = "\(peerId)#\(packetId)"
        let asm = pending[key] ?? Assembly()
        if asm.total == -1 { asm.total = fragCount }
        guard asm.total == fragCount, asm.parts[fragIndex] == nil else { return }
        asm.parts[fragIndex] = frame.subdata(in: MeshBle.frameHeader..<frame.count)
        pending[key] = asm

        guard asm.parts.count >= asm.total else { return }
        pending.removeValue(forKey: key)

        var full = Data()
        full.reserveCapacity(fragLen * asm.total)
        for i in 0..<asm.total {
            guard let part = asm.parts[i] else { return } // trou — abandon
            full.append(part)
        }
        onPacket(full, peerId, rssi)
    }

    func sweep() {
        let cutoff = Date().addingTimeInterval(-MeshBle.reassemblyTimeout)
        pending = pending.filter { $0.value.firstSeen > cutoff }
    }

    func clear() { pending.removeAll() }
}
