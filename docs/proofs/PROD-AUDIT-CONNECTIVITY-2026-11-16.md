# AUDIT PROD — CAPACITÉS DE CONNEXION (BLE, INTERNET, RELAY) ET FAISABILITÉ DES BUILDS MOBILES

- **Date** : 2026-11-16 (fenêtre 13:31 → 14:55 UTC)
- **Cible** : production Mbote Mesh — `https://mbotemesh.aenews.online` (VPS 95.111.226.63)
- **Posture** : audit **en lecture seule** — aucune modification de configuration, aucun déploiement. Les deux seules écritures sont des créations d'identités de sonde (`probe-*`) explicitement annoncées, dans la limite Sybil de 3 créations/h/IP, et un DM de test de bout en bout.
- **Méthode** : chaque constat est appuyé par une preuve re-jouable (commande + sortie brute). Secrets jamais imprimés (credentials shred après usage). Hexdump utilisé dès qu'un artefact d'affichage est suspecté.
- **Pré-vol exécuté avant l'audit** : relance « tout fonctionne ? » — SSH VPS OK (`vmi3058261`, uptime 28 j), 3 conteneurs Mbote healthy, HTTPS public 200.

---

## §0 — PRÉ-VOL PROD : VERSION DÉPLOYÉE, SANTÉ, MIGRATIONS

### §0.1 Version déployée vs dépôt

```
$ git ls-remote https://github.com/AlterEgo095/mbote-bitchat.git refs/heads/main refs/heads/feat/mbote-v1
75e9559c0e5bbcba873132819871094736c29a6d        refs/heads/main
5ce5d96a0e1f1fd894c4ab878e6e9dd5f65cd874        refs/heads/feat/mbote-v1

$ git log --oneline -1 origin/main
75e9559 audit: prod verification 2026-11-05 — verdict GO conditionnel ; A1 8/8, A2 9/9, block-DM 9/9, A3 négatif 7/7 en prod ; …

$ docker inspect mbote-relay --format "{{.Config.Image}} | created={{.Created}}"   # sur le VPS
mbote-bitchat-relay | created=2026-11-15T18:22:20.060737818Z
```

- `origin/main` = commit d'audit du **2026-11-05** (aucune nouvelle release) — le STOP main demandé est tenu.
- `origin/feat/mbote-v1` = `5ce5d96` ; prod déployée = **`e970f0e`** (workflow_dispatch du 2026-11-15, images créées 18:22:20Z — cohérent avec le push de `e970f0e` à 18:12:06Z ; `d02813c` à 18:32:11Z est POSTÉRIEUR au build).
- **Parité runtime prouvée** entre `e970f0e` (déployé) et `5ce5d96` (head feat) :

```
$ git diff --stat e970f0e origin/feat/mbote-v1
 docs/proofs/DEPLOY-AND-MOBILE.md |  79 +++++++++++
 scripts/prod-verify-oa.ts        |  12 +-
 scripts/verify-mls.ts            | 279 +++++++++++++++++++
 3 files changed, 364 insertions(+), 6 deletions(-)

$ git diff --name-only e970f0e origin/feat/mbote-v1 | grep -E "^(src/|relay/|admin/|services/|apps/|Dockerfile|prisma/|deploy/)"
AUCUN fichier runtime modifié — parité runtime OK
```

- Avance FF : `git rev-list --left-right --count origin/feat/mbote-v1...origin/main` → `122 0` (main n'a divergé d'aucun commit → FF toujours propre).

### §0.2 Santé des conteneurs

```
$ docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep mbote
mbote-admin   Up 19 hours (healthy)   127.0.0.1:3392->3001/tcp
mbote-mesh    Up 19 hours (healthy)   127.0.0.1:3390->3000/tcp
mbote-relay   Up 19 hours (healthy)   3031/tcp, 127.0.0.1:3391->3030/tcp

$ docker inspect mbote-mesh --format "Status={{.State.Status}} Health={{.State.Health.Status}} Restarts={{.RestartCount}} StartedAt={{.State.StartedAt}}"
Status=running Health=healthy Restarts=0 StartedAt=2026-11-15T18:22:32.20660341Z
(5 derniers healthchecks : ExitCode=0 ×5)
```

