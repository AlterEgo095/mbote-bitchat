# AUDIT TECHNIQUE FRONTEND 360° — Mbote BitChat

**Date** : 2025 · **Périmètre** : web Next.js (`src/`), PWA (`public/`), app native Expo (`mobile/`), relay socket.io (`mini-services/`), CI/CD
**Méthode** : audit statique exhaustif (4 axes parallèles, lecture intégrale) + audit dynamique (navigateur réel, golden path complet) + lint.
**Règle respectée** : lecture seule — aucun fichier de code modifié, aucune donnée de production altérée.
**Légende statuts** : PASS / PARTIAL / FAIL (présent mais non fonctionnel) / MISSING / NOT VERIFIED / N/A.

---

## 0. SYNTHÈSE EXÉCUTIVE

| Axe | Verdict |
|---|---|
| Web (Next.js) | **Fonctionnel de bout en bout** — golden path vérifié en navigateur (identité → post signé → like → réponse → DM E2E bot → canaux → tunnel BitChat réel → file hors-ligne → flush). Zéro erreur console. |
| PWA | **Installable et offline-shell fonctionnel**, mais raccourcis inopérants, pas de mise à jour annoncée, pas de cache de données hors-ligne. |
| Mobile native (Expo) | **Module BLE complet (non-stub)** mais **fonctionnalité cœur cassée** : impossible de publier (payload > limite protocole, F-03). |
| Sécurité | **Cluster P0** : le modèle « clé = compte » est contournable par 3 voies (identity sans preuve, signature optionnelle, pont mesh sans vérification). |
| Backend | Solidé (transactions, idempotence, rate-limit partiel) mais **seed cassé sur DB fraîche** (P2002) et **temps réel non déployable en l'état** (NEXT_PUBLIC_SOCKET_URL non transmis au build). |
| Maturité globale | **POC avancée / démo soignée — NON prête pour la production.** 3 P0, 8 P1, ~22 P2, ~20 P3. |

---

## 1. CARTOGRAPHIE DE L'ÉCOSYSTÈME FRONTEND

### 1.1 Applications existantes

| App | Stack | Entrée | État |
|---|---|---|---|
| Web/PWA | Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui, TanStack Query, socket.io-client | `src/app/page.tsx` → `MboteApp.tsx` (844 l.) | Opérationnel (vérifié navigateur) |
| Mobile native | Expo SDK 52, RN 0.76, module natif `mbote-ble` (Kotlin + Swift), @noble (crypto JS pur) | `mobile/App.tsx` (tab bar maison, 3 onglets) | Compile (tsc OK) ; publication FAIL (F-03) |
| Relay temps réel | Bun + socket.io, ports 3030 (public) / 3031 (emit interne) | `mini-services/relay-service/index.ts` | Opérationnel (handshake vérifié) |

### 1.2 Routes et pages (web)

- **Une seule page UI** : `/` (client-only, `<MboteApp />`). **Aucune** route `error.tsx` / `global-error.tsx` / `loading.tsx` / `not-found.tsx` (F-10). Aucune page admin, aucun middleware.
- **13 routes API** : `/api` (vestige « Hello world »), `posts`, `posts/like`, `follows`, `channels`, `stats`, `users`, `identity`, `seed`, `dms`, `dms/conversations`, `dms/bot`, `mesh/bridge`.
- **Navigation interne par état** (5 vues : fil/canaux/messages/réseau/profil), **pas d'URL routing** → bouton retour navigateur inopérant, raccourcis manifest `?view=` morts (F-14, confirmé dynamiquement).

### 1.3 Composants (15/15 utilisés, 0 composant mbote mort)

`MboteApp` (orchestrateur, socket, outbox courrier, panic wipe) · `FeedView` · `ChannelsView` · `MessagesView` (DM E2E) · `NetworkView` · `ProfileView` · `Composer` (partiel : props `parentId`/`onCancel` jamais exercées) · `PostCard` (+`PendingPostCard`) · `MeshSimulation` (1 430 l., simulation Canvas assumée) · `RouteurPanel` (journal DORS réel) · `BitChatBridge` (tunnel réel) · `OnboardingDialog` · `Avatar` · `PwaRegister` · `Providers`.

**Dettes de composants** : ~40 modules shadcn/ui jamais importés (tabs, table, chart, form, sidebar, sheet…), hooks `use-toast`/`use-mobile` en chaîne morte, exports API morts (`apiSetFollow`, `apiGetFollow`, `apiBridgePost`), `closeSocket()` jamais appelé, constantes mortes (`BOT_NICKNAME`, `LS_READ_DMS`, `User.avatarSeed`).

### 1.4 État et services

- **Pas de store global client** (Zustand déclaré, 0 import). État = `useState` + TanStack Query + localStorage.
- **Deux files offline hétérogènes** : (1) « courrier » social localStorage (`mbote_outbox_v1` : identity/post/like/dm, flush par `MboteApp`) ; (2) outbox **durable** IndexedDB BitChat (backoff 30 s → 15 min, plafond 1 000, purge par ack) — architecture DORS propre mais double système (F-31).
- `api.ts` : 17 fonctions, format correct (croisé avec les routes) ; **sans timeout ni retry propre** (F-32).
- Socket : reconnexion infinie 1,5→8 s, rooms `feed`/`channel:<geohash>`/`dm:<pubkey>` ; **`subscribe` jamais émis → push par canal mort** (F-33) ; fallback polling 6–25 s partout.
- Protocole BitChat **bit-identique web/mobile** (diff vérifié : 0 ligne), crypto ECDSA P-256 + ECDH/AES-GCM interopérable par conception (test croisé automatisé absent).

### 1.5 Duplication web ↔ mobile (risque de dérive)

4 fichiers copiés manuellement sans mécanisme de synchronisation ni test de parité : `bitchat-protocol.ts`, `outbox-core.ts`, `types.ts`, `router.ts` (F-22).

---

## 2. INVENTAIRE DES APPLICATIONS INSTALLABLES

| App | Artefact | Identité visuelle | Installation | Deep links |
|---|---|---|---|---|
| PWA (Android/Chrome) | manifest.webmanifest (192/512/maskable, shortcuts, standalone) | « Mbote Mesh », `#0a0f0d` | OK (manifest valide, icônes 200) | Shortcuts `?view=` **inopérants** (F-14) |
| PWA (iOS/Safari) | apple-touch-icon 180, `appleWebApp`, `viewportFit: cover` | Idem | Probable — **NOT VERIFIED sur appareil** | n/a |
| APK Android (CI) | `build-android.yml` : tsc → prebuild → assembleRelease, versionCode auto, signature conditionnelle | **Aucune icône/splash dans app.json** (F-27) | Sideload OK (debug-signed sans secrets) | **Aucun scheme** (F-27) |
| iOS (CI) | `build-ios.yml` : simulateur build toujours produit ; IPA signée **seulement si secrets** fournis | Idem | **NOT VERIFIED** (certificats absents) | n/a |

