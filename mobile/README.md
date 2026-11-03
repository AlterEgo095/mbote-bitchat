# Mbote BitChat — App mobile native (Android + iOS)

Application **React Native / Expo** du réseau social offline-first. Le cœur du
protocole BitChat (TypeScript, `src/core/bitchat-protocol.ts`) est embarqué
**tel quel** ; le transport radio est fourni par des **modules natifs BLE
écrits sur mesure** :

| Plateforme | Langage | Moteur |
|---|---|---|
| Android | **Kotlin** | GATT serveur + client, scan par service, MTU 517, service premier plan |
| iOS | **Swift** (CoreBluetooth) | `CBPeripheralManager` + `CBCentralManager`, state restoration, backpressure |

Chaque téléphone joue les **deux rôles** simultanément (central *et*
périphérique) — c'est ce qui forme le maillage, y compris **Android ↔ iOS**
(mêmes UUID de service et même format de frames des deux côtés).

## Architecture en couches

```
┌───────────────────────────────────────────────────────────┐
│ UI (React Native) : Chat · Mesh · Profil                  │
├───────────────────────────────────────────────────────────┤
│ MeshTransport (TS) — routage BitChat                      │
│   dédup LRU 1000 · TTL−1 + gigue 10–220 ms · annonces 30s │
│   store-and-forward → pont VPS /api/mesh/bridge           │
├───────────────────────────────────────────────────────────┤
│ bitchat-protocol (TS) — encodage binaire BitChat v1       │
│   ANNOUNCE / PUBLIC / PRIVATE / GOSSIP · 469 octets max   │
├───────────────────────────────────────────────────────────┤
│ modules/mbote-ble — NATIF (Expo Modules API)              │
│   frames BLE ≤ MTU−3 · fragmentation/réassembly · GATT    │
│   Android: BluetoothGattServer/Client + LeAdvertiser      │
│   iOS:     CBPeripheralManager/CentralManager             │
└───────────────────────────────────────────────────────────┘
```

**Séparation stricte** : le natif ne connaît que des octets opaques
(frames `magic|ver|packetId|fragIdx|fragCount|fragLen|data`). Toute
l'intelligence (TTL, dédup, signations, chiffrement DM) vit en TypeScript —
auditable, testable, partagée avec le web.

## Contrat natif (identique Android / iOS)

```ts
Fonctions    start() stop() send(base64) peers() requestPermissions() isSupported()
Événements   onPacket{base64,rssi,peerId} onPeerConnected{peerId}
             onPeerDisconnected{peerId} onStateChanged{state} onLog{msg}
```

## Service BLE

| | UUID |
|---|---|
| Service | `F7C41D5A-9C6B-4E4F-8D2A-3B1E0C5A6D7F` |
| WRITE (central → périphérique) | `F7C41D5B-9C6B-4E4F-8D2A-3B1E0C5A6D7F` |
| NOTIFY (périphérique → central) | `F7C41D5C-9C6B-4E4F-8D2A-3B1E0C5A6D7F` |

## Démarrage

Prérequis : Node 18+, Xcode 15+ (iOS) / Android Studio (SDK 34+).

```bash
cd mobile
npm install

# build natif (compilera automatiquement le module mbote-ble)
npx expo run:android      # émulateur ou appareil branché
npx expo run:ios          # simulateur = pas de BLE ; utiliser un appareil réel
```

> ⚠️ Le **simulateur iOS n'a pas de Bluetooth**. Testez sur de vrais
> appareils. Sur émulateur Android, le BLE est également indisponible.

## Permissions gérées

- **Android 12+** : `BLUETOOTH_SCAN` (flag `neverForLocation` — aucun usage de
  position), `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` (runtime via l'API
  Permissions d'Expo). Android ≤ 11 : `ACCESS_FINE_LOCATION`.
- **iOS** : `NSBluetoothAlwaysUsageDescription` + background modes
  `bluetooth-central` / `bluetooth-peripheral` (déjà dans `app.json`).
- Android garde le mesh actif en arrière-plan via un service premier plan
  (`connectedDevice`) avec notification discrète.

## Interopérabilité web ↔ mobile

Identités et messages sont **bit-à-bit compatibles** avec le client web :

- ECDSA P-256 SHA-256, signature brute `r‖s` (WebCrypto = @noble)
- ECDH P-256 → coordonnée X (32 o) → AES-256-GCM pour les DM
- clés publiques : point non compressé 65 o en base64url

Un paquet fabriqué sur mobile est vérifiable côté web (et réciproquement) ;
le pont VPS l'ingère tel quel (`gatewayId` = préfixe de clé publique).

## Checklist de test à deux appareils

1. **Découverte** : Bluetooth ON, deux téléphones → onglet *Mesh* : chaque
   appareil voit le voisin (rôle `central+peripheral`, RSSI).
2. **Envoi direct** : message depuis A → apparaît sur B (< 1 s).
3. **Relais 3 sauts** : A — B — C avec C hors portée de A → le message de A
   atteint C avec badge `2 sauts` (retransmission TTL−1 + gigue).
4. **Dédup** : le même message n'apparaît qu'une fois sur C.
5. **Arrière-plan** : app en arrière-plan (Android : service premier plan,
   iOS : background modes) → les messages continuent de circuler.
6. **Pont VPS** : renseigner l'URL dans *Profil*, mettre internet sur un des
   téléphones → bouton *Pont VPS* : les paquets sont acceptés et la file se
   purge ; ils apparaissent sur le fil web.
7. **Sans internet de bout en bout** : couper le Wi-Fi/données sur tous les
   appareils → tout continue de fonctionner.

## Roadmap

- DM scellés mobile (crypto `sealMessage/openMessage` déjà prête dans
  `src/core/crypto-rn.ts` — reste la sélection de destinataire dans l'UI)
- canaux géohash (geohash de position via `expo-location`, opt-in)
- courriers DTN (spray-and-wait 3 pairs, budget copies 4→8, whitepaper §6)
- purge du service de restauration d'état iOS à l'arrêt explicite
