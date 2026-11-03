package expo.modules.mboteble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.ParcelUuid
import android.util.Log
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Rôle CENTRAL (GATT client) — Mbote BLE
 * ─────────────────────────────────────────────────────────────────────────────
 *  • Scan par filtre sur MeshBle.SERVICE_UUID (aucune dérivation de position :
 *    BLUETOOTH_SCAN neverForLocation)
 *  • Connexion GATT aux péripériques voisins → découverte du service →
 *    négociation MTU 517 → abonnement NOTIFY (CCCD)
 *  • Pipeline d'écriture séquencé par connexion (ArrayDeque + busy) :
 *    l'API Android GATT exige des opérations strictement séquentielles
 * ─────────────────────────────────────────────────────────────────────────────
 */
class GattClientManager(
    private val appContext: Context,
    private val mainHandler: Handler,
    private val log: (String) -> Unit,
    private val onFrame: (peerId: String, frame: ByteArray, rssi: Int) -> Unit,
    private val onPeerChanged: (peerId: String, connected: Boolean) -> Unit,
) {
    class Connection(val gatt: BluetoothGatt) {
        var writeChar: BluetoothGattCharacteristic? = null
        var notifyChar: BluetoothGattCharacteristic? = null
        var mtu: Int = MeshBle.DEFAULT_MTU
        var rssi: Int = MeshBle.RSSI_UNKNOWN
        var ready = false
        var busy = false
        var closed = false
        val queue = ArrayDeque<ByteArray>()
    }

    private val connections = ConcurrentHashMap<String, Connection>()
    private var scanning = false

    private val reassembler = PacketReassembler { data, peerId, rssi ->
        onPacketComplete?.invoke(data, peerId, rssi)
    }

    var onPacketComplete: ((ByteArray, String, Int) -> Unit)? = null

    fun connectedPeers(): Set<String> = connections.keys.toSet()
    fun isConnected(peerId: String): Boolean = connections[peerId]?.ready == true
    fun rssiOf(peerId: String): Int = connections[peerId]?.rssi ?: MeshBle.RSSI_UNKNOWN
    fun mtuOf(peerId: String): Int = connections[peerId]?.mtu ?: MeshBle.DEFAULT_MTU

    fun start(adapterManager: BluetoothManager) {
        startScan(adapterManager)
    }

    private fun startScan(adapterManager: BluetoothManager) {
        val scanner = adapterManager.adapter?.bluetoothLeScanner ?: run {
            log("GattClient: scanner indisponible (BT off ?)")
            return
        }
        if (scanning) return
        val filter = ScanFilter.Builder()
            .setServiceUuid(ParcelUuid(UUID.fromString(MeshBle.SERVICE_UUID)))
            .build()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
            .build()
        try {
            scanner.startScan(listOf(filter), settings, scanCallback)
            scanning = true
            log("GattClient: scan actif (filtre service Mbote)")
        } catch (t: Throwable) {
            log("GattClient: échec du scan — ${t.message}")
        }
    }

    private fun stopScan() {
        if (!scanning) return
        try {
            appContext.getSystemService(BluetoothManager::class.java)
                ?.adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        } catch (_: Throwable) {
        }
        scanning = false
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            mainHandler.post { handleScanResult(result) }
        }

        override fun onScanFailed(errorCode: Int) {
            log("GattClient: scan échoué code=$errorCode")
        }
    }

    private fun handleScanResult(result: ScanResult) {
        val device = result.device ?: return
        val addr = device.address ?: return
        if (addr == "02:00:00:00:00:00") return // adaptateur local
        connections[addr]?.let { existing ->
            existing.rssi = result.rssi
            GattServerManager.peerRssiCache[addr] = result.rssi
            return
        }
        if (connections.size >= MeshBle.MAX_PEERS) return
        GattServerManager.peerRssiCache[addr] = result.rssi
        try {
            log("GattClient: connexion à $addr (rssi ${result.rssi})")
            device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } catch (t: Throwable) {
            log("GattClient: connectGatt échec $addr — ${t.message}")
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val addr = gatt.device?.address ?: return
            mainHandler.post {
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        if (status != BluetoothGatt.GATT_SUCCESS) {
                            log("GattClient: état connecté avec status=$status ($addr)")
                        }
                        gatt.discoverServices()
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        val conn = connections.remove(addr)
                        conn?.closed = true
                        try { gatt.close() } catch (_: Throwable) {}
                        if (conn != null) {
                            log("GattClient: déconnecté $addr")
                            onPeerChanged(addr, false)
                        }
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val addr = gatt.device?.address ?: return
            mainHandler.post {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("GattClient: découverte services échouée ($addr)")
                    try { gatt.disconnect() } catch (_: Throwable) {}
                    return@post
                }
                val service = gatt.getService(UUID.fromString(MeshBle.SERVICE_UUID))
                val w = service?.getCharacteristic(UUID.fromString(MeshBle.CHAR_WRITE_UUID))
                val n = service?.getCharacteristic(UUID.fromString(MeshBle.CHAR_NOTIFY_UUID))
                if (service == null || w == null || n == null) {
                    log("GattClient: service Mbote absent sur $addr")
                    try { gatt.disconnect() } catch (_: Throwable) {}
                    return@post
                }
                val conn = connections.computeIfAbsent(addr) { Connection(gatt) }
                conn.writeChar = w
                conn.notifyChar = n
                gatt.requestMtu(517)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val addr = gatt.device?.address ?: return
            mainHandler.post {
                val conn = connections[addr] ?: return@post
                if (status == BluetoothGatt.GATT_SUCCESS && mtu > 0) conn.mtu = mtu
                log("GattClient: MTU=$mtu ($addr)")
                subscribe(conn)
            }
        }

        private fun subscribe(conn: Connection) {
            val gatt = conn.gatt
            val n = conn.notifyChar ?: return
            try {
                gatt.setCharacteristicNotification(n, true)
                val cccd = n.getDescriptor(UUID.fromString(MeshBle.CCCD_UUID))
                if (cccd == null) {
                    onReady(conn)
                    return
                }
                @Suppress("DEPRECATION")
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (!gatt.writeDescriptor(cccd)) {
                    log("GattClient: writeDescriptor refusé (${gatt.device?.address})")
                    onReady(conn)
                }
            } catch (t: Throwable) {
                log("GattClient: abonnement échec — ${t.message}")
                onReady(conn)
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            val addr = gatt.device?.address ?: return
            mainHandler.post {
                val conn = connections[addr] ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("GattClient: CCCD write status=$status ($addr)")
                }
                onReady(conn)
            }
        }

        private fun onReady(conn: Connection) {
            conn.ready = true
            val addr = conn.gatt.device?.address ?: return
            log("GattClient: pair prêt $addr (mtu ${conn.mtu})")
            onPeerChanged(addr, true)
            flush(conn)
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            val addr = gatt.device?.address ?: return
            mainHandler.post {
                val conn = connections[addr] ?: return@post
                conn.busy = false
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    // abandon du fragment courant, on enchaîne
                    if (conn.queue.isNotEmpty()) conn.queue.poll()
                }
                flush(conn)
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray?
        ) {
            // Android < 33
            val data = value ?: return
            if (!characteristic.uuid.toString().equals(MeshBle.CHAR_NOTIFY_UUID, ignoreCase = true)) return
            val addr = gatt.device?.address ?: return
            val rssi = connections[addr]?.rssi ?: MeshBle.RSSI_UNKNOWN
            reassembler.feed(addr, data, rssi)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            // Android ≥ 33
            if (!characteristic.uuid.toString().equals(MeshBle.CHAR_NOTIFY_UUID, ignoreCase = true)) return
            val addr = gatt.device?.address ?: return
            val rssi = connections[addr]?.rssi ?: MeshBle.RSSI_UNKNOWN
            mainHandler.post { reassembler.feed(addr, value, rssi) }
        }
    }

    /**
     * Écrit un paquet complet vers un pair : découpe en frames selon le MTU
     * négocié puis enfile chaque frame (une seule écriture GATT à la fois).
     */
    fun write(peerId: String, packet: ByteArray): Int {
        val conn = connections[peerId] ?: return 0
        if (!conn.ready || conn.closed) return 0
        val frames = Framer.fragment(packet, MeshBle.valueCap(conn.mtu))
        synchronized(conn.queue) { conn.queue.addAll(frames) }
        flush(conn)
        return frames.size
    }

    /** Broadcast : écrit vers tous les pairs prêts. Retourne les frames émises. */
    fun writeAll(packet: ByteArray): Int {
        var total = 0
        for (peerId in connections.keys) total += write(peerId, packet)
        return total
    }

    private fun flush(conn: Connection) {
        val gatt = conn.gatt
        val char = conn.writeChar
        if (conn.closed || char == null) return
        if (conn.busy) return
        val frame = synchronized(conn.queue) {
            if (conn.queue.isEmpty()) return
            conn.queue.peek() ?: return
        }
        conn.busy = true
        try {
            @Suppress("DEPRECATION")
            char.value = frame
            char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            if (!gatt.writeCharacteristic(char)) {
                conn.busy = false
                // adaptateur occupé — nouvelle tentative différée
                mainHandler.postDelayed({ flush(conn) }, 50)
            }
        } catch (t: Throwable) {
            log("GattClient: write échec — ${t.message}")
            conn.busy = false
            synchronized(conn.queue) { if (conn.queue.isNotEmpty()) conn.queue.poll() }
            mainHandler.postDelayed({ flush(conn) }, 50)
        }
    }

    fun stop() {
        stopScan()
        for (conn in connections.values) {
            conn.closed = true
            try { conn.gatt.disconnect() } catch (_: Throwable) {}
            try { conn.gatt.close() } catch (_: Throwable) {}
        }
        connections.clear()
        reassembler.clear()
    }

    fun sweep() = reassembler.sweep()
}
