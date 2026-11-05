# Spécification cryptographique Mbote BitChat — v1 (brouillon)

> **STATUT : BROUILLON DE SPÉCIFICATION — NON VALIDÉ ADVERSARIALEMENT.**
> **Aucune garantie E2EE ne doit être déclarée publiquement avant l'achèvement du plan de validation (§8).**

Cadre décisionnel : le comité de validation a retenu (i) « E2EE : principe accepté pour les
communications privées, **sous réserve** d'une spécification cryptographique complète, d'une
authentification des clés et de tests adversariaux. Aucun mécanisme cryptographique artisanal ne
sera considéré comme validé. » et (ii) « Groupes : chiffrement pairwise accepté **temporairement**
en V1, avec une **trajectoire documentée vers MLS** ». Ce document est la réponse contractuelle à
ces deux réserves. Chaque affirmation sur le code existant est référencée `fichier:ligne` (état du
dépôt au moment de la rédaction) ; chaque chiffre porte son hypothèse explicitée.

---

## §1 — Périmètre et modèle de menace

### 1.1 Actifs protégés

| Actif | État v1.x | Localisation code |
|---|---|---|
| **Messages privés (DM)** — confidentialité + intégrité + authenticité de l'expéditeur | Chiffré E2EE (ECDH statique-statique + AES-GCM), signé | `src/lib/mbote/crypto.ts:149-198`, `src/app/api/dms/route.ts:131-143` |
| **Publications du fil public** — authenticité (attribution non répudiable), intégrité | Clair + signature ECDSA vérifiée serveur (décision produit assumée, §7) | `src/app/api/posts/route.ts:212-230`, `prisma/schema.prisma:39` |
| **Identités** — la clé publique ECDSA P-256 EST le compte ; preuve de possession exigée pour toute écriture | Signé + vérifié serveur | `src/lib/mbote/proof.ts:187-233`, `src/app/api/identity/route.ts:61-72` |
| **Clés privées locales** — non-extractibles (web), Keychain/Keystore (mobile) | Stockées hors localStorage/AsyncStorage | `src/lib/mbote/secure-keys.ts:24-27`, `mobile/src/core/crypto-rn.ts:63-65` |
| **Clé privée du bot de démo** — identité portée par le serveur (exception documentée, §7) | Chiffrée au repos AES-GCM | `src/lib/mbote/bot-key.ts:62-72`, `prisma/schema.prisma:18` |

### 1.2 Adversaires considérés

1. **Serveur malveillant ou compromis** (VPS, opérateur infra, seizure) : peut lire tout ce qui
   n'est pas chiffré E2EE, réordonner/rejouer/cacher des messages, servir des clés publiques
   falsifiées (`ecdhPub` de substitution) à un client. Constat v1 : le serveur ne stocke que
   `iv`+`ciphertext` pour les DM (`prisma/schema.prisma:101-113`), mais **il contrôle l'annuaire
   des clés** (`User.ecdhPub`, `schema.prisma:16`) sans mécanisme de vérification côté client →
   attaque de substitution de clé réaliste aujourd'hui (lacune L-3, §2).
2. **MITM réseau** (acteur sur le chemin client↔serveur ou sur le lien radio BLE) : transport
   HTTPS (Caddy/TLS) côté internet ; côté BLE, les paquets circulent en clair à l'exception des
   payloads DM scellés — un observateur radio voit toutes les métadonnées (annonces, clés
   publiques, horodatages), comme le reconnaît l'UI (`src/components/mbote/NetworkView.tsx:411-415`).
3. **Usurpation d'identité** : requiert la clé privée de signature. Toute écriture (post, identité,
   DM, like, follow, lecture DM, join relay) exige une preuve de possession ECDSA vérifiée serveur
   (`src/lib/mbote/proof.ts:61-110` pour les chaînes canoniques, application dans
   `posts/route.ts:212-230`, `identity/route.ts:61-72`, `dms/route.ts:131-143`,
   `dms/route.ts:27-48`, `mini-services/relay-service/hub.ts:59-90`).
4. **Rejeu** : couvert partiellement seulement (fenêtres de fraîcheur 7 j / 15 min + dédup SHA-256
   du pont mesh + idempotence `Post.signature @unique`) — lacunes L-4/L-5, §2.
