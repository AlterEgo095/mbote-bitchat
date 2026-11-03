package expo.modules.mboteble

import java.util.concurrent.ConcurrentHashMap

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Constantes du transport BLE Mbote (miroir exact de la facade TypeScript)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le module natif transporte des OCTETS OPAQUES (paquets BitChat).
 *  Frame BLE (une écriture GATT = une frame) :
 *
 *    offset  taille  champ
 *    0       1       MAGIC  = 0x4D ('M')
 *    1       1       FRAME_VERSION = 0x01
 *    2       4       packetId (u32 BE) — regroupe les fragments d'un paquet
 *    6       1       fragIndex
 *    7       1       fragCount
 *    8       2       fragLen (u16 BE)
 *    10      var     fragment (morceau du paquet BitChat)
 * ─────────────────────────────────────────────────────────────────────────────
 */
object MeshBle {
    const val MAGIC: Byte = 0x4D
    const val FRAME_VERSION: Byte = 0x01
    const val FRAME_HEADER = 10
    const val MAX_FRAGMENTS = 64
    const val REASSEMBLY_TIMEOUT_MS = 8_000L
    const val RSSI_UNKNOWN = 127

    const val SERVICE_UUID = "F7C41D5A-9C6B-4E4F-8D2A-3B1E0C5A6D7F"
    const val CHAR_WRITE_UUID = "F7C41D5B-9C6B-4E4F-8D2A-3B1E0C5A6D7F"
    const val CHAR_NOTIFY_UUID = "F7C41D5C-9C6B-4E4F-8D2A-3B1E0C5A6D7F"
    const val CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb"

    /** MTU plancher quasi universel sur les piles BLE iOS/Android modernes */
    const val DEFAULT_MTU = 185
    /** Plafond de connexions GATT simultanées par rôle (stabilité radio) */
    const val MAX_PEERS = 6

    /** Taille utile d'une valeur GATT pour un MTU donné (opcode ATT = 3 octets) */
    fun valueCap(mtu: Int): Int = (mtu - 3).coerceAtLeast(20)
}

/**
 * Découpe un paquet BitChat complet en frames BLE ≤ [valueCap] octets.
 * Toutes les frames partagent le même [packetId].
 */
object Framer {
    private var counter = 0
    fun nextPacketId(): Int = synchronized(this) { counter = (counter + 1) and 0x7fffffff; counter }

    fun fragment(data: ByteArray, valueCap: Int): List<ByteArray> {
        val cap = valueCap.coerceAtLeast(MeshBle.FRAME_HEADER + 1)
        val chunkSize = cap - MeshBle.FRAME_HEADER
        val fragCount = ((data.size + chunkSize - 1) / chunkSize).coerceAtLeast(1)
        require(fragCount <= MeshBle.MAX_FRAGMENTS) {
            "paquet trop grand pour le transport BLE (${data.size} octets)"
        }
        val packetId = nextPacketId()
        val frames = ArrayList<ByteArray>(fragCount)
        var offset = 0
        for (index in 0 until fragCount) {
            val len = minOf(chunkSize, data.size - offset)
            val frame = ByteArray(MeshBle.FRAME_HEADER + len)
            frame[0] = MeshBle.MAGIC
            frame[1] = MeshBle.FRAME_VERSION
            frame[2] = (packetId ushr 24).toByte()
            frame[3] = (packetId ushr 16).toByte()
            frame[4] = (packetId ushr 8).toByte()
            frame[5] = packetId.toByte()
            frame[6] = index.toByte()
            frame[7] = fragCount.toByte()
            frame[8] = (len ushr 8).toByte()
            frame[9] = len.toByte()
            System.arraycopy(data, offset, frame, MeshBle.FRAME_HEADER, len)
            offset += len
            frames.add(frame)
        }
        return frames
    }
}

/**
 * Réassemble les frames BLE reçues en paquets BitChat complets.
 * Un paquet incomplet est purgé après [MeshBle.REASSEMBLY_TIMEOUT_MS] ([sweep]).
 * Les doublons inter-pairs sont tolérés : le cœur TS déduplique par empreinte.
 */
class PacketReassembler(
    private val onPacket: (data: ByteArray, peerId: String, rssi: Int) -> Unit
) {
    private class Assembly {
        var total = -1
        var received = 0
        var firstSeen = 0L
        val parts = HashMap<Int, ByteArray>()
    }

    private val pending = ConcurrentHashMap<String, Assembly>()

    fun feed(peerId: String, frame: ByteArray, rssi: Int) {
        if (frame.size < MeshBle.FRAME_HEADER) return
        if (frame[0] != MeshBle.MAGIC || frame[1] != MeshBle.FRAME_VERSION) return

        val packetId =
            ((frame[2].toInt() and 0xff) shl 24) or ((frame[3].toInt() and 0xff) shl 16) or
                ((frame[4].toInt() and 0xff) shl 8) or (frame[5].toInt() and 0xff)
        val fragIndex = frame[6].toInt() and 0xff
        val fragCount = frame[7].toInt() and 0xff
        val fragLen = ((frame[8].toInt() and 0xff) shl 8) or (frame[9].toInt() and 0xff)

        if (fragCount <= 0 || fragCount > MeshBle.MAX_FRAGMENTS) return
        if (fragIndex >= fragCount) return
        if (frame.size < MeshBle.FRAME_HEADER + fragLen) return

        val key = "$peerId#$packetId"
        val asm = pending.computeIfAbsent(key) {
            Assembly().apply { firstSeen = System.currentTimeMillis() }
        }
        synchronized(asm) {
            if (asm.total == -1) asm.total = fragCount
            if (asm.total != fragCount) return // incohérence — ignorée
            if (asm.parts.containsKey(fragIndex)) return // doublon de fragment
            asm.parts[fragIndex] = frame.copyOfRange(MeshBle.FRAME_HEADER, MeshBle.FRAME_HEADER + fragLen)
            asm.received = asm.parts.size
            if (asm.received < asm.total) return
        }

        // Dernier fragment reçu → réassemble (hors verrou)
        pending.remove(key)
        val bag = asm.parts
        val totalBytes = bag.values.sumOf { it.size }
        val full = ByteArray(totalBytes)
        var off = 0
        for (i in 0 until asm.total) {
            val part = bag[i] ?: return // trou inattendu — abandon silencieux
            System.arraycopy(part, 0, full, off, part.size)
            off += part.size
        }
        onPacket(full, peerId, rssi)
    }

    /** Purge les réassemblages morts — appelé périodiquement par le moteur */
    fun sweep() {
        val now = System.currentTimeMillis()
        val it = pending.entries.iterator()
        while (it.hasNext()) {
            val entry = it.next()
            if (now - entry.value.firstSeen > MeshBle.REASSEMBLY_TIMEOUT_MS) it.remove()
        }
    }

    fun clear() = pending.clear()
}
