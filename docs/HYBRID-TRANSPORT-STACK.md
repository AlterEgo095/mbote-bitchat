# Pile de transport hybride Mbote — analyse & plan de croissance (DORS)

> Analyse du modèle « pile hybride » (DORS / Offline Protocol, mesh BLE, Nostr
> fallback, LoRa) **appliquée à notre code réel**. Chaque couche est confrontée à
> ce qui existe déjà dans le dépôt, avec le verdict : ✅ acquis · ⚠️ partiel · ❌
> manquant — puis l'action concrète.

---

## 0. Le verdict en une phrase

**Nous avons déjà 70 % de la pile décrite** — y compris la plus dure (le mesh BLE
natif multi-sauts). Ce qui manque tient en deux composants : le **routeur de
transports** (le chef d'orchestre « DORS ») et l'**outbox durable**. Le reste du
document est du choix d'option (LoRa, Nostr), pas des fondations.

---

## 1. Mappage couche par couche : le document vs notre code

| Couche (doc) | Ce que le doc propose | Ce qu'on a DÉJÀ | Verdict | Action |
|---|---|---|---|---|
| **1. Routage (DORS)** | Routeur qui évalue signal BLE, congestion, batterie et choisit le canal par message | `MeshTransport.ts` : BLE only + `syncBridge()` **manuel** ; web : `BitChatBridge` manuel | ❌ | **P1 — TransportRouter (DORS maison)** |
| **2. Mesh BLE local** | `react-native-ble-mesh`, flood TTL + dédup, Noise | Module natif **maison** `mbote-ble` (Kotlin + Swift) : GATT server+client, TTL 7 (clamp 5 dense), dédup LRU 1000, gigue 10–220 ms, fragmentation ≤ 469 o | ✅ (+) | Rien à remplacer ; peaufiner l'énergie (§5) |
| **2bis. Sécurité mesh** | Noise pour confidentialité E2E | DM déjà scellés **ECDH P-256 + AES-GCM**, posts signés ECDSA ; `crypto-rn` natif | ✅ (~) | Port Noise XX déjà en roadmap (P2+) |
| **3. Transport global** | Nostr comme filet de sûreté, passerelle de maillage | VPS `/api/mesh/bridge` POST (uplink, dédup persistante 6 h) + GET (downlink re-encodé BitChat) + relay socket.io (rooms feed/canal/dm/présence) | ✅ | Le « Nostr fallback » est **déjà notre pont VPS** |
| **3bis. Outbox durable** | File locale persistante, renvoi auto dès qu'un transport revient | `bridgeQueue` = tableau **en mémoire** (max 200, **perdu au kill de l'app**) ; web = state React | ❌ | **P2 — Outbox durable (sqlite/IndexedDB)** |
| **4. LoRa / Meshtastic** | Pont radio longue portée | Rien — mais notre API passerelle (`gatewayId`, `GatewayNode` tracké en DB) accueille n'importe quel pont **sans toucher au protocole** | ❌ (facile) | **P3 — pont Meshtastic = script externe** |
| **Web Bluetooth (PWA)** | Avertissement : Chromium only | On ne s'y est pas trompés : le web est console de passerelle (HTTPS), le mesh est natif | ✅ (choix validé) | Optionnel : Web Bluetooth comme transport expérimental |

**Lecture du tableau** : les couches 2 et 3 — les plus coûteuses à écrire — sont
acquises. Les couches 1 et 3bis sont du **plomberie TypeScript isomorphe
purement applicative**, ~600 lignes au total. C'est une excellente nouvelle.

---

## 2. Corrections au document (où il se trompe — pour NOTRE cas)

1. **« Utilisez `react-native-ble-mesh` »** → **Non.** Cette lib remplacerait
   notre protocole (elle a son propre format de paquet) et fragmenterait le
   réseau en deux îlots incompatibles. Notre module `mbote-ble` implémente
   *exactement* ce que le doc décrit (« inondation contrôlée avec TTL et
   déduplication ») au format **BitChat**, interopérable avec le whitepaper
   d'origine. Recommander d'installer une 2ᵉ stack mesh = régression.