**SW (`public/sw.js`, v1)** : précache shell, network-first navigations + fallback cache → 503 « Hors ligne », stale-while-revalidate `/_next/` + `/icons/`, **jamais `/api/*` ni `/socket.io`**. Enregistré **production uniquement**. Pas de push, pas de background sync, `skipWaiting` immédiat sans UI (F-26).

---

## 3. PREUVES DE L'AUDIT DYNAMIQUE (navigateur réel, via gateway :81)

| # | Test | Résultat |
|---|---|---|
| D1 | Rendu `/`, feed + modale onboarding | ✅ PASS — 0 erreur console, 0 erreur serveur |
| D2 | Création identité (pseudo→clés→entrée) | ✅ PASS |
| D3 | Publication post signé | ✅ PASS — apparaît avec badge « signée » |
| D4 | Like (0→1) | ✅ PASS |
| D5 | Réponse (thread) | ✅ PASS |
| D6 | DM au bot (« aide ») → réponse chiffrée | ✅ PASS — E2E actif, conversation listée |
| D7 | Vue Canaux (filtres, créateur, cartes) | ✅ PASS |
| D8 | Tunnel BitChat : encapsuler → transmettre | ✅ PASS — « accepted · RTT 81 ms », post injecté avec « via mesh · 3 sauts », compteurs 21→22 |
| D9 | Mode mesh : publication → file locale | ✅ PASS — carte ambre « en attente — courrier local », toast |
| D10 | Retour en ligne → flush automatique | ✅ PASS — post publié |
| D11 | Socket temps réel via gateway | ✅ PASS — « 1 en direct » (présence reçue) |
| D12 | Responsive 390×844 | ✅ PASS — nav bas 5 onglets, scroll horizontal : non |
| D13 | Thème clair | ✅ PASS |
| D14 | Sélecteur contacts + indicateur E2E par contact | ✅ PASS |
| D15 | Canvas simulation mesh | ✅ PASS (838×500) |
| D16 | `?view=network` (raccourci manifest) | ❌ **FAIL** — s'ouvre sur « Fil » (F-14) |
| D17 | Fichiers PWA (manifest/sw/icônes) | ✅ 200 + bon content-type |
| D18 | `?XTransformPort` en header (mauvais usage) | N/A — le passage query via gateway :81 fonctionne |

**Notes dynamiques** : socket.io **ne passe pas** si l'app est servie hors gateway (accès direct :3000 → badge « relay… » permanent) — en production VPS c'est le cas par défaut (F-09).

---

## 4. MATRICE DE CONFORMITÉ MULTIPLATEFORME

| Fonctionnalité | Web Desktop | Web Mobile | PWA Android | PWA iOS | Native Android | Native iOS | Backend | Statut |
|---|---|---|---|---|---|---|---|---|
| Onboarding identité (clés) | PASS | PASS | PASS | PASS | PARTIAL (auto-créé, sans consentement) | PARTIAL | PASS* | PARTIAL |
| Profil : édition, bio, copie clé | PASS | PASS | PASS | PASS | PARTIAL (pseudo seul, pas de bio) | PARTIAL | PASS | PARTIAL |
| Publication signée | PASS | PASS | PASS | PASS | **FAIL (F-03)** | **FAIL (F-03)** | PARTIAL (F-01) | FAIL |
| Réponses / threads | PASS | PASS | PASS | PASS | MISSING | MISSING | PASS | PARTIAL |
| Likes | PASS | PASS | PASS | PASS | MISSING | MISSING | PARTIAL (F-01) | PARTIAL |
| Follows (UI) | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | PASS (API orpheline) | FAIL |
| DM chiffrés E2E | PASS | PASS | PASS | PASS | MISSING | MISSING | PASS | PARTIAL |
| Bot DM | PASS | PASS | PASS | PASS | MISSING | MISSING | PASS | PARTIAL |
| Canaux géohash | PASS | PASS | PASS | PASS | MISSING | MISSING | PASS | PARTIAL |
| Géolocalisation réelle (GPS) | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | N/A | MISSING |
| Flux temps réel (socket) | PASS | PASS | PASS | PASS | MISSING | MISSING | PARTIAL (F-09 en prod) | PARTIAL |
| Mesh BLE réel | N/A (simulation) | N/A | N/A | N/A | PASS* (code complet, NOT VERIFIED appareil) | PASS* (NOT VERIFIED) | PASS (pont) | PARTIAL |
| Uplink pont `/api/mesh/bridge` | PASS | PASS | PASS | PASS | FAIL (F-03/F-05) | FAIL | PASS | PARTIAL |
| Downlink pont (VPS→client) | PASS (panneau) | PASS | PASS | PASS | **MISSING (F-04)** | **MISSING (F-04)** | PASS | FAIL |
| Outbox durable hors-ligne | PASS | PASS | PASS | PASS | PARTIAL (F-05) | PARTIAL | PASS | PARTIAL |
| Panic wipe complet | PARTIAL (F-11) | PARTIAL | PARTIAL | PARTIAL | PARTIAL (F-11) | PARTIAL | N/A | FAIL |
| Notifications push | MISSING | MISSING | MISSING | MISSING | PARTIAL (FGS ; permission non demandée F-27) | PARTIAL | MISSING | MISSING |
| Upload média (images/vidéos) | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING |
| Blocage / signalement | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING |
| Recherche (users/posts) | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING |
| Pagination / scroll infini | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | PASS (curseur prêt) | FAIL |
| Deep links | N/A | N/A | FAIL (F-14) | N/A | MISSING | MISSING | N/A | MISSING |
| Installation PWA | N/A | N/A | PASS (NOT VERIFIED device) | NOT VERIFIED | N/A | N/A | N/A | PARTIAL |
| Shell offline | PASS | PASS | PASS | PASS | N/A | N/A | N/A | PARTIAL (données non cachées F-25) |
| Thème clair/sombre | PASS | PASS | PASS | PASS | MISSING (dark only) | MISSING | N/A | PARTIAL |
| Journal de routage DORS | PASS | PASS | PASS | PASS | PASS (MeshScreen) | PASS | N/A | PARTIAL |