5. **Sybil** (ferme d'identités jetables) : aujourd'hui seulement ralentie par rate limits par clé
   et par IP (`identity/route.ts:12-14`, `dms/route.ts:15-19`, `posts/route.ts:19-21`,
   `bridge/route.ts:35-39`). Aucune vérification d'unicité humaine. Traité en §6.

### 1.3 Hors périmètre explicite (v1 ET v2 — à ne pas promettre)

- **Métadonnées de transport** : qui parle à qui, quand, fréquence, taille des enveloppes,
  adresses IP, positions géohash des posts. Visibles du serveur et des relais mesh.
- **Traffic analysis** côté radio BLE : l'ID pair est stable et les annonces publient les clés en
  clair (whitepaper BitChat ; reconnu dans `NetworkView.tsx:411-413`). Pas d'identités rotatives.
- **Dispositif compromis** (malware, XSS avec accès session) : un XSS peut signer et déchiffrer
  en session mais ne peut plus exfiltrer les clés privées web (`crypto.ts:8-15` — clés
  `extractable: false` depuis l'audit F-06). Un compromis complet de l'appareil vainc tout.
- **Confidentialité du fil public** : le fil est clair-signé et modéré ; c'est une décision
  produit retenue, pas une lacune (§7).

---

## §2 — Inventaire cryptographique ACTUEL (état des lieux vérifié dans le code)

**Méthode** : lecture directe des sources (`rg` + lecture intégrale des modules cités). Aucun
mécanisme n'est décrit ici sans référence. Ce qui n'existe pas est marqué **ABSENT DU CODE (v1.x)**.

| # | Mécanisme | Référence code | Primitives | Statut |
|---|---|---|---|---|
| A | Génération d'identité web : paire ECDSA P-256 + paire ECDH P-256, clés privées **non-extractibles** (`extractable:false`) | `src/lib/mbote/crypto.ts:68-88` (l.71, l.75) | WebCrypto `generateKey` P-256 | **OK** |
| B | Signature client web : ECDSA P-256 / SHA-256 sur chaîne canonique | `src/lib/mbote/crypto.ts:139-147` ; usages : `MessagesView.tsx:200-203,231-234`, `MboteApp.tsx:291,323,444,486,531`, `BitChatBridge.tsx:171,175`, `ProfileView.tsx:97`, `NetworkView.tsx:123` | ECDSA P-256, SHA-256 | **OK** |
| C | Signature client mobile : @noble/curves p256, signature brute r‖s (64 o) interop WebCrypto | `mobile/src/core/crypto-rn.ts:144-150` (imports :23-27) | @noble p256 + @noble/sha256 | **OK** |
| D | Vérification serveur des posts (rejet 400/401 si absente/invalide ; fraîcheur 7 j ; ts futur −60 s ; normalisation s↔ms F-16) | `src/lib/mbote/verify.ts:17,32-34,56-103` ; appliqué dans `src/app/api/posts/route.ts:212-230` et `src/app/api/mesh/bridge/route.ts` (import :30) | ECDSA P-256/SHA-256 | **OK** |
| E | Vérification serveur générique (identity/like/follow/dm/dm-read/relay-hello) + format de clé (65 o, préfixe 0x04) | `src/lib/mbote/proof.ts:144-147,187-233` ; appliqué : `identity/route.ts:61-72`, `dms/route.ts:131-143,27-48`, `mini-services/relay-service/hub.ts:59-90` | ECDSA P-256/SHA-256 | **OK** |
| F | Chiffrement DM web : ECDH P-256 **statique-statique** (`deriveBits` 256 → clé AES-GCM), AES-GCM IV 12 o aléatoire | `src/lib/mbote/crypto.ts:149,156-167,169-183` (IV aléatoire l.176) ; déchiffrement : `MessagesView.tsx:153-156` | ECDH P-256 + AES-256-GCM | **OK chiffrement / LACUNE L-1 (pas de FS)** |
| G | Chiffrement DM mobile : `p256.getSharedSecret` (coordonnée X 32 o) + AES-256-GCM, IV 12 o aléatoire | `mobile/src/core/crypto-rn.ts:162,173-187` | @noble p256 + @noble gcm | **OK chiffrement / LACUNE L-1** |
| H | Schéma serveur DM : le serveur ne stocke que `iv` + `ciphertext` (base64), aucun contenu clair | `prisma/schema.prisma:101-113` (iv l.106, ciphertext l.107) ; taille plafonnée 8 KiB en octets réels (`dms/route.ts:159-163`, F-44) | — | **OK** / LACUNE L-4 |
| I | Anti-rejeu par fraîcheur : actions 7 j (`ACTION_MAX_AGE_MS`), lectures DM 15 min (`READ_MAX_AGE_MS`), tolérance future 60 s/2 min | `src/lib/mbote/proof.ts:26,29,36,39,156-180` | fenêtre temporelle | **OK partiel** |
| J | Dédup SHA-256 persistante du pont mesh (F-30, remplace FNV-64 forgable) + table `MeshIngest` | `src/app/api/mesh/bridge/route.ts:45-51,116,119-132` ; `prisma/schema.prisma:69-77` ; test e2e `tests/mesh-bridge-e2e.ts:8,115` | SHA-256 (Node `createHash`) | **OK** — **portée limitée au pont mesh** |
| K | Dédup LRU 1000 en mémoire du mesh (web + mobile) — empreinte **FNV-1a 64 non cryptographique** | `src/lib/mbote/bitchat-protocol.ts:122-131,242-266` ; `mobile/src/core/bitchat-protocol.ts:242-266` ; `mobile/src/transport/MeshTransport.ts:93` | FNV-1a 64 | **LACUNE L-5** |
| L | Idempotence des posts par signature unique (rejeu d'ingestion web OU mesh → `duplicate`) | `prisma/schema.prisma:39` (`signature @unique`) ; `src/app/api/posts/route.ts:292-311` (code P2002) | contrainte DB | **OK** (posts uniquement) |
| M | Stockage web : clés privées = objets CryptoKey clonés dans IndexedDB `mbote-secure` ; localStorage = métadonnées publiques seulement ; migration legacy JWK en clair (F-06) | `src/lib/mbote/secure-keys.ts:24-27,82-98` ; `src/lib/mbote/identity.ts:82-134,137-146` | IndexedDB | **OK** / §5 |
| N | Stockage mobile : bundle hex dans expo-secure-store (Keychain iOS / Keystore Android), migration AsyncStorage (F-06) | `mobile/src/core/crypto-rn.ts:63-65,86-127` | SecureStore | **OK** / §5 |
| O | Panic wipe : destruction identité + outboxes + Bases IndexedDB (F-11, web) / SecureStore+AsyncStorage (mobile) | `src/lib/mbote/identity.ts:172-183` ; `mobile/src/core/crypto-rn.ts:130-141` | — | **OK** |
| P | Bot de démo : `User.botPriv` chiffré au repos (`enc:v1:iv:ct`, AES-GCM 256, dérivation SHA-256 de `MBOTE_BOT_KEY`) | `src/lib/mbote/bot-key.ts:22,36-54,62-72` ; note honnête l.15-18 (secret de repli dev dérivable) | AES-256-GCM + SHA-256 | **OK (exception §7)** |
| Q | En-tête de paquet mesh versionné (version 1 octet, rejet de version inconnue) | `src/lib/mbote/bitchat-protocol.ts:31,210-232` | — | **OK** / payload non versionné (L-6) |

### 2.1 Lacunes réelles constatées (chacune vérifiée dans le code)

- **L-1 — Pas de forward secrecy.** Le chiffrement DM dérive la clé d'un ECDH **statique-statique**
  (`crypto.ts:149,156-167` ; `crypto-rn.ts:162,173-176`) : la compromission d'une clé privée
  ECDH révèle l'intégralité de l'historique des DM. L'UI le reconnaît honnêtement :
  « l'ECDH statique-statique des DM n'offre pas de confidentialité persistante (pas de prekeys) »
  (`src/components/mbote/NetworkView.tsx:413-415`). Aucun prekey, aucun ratchet :
  **ABSENT DU CODE (v1.x)** (grep `prekey|ratchet|libsignal|MLS` : 0 occurrence dans `src/` et `mobile/src/`).
- **L-2 — Pas d'authentification des clés.** Aucun safety number, aucune empreinte vérifiable,
  aucun QR, aucun indicateur d'état de vérification dans l'UI : **ABSENT DU CODE (v1.x)**. Les
  « empreintes » existantes (`shortKey`, `crypto.ts:202-204`) ne sont que des troncatures d'affichage.
  **→ CORRIGÉ PAR A2 (feat/a2-key-auth, en validation)** : numéro de sécurité documenté
  (`docs/SAFETY-NUMBER-SPEC.md`, référence Signal) + indicateur d'état dans l'UI DM
  (jaune non vérifié / vert scellé / rouge bloquant) + dialogue de comparaison hors-bande.
  Le QR scan en présentiel (caméra) reste au Bloc 2 phase F — le canal numérique hors-bande
  (60 chiffres comparables de vive voix) est livré.
- **L-3 — Substitution de clé par le serveur.** `ecdhPub` est enregistré via une preuve signée
  (`identity/route.ts:61-72`), mais un serveur malveillant peut ensuite servir n'importe quelle
  `ecdhPub` au client (`api.ts` / `/api/identity?pubkey=`) : l'attaquant devient MITM des DM
  **sans détectabilité**. La signature de l'enveloppe (`proof.ts:78-86`) lie l'expéditeur au
  ciphertext, pas le destinataire à la clé de chiffrement.
  **→ CORRIGÉ PAR A2 (feat/a2-key-auth, en validation)** : numéro de sécurité 60 chiffres
  (SHA-512 itéré 5200× sur les QUATRE clés, spec Signal — `docs/SAFETY-NUMBER-SPEC.md`,
  `safety-number.ts` isomorphe) + épinglage LOCAL par appareil (`trust-client.ts` — indépendant
  du serveur) + registre serveur `TrustedKey` (audit + détection inter-appareils,
  `GET /api/trust` + `POST /api/trust/verify`) + alerte rouge BLOQUANTE dans l'UI DM
  (envoi suspendu jusqu'à re-vérification hors-bande). Tests : propriétés du fingerprint
  (6), flux premier contact/substitution/re-vérification (4), E2E API réel (7 scénarios).
- **L-4 — Pas d'anti-rejeu DM structuré.** Aucune contrainte d'unicité sur `DirectMessage`
  (`schema.prisma:101-113` : pas de `@unique` sur `iv`/`ciphertext`) : réinjecter une enveloppe
  interceptée dans la fenêtre de fraîcheur de 7 j (`proof.ts:26`) crée un doublon légitime. Pas de
  compteur d'époque par pair : **ABSENT DU CODE (v1.x)**.
  **→ CORRIGÉ PAR A1 (feat/a1-anti-replay, en validation)** : garde persistante SHA-256 liée au
  payload (`ReplayGuard`, TTL 7 j) + compteurs monotones par (conversation, époque de 6 h)
  (`ReplayCounter`) + chaîne signée `dm2` liant msgId+seq ; transaction garde+message ; harness
  adversarial 13 tests + E2E 10 scénarios (`tests/anti-replay*`).
- **L-5 — Dédup mesh en mémoire non cryptographique.** FNV-1a 64 (`bitchat-protocol.ts:122-131`)
  permet des collisions forgées ; seul le pont serveur est passé à SHA-256 (J). La parité
  web/mobile du FNV est même testée (`scripts/check-protocol-parity.ts:111`) — le test verrouille
  l'empreinte faible, pas son remplacement.
  **→ PARTIELLEMENT CORRIGÉ PAR A1 (feat/a1-anti-replay, en validation)** : `dedupFingerprint()`
  (SHA-256 tronquée 128 bits, WebCrypto) livrée dans les DEUX miroirs + parité étendue
  (`check-protocol-parity.ts` : égalité + avalanche). Le FNV-64 subsiste uniquement pour les
  usages NON-sécurité (fragId de fragmentation, affichage) et le repli documenté hôtes sans
  WebCrypto ; la migration des appelants mobiles synchrones (MeshTransport, contrainte Hermes)
  reste à la vague mobile (OD-6 inchangé pour eux).
- **L-6 — Payload non versionné, pas d'agilité algorithmique.** `MeshEvent` est un JSON brut sans
  champ version ni identifiant d'algorithme (`bitchat-protocol.ts:403-431`) ; seule la couche
  paquet est versionnée (Q). L'enveloppe DM n'a pas non plus de version.
- **L-7 — AES-GCM sans AAD.** `sealMessage`/`openMessage` ne lient aucun contexte au ciphertext
  (`crypto.ts:177-181`, `crypto-rn.ts:185`) : le lien avec expéditeur/destinataire/horodatage
  repose uniquement sur la signature externe et l'annuaire serveur.
- **L-8 — Commentaire trompeur.** `bitchat-protocol.ts:21` annonce « DM scellé Noise-X » alors
  qu'aucune implémentation Noise n'existe dans le dépôt (grep `noise` : commentaires seulement).
  À corriger : le risque est la confusion pendant un audit.
- **L-9 — Zéro test adversarial.** `tests/` contient des e2e fonctionnels (bridge, push, load) ;
  aucun vecteur Wycheproof, aucun test de nonce, aucun fuzzing : **ABSENT DU CODE (v1.x)** (§8).
- **L-10 — Mobile : clés privées en hex dans le bundle JS sécurisé.** `crypto-rn.ts:67-79` tient
  les privées en `signPrivHex`/`ecdhPrivHex` (chaînes JS) ; SecureStore protège au repos
  (`crypto-rn.ts:63-65`) mais le matériel transite en mémoire JS — pas d'équivalent
  non-extractible web sans module natif. Risque résiduel documenté, non bloquant V1.

---

## §3 — Spécification normative cible v2 (DM privés)

> Les normes « DOIT / NE DOIT PAS » ci-dessous définissent la cible v2 du canal privé. Le canal v1
> reste en production mais est déclaré **non conforme** aux exigences de forward secrecy et
> d'authentification des clés jusqu'à J-M1 (§3.3).

### 3.1 Primitives imposées

| Usage | Primitive IMPOSÉE | Interdits explicites |
|---|---|---|
| Échange de clé | ECDH P-256 (puis X25519 via la lib adoptée en §3.3) | ECDH sur courbes non standard, RSA échange |
| Dérivation de clé | HKDF-SHA-256 (salt par session, info étiqueté `"mbote-dm-v2"`) | Utiliser le secret ECDH brut comme clé AES (**faute v1 corrigée**) |
| Chiffrement symétrique | AES-256-GCM, **nonce 96 bits aléatoire par message** (`crypto.getRandomValues`/CSPRNG), AAD = en-tête canonique | AES-CBC, AES-ECB, AES-GCM sans AAD, nonce de compteur réutilisé entre clés, réutilisation (nonce,clé) |
| Signature | ECDSA P-256 / SHA-256 (inchangé v1, interop web/mobile) | MD5, SHA-1, RSA-PKCS1v1.5, « EdDSA maison » |
| Empreinte de clé | SHA-256 sur la clé publique brute 65 o | FNV / troncatures ad hoc pour tout usage de sécurité |
| Aléa | CSPRNG plateforme uniquement (`getRandomValues`, `java.security.SecureRandom` via libs) | `Math.random()` pour tout rôle cryptographique |
| Général | Bibliothèques auditées (@noble, WebCrypto, lib signal/MLS §3.3) | **Toute crypto « maison »** : ratchet artisanal, KDF maison, sérialisation binaire non spécifiée |

Contrainte de non-réutilisation : la paire (clé AES, nonce) DOIT être unique par message. La v2
l'obtient trivialement (nouvelle clé de chaîne à chaque message via ratchet §3.3) ; la v1 l'obtient
par nonce aléatoire uniquement (`crypto.ts:176`) — acceptable statistiquement (96 bits) mais
sans garantie formelle, d'où le test de nonces §8-T2.

### 3.2 Cycle de vie des clés d'identité

1. **Génération locale** : sur l'appareil, jamais côté serveur. Constat v1 conforme :
   `crypto.ts:68-88` (web, non-extractible), `crypto-rn.ts:67-79` (mobile @noble). Le serveur
   n'accepte que des clés publiques brutes 65 o préfixe 0x04 (`proof.ts:144-147`).
2. **Export en clair : interdit.** Aucune fonctionnalité « sauvegarder/exporter ma clé privée » ne
   sera ajoutée en clair. Toute sauvegarde future passe par un chiffrement à phrase de récupération
   (décision ouverte OD-4, §9). Constat v1 : web `extractable:false` (`crypto.ts:71,75`), mobile
   SecureStore (`crypto-rn.ts:63-65`) — la v2 conserve ces propriétés.
3. **Empreinte publique** : la v2 DOIT afficher une empreinte SHA-256 (§3.4) et non plus la
   troncature base64 (`crypto.ts:202-204`).
4. **Rotation** : la v2 DOIT prévoir la rotation de la clé ECDH (prekeys) ; la clé de signature
   ECDSA reste longue durée (identité sociale). L'opération de remplacement d'`ecdhPub` existe déjà
   comme écriture signée (`identity/route.ts:87`) — la v2 y ajoute : compteur de version de clé
   monotone + rétention des anciennes clés publiques pour déchiffrement des messages en vol.
5. **Révocation/perte** : hors V1 ; décision ouverte OD-5.

### 3.3 Prekeys + ratchet : adoption d'une bibliothèque éprouvée (interdiction du fait maison)

- **Exigence normative** : le double ratchet, X3DH et la gestion des prekeys DOIVENT provenir
  d'une bibliothèque éprouvée et auditée. **Il est INTERDIT d'implémenter un double ratchet
  maison** (résolution du comité : « aucun mécanisme cryptographique artisanal »).
- **Candidat retenu** : **libsignal** (core Rust `signalapp/libsignal`, bindings officiels) —
  mobile via FFI (Kotlin/Swift) ; web via le paquet WASM/publié par Signal ou, à défaut
  d'API web maintenue, **repli MLS/OpenMLS** (§4) uniforme sur toutes les plateformes.
  Critère de choix M1 : si les bindings web libsignal ne sont pas maintenables à 3 devs,
  MLS devient le protocole 1:1 ET de groupe (une seule pile à auditer).
- **Champ d'application** : DM 1:1 uniquement. Le protocole v1 (ECDH-SS, §2-F/G) reste lisible en
  réception pendant la transition (enveloppes versionnées §3.5).
- **Exigence d'intégration** : la lib DOIT être consommée telle quelle (aucun fork, aucun
  contournement de sa gestion d'état de session), ses versions épinglées, et le verrouillage de
  dépendance documenté dans le registre de supply chain (§8-T6).

### 3.4 Authentification des clés (exigence du comité)

1. **Empreinte / safety number** : `SHA-256("MBOTE-SN-v1" ‖ min(pubA_raw,pubB_raw) ‖ max(...))`
   où `*_raw` = clé publique ECDSA brute 65 o (`proof.ts:144-147` définit déjà le format) ;
   on prend les 30 premiers octets → **60 chiffres décimaux, affichés par groupes de 5**
   (12 groupes), identique au format Signal. Le tri lexicographique rend l'empreinte symétrique.
2. **Vérification hors-bande** : lecture comparée en personne, ou QR contenant
   `{v:1, pubkey, ecdhPub, ts, sig}` signé par la clé de signature — le scanner vérifie la
   signature puis compare l'empreinte. Le rendu/scan QR est **ABSENT DU CODE (v1.x)** (à construire).
3. **État de vérification dans l'UI** : trois états obligatoires sur chaque conversation DM —
   `non vérifié` (défaut), `vérifié` (empreinte comparée), `alerte` (la clé du pair a changé après
   vérification → bannière rouge, messages en attente de re-confirmation). Le changement
   d'`ecdhPub` est aujourd'hui silencieux (`identity/route.ts:87`) — la v2 le rend détectable.
4. **Trajectoire transparence de clés** (nommée comme trajectoire, PAS en V1/V2 par défaut) :
   annuaire append-only des `(pubkey, ecdhPub, version, ts)` signées par leurs propriétaires,
   publié en log Merkle (ex. transparence type CT) consultable par les clients ; un serveur qui
   servirait une `ecdhPub` falsifiée (L-3) devient prouvablement détectable. Jalons : étude P3,
   pas de gage de date.

### 3.5 Anti-rejeu et fenêtres

- **Actions** (posts, likes, follows, envois DM) : conserver les fenêtres v1 (7 j offline-first,
  `proof.ts:26` ; lectures 15 min, `proof.ts:36`) — elles sont cohérentes avec l'outbox
  store-and-forward (`identity.ts:31-32`).
- **DM v2** : chaque message porte `(epoch, counter, ts)` ; le récepteur refuse
  `counter ≤ dernier vu` pour l'époque courant et garde une fenêtre de tolérance de 256
  compteurs pour le réordonnancement transport. La réinjection d'une enveloppe déjà traitée
  (L-4) est alors refusée cryptographiquement, pas seulement dédupliquée.
- **Dédup transport** : généraliser la dédup SHA-256 persistante (J) à toutes les voies
  d'ingestion ; remplacer le FNV-64 en mémoire (L-5) par SHA-256 tronquée 128 bits minimum.

### 3.6 Format d'enveloppe de message (versionné, agilité algorithmique)

```jsonc
{
  "v": 2,                          // version du schéma d'enveloppe — ABSENT en v1 (L-6)
  "alg": "ECDSA-P256/SHA-256 + ECDH-P256/HKDF-SHA256/AES-256-GCM",
                                   // identifiant d'algorithme explicite → agilité
  "senderKey": "<pubkey sign 65o b64url>",
  "recipientKey": "<pubkey sign 65o b64url>",
  "eContent": { "iv": "<12o>", "ciphertext": "<…>", "aad": "v2|senderKey|recipientKey|epoch|counter|ts" },
  "epoch": 0, "counter": 42, "ts": 1730000000000,
  "signature": "<ECDSA sur la sérialisation canonique des champs ci-dessus>"
}
```

Règles : (i) `aad` DOIT être passé à AES-GCM (corrige L-7) et couvrir expéditeur, destinataire,
époque, compteur, ts ; (ii) tout champ inconnu dans une version supérieure DOIT être ignoré sans
casser le parsing ; (iii) un `alg` non reconnu → rejet explicite, jamais de repli silencieux ;
(iv) la sérialisation canonique signée est décrite dans un document de test vectoriel (§8-T1).

---

## §4 — Groupes : V1 pairwise (accepté temporairement) → MLS (trajectoire documentée)

> Constat factuel : **il n'existe aucune conversation de groupe dans le code v1.x** (grep
> `groupe|group` dans `src/` et `mobile/src/` : 0 match fonctionnel ; pas de modèle Prisma, pas
> d'UI). Cette section spécifie donc (a) le plafond si le chiffrement pairwise de groupe était
> activé en V1, et (b) la trajectoire MLS exigée par le comité.

### 4.1 Chiffrement pairwise en V1 — coût chiffré assumé

Si un groupe est implémenté en V1, chaque message est chiffré **N fois** (une enveloppe par
membre, modèle sender-side fan-out). Coût : O(N) en chiffrements, en octets envoyés et en trafic
mesh (où chaque octet coûte du duty-cycle radio, budget paquet 469 o : `bitchat-protocol.ts:47`).

Hypothèses du tableau : message clair 1 024 o → ciphertext 1 040 o (+16 tag GCM) → base64 +33 %
≈ 1 387 o + en-tête/enveloppe JSON ≈ 230 o ⇒ **≈ 1,6 KiB envoyés par membre et par message**.

| Taille groupe | Enveloppes | Octets envoyés / message | Verdict |
|---|---|---|---|
| 5 membres | 5 | ≈ 8 KiB | OK |
| 20 membres | 20 | ≈ 32 KiB | Plafond pratique recommandé **≤ 20 membres** en V1 |
| 50 membres | 50 | ≈ 80 KiB | Dégradé ; interdit en mesh BLE (fragmentation > 64 blocs, `bitchat-protocol.ts:321`) |
| 100 membres | 100 | ≈ 160 KiB | Refusé — activer uniquement après MLS |

Plafond normatif V1 : **groupes ≤ 20 membres**, 30 msgs/min/groupe, et refus serveur au-delà
(aligné sur les rate limits DM existants, `dms/route.ts:15-19`). Au-delà : MLS obligatoire.

### 4.2 Spécification d'adoption MLS (RFC 9420)

- **Protocole** : MLS (RFC 9420), suite cryptographique fixée à l'adoption (cible :
  `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` pour rester P-256/interopérabilité orientée
  navigateur ; hypothèse à valider au M-G1 contre le support OpenMLS).
- **Bibliothèque** : **OpenMLS** (`openmls`, Rust) — interdiction d'implémenter l'arbre de
  ratchet (TreeKEM) ou le Delivery Service maison. Lien avec §3.3 : si libsignal-web n'est pas
  retenu, OpenMLS couvre AUSSI les DM 1:1 (groupe à 2 membres), une seule pile auditable.
- **Backend minimal** : Delivery Service = endpoints existants du VPS (listing des membres,
  distribution des KeyPackages, forgage des commits) ; le serveur voit les GroupInfo/KeyPackages
  mais jamais les messages (ciphertext groupés).

### 4.3 Jalons et critères d'acceptation chiffrés

| Jalon | Contenu | Critères d'acceptation (mesurables) |
|---|---|---|
| **M-G1 — Prototypage** | PoC OpenMLS (web WASM + mobile FFI ou uni-rust) : groupe 5 membres, add/remove, envoi/réception | 1 salle de test fonctionne web↔mobile ; ajout/suppression d'un membre propagé < 2 s ; zéro crypto écrite à la main (diff de dépendances vérifiable) |
| **M-G2 — Tests d'interopérabilité** | Vecteurs RFC 9420 (test vectors officiels OpenMLS), interop avec une 2ᵉ implémentation si disponible, chaos réseau (pertes, réordonnancement) | 100 % des vecteurs officiels passent ; 500 messages / 30 events de groupe sans divergence d'état ; commit/merge sous 30 % de pertes |
| **M-G3 — Activation derrière flag** | Feature flag `mls_groups=on/off`, cohabitation pairwise V1, bascule progressive | Flag distant désactivable à chaud ; métriques d'échec < 1 % des envois sur cohort 5 % ; rollback testé ; doc utilisateur à jour |

La trajectoire pairwise→MLS est la « trajectoire documentée » exigée par le comité : ce §4.3
est sa référence contractuelle ; toute dérive de jalon doit être inscrite au registre §9.

---

## §5 — Stockage local

- **Web — clés privées** : objets CryptoKey **non-extractibles** persistés dans IndexedDB
  `mbote-secure` (`secure-keys.ts:24-27,82-98`) ; localStorage ne contient que les métadonnées
  publiques (`identity.ts:137-146`). Norme v2 : **interdiction de remettre du matériel privé
  (JWK `d`, hex) dans localStorage** — régression interdite (la migration F-06,
  `identity.ts:85-106`, détruit l'héritage en clair).
- **Mobile — clés privées** : expo-secure-store (Keychain/Keystore) avec migration depuis
  AsyncStorage (`crypto-rn.ts:63-65,86-127`). Norme v2 : conserver SecureStore ; évaluer un
  stockage chiffré matériau si multi-device (OD-4).
- **Chiffrement au repos optionnel** : IndexedDB n'est pas chiffrée par l'OS (web). Option v2 :
  envelopper les données locales sensibles (cache DM déchiffré) dans une base chiffrée WebCrypto
  (clé dérivée du déverrouillage utilisateur, PBKDF2/Argon2 → AES-GCM). Statut : **optionnel**,
  ne doit pas créer de fausse promesse contre un appareil compromis (§1.3).
- **Effacement** : panic wipe complet web (`identity.ts:172-183` — localStorage, IndexedDB
  `mbote-secure` + `mbote-outbox`) et mobile (`crypto-rn.ts:130-141`). Norme v2 : tout nouveau
  stockage (cache DM chiffré, sessions ratchet) DOIT être intégré au panic wipe au moment de sa
  création (règle de CI : toute création de base IndexedDB/SQLite listée dans un test de wipe).
- **Messages en clair en mémoire** : le cache de déchiffrement de session (`MessagesView.tsx:144-167`)
  vit en RAM React — acceptable ; ne pas le persister en clair.

---

## §6 — Résistance Sybil et authentification d'identité

Le modèle « clé = compte » (`schema.prisma:10-13`) rend la création d'identités gratuite :
les rate limits (`identity/route.ts:12-14`, `dms/route.ts:15-19`) ralentissent mais ne stoppent
pas une ferme d'identités. Trois pistes, chiffrées (hypothèses explicitées) :

| Piste | Mécanisme | Coût direct | Coûts cachés / risques | Impact Sybil | Verdict indicatif |
|---|---|---|---|---|---|
| **S-1 Vérification téléphone (SMS OTP)** | 1 SMS par identité, hash du numéro signé côté serveur (le numéro n'est pas publié) | **Hypothèse** : 0,05–0,20 USD/SMS RDC (opérateurs Vodacom/Airtel, tarifs routeur international) ; 100 k créations/mois ⇒ 5–20 k USD/mois | Dépendance opérateurs (couverture intermittente en zone de blackout — contradictoire avec le produit), SIM farms (les fraudeurs paient aussi, coût dissuasif seulement ×1), absence de confidentialité du numéro vis-à-vis du serveur, exclusion des sans-numéro | Élevé contre le Sybil amateur, moyen contre l'organisé | Mal adapté au contexte blackout ; à réserver à un niveau « compte renforcé » optionnel |
| **S-2 Preuve de travail / PoW captcha (type WCID, PoW-captcha)** | Puzzle hash (ex. 2^26 ≈ 0,5–2 s mobile, **hypothèse** CPU milieu de gamme) par identité créée ; difficulty ajustée | Quasi nul en argent ; coût CPU/batterie pour TOUS (dont les vieux Android — critère RDC) | Ne bloque pas une ferme avec GPU ; tension avec les appareils low-end ; UX d'attente | Faible seul, utile comme ralentisseur + signal anti-spam | Retenu comme **frein par défaut** (difficulty adaptative), jamais comme preuve d'humanité |
| **S-3 Réputation progressive + parrainage** | Identité neuve = plafonds bas (ex. 3 DM/j vers inconnus — **hypothèse** à calibrer sur `dms/route.ts:15`) ; un membre établi peut « parrainer » (chaîne de confiance style favoris mutuels BitChat, cf. modèle `Follow` `schema.prisma:89-99`) ; plafonds débloqués par ancienneté/réciprocité | Nul en argent ; coût produit (UX de progression) | Boucles de parrainage payées, collusion ; risque de discrimination des nouveaux légitimes en crise (blackout = tout le monde est nouveau) | Moyen-élevé à terme, nul à T0 | Retenu en V2 ; garder un « mode crise » qui relâche les plafonds quand la densité mesh est faible |

**Décision demandée (OD-1, §9)** : combiner S-2 (frein par défaut) + S-3 (plafonds progressifs),
S-1 en option « identité renforcée ». Aucune de ces pistes n'est une preuve d'humanité : le
document d'architecture doit cesser de le suggérer si tel est le cas.

---

## §7 — Ce qui NE sera PAS fait (frontières assumées)

1. **Aucune backdoor**, aucun « accès légal assisté », aucun mécanisme de déchiffrement caché.
2. **Aucun escrow de clés** : aucune copie de clé privée chez le serveur, même chiffrée, même « au
   bénéfice de l'utilisateur ». (Exception existante et bornée : le bot de démonstration est une
   identité SERVEUR par design, `schema.prisma:18` + `bot-key.ts` — elle n'est pas un utilisateur
   humain et ne doit jamais servir de modèle pour de vraies identités.)
3. **Aucune récupération de compte par le serveur** : le serveur ne peut pas régénérer/restaurer
   une clé privée. Perte = perte (panic wipe `identity.ts:172-183` est définitif). Toute
   récupération future sera locale (phrase de récupération, OD-4).
4. **Pas d'E2EE du fil public** : décision produit retenue — le fil reste **clair-signé modéré**
   (ECDSA P-256 vérifiée serveur, `posts/route.ts:212-230`), permettant la modération et la
   recherche. Les canaux géohash sont publics par nature (`NetworkView.tsx:398-401`). Chiffrer le
   fil public le rendrait injoignable et imodérable ; ce trade-off est assumé et documenté.
5. **Pas de traçabilité de clés active en V1/V2** (§3.4.4 reste une trajectoire, pas un engagement).

---

## §8 — Plan de validation adversariale (GATE de communication)

> **Règle de gate** : tant que les tests T1–T6 ne sont pas verts et qu'au moins une revue externe
> (R1) n'a pas eu lieu, **il est INTERDIT de communiquer « E2EE validé »** (site, store, presse,
> README). Formulation autorisée d'ici là : « chiffrement de bout en bout en cours de validation ;
> spécification publique §8 ».

| # | Test | Contenu | Outil / méthode | Critère de sortie |
|---|---|---|---|---|
| **T1** | Vecteurs Wycheproof — ECDSA & ECDH | Exécuter les vecteurs Project Wycheproof (ECDSA_P256_SHA256, ECDH_P256, cas limites : malleabilité s, clés faibles, DER/ASN.1, encodages 64/65 o) sur `verify.ts`, `proof.ts`, `crypto-rn.ts` | vecteurs JSON wycheproof + runner Node/JS | 100 % des vecteurs « valid/invalid » tranchés conformément à l'oracle ; zéro exception non gérée |
| **T2** | Tests de nonces | Instrumenter `sealMessage` web+mobile : N = 10^5 messages, vérifier l'unicité des IV (96 bits aléatoires, `crypto.ts:176`, `crypto-rn.ts:184`), la distribution, et l'absence de réutilisation sous concurrence | script de propriété (property-based) CI | 0 doublon ; Kolmogorov-sur-octets sans anomalie grossière ; le test s'exécute en CI sur chaque PR touchant `crypto*` |
| **T3** | Fuzzing des parseurs d'enveloppe | Fuzz `decodePacket`, `decodeMeshEvent`, `FragmentAssembler`, parsing des enveloppes DM v2 (§3.6) : entrées aléatoires/mutées, troncatures, champs négatifs, versions inconnues | cargo-fuzz sur les crates Rust ciblées ou jsfuzz/AFL sur TS ; 10^7 inputs min | Aucun crash/panic/hang ; toutes les erreurs = rejet propre avec raison ; budgets mémoire respectés (`bitchat-protocol.ts:319-321`) |
| **T4** | Tests différentiels multi-clients | Le même flux (identité→post→DM→réseau→sync) exécuté sur web (Chrome/Firefox), mobile (Hermes) et le parity check : les signatures/empreintes/enveloppes produits par chaque client sont acceptés par tous les vérificateurs | `scripts/check-protocol-parity.ts` étendu à la crypto ; matrice CI | Parité 100 % web/mobile/serveur sur chaînes canoniques, signatures r‖s, secret ECDH (déjà vrai par construction `crypto-rn.ts:9-15` — le test doit le verrouiller) |
| **T5** | Scénarios adversariaux bout-en-bout | (a) réinjection d'enveloppe DM v1 dans la fenêtre 7 j (prouve L-4) → puis vérifie que v2 (§3.5) la refuse ; (b) substitution d'`ecdhPub` par un serveur malveillant simulé (prouve L-3) → v2 détecte via safety number ; (c) rejeu inter-transport (API vs pont mesh) | suite e2e dédiée `tests/adversarial/` | L-3/L-4 démontrées sur v1, fermées sur v2 ; le test échoue si une régression réouvre la faille |
| **T6** | Revue de supply chain | Épinglage + audit des dépendances crypto (@noble/curves, @noble/ciphers, @noble/hashes, expo-secure-store, OpenMLS) ; SBOM ; vérification des checksums | `bun.lock` audité, outils SBOM, revue manuelle | Versions épinglées listées publiquement ; 0 dépendance crypto non auditée |

**Revue par un tiers + audit externe.** Séquence recommandée : (R1) revue croisée par un
cryptographe externe sur CE document + le diff v1→v2 (gratuit à faible coût : contacts
académiques/communautés, 2–5 jours-homme) ; (R2) audit externe ciblé avant ouverture grand
public. **Critères de sélection d'un cabinet** : (i) références d'audits de protocoles E2EE
publiés (pas seulement webapps) ; (ii) méthode publique (revue de spec + code, pas scan
automatisé) ; (iii) publication intégrale du rapport final (même NR : nota rectificatif) ;
(iv) périmètre explicite : `crypto.ts`, `crypto-rn.ts`, `proof.ts`, `verify.ts`, enveloppes
v2, intégration libsignal/MLS ; (v) clauses de re-test. **Budget indicatif** : 15–40 k€ pour un
audit ciblé de 2–4 semaines-homme sur ce périmètre (**hypothèse à confirmer par devis ; hors
scope un audit global app serait 2–3× plus cher**). Le jalon d'audit est planifié après M2 (§3.3)
pour auditer l'intégration de la lib, pas une version condamnée à changer.

**Gate final** : la mention « E2EE validé adversarialement » n'est autorisée qu'après T1–T6 verts
sur la version déployée + R1 + R2, avec publication de la date de version auditée.

---

## §9 — Registre des décisions ouvertes

| ID | Décision ouverte | Options | Propriétaire suggéré | Délai suggéré |
|---|---|---|---|---|
| OD-1 | Stratégie anti-Sybil (§6) | S-2+S-3 combinés ; S-1 option renforcée | Produit + infra | Avant ouverture publique des inscriptions |
| OD-2 | Protocole DM v2 : libsignal (web dispo ?) vs OpenMLS uniforme (§3.3/§4.2) | Bench des bindings web Rust/WASM ; critère : 1 seule pile à auditer | Tech lead crypto | Fin M1 (3–4 sem. après kickoff) |
| OD-3 | Suite MLS exacte (P-256 vs Curve25519) selon support OpenMLS + cible navigateur (§4.2) | `MLS_128_DHKEMP256_…` vs `…X25519…` | Tech lead crypto | M-G1 |
| OD-4 | Sauvegarde/restauration locale chiffrée (phrase de récupération) et multi-device | Hors V1 ; risque d'élargir la surface d'attaque | Produit | V2.x |
| OD-5 | Politique de perte/révocation d'identité (pas de récup serveur, §7.3) | Recréation + parrainage de réputation vs prekey à long terme | Produit | V2 |
| OD-6 | Remplacement du FNV-64 mémoire (L-5) : SHA-256 tronqué 128 bits, compat des deux dédups pendant transition | Étendre `check-protocol-parity.ts` à la nouvelle empreinte | **A1 LIVRÉ (web+miroirs+parité)** — reste la migration des appelants mobiles synchrones | Vague mobile |
| OD-7 | Transparence de clés : log Merkle hébergé par nous vs témoin tiers (§3.4.4) | Étude P3 | Infra | P3 (post-MLS) |
| OD-8 | Correctif du commentaire « Noise-X » trompeur (`bitchat-protocol.ts:21`, L-8) et de toute doc sur déclarant du Noise | PR doc 15 min | Dev core mesh | Immédiat (avant audit) |
| OD-9 | Taille de groupe max pairwise V1 : 20 (§4.1) à confirmer par mesure réelle BLE (duty-cycle) | 15 / 20 / 25 | Mobile + produit | M-G1 |

---

### Annexe A — Récapitulatif présent vs absent (audit d'honnêteté)

**PRÉSENT (vérifié)** : génération d'identité locale non-extractible web / SecureStore mobile
(A, M, N) ; signature ECDSA P-256/SHA-256 client web + mobile (B, C) ; vérification serveur
obligatoire posts/identité/DM/likes/follows/lectures/relay-hello (D, E) ; chiffrement DM
ECDH P-256 + AES-256-GCM à IV aléatoire web + mobile (F, G) ; serveur aveugle (iv+ciphertext
seulement, H) ; fenêtres de fraîcheur 7 j / 15 min (I) ; dédup SHA-256 persistante du pont mesh
(J) ; idempotence posts par signature unique (L) ; panic wipe (O) ; bot-key chiffrée au repos (P).

**ABSENT DU CODE (v1.x)** : tout protocole de groupe (aucune feature groupe, pas de modèle de
données) ; MLS/OpenMLS/libsignal/prekeys/ratchet (0 occurrence) ; forward secrecy (ECDH
statique-statique assumé, L-1) ; authentification des clés / safety number / QR / état de
vérification UI (L-2) ; transparence de clés (L-3 côté serveur exploitables) ; compteur
d'époque anti-rejeu DM (L-4) ; dédup cryptographique en mémoire mesh (L-5) ; versionnage du
payload MeshEvent et identifiants d'algorithmes (L-6) ; AAD AES-GCM (L-7) ; tests Wycheproof /
nonces / fuzzing / adversariaux (L-9) ; chiffrement au repos optionnel du cache local (§5).
