import Foundation
import CoreBluetooth
import ExpoModulesCore

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Module Expo NATIF « MboteBle » — transport BLE du mesh Mbote (iOS)
 * ─────────────────────────────────────────────────────────────────────────────
 *  API JS (voir modules/mbote-ble/index.ts) :
 *    start() stop() send(base64) peers() requestPermissions() isSupported()
 *  Événements :
 *    onPacket{base64,rssi,peerId} onPeerConnected{peerId}
 *    onPeerDisconnected{peerId} onStateChanged{state,detail} onLog{msg}
 *
 *  Permissions : iOS ne fournit pas d'invite programmatique — la boîte
 *  système apparaît à la première création d'un CBManager. `requestPermissions`
 *  déclenche la création (invite si nécessaire) et renvoie l'état courant.
 * ─────────────────────────────────────────────────────────────────────────────
 */
public class MboteBleModule: Module {

    private var engine: BleMeshEngine?

    private func getEngine() -> BleMeshEngine {
        if let engine = engine { return engine }
        let e = BleMeshEngine { [weak self] name, payload in
            self?.sendEvent(name, payload)
        }
        engine = e
        return e
    }

    public func definition() -> ModuleDefinition {
        Name("MboteBle")

        Events(
            "onPacket",
            "onPeerConnected",
            "onPeerDisconnected",
            "onStateChanged",
            "onLog"
        )

        Function("isSupported") { _ -> Bool in
            // F-46 : plus de `true` hardcodé — reflet de l'état système réel.
            // (Tout iPhone depuis le 4s a le BLE requis ; seul un refus explicite
            // dans Réglages rend le support indisponible au runtime.)
            let auth = CBManager.authorization
            return auth != .denied && auth != .restricted
        }

        AsyncFunction("start") { (promise: Promise) in
            self.getEngine().start { running in
                if running {
                    promise.resolve(["running": true])
                } else {
                    promise.reject("ERR_START", "moteur BLE non démarré (voir onStateChanged)")
                }
            }
        }

        AsyncFunction("stop") { (promise: Promise) in
            self.getEngine().stop()
            promise.resolve(["running": false])
        }

        AsyncFunction("send") { (base64: String, promise: Promise) in
            self.getEngine().send(base64) { delivered in
                promise.resolve(["delivered": delivered])
            }
        }

        Function("peers") { _ -> [[String: Any]] in
            self.engine?.peers() ?? []
        }

        AsyncFunction("requestPermissions") { (promise: Promise) in
            // Créer le CBManager déclenche l'invite système si nécessaire.
            _ = self.getEngine()
            switch CBManager.authorization {
            case .allowed:
                promise.resolve(["granted": true, "missing": []])
            case .notDetermined:
                // F-46 : l'invite vient d'être déclenchée par la création du
                // CBManager — on attend la réponse réelle de l'utilisateur
                // (poll 250 ms, plafond 30 s) au lieu de résoudre à l'aveugle.
                let timer = DispatchSource.makeTimerSource(queue: .main)
                var waited = 0.0
                timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
                timer.setEventHandler {
                    waited += 0.25
                    let auth = CBManager.authorization
                    guard auth != .notDetermined || waited >= 30 else { return }
                    timer.cancel()
                    switch auth {
                    case .allowed:
                        promise.resolve(["granted": true, "missing": []])
                    case .notDetermined:
                        promise.resolve(["granted": false, "missing": ["bluetooth (invite sans réponse)"]])
                    default:
                        promise.resolve(["granted": false, "missing": ["bluetooth (désactivé dans Réglages)"]])
                    }
                }
                timer.resume()
            default:
                promise.resolve(["granted": false, "missing": ["bluetooth (désactivé dans Réglages)"]])
            }
        }

        OnDestroy {
            self.engine?.stop()
        }
    }
}
