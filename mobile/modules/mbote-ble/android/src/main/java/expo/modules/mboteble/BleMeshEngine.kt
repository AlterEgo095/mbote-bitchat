package expo.modules.mboteble

import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ORCHESTRATEUR du mesh BLE — Mbote (Android)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Lance et supervise les trois organes du transport :
 *    1. GattServerManager  (rôle périphérique : reçoit les writes des voisins)
 *    2. Advertising        (rend l'appareil découvrable par le service Mbote)
 *    3. GattClientManager  (rôle central : découvre et se connecte aux voisins)
 *
 *  Chaque appareil joue les DEUX rôles simultanément — c'est ce qui forme le
 *  maillage. Les paquets BitChat complets remontent en JS via `onPacket` ;
 *  la retransmission (TTL −1, gigue 10–220 ms, dédup) est pilotée par le cœur
 *  TypeScript, qui rappelle `send()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
class BleMeshEngine(
    private val appContext: Context,
    private val emit: (event: String, payload: Map<String, Any?>) -> Unit,
    private val requestPermissionsNative: (onResult: (granted: Boolean, missing: List<String>) -> Unit) -> Unit,
    private val logFn: (String) -> Unit = {},
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var serverManager: GattServerManager? = null
    private var clientManager: GattClientManager? = null
    private var advertiser: android.bluetooth.BluetoothLeAdvertiser? = null
    private var running = false
    private var stateEmitted = ""

    private val peerSince = ConcurrentHashMap<String, Long>()
    private val peerRoles = ConcurrentHashMap<String, MutableSet<String>>()
    private val peerLastSeen = ConcurrentHashMap<String, Long>()
    private val peerRssi = ConcurrentHashMap<String, Int>()

    private val log: (String) -> Unit = { msg ->
        logFn(msg)
        mainHandler.post { emit("onLog", mapOf("msg" to msg)) }
    }

    private fun setState(state: String, detail: String? = null) {
        if (state == stateEmitted) return
        stateEmitted = state
        emit("onStateChanged", mapOf("state" to state, "detail" to detail))
    }

    fun isSupported(): Boolean =
        appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)

    fun start(onDone: (Boolean) -> Unit) {
        mainHandler.post { startInternal(onDone) }
    }

    private fun startInternal(onDone: (Boolean) -> Unit) {
        if (running) {
            onDone(true)
            return
        }
        if (!isSupported()) {
            setState("unsupported")
            onDone(false)
            return
        }
        val missing = BlePermissions.missing(appContext)
        if (missing.isNotEmpty()) {
            setState("permission_needed", missing.joinToString(","))
            onDone(false)
            return
        }
        val manager = appContext.getSystemService(BluetoothManager::class.java)
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            setState("bluetooth_off")
            onDone(false)
            return
        }

        setState("starting")
        log("Moteur BLE : démarrage…")

        val server = GattServerManager(
            appContext, mainHandler, log,
            onFrame = { peerId, frame, rssi -> /* réassemblé par le manager */ },
            onPeerChanged = { peerId, connected -> onServerPeerChanged(peerId, connected) }
        )
        // Les paquets complets du rôle serveur remontent ici :
        server.onPacketComplete = { data, peerId, rssi -> dispatchPacket(data, peerId, rssi) }

        val client = GattClientManager(
            appContext, mainHandler, log,
            onFrame = { _, _, _ -> },
            onPeerChanged = { peerId, connected -> onClientPeerChanged(peerId, connected) }
        )
        client.onPacketComplete = { data, peerId, rssi -> dispatchPacket(data, peerId, rssi) }

        val serverOk = server.start(manager)
        client.start(manager)

        if (!serverOk) {
            log("Moteur BLE : rôle serveur indisponible (l'appareil peut rester central seul)")
        }

        advertiser = startAdvertising(adapter)
        serverManager = server
        clientManager = client
        running = true

        MeshForegroundService.start(appContext)
        mainHandler.postDelayed(sweepRunnable, SWEEP_INTERVAL_MS)

        setState("running")
        log("Moteur BLE : actif")
        onDone(true)
    }

    fun stop(onDone: (Boolean) -> Unit = {}) {
        mainHandler.post {
            if (!running) {
                onDone(false)
                return@post
            }
            running = false
            mainHandler.removeCallbacks(sweepRunnable)
            stopAdvertising()
            serverManager?.stop()
            clientManager?.stop()
            serverManager = null
            clientManager = null
            MeshForegroundService.stop(appContext)
            peerSince.clear()
            peerRoles.clear()
            peerLastSeen.clear()
            setState("stopped")
            log("Moteur BLE : arrêté")
            onDone(true)
        }
    }

    fun stopQuiet() {
        if (running) stop()
    }

    // ───────────────────────── Advertising ─────────────────────────

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            log("Advertising : démarré")
        }

        override fun onStartFailure(errorCode: Int) {
            log("Advertising : échec code=$errorCode")
        }
    }

    private fun startAdvertising(adapter: android.bluetooth.BluetoothAdapter): android.bluetooth.BluetoothLeAdvertiser? {
        val adv = adapter.bluetoothLeAdvertiser ?: run {
            log("Advertising : non supporté par la puce")
            return null
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(UUID.fromString(MeshBle.SERVICE_UUID)))
            // aucun nom d'appareil : pas de fuite d'identité dans le beacon
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()
        return try {
            adv.startAdvertising(settings, data, advertiseCallback)
            adv
        } catch (t: Throwable) {
            log("Advertising : erreur — ${t.message}")
            null
        }
    }

    private fun stopAdvertising() {
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (_: Throwable) {
        }
        advertiser = null
    }

    // ───────────────────────── Envoi / routage ─────────────────────────

    /**
     * Envoie un paquet BitChat complet à tous les pairs joignables.
     * • pairs côté central : écritures GATT (fragmentées selon MTU négocié)
     * • pairs côté serveur  : notifications NOTIFY (fragmentées selon MTU)
     * Retourne le nombre de frames effectivement livrées.
     */
    fun send(base64: String, onDone: (Int) -> Unit) {
        mainHandler.post {
            val bytes = try {
                Base64.decode(base64, Base64.NO_WRAP)
            } catch (t: Throwable) {
                log("send : base64 invalide — ${t.message}")
                onDone(0)
                return@post
            }
            var delivered = 0

            serverManager?.let { server ->
                for ((addr, device) in server.subscribers) {
                    val mtu = server.peerMtu[addr] ?: MeshBle.DEFAULT_MTU
                    delivered += server.notifyPeer(device, Framer.fragment(bytes, MeshBle.valueCap(mtu)))
                    peerLastSeen[addr] = System.currentTimeMillis()
                }
            }
            clientManager?.let { client ->
                delivered += client.writeAll(bytes)
            }
            onDone(delivered)
        }
    }

    private fun dispatchPacket(data: ByteArray, peerId: String, rssi: Int) {
        val b64 = Base64.encodeToString(data, Base64.NO_WRAP)
        peerLastSeen[peerId] = System.currentTimeMillis()
        if (rssi != MeshBle.RSSI_UNKNOWN) peerRssi[peerId] = rssi
        mainHandler.post {
            emit("onPacket", mapOf("base64" to b64, "rssi" to rssi, "peerId" to peerId))
        }
    }

    // ───────────────────────── Peers ─────────────────────────

    private fun onServerPeerChanged(peerId: String, connected: Boolean) {
        mainHandler.post { onPeerChangedInternal(peerId, connected, "peripheral") }
    }

    private fun onClientPeerChanged(peerId: String, connected: Boolean) {
        mainHandler.post { onPeerChangedInternal(peerId, connected, "central") }
    }

    private fun onPeerChangedInternal(peerId: String, connected: Boolean, role: String) {
        if (connected) {
            peerRoles.computeIfAbsent(peerId) { ConcurrentHashMap.newKeySet() }.add(role)
            if (!peerSince.containsKey(peerId)) {
                peerSince[peerId] = System.currentTimeMillis()
                emit("onPeerConnected", mapOf("peerId" to peerId))
            }
        } else {
            peerRoles[peerId]?.remove(role)
            val stillPresent = peerRoles[peerId]?.isNotEmpty() == true
            if (!stillPresent) {
                peerRoles.remove(peerId)
                peerSince.remove(peerId)
                peerRssi.remove(peerId)
                emit("onPeerDisconnected", mapOf("peerId" to peerId))
            }
        }
    }

    fun peers(): List<Map<String, Any?>> {
        val now = System.currentTimeMillis()
        return peerSince.keys.map { id ->
            mapOf(
                "peerId" to id,
                "rssi" to (peerRssi[id] ?: clientManager?.rssiOf(id) ?: MeshBle.RSSI_UNKNOWN),
                "roles" to (peerRoles[id]?.toList() ?: emptyList()),
                "since" to (peerSince[id] ?: now),
                "lastSeen" to (peerLastSeen[id] ?: now)
            )
        }
    }

    fun requestPermissions(onResult: (granted: Boolean, missing: List<String>) -> Unit) {
        requestPermissionsNative(onResult)
    }

    // ───────────────────────── Maintenance ─────────────────────────

    private val sweepRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            serverManager?.sweep()
            clientManager?.sweep()
            // purge des pairs fantômes (plus vus depuis 60 s)
            val now = System.currentTimeMillis()
            for ((id, last) in peerLastSeen) {
                if (now - last > 60_000 && !peerRoles[id].isNullOrEmpty()) {
                    // conservé : la connexion GATT fait foi, on ne coupe pas ici
                }
            }
            mainHandler.postDelayed(this, SWEEP_INTERVAL_MS)
        }
    }

    companion object {
        private const val SWEEP_INTERVAL_MS = 5_000L
    }
}
