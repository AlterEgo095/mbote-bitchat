package expo.modules.mboteble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Rôle PÉRIPHÉRIQUE (GATT serveur) — Mbote BLE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Héberge le service MeshBle.SERVICE_UUID :
 *    • WRITE   (F7C41D5B…) : les centraux voisins écrivent des frames ici
 *    • NOTIFY  (F7C41D5C…) : on pousse les paquets aux centraux abonnés
 *                            (CCCD 0x2902 activé)
 *
 *  Les callbacks GATT arrivent sur un thread binder : tout est re-posté sur le
 *  thread principal avant de toucher l'état partagé.
 * ─────────────────────────────────────────────────────────────────────────────
 */
class GattServerManager(
    context: Context,
    private val mainHandler: Handler,
    private val log: (String) -> Unit,
    private val onFrame: (peerId: String, frame: ByteArray, rssi: Int) -> Unit,
    private val onPeerChanged: (peerId: String, connected: Boolean) -> Unit,
) {
    private val appContext: Context = context.applicationContext
    private var server: BluetoothGattServer? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    private var notifyChar: BluetoothGattCharacteristic? = null

    /** centraux abonnés au NOTIFY (CCCD activé) : adresse → device */
    val subscribers = ConcurrentHashMap<String, BluetoothDevice>()

    /** MTU négocié par chaque central (plancher par défaut) */
    val peerMtu = ConcurrentHashMap<String, Int>()

    private val reassembler = PacketReassembler { data, peerId, rssi ->
        onFrameComplete(data, peerId, rssi)
    }

    var onPacketComplete: ((ByteArray, String, Int) -> Unit)? = null

    private fun onFrameComplete(data: ByteArray, peerId: String, rssi: Int) {
        onPacketComplete?.invoke(data, peerId, rssi)
    }

    fun start(adapterManager: BluetoothManager): Boolean {
        return try {
            val s = adapterManager.openGattServer(appContext, callback)
            if (s == null) {
                log("GattServer: openGattServer a renvoyé null")
                false
            } else {
                val service = BluetoothGattService(
                    UUID.fromString(MeshBle.SERVICE_UUID),
                    BluetoothGattService.SERVICE_TYPE_PRIMARY
                )

                val w = BluetoothGattCharacteristic(
                    UUID.fromString(MeshBle.CHAR_WRITE_UUID),
                    BluetoothGattCharacteristic.PROPERTY_WRITE or
                        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                    BluetoothGattCharacteristic.PERMISSION_WRITE
                )
                val n = BluetoothGattCharacteristic(
                    UUID.fromString(MeshBle.CHAR_NOTIFY_UUID),
                    BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                        BluetoothGattCharacteristic.PROPERTY_READ,
                    BluetoothGattCharacteristic.PERMISSION_READ
                )
                val cccd = BluetoothGattDescriptor(
                    UUID.fromString(MeshBle.CCCD_UUID),
                    BluetoothGattDescriptor.PERMISSION_READ or
                        BluetoothGattDescriptor.PERMISSION_WRITE
                )
                n.addDescriptor(cccd)
                service.addCharacteristic(w)
                service.addCharacteristic(n)
                s.addService(service)
                writeChar = w
                notifyChar = n
                server = s
                log("GattServer: service publié")
                true
            }
        } catch (t: Throwable) {
            log("GattServer: échec démarrage — ${t.message}")
            false
        }
    }

    /**
     * Pousse un paquet complet (déjà fragmenté par l'appelant) à un central
     * abonné. Retourne le nombre de frames livrées.
     */
    fun notifyPeer(device: BluetoothDevice, frames: List<ByteArray>): Int {
        val s = server ?: return 0
        val n = notifyChar ?: return 0
        var sent = 0
        for (frame in frames) {
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    // signature API 33 : valeur portée par l'appel, retour void
                    s.notifyCharacteristicChanged(device, n, false, frame)
                    sent++
                } else {
                    @Suppress("DEPRECATION")
                    n.value = frame
                    if (s.notifyCharacteristicChanged(device, n, false)) sent++
                }
            } catch (t: Throwable) {
                log("GattServer: notify échec ${device.address} — ${t.message}")
                break
            }
        }
        return sent
    }

    fun stop() {
        try {
            subscribers.clear()
            peerMtu.clear()
            reassembler.clear()
            server?.close()
        } catch (_: Throwable) {
        }
        server = null
    }

    fun sweep() = reassembler.sweep()

    private val callback = object : BluetoothGattServerCallback() {

        private fun post(body: () -> Unit) = mainHandler.post { try { body() } catch (t: Throwable) { Log.e("MboteBLE", "server cb", t) } }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            post {
                val addr = device.address ?: return@post
                when (newState) {
                    BluetoothGatt.STATE_CONNECTED -> log("GattServer: central connecté $addr")
                    BluetoothGatt.STATE_DISCONNECTED -> {
                        if (subscribers.remove(addr) != null) {
                            peerMtu.remove(addr)
                            log("GattServer: central parti $addr")
                            onPeerChanged(addr, false)
                        }
                    }
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            post {
                val data = value ?: ByteArray(0)
                if (responseNeeded) {
                    try {
                        server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, data)
                    } catch (_: Throwable) {}
                }
                if (characteristic.uuid.toString().equals(MeshBle.CHAR_WRITE_UUID, ignoreCase = true)) {
                    val rssi = peerRssiCache[device.address] ?: MeshBle.RSSI_UNKNOWN
                    reassembler.feed(device.address ?: "unknown", data, rssi)
                }
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            post {
                val data = value ?: ByteArray(0)
                val isCccd = descriptor.uuid.toString().equals(MeshBle.CCCD_UUID, ignoreCase = true)
                if (isCccd) {
                    val enabled = data.size >= 2 && data[0] == 0x01.toByte()
                    val addr = device.address ?: "unknown"
                    if (enabled) {
                        subscribers[addr] = device
                        log("GattServer: central abonné $addr")
                        onPeerChanged(addr, true)
                    } else {
                        subscribers.remove(addr)
                        onPeerChanged(addr, false)
                    }
                }
                if (responseNeeded) {
                    try {
                        server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, data)
                    } catch (_: Throwable) {}
                }
            }
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor
        ) {
            post {
                val value = if (subscribers.containsKey(device.address)) {
                    byteArrayOf(0x01, 0x00)
                } else {
                    byteArrayOf(0x00, 0x00)
                }
                try {
                    server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
                } catch (_: Throwable) {}
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            post {
                if (Build.VERSION.SDK_INT >= 33) {
                    peerMtu[device.address ?: return@post] = mtu
                }
            }
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            post {
                try {
                    server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                } catch (_: Throwable) {}
            }
        }
    }

    companion object {
        /** RSSI des centraux serveur est inconnu (pas de scan) — mis en cache par le moteur */
        val peerRssiCache = ConcurrentHashMap<String, Int>()
    }
}