3/3 healthy, **0 restart**, healthchecks sortis en 0. Composition réelle : `compose_dir=/opt/mbote-bitchat`, fichiers `docker-compose.yml + docker-compose.override.yml` (rebine les ports sur `127.0.0.1:3390/3391/3392` — rien d'exposé en direct).

### §0.3 Migrations Prisma

```
$ docker exec mbote-mesh sh -c "cd /app && DATABASE_URL=file:/app/db/custom.db ./node_modules/.bin/prisma migrate status"
Prisma schema loaded from prisma/schema.prisma
Datasource "db": SQLite database "custom.db" at "file:/app/db/custom.db"

14 migrations found in prisma/migrations

Database schema is up to date!
```

Liste effective : `0001_baseline`, `0002_drop_avatar_seed`, `0003_a1a2a3_replay_trust_moderation`, `0004_admin`, `0005_admin_auth`, `0006_etape6_queue`, `0007_b2_media`, `0007_etape9_four_eyes`, `0008_c1_push`, `0008_etape10_audit_stress`, `0009_d1_post_fts`, `0010_c4_groups`, `0011_d2_sybil`, `0012_g_i18n_preferences`. (**14**, y compris le delta 0003 ajouté après l'incident I-2 du 2026-11-05.) `npx` est absent de l'image (bun) — la commande re-jouable passe par `./node_modules/.bin/prisma`.

**Alerte environnementale** (hors périmètre Mbote, host partagé) : `load average 17.37, 13.82, 12.26` au moment de l'audit — le VPS héberge ~90 conteneurs d'autres services (mailcow, redamon, auditforge, penpot…). Le p95 mesuré par l'app reste 535 ms (§4). À surveiller, aucune action Mbote requise.

---

## §1 — BLE SUR LE VPS

### §1.1 Inventaire matériel/logiciel

```
$ which hciconfig bluetoothctl btmgmt          → (aucun — bluez non installé)
$ lsusb | grep -i -E "bluetooth|wireless"      → (aucun périphérique USB Bluetooth)
$ lsusb | wc -l                                → 1
$ ls -la /dev/hci*                             → ls: cannot access '/dev/hci*': No such file or directory
$ systemctl status bluetooth                   → Unit bluetooth.service could not be found.
$ busctl list | grep -i bluez                  → (bluez absent du bus système)
```

**Constat : zéro capacité BLE native sur le VPS** — pas d'adaptateur, pas de pile bluez, pas d'interface hci, pas de service.

### §1.2 Ce que le code exige réellement (relecture `feat/mbote-v1@5ce5d96`)

Le BLE de Mbote est **strictement client** (même architecture que BitChat) :

- Module natif Expo `mobile/modules/mbote-ble/` :
  - Android : `android/src/main/java/expo/modules/mboteble/BleMeshEngine.kt`, `GattServerManager.kt`
  - iOS : `ios/BleMeshEngine.swift`, `CentralTransport.swift`, `MboteBleModule.swift`, `PacketFramer.swift`, `PeripheralTransport.swift`
- `mobile/src/transport/ble-transport.ts` : `BleTransport` — `priority = 0` (premier canal essayé) ; `health()` expose voisins GATT + RSSI moyen.
- `mobile/src/transport/transport-router.ts` — politique de routage (§3.1 HYBRID-TRANSPORT-STACK) :
  1. BLE avec ≥ 1 voisin → émission mesh immédiate + copie outbox ;
  2. sinon Internet si la sonde RTT est OK → pont `/api/mesh/bridge` ;
  3. sinon outbox (spray-and-wait).
- Permissions déclarées (`mobile/app.json`) :
  - iOS : `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription`, `UIBackgroundModes: bluetooth-central + bluetooth-peripheral` ;
  - Android : `ACCESS_FINE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS`.

### §1.3 Verdict §1

Le « sans BLE » du VPS est **conforme à l'architecture** : le BLE se joue téléphone↔téléphone ; le VPS est le hub internet. La passerelle mesh↔internet est un **smartphone** (`MeshTransport.ts` : `gatewayId = pubkey.slice(0,16)`, POST/GET `/api/mesh/bridge`). Les deux options du mandat restent valables mais **non requises pour le MVP** :

- (a) nœud relais externe (Raspberry Pi + dongle BLE) = utile uniquement pour une passerelle fixe 24/7 ;
- (b) adaptateur USB BLE + `--device=/dev/hci0` dans le conteneur = utile uniquement si un jour un service serveur devait parler BLE directement (aucun code serveur BLE n'existe aujourd'hui).

**Aucune action bloquante.**

---

## §2 — TRANSPORTS INTERNET (RELAY, BRIDGE, OUTBOX, TURN)

### §2.1 Relay WebSocket — **PASS**

Reverse-proxy réel : **nginx** (pas le Caddyfile du dépôt) sur `mbotemesh.aenews.online` — TLS 1.2/1.3 Let's Encrypt, `/socket.io/ → 127.0.0.1:3391` avec `Upgrade/Connection` et timeouts 7 j, `/api/ → 127.0.0.1:3390` (limit_req 120 r/m burst 30). Le serveur est derrière **Cloudflare** (DNS `2606:4700:3036::…`, `server: cloudflare`).

```
$ curl -sS "https://mbotemesh.aenews.online/socket.io/?EIO=4&transport=polling"
0{"sid":"qkp2GLWpuqjPHHvhAAAE","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}
```

Test **WebSocket réel** (sonde bun, upgrade complet — `wss://mbotemesh.aenews.online/socket.io/?EIO=4&transport=websocket`) :

```
WS_OPEN (upgrade HTTP→WS accepté par nginx)
WS_RECV: 0{"sid":"XojWvcmt6jGH1JxTAAAG","upgrades":[],…}
WS_RECV: 40{"sid":"EWhL4JaWVQKqIMJdAAAC"}
SOCKETIO_CONNECTED (ns /)
PASS WS (fermé code=1000)
```

Upgrade HTTP→WS accepté, handshake socket.io acquitté, fermeture propre. Le relay est **publiquement joignable en WebSocket** (re-jouable : `bun ws-probe.ts`).

### §2.2 `/api/mesh/bridge` + rate-limit / forge d'en-têtes — **PASS avec 1 durcissement recommandé**

Contrat vérifié dans `src/app/api/mesh/bridge/route.ts` : POST dépôt de paquets passerelle (dedup crypto SHA-256 persistante), GET downlink `?gatewayId=&since=` (max 50, persistance DB → **store-and-forward serveur du flux mesh**).

```
$ curl -X POST -d '{}' https://mbotemesh.aenews.online/api/mesh/bridge            → 400
$ curl -X POST -H "X-Forwarded-For: 1.2.3.4" -d '{}' …/api/mesh/bridge           → 400
$ curl -X POST --resolve mbotemesh.aenews.online:443:95.111.226.63 -H "cf-connecting-ip: 8.8.8.8" -d '{}' …/api/mesh/bridge  → 400 (bypass CF)
# burst 35 POST payload vide via CF + 8 avec XFF forgé : 43× HTTP 400, aucun 503 nginx, aucun 429
```

- La forge `X-Forwarded-For` **n'a aucun effet** : `src/lib/mbote/client-ip.ts` n'accepte une IP réelle que si `cf-connecting-ip` + `cf-ray` + dernier hop XFF ∈ plages Cloudflare officielles (vérifié par exécution locale de `clientIp()` : renvoie bien `cf-connecting-ip` sur trajet CF, et ignore le XFF forgé).
- **Durcissement recommandé** : l'origine accepte les connexions TLS directes (contournement Cloudflare par `--resolve` → 200/400). En prod, tout trafic direct-origine reçoit `clientIp() = "local"` → il partage **un seul** bucket de rate-limit/Sybil. Atténuation : restreindre le `server{443}` nginx de mbote aux plages IP Cloudflare (`allow/deny`), ou firewall. Non bloquant : CF est le chemin nominal et les plafonds crypto (PoW, ECDSA) restent actifs.

### §2.3 Store-and-forward — trois couches vérifiées

**Couche client (outbox durable)** — `mobile/src/transport/outbox-core.ts` + `outbox-storage.ts` :
- persistance : `expo-sqlite` (`mbote-outbox.db`) + repli AsyncStorage ; web : IndexedDB + repli localStorage ;
- spray-and-wait : purge sur ack (`accepted`/`duplicate`/`invalid`), backoff exponentiel 30 s → 15 min, ≤ 3 flush concurrents, déclencheurs regain réseau / foreground / timer 5 min / paquet reçu.

**Couche serveur (DM hors ligne)** — les DM sont persistés en DB (`POST /api/dms`, 8 KiB max, replay-guard, quota réputation D2) et relus à la reconnexion (`GET /api/dms` protégé par preuve `${me}|dm-read|${peer}|${ts}` F-07). **Test E2E réel en prod (résultats §2.3-bis)**.

**§2.3-bis — Test E2E store-and-forward DM en production** : **EXÉCUTÉ — PASS** (en deux temps pour respecter le plafond Sybil 3 créations/h/IP : A' créée à 13:45 UTC, B' à 14:46 UTC une fois la fenêtre glissante libérée — le 429 attendu aurait été un échec de planification, il n'a pas eu lieu). Sorties brutes :

```
$ bun /home/z/audit-dm.ts stage1   # 13:45 UTC — identité A' (PoW 20 bits + ECDSA P-256)
   identité A' créée : 200 — BHacj87Wz4KM…
$ bun /home/z/audit-dm.ts stage2   # 14:46 UTC — identité B' puis DM E2EE
   identité B' créée : 200 — BGDk5Hk9ldnZ…
   POST /api/dms : 200 {"message":{"id":"cmwjdmxcg000lqt010sghfv5h","senderKey":"BHacj87Wz4KM…","recipientKey":"BGDk5Hk9ldnZ…"}}
   PASS — DM v2 accepté et persisté (destinataire hors ligne) : status 200
   GET /api/dms (B' relit) : 200
   PASS — store-and-forward DM E2EE complet : persisté puis livré à la reconnexion
          — déchiffré côté B' : "audit-store-and-forward-mwjbg4kz"
```

Chaîne complète prouvée en prod : ECDH P-256 (A'×B') → AES-256-GCM → POST signé `dm2` (`msgId+seq`, id DB `cmwjdmxcg000lqt010sghfv5h`) → persistance serveur pendant que B' n'a **jamais** ouvert sa boîte → relecture signée par B' (`dm-read`) à la « reconnexion » → déchiffrement **identique au clair original** `audit-store-and-forward-mwjbg4kz`. **PASS.**

**Couche bridge mesh** : downlink GET `?since=` lit les paquets stockés (`createdAt >= since`, max 50, dedup) → un maillage dont la passerelle est absente retrouve son flux au retour. (Re-jouable : `scripts/prod-verify-oa.ts`.)

### §2.4 TURN / coturn — **NON CÂBLÉ À MBOTE (constat majeur), serveur présent et joignable**

```
$ curl "https://mbotemesh.aenews.online/api/turn-credentials?me=…&ts=…&signature=…"   # preuve ECDSA valide A'
{"available":false,"reason":"TURN non configuré — ICE direct uniquement, fallback notes vocales possible"}
```

- Le conteneur `mbote-mesh` n'a **pas** `TURN_SHARED_SECRET` → `/api/turn-credentials` répond `available:false` → les appels WebRTC restent en ICE direct (host/srflx) puis basculent en notes vocales après 2 échecs/30 s (comportement dégradé câblé dans le client C2).
- **MAIS** un serveur coturn tourne bien sur le VPS, au niveau host :

```
$ systemctl status coturn
● coturn.service - coTURN STUN/TURN Server
   Active: active (running) since Sat 2026-11-14 06:21:17 WAT; 2 days ago
$ ps aux | grep [t]urnserver
turnser+ 1411589 … /usr/bin/turnserver -c /etc/turnserver.conf --pidfile=
$ ss -tlnp | grep ":443 "        → nginx (0.0.0.0:443, [::]:443)
$ ss -ulnp | grep ":3478"        → coturn : UDP 3478 sur l'IP publique 95.111.226.63 + IPv6 + toutes les bridges docker
```

- **Joignabilité externe prouvée** (sonde STUN depuis le sandbox — re-jouable : `bun stun-probe.ts`) :

```
UDP 3478 : réponse 112 octets — Binding Error Response
TCP 3478 : réponse 112 octets — Binding Error Response
```

Le serveur répond en TCP **et** UDP sur l'IP publique (les réponses d'erreur 112 octets indiquent un mécanisme d'auth/fingerprint actif — pas un relais ouvert). NB : `/etc/turnserver.conf` n'est pas lisible par `aenews` (root 640) — contenu exact non vérifiable sans root ; documenté tel quel.
- **Conflit 443** : le plan RDC/CGNAT de `deploy/docker-compose.turn.yml` (`turns:443?transport=tcp` en priorité) est **impossible sur ce host** — nginx occupe déjà 0.0.0.0:443. Contournements : (1) câbler le coturn host EXISTANT via `TURN_SHARED_SECRET` + realm/secret alignés (port 3478 déjà joignable), (2) SNI-passthrough nginx `stream{}` pour dédier 443 au TURN, (3) host TURN séparé.
- Impact produit : derrière CGNAT strict (Vodacom/Airtel/Orange RDC), les appels P2P échoueront sans TURN ; la voix dégradée (notes vocales) fonctionne. Le transport messagerie (BLE + relay) n'est **pas** affecté par TURN.

---

## §3 — BUILDS MOBILES : **PASS**

### §3.1 Workflows

`build-android.yml` (« Android (APK) ») et `build-ios.yml` (« iOS (IPA / simulateur) ») : `state=active`, déclencheurs `push (branches: [main])`, `tags: v*.*.*`, `pull_request`, **`workflow_dispatch`**. Droits : `contents: read` au workflow, `write` uniquement pour publier l'artefact/release.

### §3.2 Derniers runs (les 2 déclenchés le 2026-11-15 avec le déploiement)

```
$ gh api repos/AlterEgo095/mbote-bitchat/actions/workflows/build-android.yml/runs?per_page=5 (via curl -H "Authorization: token ***")
51 | workflow_dispatch | completed | conclusion=success | feat/mbote-v1 @ 2026-11-15T17:06:52Z | id=43739259154
52 (iOS) | workflow_dispatch | completed | conclusion=success | feat/mbote-v1 @ 2026-11-15T17:06:53Z | id=43739261535
```

### §3.3 Artefacts téléchargeables (vérifiés par téléchargement réel)

```
$ curl -H "Authorization: token ***" …/actions/runs/43739259154/artifacts
mbote-android-v1.0.0-r51 | 32 770 485 octets | expired=false | id=14172191458
$ curl -H "Authorization: token ***" …/actions/runs/43739261535/artifacts
mbote-ios-v1.0.0-r52     | 20 045 911 octets | expired=false | id=14172628639

$ curl -sSL -H "Authorization: token ***" -o apk.zip …/artifacts/14172191458/zip && unzip -l apk.zip
  72 405 979  mbote-v1.0.0-android.apk
$ curl -sSL … ipa.zip && unzip -l ipa.zip
   7 230 191  mbote-v1.0.0-ios-unsigned.ipa
  12 996 748  mbote-v1.0.0-ios-simulateur.zip
```

- **APK** : artefact réel de 72.4 MB, signé **clé debug** (sans secrets keystore) → **installable en sideload** immédiatement ; le workflow bascule en keystore production si `ANDROID_KEYSTORE_BASE64` est fourni.
- **IPA** : build device non signé — `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`, méthode `Payload/` zippée en `.ipa` (workflow lignes 113-137) + build simulateur. **Limite à rappeler** : une IPA non signée prouve la compilation mais **ne s'installe pas sur un iPhone réel** sans certificat Apple (compte Developer 99 $/an, signature ad-hoc/TestFlight).

---

## §4 — DÉCOUVERTE DE PAIRS VS BITCHAT

```
$ curl https://mbotemesh.aenews.online/api/users
200 — 17 profils | champs : id, pubkey, nickname, bio, ecdhPub, isBot, createdAt, quota, flaggedCount, _count, isFollowing
$ curl https://mbotemesh.aenews.online/api/presence
404 (route HTTP absente)
$ curl https://mbotemesh.aenews.online/api/stats
{"users":17,"posts":2,"dms":9,"channels":0,"likes":2,"gateways":1,"meshIngest24h":0,
 "perf":{"reqPerSec":0.08,"p95Ms":535,…}}
```

- **Découverte centralisée** : `/api/users` expose les profils publics **avec `ecdhPub`** → n'importe quel client peut chiffrer un DM vers un pair découvert sans session préalable. BitChat, lui, n'a **aucune** découverte serveur (pairs trouvés uniquement par BLE/réseau local) — Mbote dépasse ici le modèle BitChat, c'est un choix produit assumé (identités enregistrées par PoW Sybil).
- **Présence** : pas de `/api/presence` HTTP ; la présence vivant côté relay (`presence:update` socket.io, comptage online, hello signé ECDSA F-08 — `mini-services/relay-service/hub.ts`). Cohérent avec le durcissement D3 (relay sans état).
- `gateways:1` : une passerelle mesh est enregistrée ; `meshIngest24h:0` : aucun paquet mesh ingéré ces dernières 24 h (pas de passerelle mobile active récente — attendu avant distribution des builds).

---

## §5 — TABLEAU RÉCAPITULATIF ET VERDICT

| Capacité | État réel (preuve) | Écart vs BitChat | Action requise |
|---|---|---|---|
| **BLE scan/mesh** | PASS — module natif complet Android (Kotlin) + iOS (Swift), `BleTransport` priorité 0, permissions déclarées ; VPS sans BLE = conforme (BLE device-to-device) | Aligné BitChat (aucun BLE serveur) | Aucune (option : passerelle fixe RPi/dongle pour un relais 24/7) |
| **Relay internet** | PASS — WS réel vérifié via nginx+CF (upgrade + handshake + close propre) | Extension BitChat (hub internet assumé) | Aucune |
| **Store-and-forward** | PASS — 3 couches prouvées : outbox client durable (sqlite/IndexedDB, spray-and-wait), **E2E prod §2.3-bis** (DM v2 200, relu par B' à la reconnexion, déchiffré identique), bridge downlink `since`+dedup | Extension BitChat (P2 durable) | Aucune |
| **WebRTC TURN** | **NON CÂBLÉ** — `/api/turn-credentials` → `available:false` (secret absent) ; coturn host EXISTE, joignable 3478 TCP+UDP (sonde STUN), 443 occupé par nginx | BitChat n'a pas d'appels ; écart vs objectif Mbote (appels RDC/CGNAT) | **Bloquant appels** : poser `TURN_SHARED_SECRET` + aligner coturn host (realm/secret), résoudre 443 (SNI passthrough ou 3478-only), re-tester ICE relay |
| **Découverte pairs** | PASS — `/api/users` 200 (17 profils, ecdhPub exposé), présence via socket.io ; `/api/presence` 404 (n'existe pas, par design) | Dépasse BitChat (découverte centralisée vs locale) | Aucune (choix produit) |
| **APK Android** | PASS — artefact r51 téléchargé : `mbote-v1.0.0-android.apk` 72.4 MB, signé debug → sideload immédiat | — | Distribuer le lien artefact ; fournir keystore prod pour la signature finale |
| **IPA iOS** | PARTIEL — artefact r52 : `mbote-v1.0.0-ios-unsigned.ipa` (7.2 MB) + simulateur ; prouve la compilation ; **non installable sur iPhone réel sans certificat Apple** | — | Compte Apple Developer (99 $/an) → signature ad-hoc/TestFlight |

### Verdict final : **GO CONDITIONNEL**

**Ce qui est opérationnel dès aujourd'hui** : la messagerie complète du MVP — identités (PoW Sybil + ECDSA), DM E2EE avec store-and-forward prouvé en production, feed/channels via relay WebSocket réel, BLE téléphone↔téléphone embarqué dans les builds, APK installable par sideload, découverte de pairs centralisée.

**Bloquants (2) et contournements** :
1. **Appels derrière CGNAT strict** : TURN non câblé à Mbote (`available:false`). Contournement immédiat : câbler le coturn **déjà présent** sur le host (joignable 3478) via `TURN_SHARED_SECRET` + realm alignés ; moyen terme : 443 dédié (SNI passthrough) pour la priorité RDC `turns:443`. Sans cela : ICE direct + fallback notes vocales (déjà câblé côté client).
2. **Distribution iOS réelle** : IPA non signée (prouve la compilation, pas l'installation). Contournement : compte Apple Developer + signature ad-hoc/TestFlight ; Android n'est pas concerné (APK debug sideloadable).

**Durcissement recommandé (non bloquant)** : restreindre le 443 nginx de mbote aux plages Cloudflare (fermer le bypass direct-origine qui réduit le rate-limit per-IP à un bucket global « local ») ; surveiller le load average du host partagé (17+).

**Actions opérateur listées (aucune exécutée)** :
1. Poser `TURN_SHARED_SECRET=<openssl rand -hex 32>` dans `/opt/mbote-bitchat/.env` + aligner le realm/secret de `/etc/turnserver.conf` (accès root requis) ; re-tester `available:true` puis ICE relay.
2. Décision 443 : SNI passthrough nginx `stream{}` **ou** accepter 3478-only.
3. Provisionner `MEDIA_S3_*` (restant du déploiement 2026-11-15).
4. Push `feat/mbote-v1 → main` sur feu vert (FF 122/0 vérifié).
5. Compte Apple Developer pour l'IPA signée ; fournir `ANDROID_KEYSTORE_BASE64` pour l'APK production.

*Fin de l'audit — posture lecture seule respectée ; écritures limitées aux sondes identités/DM annoncées (4 créations de sondes réparties sur deux fenêtres horaires glissantes — jamais plus de 3/h — et 1 DM de test, ciphertext `audit-store-and-forward-mwjbg4kz`, contenu clairement étiqueté).*