2. **« Utilisez le SDK Offline Protocol (DORS) »** → **Non.** DORS n'est pas une
   lib, c'est un *pattern* : machine à états + sondes de santé + politique de
   priorité. On l'implémente nous-mêmes en TS isomorphe (~300 lignes), sans
   dépendance, sans vendor lock-in — et avec la **traçabilité des décisions**
   exposée dans l'UI, ce qu'aucun SDK fermé n'offrira.

3. **« Outbox via `@formstr/local-relay` / NDKSwift »** → ces libs ciblent le
   modèle d'événements Nostr. Nos messages sont des **paquets binaires opaques
   base64** (déjà scellés/signés) : une table SQLite (mobile) / un store
   IndexedDB (web) suffisent, avec purge par ack — et notre API bridge renvoie
   **déjà** un statut par paquet (`accepted` / `duplicate` / `invalid`), donc la
   purge fiable est triviale à brancher.

4. **« Nostr est votre base actuelle »** → notre base est BitChat + graphe social
   VPS. Nostr devient une **option d'interopérabilité** (P3) : mapper
   `MeshEvent` ↔ événements NIP pour capter l'écosystème Nostr (relais publics,
   clients existants). C'est un multiplicateur d'audience, pas une fondation.

5. **Le doc sous-estime un point que nous avons déjà résolu** : la passerelle.
   Chez nous, *tout* appareil peut être passerelle (uplink + downlink), le
   serveur tracke chaque passerelle (`GatewayNode`), déduplique par empreinte
   sur 6 h et ré-encode le downlink en paquets BitChat. Un pont LoRa ou Nostr
   sera donc un simple **nouveau type de passerelle**, pas une refonte.

---

## 3. Architecture cible (ce qu'on construit)

```
                        ┌────────────────────────────────────┐
                        │      TRANSPORT ROUTER (DORS)       │
                        │  score(transport) =                │
                        │    disponibilité × qualité         │
                        │    (voisins BLE, RTT, batterie,    │
                        │     pression de la file)           │
                        │  → décision par message + journal  │
                        └───────┬──────────┬──────────┬──────┘
                                │          │          │
                 ┌──────────────▼─┐  ┌─────▼──────┐  ┌▼──────────────┐
                 │  BleTransport  │  │  Internet  │  │  LoRaBridge   │
                 │ (module natif  │  │ Transport  │  │  (P3, externe │
                 │   mbote-ble)   │  │ (HTTPS VPS)│  │   Meshtastic) │
                 └──────┬─────────┘  └─────┬──────┘  └───────────────┘
                        │                  │
                        ▼                  ▼
              ┌────────────────────────────────────────┐
              │        OUTBOX DURABLE (P2)             │
              │  expo-sqlite (mobile) / IndexedDB (web)│
              │  ack-purge · backoff exp · flush auto  │
              │  (NetInfo / foreground / périodique)   │
              └────────────────────────────────────────┘
                                 │
                                 ▼
              VPS : /api/mesh/bridge + relay socket.io
              (déjà livrés, inchangés)
```

### 3.1 Politique de routage (le cœur du DORS maison)

Par message sortant, le routeur évalue et **journalise** sa décision :

```
1. BLE disponible et ≥ 1 voisin ?
   → OUI : émission mesh immédiate (latence ~1 s, zéro infrastructure)
     + copie dans l'outbox tant que le paquet n'a pas atteint un canal
       confirmé (mesh = livraison « au mieux », jamais acquittée).
   → NON : passer à 2.
2. Internet disponible (sonde RTT légère, cache 30 s) ?
   → OUI : flush outbox via HTTPS + envoi direct.
   → NON : le message DORT dans l'outbox (spray-and-wait) ; le routeur
     programme le flush sur : regain réseau (NetInfo) · retour au premier
     plan · timer périodique · réception d'un paquet (un voisin = un canal).
3. Batterie faible (< 15 %) et pas de chargeur ?
   → le duty-cycle BLE est réduit (adv 1000 ms), la priorité passe à
     l'Internet si disponible (le BLE coûte la radio la plus chère).
```

Règle d'or BitChat conservée : **un paquet mesh est relayé, jamais dupliqué
entre canaux** — sauf copie d'outbox, purgée dès qu'un canal confirme
(`accepted`/`duplicate` renvoyés par le pont).

### 3.2 Contrat `Transport` (isomorphe mobile/web)

