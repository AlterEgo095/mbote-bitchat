# Spec — Application native Mbote Mesh (BitChat en sous-couche)

> Objectif : donner à **tous** l'accès au réseau social, **avec ou sans internet**,
> en embarquant le protocole BitChat (domaine public) comme couche de transport
> native. Le cœur du protocole est **déjà écrit en TypeScript isomorphe** dans ce
> dépôt : `src/lib/mbote/bitchat-protocol.ts`. Il tourne tel quel dans React
> Native (aucune API DOM/Node utilisée).

```
┌──────────────────────────────────────────────────────────────────────┐
│  APP NATIVE (Expo / React Native)                                    │
│                                                                      │
│  Écran social (feed, canaux, DM) ── même UX que la PWA               │
│        │                                                             │
│  ┌─────▼──────────────────────────────────────────────┐              │
│  │  CORE MESH (TypeScript partagé, ~450 lignes)       │              │
│  │  bitchat-protocol.ts :                             │              │
│  │   • paquets binaires ≤ 469 o (header 17 o)         │              │
│  │   • TTL 7 (clamp 5 si ≥ 6 voisins), gigue 10–220 ms│              │
│  │   • dédup LRU 1000, fragmentation/réassembly       │              │
│  │   • encode/decode MeshEvent (post/announce/dm)     │              │
│  └─────┬───────────────────────┬──────────────────────┘              │
│        │                       │                                     │
│  ┌─────▼──────┐         ┌──────▼───────┐                             │
│  │ BLE Adapter│         │ Net Adapter  │                             │
│  │ react-     │         │ fetch + WS   │                             │
│  │ native-    │         │ (optionnel)  │                             │
│  │ ble-plx    │         └──────┬───────┘                             │
│  └─────┬──────┘                │                                     │
└────────┼───────────────────────┼─────────────────────────────────────┘
         │ GATT notify/write     │ HTTPS (quand internet existe)
┌────────▼───────────────────────▼─────────────────────────────────────┐
│  VPS : Next.js + SQLite  ──  POST/GET /api/mesh/bridge               │
│  dédup persistante 6 h, injection dans le social graph, downlink     │
│  (les publications récentes re-encodées en paquets BitChat)          │
└──────────────────────────────────────────────────────────────────────┘
```

## 1. Les 3 niveaux de connectivité (l'app choisit automatiquement)

| Niveau | Condition | Transport | Latence |
|---|---|---|---|
| **A. Mesh pur** | ≥ 1 autre appareil à portée BLE | BitChat contrôlé flood, multi-sauts (TTL 7) | 1–3 s |
| **B. Store-and-forward** | Personne à portée | Outbox locale + courriers spray-and-wait | heures/jours |
| **C. Internet** | Wi-Fi/data (directement ou via passerelle) | HTTPS `/api/mesh/bridge` + socket.io temps réel | < 1 s |

Un message passe par le niveau A d'abord ; s'il atteint un appareil avec
internet (l'**app elle-même** ou toute passerelle), ce dernier le dépose au VPS.
Le VPS re-diffuse vers les navigateurs et vers les passerelles du downlink.
**Le même message peut donc atteindre le monde entier sans que l'émetteur ait
jamais eu de connexion.**

## 2. Le core partagé (déjà livré)

`src/lib/mbote/bitchat-protocol.ts` expose tout ce dont l'app native a besoin :

```ts
import {
  buildPacket, decodePacket, forwardPacket,   // cycle de vie d'un paquet
  DedupCache, retransmitJitter, ttlForDensity, // anti-tempête (§3 whitepaper)
  fragmentPayload, FragmentAssembler,          // charge utile > 452 o
  encodeMeshEvent, decodeMeshEvent,            // post / announce / dm
  bytesToBase64, base64ToBytes, hexDump,       // logs et UI
} from "@/lib/mbote/bitchat-protocol";
```

`src/lib/mbote/geohash.ts` fournit les canaux géographiques (précision 2..7).
`src/lib/mbote/crypto.ts` (WebCrypto) fournit ECDSA P-256 (signature des
événements) et ECDH P-256 + AES-GCM (scellement des DM). Sur natif, ces deux
dernières fonctions sont remplacées par l'implémentation **Noise XX/X** de
BitChat (lib `react-native-noise` ou port `noisy` Rust) — l'interface
`MeshEvent` ne change pas.

## 3. Adaptateur BLE (`BleAdapter.ts`) — react-native-ble-plx

### 3.1 Service et caractéristiques GATT

Un service GATT propre à Mbote, **et** l'écoute du service BitChat officiel
pour l'interopérabilité progressive :

```
Service Mbote    : 6E40FE01-B5A3-F393-E0A9-E50E24DCCA9E   (write + notify, 512 o)
Service BitChat  : UUID déclaré par bitchat-android (lecture de compatibilité)
MTU              : négocier 512 (Android) / 185 min (iOS) → fragmentation automatique
Scan             : ScanFilter sur les UUID de service (pas de scan brut)
Publicité (adv)  : payload = senderID (8 o) + 1 octet type + 2 o longueur,
                   intervalle 250 ms en actif, 1000 ms en économie d'énergie
```

### 3.2 Cycle de réception (fidèle au whitepaper §3–4)

```ts
const dedup = new DedupCache(1000);
const assembler = new FragmentAssembler();

async function onCharacteristicValue(bytes: Uint8Array) {
  if (!dedup.checkAndRecord(bytes)) return;      // dédup LRU 1000
  const pkt = decodePacket(bytes);               // header + payload
  const ev = decodeMeshEvent(pkt.payload);

  consume(ev, pkt.ttl);                          // → UI / outbox / DB locale

  const next = forwardPacket(pkt);               // TTL-- ; null si dernier saut
  if (next) {
    await sleep(retransmitJitter());             // gigue 10–220 ms
    await ble.notifyCharacteristic(SERVICE, next);
  }
}
```

Émission : `ttl = ttlForDensity(neighborCount)` (clamp 5 si ≥ 6 voisins),
puis `buildPacket(PKT_PUBLIC, myPubkey, event)`. Les annonces de présence
partent toutes les 15 s (`PKT_ANNOUNCE`), la réconciliation gossip
(`PKT_GOSSIP`) toutes les 15 s avec une fenêtre de 6 h.

### 3.3 Permissions & énergie

- Android 12+ : `BLUETOOTH_SCAN` (neverForLocation) + `BLUETOOTH_ADVERTISE`
  + `BLUETOOTH_CONNECT`. Android ≤ 11 : location services requis pour le scan.
- iOS : `NSBluetoothAlwaysUsageDescription` ; l'advertising en arrière-plan
  passe par `CBCentralManager` + state restoration.
- Économie : scan duty-cycle 30 %, arrêt complet quand l'écran est éteint
  depuis > 10 min et qu'aucun message n'est en route (resumption par adv).

## 4. Rôle passerelle (`GatewayRole.ts`) — le pont vers le VPS

N'importe quel appareil peut servir de passerelle (option dans les réglages,
activable même en arrière-plan via WorkManager/BGTaskScheduler) :