\* PASS = implémentation complète au niveau code ; comportement radio réel sur matériel **NOT VERIFIED** (simulateur incapable de CoreBluetooth/BLE).

---

## 5. INVENTAIRE DES FONCTIONNALITÉS

### 5.1 Opérationnelles (vérifiées)
Identité locale + clés (web), publication signée (web), likes, réponses/threads, DM E2E + bot (web), canaux géohash + filtres, stats réseau réelles, tunnel BitChat web (encapsulation binaire, outbox durable IndexedDB, purge par ack, downlink panneau), file « courrier » hors-ligne + flush auto, socket temps réel (via gateway), shell PWA offline, thème, panic wipe (local), journal DORS, simulation pédagogique.

### 5.2 Incomplètes
- **Follows** : backend complet, compteurs affichés, **aucun bouton suivre** (F-12).
- **DM hors-ligne** : refus explicites alors que le rejoueur outbox sait traiter les DM (F-15).
- **Panic wipe** : n'efface pas l'outbox IndexedDB/repli LS (web) ni outbox SQLite/AsyncStorage (mobile) (F-11).
- **PWA** : shortcuts morts, pas d'UI de mise à jour, pas de cache de données (F-14/F-25/F-26).
- **Mobile** : pseudo sans bio, pas de DM UI (PKT_PRIVATE jamais câblé), pas de downlink, outbox sans UI de gestion, URL pont perdue au redémarrage.
- **Pagination** : contrat curseur prêt, jamais consommé (F-13).
- **Composer** : chemin réponse jamais exercé (double implémentation avec PostCard).

### 5.3 Absentes (périmètre produit réel)
Upload d'images/vidéos, notifications push (web + app), recherche d'utilisateurs/publications, tendances/suggestions, blocage, signalement, modération, géolocalisation réelle (GPS — presets villes uniquement), raccourcis PWA fonctionnels, deep links mobiles, i18n (tout est FR codé en dur), raccourci « partage entrant » (share_target).

---

## 6. INCOHÉRENCES ENTRE PLATEFORMES (sélection)

1. **Noms différents** : PWA « Mbote Mesh » vs mobile « Mbote BitChat » ; theme colors `#0a0f0d` vs `#0B0F0E` (F-27).
2. **Parité fonctionnelle très éloignée** : 12 fonctionnalités web absentes du mobile (canaux, DM, likes, réponses, bio, géohash, follows, simulation, downlink, thème, onboarding, temps réel).
3. **MAX_PEERS divergent** : 6 (Kotlin `MeshBle.kt:38`) vs 8 (Swift `PacketFramer.swift:20`).
4. **Validation incohérente** : web tronque à 500 caractères avec compteur ; mobile autorise 500 chars mais le protocole rejette le paquet (F-03) — même saisie, résultats opposés.
5. **Panic wipe** : web efface plus que mobile (ni outbox SQLite, ni nickname/bridgeUrl côté mobile).
6. **Vue « réseau »** : web expose le downlink + tunnel réel ; mobile expose le vrai BLE mais jamais le downlink.
7. **Onboarding** : web consentant (modale), mobile silencieux (identité auto-créée au lancement).

---

## 7. UX/UI — PROBLÈMES

- Bouton like sans rollback si 4xx après enqueue (compteur optimiste non annulé) — `PostCard.tsx:59-64`.
- Cartes canaux cliquables non focusables clavier + bouton « Ouvrir » `tabIndex={-1}` sans action propre — `ChannelsView.tsx:118-168`.
- Présence trichée : `Math.max(presence, 1)` → « 1 en direct » même à 0 — `MboteApp.tsx:572,725`.
- Texte pédagogique cite **Nostr** (transport/boîtes aux lettres) alors que le pont réel est `/api/mesh/bridge` — `NetworkView.tsx:80-114`.
- Header sticky sans padding `safe-area-inset-top` iOS standalone (bas OK, `MboteApp.tsx:788`).
- Toast d'erreur absent sur échec de chargement du feed (`isError` ignoré) ; pas d'état d'erreur dédié.
- Bouton « Close » de la modale d'onboarding « bloquante » : fermer sans identité laisse l'app en mode lecture avec CTA — comportement cohérent mais mérite un état d'aide explicite.
- Design system globalement **cohérent et soigné** (emerald/vert, dark par défaut, aria-labels, aria-live, états vides/loading présents partout, footer sticky conforme).

---

## 8. PERFORMANCE (mesures dev + analyse statique)

| Mesure (mode dev, via gateway) | Valeur |
|---|---|
| TTFB | 39 ms |
| DOM ready / load complet | 121 ms / 567 ms |
| Requêtes / poids transféré | 77 / ~1,4 Mo (JS ~1,0 Mo non minifié) |