```ts
export interface Transport {
  readonly id: "ble" | "internet" | "lora";
  isAvailable(): boolean;                 // sondé en continu, cache court
  health(): TransportHealth;              // voisins, rssiMoyen, rttMs, batterie
  send(raw: Uint8Array): Promise<SendReceipt>; // { delivered: boolean }
  onPacket(cb: (raw: Uint8Array) => void): () => void;
}

export class TransportRouter {
  register(t: Transport, priority: number): void;
  submit(raw: Uint8Array, opts?: { trace?: boolean }): Promise<RouteDecision>;
  onDecision(cb: (d: RouteDecision) => void): () => void; // → UI NetworkView
}
```

`RouteDecision` = `{ transport, reason, at }` — affiché dans NetworkView (« ce
message est parti en BLE, 2 voisins, RSSI −67 »). La transparence du routage est
un argument produit fort : l'utilisateur **voit** pourquoi son message voyage.

---

## 4. Roadmap de croissance

### P1 — TransportRouter « DORS maison » (la fondation) — ~300 lignes
- `src/lib/mbote/transports/types.ts` — contrat Transport + santé.
- `src/lib/mbote/transports/router.ts` — scoring, politique §3.1, journal.
- Mobile : `BleTransport` (wrap `mbote-ble`) + `InternetTransport` (wrap fetch
  bridge + NetInfo) ; web : `WebBridgeTransport` (HTTPS) — même routeur.
- Intégration `MeshTransport` : le routeur remplace le choix binaire actuel.
- UI : panneau « Routeur » dans NetworkView (décisions en direct).

### P2 — Outbox durable (la garantie) — ~250 lignes
- `src/lib/mbote/outbox.ts` — file persistante avec storage adapter :
  mobile `expo-sqlite`, web IndexedDB (+ fallback localStorage).
- Purge par ack (statuts par paquet déjà renvoyés par `/api/mesh/bridge`).
- Backoff exponentiel (30 s → 15 min) ; jamais plus de 3 flush concurrents.
- Déclencheurs : NetInfo regain · foreground · timer 5 min · paquet reçu.
- Remplace `bridgeQueue` en mémoire (le bug « je tue l'app, je perds 200
  paquets » disparaît).

### P3 — Extension & interop (les options)
- **Pont Meshtastic** : script Node (`@meshtastic/js`) sur un boîtier LoRa (ou le
  VPS si le boîtier est en USB/BT) qui POST les paquets à `/api/mesh/bridge`
  avec `gatewayId: "lora-<node>"`. Portée : plusieurs km par saut. Zéro
  changement de protocole.
- **Passerelle Nostr** : mapper `MeshEvent.post` ↔ NIP-01/22, sync via relais
  publics → nos utilisateurs mesh deviennent visibles depuis n'importe quel
  client Nostr (et inversement). Multiplicateur d'adoption.
- **Web Bluetooth (Chromium)** : transport expérimental côté PWA, derrière le
  même `Transport` (détection de disponibilité, dégradation silencieuse).

### Énergie & robustesse (transversal, petit pas)
- Duty-cycle scan 30 %, adv 1000 ms si batterie < 15 % (spéc §3.3 déjà écrite).
- Sondes de santé partagées routeur ↔ UI (une seule source de vérité).

---

## 5. Pourquoi c'est LE bon plan de croissance

1. **Aucune reprise de code** : les couches dures (BLE natif, pont VPS, temps
   réel, social graph) existent et sont testées ; P1/P2 les *orchestrent*.
2. **Zéro dépendance externe** : DORS maison = pas de SDK tiers, pas de
   vendor lock-in, journal de décisions transparent dans l'UI.
3. **La distribution suit** : les workflows CI/CD déjà en place produisent les
   APK dès le prochain push — la pile de transport arrive dans les mains des
   utilisateurs au moment où les builds sortent.
4. **Croissance par ajout de passerelles** : LoRa, Nostr, Raspberry Pi… chaque
   nouveau canal est un client de `/api/mesh/bridge`, pas une refactorisation.

---

*Mbote Mesh — « le message trouve toujours un chemin » : BLE à portée, Internet
quand il existe, outbox pendant la nuit, LoRa au-delà.*