```ts
// UPLINK — dépôt des paquets accumulés quand internet revient
await fetch(`${VPS}/api/mesh/bridge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    gatewayId: bytesToHex(senderIdFromPubkey(myPubkey)).toUpperCase(),
    label: "Pixel-8 de Mato",
    packets: outbox.map((p) => bytesToBase64(p.raw)), // paquets BRUTS, non altérés
  }),
});
// → { accepted, duplicates, invalid, results[] } : on purge les acceptés/doublons

// DOWNLINK — récupération des publications à redistribuer en BLE
const dl = await fetch(`${VPS}/api/mesh/bridge?gatewayId=${gwId}&since=${lastSync}`);
// dl.packets[] = paquets BitChat (base64) déjà encodés côté serveur :
// on les ré-émet tels quels en notify GATT aux voisins hors-ligne.
```

Le serveur déduplique par empreinte du paquet (fenêtre 6 h) : déposer le même
paquet depuis 3 passerelles différentes est sûr et idempotent.

## 5. Écrans natifs

1. **Onboarding** : génération de la paire de clés locale, pseudo, sauvegarde
   de la phrase de secours (optionnelle). Aucune donnée personnelle.
2. **Feed / Canaux géohash** : identique à la PWA (React Native Web ou
   réécriture native), hydraté par la DB locale (WatermelonDB / expo-sqlite).
3. **Carte réseau** : voisins à portée, paquets/s, sauts moyens — les données
   du core sont déjà exposées (`DedupCache.size`, hops déduits du TTL).
4. **Mode avion** : gros badge « Mesh actif · N voisins » ; la file courrier
   affiche les messages en attente (outbox) comme la PWA.
5. **Panic wipe** : triple-tap logo → destruction clés + DB locale (déjà
   implémenté côté web dans `identity.ts`).

## 6. Plan de build (Expo recommandé)

```bash
npx create-expo-app mbote-native --template tabs          # shell
npx expo prebuild                                          # bare pour BLE
bun add react-native-ble-plx react-native-get-random-values
bun add expo-sqlite react-native-mmkv                      # storage local
```

- `src/lib/mbote/bitchat-protocol.ts`, `geohash.ts` → **copiés tels quels**
  dans l'app (ou importés depuis un package privé `@mbote/mesh-core`).
- `crypto.ts` : remplacer `window.crypto.subtle` par
  `react-native-quick-crypto` (implémente WebCrypto sur RN).
- socket.io : `socket.io-client` fonctionne tel quel sur RN (websocket only).
- PWA ↔ natif : même identité exportable (QR « exporter mes clés ») pour
  migrer d'un support à l'autre.

## 7. Ce qui existe déjà vs. ce que la spec ajoute

| Composant | État |
|---|---|
| Core protocole TS (paquets, TTL, dédup, fragmentation) | ✅ livré (`bitchat-protocol.ts`) |
| Passerelle serveur uplink/downlink + dédup 6 h | ✅ livrée (`/api/mesh/bridge`) |
| Démo tunnel dans la PWA (vue Réseau) | ✅ livrée |
| PWA installable offline-first (manifest + SW) | ✅ livrée |
| Adaptateur BLE react-native-ble-plx | 📐 spec §3 |
| Rôle passerelle natif (WorkManager/BGTask) | 📐 spec §4 |
| Noise XX/X natif (remplace P-256 web) | 📐 spec §2 (option, interop BitChat) |

## 8. Limites honnêtes

- **BLE en navigateur = impossible** : la PWA gère l'offline par queue locale +
  sync ; seul le natif fait le vrai mesh radio. (Web Bluetooth existe mais est
  interdit en arrière-plan et absent d'iOS Safari.)
- Le format binaire ci-dessus est **fidèle aux paramètres BitChat** (TTL,
  jitter, dédup, 469 o) mais l'en-tête 17 o est une implémentation Mbote ;
  l'interop bit-à-bit avec les clients BitChat iOS/Android officiels passera
  par l'adoption de leur schéma d'encodage (étape d'interop §3.1).
- Les métadonnées radio (senderID visible dans les annonces) restent un
  compromis documenté du whitepaper BitChat — identités rotatives en travaux
  futurs.
