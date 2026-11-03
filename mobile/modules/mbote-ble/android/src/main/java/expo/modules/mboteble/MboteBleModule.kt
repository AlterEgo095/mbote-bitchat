package expo.modules.mboteble

import android.app.Activity
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Module Expo NATIF « MboteBle » — transport BLE du mesh Mbote (Android)
 * ─────────────────────────────────────────────────────────────────────────────
 *  API JS (voir modules/mbote-ble/index.ts) :
 *    start() stop() send(base64) peers() requestPermissions() isSupported()
 *  Événements :
 *    onPacket{base64,rssi,peerId} onPeerConnected{peerId}
 *    onPeerDisconnected{peerId} onStateChanged{state,detail} onLog{msg}
 * ─────────────────────────────────────────────────────────────────────────────
 */
class MboteBleModule : Module() {

    private val engine: BleMeshEngine by lazy {
        val ctx = appContext.reactContext
            ?: throw IllegalStateException("MboteBle : contexte React indisponible")
        BleMeshEngine(
            appContext = ctx.applicationContext,
            emit = { name, payload -> sendEvent(name, payload) },
            requestPermissionsNative = { onResult -> requestNativePermissions(onResult) },
            logFn = { msg -> Log.i("MboteBLE", msg) }
        )
    }

    override fun definition() = ModuleDefinition {
        Name("MboteBle")

        Events(
            "onPacket",
            "onPeerConnected",
            "onPeerDisconnected",
            "onStateChanged",
            "onLog"
        )

        Function("isSupported") {
            engine.isSupported()
        }

        AsyncFunction("start") { promise: Promise ->
            try {
                engine.start { running ->
                    if (running) promise.resolve(mapOf("running" to true))
                    else promise.reject("ERR_START", "moteur BLE non démarré (voir onStateChanged)", null)
                }
            } catch (t: Throwable) {
                promise.reject("ERR_START", t.message ?: "échec démarrage", t)
            }
        }

        AsyncFunction("stop") { promise: Promise ->
            engine.stop { stopped -> promise.resolve(mapOf("running" to !stopped)) }
        }

        AsyncFunction("send") { base64: String, promise: Promise ->
            engine.send(base64) { delivered -> promise.resolve(mapOf("delivered" to delivered)) }
        }

        Function("peers") {
            engine.peers()
        }

        AsyncFunction("requestPermissions") { promise: Promise ->
            try {
                engine.requestPermissions { granted, missing ->
                    promise.resolve(mapOf("granted" to granted, "missing" to missing))
                }
            } catch (t: Throwable) {
                promise.reject("ERR_PERMISSIONS", t.message ?: "échec permissions", t)
            }
        }

        OnDestroy {
            try {
                engine.stopQuiet()
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * Permissions runtime via l'API Permissions d'expo-modules-core
     * (plumbing ActivityResult géré par Expo).
     * Signature Java : askForPermissions(listener, vararg permissions) —
     * le listener vient AVANT le vararg.
     */
    private fun requestNativePermissions(onResult: (granted: Boolean, missing: List<String>) -> Unit) {
        val required = BlePermissions.required()
        val manager = appContext.permissions
        if (manager == null) {
            onResult(false, required)
            return
        }
        try {
            manager.askForPermissions({ _ ->
                val missing = required.filter { !manager.hasGrantedPermissions(it) }
                onResult(missing.isEmpty(), missing)
            }, *required.toTypedArray())
        } catch (t: Throwable) {
            Log.e("MboteBLE", "askForPermissions a échoué", t)
            onResult(false, required)
        }
    }
}