**Goulots identifiés (statique)** :
1. **Zéro code-splitting** : aucune importation dynamique — les 5 vues **+ MeshSimulation (1 430 lignes)** sont dans le bundle initial (F-34).
2. **Polling multiple** : refetch 6–25 s sur toutes les vues en plus du socket (charges serveur inutiles quand le relay est sain).
3. **N+1 SQL sur `/api/channels`** (une requête `distinct` par canal) + `posts` GET sans garde sur `limit` négatif.
4. Hero en **background-image CSS** (PNG non optimisé, non priorisé) ; `next/image` utilisé uniquement pour le logo.
5. SW sans précache des chunks `/_next/` au premier lancement (remplissage au fil de l'eau — acceptable).
6. Simulation canvas : boucle rAF jusqu'à 80 nœuds — confinée à la vue Réseau, acceptable sur desktop, **risque batterie mobile** (pas de pause hors-écran vérifiée).

---

## 9. ACCESSIBILITÉ & COMPATIBILITÉ

- ✅ Rôles/labels ARIA présents (navigation, switch, régions, `aria-live`), navigation clavier correcte sur la majorité des contrôles, footer et nav conformes.
- ❌ Cartes canaux non focusables clavier (`div onClick`).
- ❌ **`prefers-reduced-motion` non supporté** (aucune occurrence) — animations de simulation et transitions non désactivables.
- ⚠️ Contrastes : **NOT VERIFIED** (pas d'audit automatique exécuté).
- ⚠️ Compatibilité navigateurs/WebView : **NOT VERIFIED** (aucune matrice testée ; le code est standard ES2020+, sans API exotique côté web).
- iOS standalone : safe-area bas gérée, haut non (risque chevauchement encoche).

---

## 10. SÉCURITÉ FRONTEND (détail dans registre)

- ✅ Aucun secret versionné (grep exhaustif), `.env*` ignoré, aucun `.env` dans l'historique git.
- ✅ Pas de sink XSS (aucun `dangerouslySetInnerHTML` sur données utilisateur, aucun eval/innerHTML), liens externes `noopener noreferrer`, rendu React échappé.
- ✅ SW propre : `/api` jamais caché, pas de données sensibles en cache.
- ❌ **Clés privées en clair** : localStorage web (JWK avec `d`), AsyncStorage mobile (hex) — commentaire « chiffré » faux (F-06).
- ❌ **Cluster usurpation** (F-01) : identity sans preuve, signature optionnelle, pont sans vérification, likes/follows/DM attribuables.
- ❌ **IDOR DM** : lecture + marquage lu sans authentification (F-07) ; rooms `dm:<pubkey>` rejoints sans preuve + CORS `*` (F-08).
- ❌ `/api/seed` publique et auto-appelée par tout visiteur (F-02) ; `botPriv` JWK en clair en DB (F-29).
- ❌ Aucun header de sécurité (CSP/HSTS/XFO/XCTO/Referrer-Policy) — `next.config.ts` (F-35).
- ⚠️ `/emit` :3031 sans token (mitigé par non-publication Docker) ; Caddy sandbox = proxy ouvert par query (SSRF de proximité, spécifique sandbox).

---

## 11. INTÉGRATION FRONTEND ↔ BACKEND

- **17 fonctions `api.ts` ↔ 13 routes : formats et chemins tous corrects** (croisage complet). Aucune donnée fictive présentée comme réelle dans l'UI (stats réelles, simulation explicitement annoncée).
- Endpoints ou fonctions **morts** : `/api` (Hello world), `apiSetFollow`/`apiGetFollow`/`apiBridgePost`, rooms canal du relay (jamais jointes), `stats.perf`/`gateways` non affichés.
- Frontend prêt / backend manquant : rien de bloquant détecté (le polling couvre le relay down) ; en revanche **backend prêt / frontend absent** : follows, pagination, downlink mobile.
- **Idempotence** réelle (signature `@unique`, dédup 6 h) ; **mais** posts sans signature non dédupliqués (F-30) et unité `ts` ms/s incohérente entre downlink et vérification (F-16).
- Déploiement : Docker/compose cohérents ; **CI ne transmet pas `NEXT_PUBLIC_SOCKET_URL`** → temps réel dégradé sur VPS (F-09) ; `db push --accept-data-loss` au lieu de migrations (F-36).

---

## 12. REGISTRE DES ANOMALIES (unifié, dédupliqué)

### P0 — Critique (bloque la production / faille majeure)

| ID | Description | Plateforme | Preuve | Cause | Conséquence utilisateur | Solution recommandée | Validation post-correctif |
|---|---|---|---|---|---|---|---|
| **F-01** | **Usurpation d'identité généralisée** : (a) `POST /api/identity` upsert sans preuve de possession → réécriture pseudo/bio/**ecdhPub** d'un tiers = détournement des DM futurs ; (b) `POST /api/posts` accepte les posts **sans signature** ; (c) `/api/mesh/bridge` ne vérifie jamais `verifyPostSignature` ; (d) likes/follows/DM attribuables à n'importe quelle pubkey | Web, Mobile, Backend | `identity/route.ts:24-40` ; `posts/route.ts:195-208` ; `bridge/route.ts:146-239` ; `posts/like/route.ts:18`, `follows/route.ts:27`, `dms/route.ts:49` | Modèle « clé = compte » sans challenge signé | N'importe qui peut publier/agir sous une identité existante et rediriger ses DM | Exiger une signature ECDSA sur identity (challenge) et posts (obligatoire), vérifier dans le pont, valider formats de clés | Tests : POST identity/posts/bridge avec clé d'autrui → 401/400 |
| **F-02** | **Seed cassé sur DB fraîche + seed public auto-déclenché** : 7 posts démo avec la même signature vs `Post.signature @unique` → P2002 au 2ᵉ post → 500 et seed partiel **permanent** (garde `postCount>0`) ; chaque visiteur appelle `apiSeed()` | Web, Backend | `seed/route.ts:177` vs `schema.prisma:40` ; `MboteApp.tsx:116-119` ; preuve DB : 1 seul post `demo-signature-seed` | Contrainte d'unicité non anticipée + endpoint non gardé | Tout déploiement neuf démarre corrompu/démo | Signatures uniques (ou sans signature + dédup par contenu), incréments compteurs, garde d'environnement ou secret admin | Déployer sur DB vierge → seed complet 200 |
| **F-03** | **Publication mobile impossible à 100 %** : payload post signé ≈ 465 o > `PAYLOAD_MAX_BYTES` 452, `MeshTransport.publish` n'appelle jamais `fragmentPayload` (le web, oui) | Native Android/iOS | `mobile/src/core/bitchat-protocol.ts:46-48,193-197` ; `MeshTransport.ts:230-243` (0 usage de `fragmentPayload`) | Payload non fragmenté | Tout `sendPost` échoue (Alert « Échec d'envoi ») | Fragmenter (ou compacter) avant `buildPacket` dans `publish` | Envoyer un post ≥ 100 chars → paquet(s) acceptés par le pont |

### P1 — Majeur

| ID | Description | Plateforme | Preuve | Solution |
|---|---|---|---|---|
| **F-04** | Le mobile **ne reçoit jamais le downlink** du pont (`onPacket` vide, GET jamais appelé) → ne reçoit pas les messages du réseau | Mobile | `internet-transport.ts:123-126` ; grep downlink = 0 | Polling `/api/mesh/bridge?gatewayId=` + injection dans `handleNativePacket` |
| **F-05** | URL du pont non restaurée au démarrage → `lastBridgeUrl=""` → **outbox mobile inerte après redémarrage** (tous déclencheurs P2 sans effet) | Mobile | `AppStore.tsx:130-141` ; `MeshTransport.ts:89,350` | Appliquer `storedUrl` au transport dans `start()` |
| **F-06** | Clés privées en clair : web JWK `d` dans localStorage (`crypto.ts:66-77`, `identity.ts:14-22`) ; mobile hex dans AsyncStorage (`crypto-rn.ts:78-88`, commentaire « chiffré » **inexact**) — XSS/root = vol d'identité permanent | Web, Mobile | cf. fichiers | WebCrypto non-extractible ou chiffrement passphrase ; mobile `expo-secure-store` |
| **F-07** | **IDOR DM** : `GET /api/dms?me=&peer=` et `/conversations` sans auth → lecture des enveloppes + **marquage lu** d'autrui ; sans rate limit | Backend exposé web | `dms/route.ts:13-38`, `dms/conversations/route.ts:8-18` | Challenge signé pour lire `me` ; supprimer l'effet de bord ; rate-limit |
| **F-08** | Relay CORS `*` + room `dm:<pubkey>` rejoints sans preuve → **fuite de métadonnées DM cross-origin** (timing/pairs) | Web, Relay | `relay-service/index.ts:29-32,65-73` | Restreindre CORS ; preuve signée pour join `dm:*` |
| **F-09** | `NEXT_PUBLIC_SOCKET_URL` jamais transmis (Dockerfile sans ARG, compose sans build.args, CI sans secret) → bundle embarque le mode sandbox `XTransformPort` → **temps réel HS sur VPS** (polling dégradé permanent) | Déploiement web | `deploy-vps.yml:86-91`, `Dockerfile:25-29`, `docker-compose.yml:3-14` | ARG + build.args + secret CI ; vérifier le badge socket en prod |
| **F-10** | Aucune `error.tsx` / `global-error.tsx` / `not-found.tsx` → tout crash de rendu = écran blanc Next | Web | glob `src/app/**` | Ajouter boundaries + page 404 |
| **F-11** | **Panic wipe incomplet vs promesse UI** (« Clés, file locale et état local détruits ») : n'efface ni outbox IndexedDB `mbote-outbox`, ni repli LS `mbote.outbox.packets.v1`, ni thème (web) ; ni outbox SQLite, ni nickname/bridgeUrl (mobile) | Web, Mobile | `identity.ts:26-30` ; `web-outbox-storage.ts:14-17` ; `AppStore.tsx:218-225` | Effacer toutes les clés + IndexedDB/SQLite ; aligner le texte |

### P2 — Important

| ID | Description | Preuve |
|---|---|---|
| **F-12** | Follows sans UI : `apiSetFollow`/`apiGetFollow` jamais importées ; scope `following` du feed inutilisé | `api.ts:104-115` ; `posts/route.ts:86-95` |
| **F-13** | Pagination curseur (`before`/`nextCursor`) jamais consommée — pas de scroll infini, limite 50 | `api.ts:59-76` ; `FeedView.tsx:48-60` |
| **F-14** | Raccourcis PWA `?view=feed`/`?view=network` inopérants (**confirmé dynamiquement**) — aucune lecture des query params | `manifest.webmanifest:35-46` ; test D16 |
| **F-15** | DM hors-ligne refusés (toast) alors que `flushOutbox` sait rejouer les DM — branche outbox morte | `MessagesView.tsx:130-135` vs `MboteApp.tsx:156-159` |
| **F-16** | Unité `ts` incohérente : web/mobile signent en **ms**, downlink serveur et e2e émettent en **s** → events re-signés du downlink irrecevables | `bridge/route.ts:320`, `e2e:16` vs `verify.ts:54-64` |
| **F-17** | Seed n'incrémente pas likeCount/replyCount ; `backfill-counters.ts` non branché aux scripts npm | `seed/route.ts:184-227`, `package.json:5-14` |
| **F-18** | Rate limiting absent sur `identity`, `follows`, `seed`, `dms/bot` ; in-memory (par process) ailleurs | fichiers respectifs, `state-store.ts:38-40` |
| **F-19** | `FragmentAssembler` serveur sans borne ni purge → croissance mémoire par fragments orphelins (DoS progressif) | `bitchat-protocol.ts:308-337` |
| **F-20** | `/api/dms/bot` sans rate limit ni borne de taille (contrairement à `/api/dms` 8192) | `dms/bot/route.ts:102-150` |
| **F-21** | Portes qualité neutralisées : `typescript.ignoreBuildErrors: true`, `reactStrictMode: false`, ESLint 27 règles off, `noImplicitAny: false` | `next.config.ts:6-9`, `eslint.config.mjs:10-44`, `tsconfig.json:13` |
| **F-22** | 4 fichiers protocole dupliqués web/mobile sans mécanisme de sync ni test de parité | diff §1.5 |
| **F-23** | ~24 dépendances runtime mortes (zustand, framer-motion, next-auth, zod, react-markdown…) + ~40 composants shadcn + 2 hooks + 3 exports API morts | `package.json:15-83`, grep imports |
| **F-24** | Présence trichée `Math.max(presence,1)` ; texte UI cite Nostr alors que le pont est `/api/mesh/bridge` | `MboteApp.tsx:572,725` ; `NetworkView.tsx:80-114` |
| **F-25** | Hors-ligne : données non cachées (SW n'intercepte jamais `/api`, react-query sans persistance) → feed vide offline, seul le shell tient | `sw.js:57-64`, `Providers.tsx:12-19` |
| **F-26** | SW : `skipWaiting`+`clientsClaim` immédiats, pas d'UI « nouvelle version », version hardcodée `mbote-v1` | `sw.js:13,31,46` |
| **F-27** | Mobile : `app.json` sans icône/splash/scheme/EAS ; `POST_NOTIFICATIONS` déclarée jamais demandée ; identité visuelle PWA ≠ mobile (nom, couleurs) | `app.json:1-39`, `BlePermissions.kt:15-25`, `manifest.webmanifest` |
| **F-28** | `GET /api/dms` sans rate limit (complète F-07) ; like optimiste sans rollback si 4xx | `dms/route.ts`, `PostCard.tsx:59-64` |
| **F-29** | `botPriv` JWK en clair dans la DB (démo assumée mais réelle) | `schema.prisma:19`, `seed/route.ts:126-140` |
| **F-30** | Posts sans signature non dédupliqués (spam/rejeu) ; dédup par FNV-64 non cryptographique | `bridge/route.ts:104-121`, `bitchat-protocol.ts:121-131` |
| **F-31** | Double outbox hétérogène (LS social vs IndexedDB binaire) — cohérence fragile, purges divergentes | `identity.ts:34-70` vs `outbox-core.ts` |
| **F-32** | `jsonFetch` sans timeout/AbortController ; fetch des panneaux réseau sans garde | `api.ts:11-21` |
| **F-33** | Rooms `channel:<geohash>` alimentées mais jamais jointes (`subscribe` jamais émis) → push canal mort | `relay index.ts:76-83` vs `MboteApp.tsx:223` |
| **F-34** | Zéro code-splitting (aucun `next/dynamic`) : 5 vues + MeshSimulation (1 430 l.) dans le bundle initial | grep dynamic imports = 0 |
| **F-35** | Aucun header de sécurité (CSP, HSTS, XFO, XCTO, Referrer-Policy) | `next.config.ts:3-10` |
| **F-36** | `db push --accept-data-loss` au boot au lieu de migrations Prisma | `Dockerfile:43`, `package.json:10` |

### P3 — Mineur

| ID | Description | Preuve |
|---|---|---|
| F-37 | Route `/api` « Hello world » résiduelle | `api/route.ts:3-5` |
| F-38 | Champs/constantes morts : `User.avatarSeed`, `BOT_NICKNAME`, `LS_READ_DMS`, `closeSocket()` | `schema.prisma:16`, `constants.ts:19,25`, `socket.ts:35-38` |
| F-39 | Composer : props `parentId`/`onCancel`/`placeholder` jamais exercées (double saisie de réponse) | `Composer.tsx:16,21` vs `PostCard.tsx:193-215` |
| F-40 | A11y : cartes canaux non focusables ; bouton « Ouvrir » `tabIndex={-1}` sans action | `ChannelsView.tsx:118-168` |
| F-41 | Pas de support `prefers-reduced-motion` (simulation + transitions) | grep = 0 |
| F-42 | Safe-area iOS : bas gérée, haut non (header sticky) | `MboteApp.tsx:788`, header l.511 |
| F-43 | `MAX_PEERS` divergent : 6 Kotlin vs 8 Swift | `MeshBle.kt:38` vs `PacketFramer.swift:20` |
| F-44 | Garde DM « 16 KiB » vs réel 8 192 caractères (non-octets) | `dms/route.ts:71-73` |
| F-45 | `parseInt`/`limit` non validés (NaN, négatif → 500 potentiels) ; N+1 sur `/api/channels` | `channels/route.ts:9-29`, `posts/route.ts:52` |
| F-46 | iOS `requestPermissions` : `.notDetermined` renvoyé sans re-sondage ; `isSupported` hardcodé true | `MboteBleModule.swift:44-47,80-82` |
| F-47 | Messages mobile non persistés (RAM 200) ; PKT_GOSSIP défini jamais implémenté | `AppStore.tsx:40,93-95` |
| F-48 | Recalcul `describePacket` ×3 par render dans BitChatBridge | `BitChatBridge.tsx:544` |
| F-49 | Fallback offline SW minimal (503 texte) ; pas de share_target ; PNG maskable sans padding dédié (sans alpha) | `sw.js:76`, `manifest.webmanifest:29-33` |
| F-50 | CI : `permissions: contents: write` trop large sur PR ; keychain pwd en dur (jetable) ; `ssh-keyscan` TOFU ; deploy-vps sans bloc `permissions:` | `build-android.yml:18-19`, `build-ios.yml:107-112`, `deploy-vps.yml:65` |
| F-51 | Caddy sandbox = proxy ouvert par query (SSRF de proximité, spécifique sandbox) ; `/emit` :3031 sans token (mitigé) | `Caddyfile:2-13`, `relay index.ts:112-138` |
| F-52 | `AsyncFallbackOutboxStorage.kind` figé au constructeur (affichage mensongère après bascule) | `outbox-core.ts:77` |
| F-53 | Zod déclaré, jamais utilisé — validation 100 % manuelle inégale (formats de clés non vérifiés) | `package.json:81`, `identity/route.ts:13` |
| F-54 | Hero en background-image CSS non priorisé/non optimisé | `FeedView.tsx:73` |

---

## 13. PLAN DE CORRECTION PRIORISÉ

**Vague 1 — Bloquants production (P0) : F-01, F-02, F-03**
1. F-01 : signature obligatoire + challenge d'identité + vérification dans le pont (impact : tout le modèle de confiance).
2. F-02 : seed réparé + gardé (endpoint admin/dev uniquement) ; retirer l'auto-seed client.
3. F-03 : fragmentation dans `MeshTransport.publish` (réutiliser `fragmentPayload` déjà présent).
→ Validation : tests HTTP hostiles + post mobile E2E réel.

**Vague 2 — Fiabilité produit (P1) : F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11** ✅ exécutée et validée (§17)
4. Mobile : downlink polling + restauration URL pont (fait re-vivre l'outbox P2).
5. Stockage clés chiffré (web passphrase/non-extractible, mobile SecureStore).
6. Auth lecture DM (challenge) + CORS relay restreint.
7. Chaîne de build : `NEXT_PUBLIC_SOCKET_URL` (ARG/args/secret) + error boundaries.

**Vague 3 — Complétion fonctionnelle (P2 ciblé) : F-12, F-13, F-14, F-15, F-25, F-27**
8. UI follows + scroll infini (backend déjà prêt) + lecture `?view=` + DM hors-ligne via outbox.
9. Cache de données offline (persistance react-query ou stale-if-error SW) ; icônes/splash/scheme mobile ; harmonisation de marque.

**Vague 4 — Hygiène (P2/P3 groupés) : F-21, F-23, F-32, F-35, F-36, puis P3**
10. Réactiver strict TS/ESLint/React strict mode (avec correction des erreurs), purger les deps/composants morts, headers de sécurité, migrations Prisma, timeouts fetch, puis nettoyage P3 en lot.

---

## 14. ÉVALUATION GLOBALE DE MATURITÉ

| Domaine | Note /10 | Justification |
|---|---|---|
| Web (UI/UX) | **7,5** | Golden path complet vérifié, design system cohérent, états soignés ; lacunes : follows, recherche, pagination, media |
| Web (sécurité) | **3** | Cluster d'usurpation confirmé, IDOR DM, seed public, zéro header |
| PWA | **6** | Installable, shell offline ; données offline absentes, shortcuts morts, update sans annonce |
| Mobile Android | **4** | BLE complet non-stub, outbox SQLite solide ; publication cœur FAIL, downlink absent, URL pont perdue |
| Mobile iOS | **3,5** | Code symétrique au Kotlin (bon), mais NOT VERIFIED sur appareil, permissions UX confuse, mêmes FAIL |
| Backend | **6** | Routes cohérentes, idempotence, rate-limit partiel ; seed cassé, auth par preuve absente, temps réel non déployable |
| Architecture | **7** | DORS propre, protocole bit-identique web/mobile, outbox robuste ; duplication manuelle, double outbox |
| **Global** | **5,5/10 — POC avancée** | Non prête pour la production avant Vague 1 + 2 ; produit de démonstration de très bonne facture |

---

## 15. TESTS RESTANT À EFFECTUER (appareils réels)

1. **Android physique** : scan/advertise BLE réel entre 2 téléphones, délivrance mesh multi-sauts, foreground service après swipe-away, permission POST_NOTIFICATIONS (Android 13+), installation PWA (badge installable) + lancement standalone + shortcuts.
2. **iPhone physique** : comportement background BLE (restauration d'état), installation PWA iOS (ajout écran d'accueil, safe-area header), NOT VERIFIED faute d'appareil.
3. **Réseaux dégradés** : coupure/retour (throttle offline DevTools) sur VPS réel avec `NEXT_PUBLIC_SOCKET_URL` corrigé ; validation flush outbox web + mobile.
4. **Charge** : montée à ~100 posts/min via pont (rate limits + N+1 channels), FragmentAssembler sous flood de fragments orphelins.
5. **Accessibilité** : audit axe/Lighthouse + lecteur d'écran (VoiceOver/TalkBack) — NON EXÉCUTÉ dans cet audit.
6. **Compatibilité** : Safari iOS WebView, Firefox, Chrome Android — matrice non testée.

---

## 16. JOURNAL D'EXÉCUTION — VAGUE 1 (P0) ✅ EXÉCUTÉE ET VALIDÉE

**Statut au moment de l'audit** : les 3 P0 étaient confirmés (preuves §12). **Correctifs appliqués puis validés** :

### F-01 — Usurpation d'identité (cluster) — CORRIGÉ
- **Nouveau module isomorphe `src/lib/mbote/proof.ts`** : chaînes canoniques signées (identity / like / follow / dm), vérification ECDSA P-256 + fraîcheur (7 j offline-first, alignée posts), validation de format de clé (65 octets bruts, préfixe 0x04).
- `POST /api/identity` : preuve de possession OBLIGATOIRE (`${pubkey}|identity|…|${ts}`) → 401 sans/mauvaise preuve, 400 si format de clé invalide.
- `POST /api/posts` : signature ECDSA OBLIGATOIRE (400 si absente, 401 si invalide) — plus aucun post anonyme.
- `POST /api/mesh/bridge` : posts mesh rejetés sans signature valide (« publication non signée (rejetée) » / « signature refusée ») ; **announce non signé = création seule, jamais d'écrasement** d'une identité existante (pseudo/ecdhPub protégés).
- `POST /api/posts/like`, `/api/follows`, `/api/dms` : preuve de possession obligatoire (401).
- **Client web adapté** : identité (création + édition profil), likes, follows, DM — tous signés localement avant envoi **et** avant mise en file hors-ligne (la preuve part dans l'outbox, tolérance 7 j).
- **Tunnel BitChat web aligné** : signature en millisecondes (une seule valeur ts partagée signature/événement) et pair éphémère muni d'une vraie paire P-256 jetable (fini l'anonymat non signé) — compatible pont durci.

**Validation hostile (23 tests HTTP, script WebCrypto réel)** : identity sans preuve → 401 · signature d'autrui → 401 · format clé invalide → 400 · preuve valide → 200 ; posts sans signature → 400, forgé → 401, rejeu → idempotent ; like/follow/dm idem ; pont : paquet signé → accepted (+ réassembly fragmenté), même paquet → duplicate, non signé → invalid, forgé → invalid, announce non signé n'écrase PAS l'identité (nickname/ecdhPub intacts). **22 PASS + 1 faux négatif d'assertion (paquet forgé fragmenté : 1 frag en attente + 1 invalid = post bien rejeté)**.

### F-02 — Seed cassé + auto-seed public — CORRIGÉ
- Signatures démo **uniques** (`demo-signature-seed-<n>`) → plus de P2002 ; compteurs `replyCount`/`likeCount` incrémentés à la création ; **garde** : dev uniquement, ou `x-seed-secret: $SEED_SECRET` en production (403 sinon) ; auto-seed client retiré (`apiSeed` supprimée de l'UI et de `api.ts`).
- **Validation DB vierge** : `{"seeded":true,"users":6,"posts":9}` ; cohérence compteurs ΣreplyCount=2=réponses, ΣlikeCount=7=likes ; signatures uniques.

### F-03 — Publication mobile impossible — CORRIGÉ (code ; E2E appareil restant)
- `mobile/src/transport/MeshTransport.publish` **fragmente désormais** le payload signé via `fragmentPayload` (§2 whitepaper, format identique web/pont) avant `encodePacket` ; chaque fragment suit routeur/outbox. Typecheck mobile ✅. **Reste NOT VERIFIED sur appareil physique** (§15.1) — la chaîne de fragmentation/réassembly est elle validée côté pont (test paquet fragmenté → accepted).

### Golden path navigateur (re-vérifié après correctifs)
Identité signée créée (preuve acceptée, ecdhPub enregistré) → post signé publié et visible → like signé persisté (likeCount=1) → DM E2E bot (enveloppe signée acceptée, réponse du bot **déchiffrée** dans l'UI) → **tunnel mesh : paquet signé → pont → signature vérifiée → post ingéré (origine mesh)**. Zéro erreur console/page. Lint ✅ · tsc web ✅ · tsc mobile ✅.


---

## 17. JOURNAL D'EXÉCUTION — VAGUE 2 (P1) ✅ EXÉCUTÉE ET VALIDÉE

**Périmètre** : F-04 → F-11 (8 anomalies majeures). **Statut : 8/8 corrigées**, validations détaillées ci-dessous.

### F-04 — Downlink mobile inexistant — CORRIGÉ
- `MeshTransport.pollDownlink()` : GET `/api/mesh/bridge?gatewayId=&since=` (curseur ISO persisté en mémoire, AbortController 8 s, anti-réentrance) — premier tir au démarrage, puis polling 60 s, plus tir immédiat après chaque flush accepté.
- Nouveau `handleDownlinkPacket()` : dédup → affichage (`peerId: "pont-vps"`) → **redistribution BLE** (TTL−1 après gigue) aux voisins hors-ligne. Les paquets venus du pont ne sont **jamais re-montés** (pas de boucle, pas de pollution des stats).
- Validation : route downlink interrogée (réponse `packets[]` nominale) ; le chemin complet BLE→UI reste NOT VERIFIED sur appareil (§15.1).

### F-05 — URL du pont perdue au redémarrage — CORRIGÉ
- Nouveau `MeshTransport.setBridgeUrl()` (URL + sonde + reset curseur downlink) ; `AppStore` l'appelle **avant** `transport.start()` avec l'URL persistée AsyncStorage → l'outbox durable et le downlink repartent vivants après un kill de l'app.
- `setBridgeUrl` (UI) configure désormais le transport immédiatement (fini l'outbox inerte en attendant une sync manuelle) ; `syncBridge` passe par le même chemin.

### F-06 — Clés privées en clair — CORRIGÉ (web + mobile)
- **Web** : clés générées `extractable: false` ; privées persistées comme objets CryptoKey (structured-clone) dans IndexedDB `mbote-secure` (nouveau module `secure-keys.ts`) ; localStorage ne contient plus que les métadonnées publiques (pubkey/ecdhPub/nickname/bio). `signPayload`/`sealMessage`/`openMessage` signent/dérivent directement sur les CryptoKey — plus aucune importation JWK à chaque usage.
- **Migration automatique** : une identité legacy (JWK `d` en clair) est réimportée NON-extractible via `importLegacyKeyBundle()`, réécrite en LS sans matériel privé. Validée en navigateur : identité legacy écrite à la main → rechargement → identité conservée, LS sans JWK, signature hello relay **acceptée** (la clé migrée signe correctement).
- **Mobile** : `expo-secure-store@~14.0.1` (Keychain/Keystore) — identité stockée en SecureStore, ancien AsyncStorage migré puis EFFACÉ ; repli session-only si SecureStore indisponible (jamais de re-persistance insécurisée).
- Vérifié navigateur : `localStorage` sans `signPrivJwk` ; `indexedDB.databases() == ["mbote-secure"]`.

### F-07 — IDOR DM — CORRIGÉ
- `proof.ts` : nouvelle chaîne `${me}|dm-read|${peer ou *}|${ts}` + fenêtre courte dédiée (`READ_MAX_AGE_MS` 15 min, tolérance futur 2 min) ; `verifySignedMessage` accepte une fraîcheur paramétrable.
- `GET /api/dms` et `GET /api/dms/conversations` exigent la preuve (401 sinon, **avant** tout effet de bord : le marquage « lu » ne se produit que pour un lecteur authentifié) + rate limit dédié (60/min/clé, 180/min/IP).
- Client : `apiGetConversation`/`apiGetConversations` signent à chaque poll/refetch (react-query).
- **Validation hostile (9/9 PASS, script WebCrypto)** : sans preuve → 401 · signature d'autrui → 401 · preuve expirée → 401 · preuve valide → 200 + `messages[]`/`conversations[]`.

### F-08 — Relay CORS `*` + join dm:* anonyme — CORRIGÉ
- CORS : `origin: false` par défaut (même origine via Caddy n'a pas besoin de CORS) ; `RELAY_ALLOWED_ORIGIN` (liste) pour ouvrir explicitement — passée au conteneur via docker-compose (F-09). Vérifié : requête avec `Origin: https://evil.example` → **aucun** header `Access-Control-Allow-Origin`.
- `dm:<pubkey>` exigée désormais une preuve ECDSA courte durée (`${pubkey}|relay-hello|${ts}`) — vérificateur autonome dans le relay (contexte Docker isolé, miroir de proof.ts). Sans preuve valide : feed seul + **pas de présence revendiquée**. `subscribe` refuse tout `dm:*`.
- **Validation** : hello signé via navigateur → `identitiesOnline: 1`, badge « 1 en direct » ; hello usurpateur sans preuve → `identitiesOnline` inchangé ; `subscribe dm:*` filtré.

### F-09 — NEXT_PUBLIC_SOCKET_URL jamais transmis — CORRIGÉ
- Chaîne complète : `ARG/ENV` dans le Dockerfile (avant `next build`) → `build.args` docker-compose (`${NEXT_PUBLIC_SOCKET_URL:-}`) → étape CI « Environnement de build » qui écrit `.env` sur le VPS via ssh+stdin (secrets jamais en ligne de commande) depuis les secrets GitHub `NEXT_PUBLIC_SOCKET_URL`, `RELAY_ALLOWED_ORIGIN`, `SEED_SECRET` (documenté dans docs/CI-CD.md). Le bundle embarquera l'URL publique du hub au lieu du mode sandbox `XTransformPort`.
- NOT VERIFIED sur VPS réel (déploiement à la prochaine release) — les secrets GitHub restent à créer par l'opérateur.

### F-10 — Aucune error boundary — CORRIGÉ
- `src/app/error.tsx` (carte de panne, « Réessayer »/« Recharger la page », digest loggé), `src/app/global-error.tsx` (minimaliste, autonome, `<html>` inclus), `src/app/not-found.tsx` (404 française « Ce fil n'existe pas ou a été emporté par le mesh »). Validé navigateur : `/page-inexistante` → 404 rendue.

### F-11 — Panic wipe incomplet — CORRIGÉ (web + mobile)
- **Web** `panicWipe()` (async) : LS identité + outbox sociale + mode mesh + **thème** + repli LS `mbote.outbox.packets.v1` ; suppression des bases IndexedDB `mbote-secure` (coffre) **et** `mbote-outbox` (outbox binaire) — ordre corrigé (purge du record avant `deleteDatabase`) et nouveau `closeWebOutbox()` qui libère la connexion du singleton pour ne pas bloquer la suppression.
- **Mobile** `resetIdentity` : coffre SecureStore + vestiges AsyncStorage, outbox SQLite (`outbox.clear()`), repli AsyncStorage, nickname, URL du pont, messages, décisions de routage.
- Validé navigateur (thème volontairement modifié avant test) : après wipe → `localStorage` intégralement vide, `indexedDB.databases() == []`, onboarding relancé.

### Golden path navigateur (re-vérifié après Vague 2, via gateway :81)
Identité créée (clés non-extractibles) → post signé publié → DM bot : envoi chiffré (ECDH CryptoKey) → lecture conversation **authentifiée** (preuve signée, HTTP 200) → réponse du bot déchiffrée dans l'UI → hello relay signé → présence comptée (« 1 en direct ») → panic wipe → état local intégralement détruit. Zéro erreur console/page. Lint ✅ · tsc web ✅ · tsc mobile ✅.

### Restant NOT VERIFIED (appareils/infra réels, §15)
1. F-03 + F-04/F-05 : publication et downlink sur Android/iOS physiques (BLE réel).
2. F-06 mobile : persistance SecureStore après kill/relance de l'app (rebuild dev-client requis — nouveau module natif).
3. F-09 : déploiement VPS avec secrets GitHub configurés (badge socket en prod).
