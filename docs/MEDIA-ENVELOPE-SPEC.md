# MEDIA-ENVELOPE-SPEC v1 — socle média B1 (chiffrement par objet, EXIF, stockage présigné)

**Statut** : socle livré en B1 (bibliothèque + tests + benchmark) — **aucune
route API activée à ce stade** (directive B1 : socle uniquement). Les routes
d'upload/download arriveront en B2 avec le device réel.

---

## 1. Enveloppe de chiffrement (par objet)

### 1.1 Format `v1:iv:ciphertext:tag`

Chaque objet média est chiffré INDÉPENDAMMENT :

```
envelope = "v1:" + b64url(IV) + ":" + b64url(ciphertext) + ":" + b64url(tag)
```

| Champ | Taille | Règle |
|---|---|---|
| `v1` | — | version du format (constante ; tout autre préfixe → refus) |
| `iv` | **12 octets** (96 bits, taille GCM recommandée NIST SP 800-38D) | **ALÉATOIRE UNIQUE par objet** — généré CSPRNG (`crypto.randomBytes`), JAMAIS dérivé, JAMAIS réutilisé (garde process-wide, §1.3) |
| `ciphertext` | taille du plaintext | AES-256-GCM |
| `tag` | **16 octets** | tag d'authentification GCM (intégrité + authenticité) |

- Algorithme : **AES-256-GCM** (confidentialité + intégrité en une passe).
- Les 3 parties binaires sont en **base64url** (sans padding) — l'enveloppe
  est une string sûre en JSON/DM.
- Parse strict : nombre de segments, préfixe, longueurs (IV=12, tag=16) —
  toute malformation → `MediaCryptoError("bad-envelope")`, jamais de crash.

### 1.2 CEK par objet — généré CÔTÉ CLIENT (jamais serveur)

- **CEK (Content Encryption Key) = 32 octets aléatoires PAR OBJET**
  (`crypto.getRandomValues` côté client). Une clé compromis ne compromet
  qu'un objet.
- Le serveur ne voit **jamais** le CEK : il transite dans la charge dm2
  chiffrée E2EE (§3). Le serveur ne stocke que l'objet chiffré (aveugle,
  comme les DM aujourd'hui).
- Dérivation future (B2+, hors V1) : wrap du CEK par la clé de conversation
  ECDH existante — le socle V1 expose `encryptMedia/decryptMedia(cek)` sans
  hypothèse sur le transport de la clé.

### 1.3 Garde anti-réutilisation d'IV (refus explicite)

- Toute opération de scellé enregistre son IV dans une **garde process-wide**
  (`MediaIvRegistry`, LRU ~10 000 entrées) : deux scellés avec le MÊME IV →
  `MediaCryptoError("iv-reused")` — **refus explicite** (testé).
- Rappel crypto : la réutilisation (clé, IV, nonce) en GCM casse la
  confidentialité ET l'authenticité — la garde est une barrière dure même en
  cas de bug d'appelant.
- Test A6 : `sealWithIv` deux fois avec le même IV → refus ; 1 000 scellés
  aléatoires → 1 000 IV distincts.

## 2. Limites de taille (imposées à la présignation)

| Type | Taille max | Contrôle |
|---|---|---|
| Image | **5 Mo** | `assertMediaLimit(mediaType, bytes)` + **Content-Length signé dans l'URL présignée** (§4.3) |
| Audio | **10 Mo** | id. |
| Vidéo | **100 Mo** | id. |

- Dépassement → `MediaLimitError` **avant** tout octet envoyé au stockage.
- Quota par compte (**proposition retenue V1**) : **500 Mo total par compte**,
  comptabilisé serveur à la validation d'upload (B2 — nécessite les routes ;
  le socle V1 expose les limites par type, le quota par compte est une règle
  métier de la couche upload).

## 3. Encapsulation dans dm2 (réutilisation du canal existant)

- L'enveloppe + les métadonnées voyagent dans un message **dm2** (canal signé
  E2EE existant — preuves de possession ECDSA, garde anti-rejeu A1) :

```jsonc
// charge dm2 de type « media-attach » (B2) — le serveur n'en voit que le chiffré
{
  "kind": "media",
  "objectKey": "media/<random-uuid>",   // clé de stockage, sans identité
  "mediaType": "image/jpeg",            // whitelist §2
  "bytes": 482133,                      // taille en clair (contrôle côté destinataire)
  "envelope": "v1:…:…:…",               // §1.1 — le CEK n'y est JAMAIS
  "cekWrapped": "…",                    // B2 : CEK wrappé pour les destinataires (ECDH existant)
  "sha256": "…"                         // empreinte de l'objet CHIFFRÉ (dédup/contrôle)
}
```

- Le serveur reste aveugle : il achemine le dm2 (déjà le cas) et stocke
  l'objet chiffré — il ne peut ni déchiffrer, ni lister le contenu par
  utilisateur (clés d'objet sans identité, §4.2).

## 4. Stockage présigné (abstraction R2/MinIO)

### 4.1 Drivers

- `MEDIA_STORAGE_DRIVER=minio` (S3-compatible, dev/docker) ou `r2`
  (Cloudflare R2, prod) — les DEUX parlent S3 SigV4 : **une seule
  implémentation de présignature**, config par env :

| Variable | Rôle |
|---|---|
| `MEDIA_STORAGE_DRIVER` | `minio` \| `r2` (défaut `minio`) |
| `MEDIA_S3_ENDPOINT` | endpoint (MinIO : `http://127.0.0.1:9000`, R2 : account endpoint) |
| `MEDIA_S3_REGION` | région sigv4 (`us-east-1` MinIO, `auto` R2) |
| `MEDIA_S3_BUCKET` | bucket |
| `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY` | credentials |

- **Zéro dépendance ajoutée** : SigV4 présignature écrite sur `node:crypto`
  (~80 lignes, spécification AWS) — pas d'`@aws-sdk/*` (justification :
  discipline « dépendance à justifier », la surface utilisée est minuscule et
  testée).

### 4.2 Clés d'objet

- Format : `media/<uuid v4>` — **aucune identité utilisateur dans la clé**
  (le stockage est aveugle, comme la DB des DM). Le lien objet↔utilisateur
  ne vit que côté application (B2).
- `assertObjectKey` : whitelist stricte (`^media/[0-9a-f-]{36}$`) — refus de
  toute clé exotique (traversée de chemin, `..`, etc.).

### 4.3 URLs présignées — TTL 15 min, PUT uniquement, taille liée

- `generatePresignedUrl(objectKey, { ttlSec = 900, method = "PUT", contentLength })` :
  - **TTL par défaut : 15 min = 900 s** (directive) — `ttlSec` borné 60…3600,
    `ttl ≤ 0` ou expiré → refus explicite ;
  - **méthode bornée : `PUT` (upload) ou `GET` (download)** — pas d'autres
    verbes signés ;
  - **taille imposée** : le `content-length` exact est inclus dans les
    **signed headers** — tout upload d'une autre taille est rejeté par
    signature S3 (le client connaît la taille : il vient de chiffrer les
    octets) ;
  - en-tête signé unique : `host` (+ `content-length` en PUT).
- `verifyPresignedUrl(url, { now })` — **vérificateur local** (utilisé par les
  tests V1 et par la future route PUT B2) : re-calcul sigv4 + fenêtre
  d'expiration → `MediaStorageError("expired" | "bad-signature" | "bad-method")`.
  Test B : TTL respecté, méthode respectée, **URL expirée → refus**.

## 5. Strip EXIF (privacy-by-default)

### 5.1 Liste exacte des métadonnées supprimées

`stripExif(imageBytes)` ré-encode l'image via sharp **sans aucune métadonnée**
(équivaut à tout supprimer) :

| Catégorie | Exemples de champs supprimés |
|---|---|
| **Localisation** | GPS IFD complet : `GPSLatitude/Ref`, `GPSLongitude/Ref`, `GPSAltitude`, `GPSTimeStamp`, `GPSImgDirection` |
| **Dates** | `DateTime`, `DateTimeOriginal`, `DateTimeDigitized`, `CreateDate`, `ModifyDate` |
| **Appareil** | `Make`, `Model`, `Software`, `LensMake`, `LensModel`, `BodySerialNumber`, `CameraOwnerName` |
| **Technique** | `ExposureTime`, `FNumber`, `ISO`, `FocalLength`, `Flash`, `WhiteBalance`, `MeteringMode` |
| **Structural** | **IFD1 thumbnail** (vignette incorporée — fuite de pixels historique), XMP, IPTC, commentaires |
| **ICC** | profil couleur incorporé (V1 : supprimé aussi — sRGB supposé ; arbitrage documenté §6.4) |

### 5.2 Orientation — TRANCHEMENT EXPLICITE

**L'orientation EXIF n'est PAS conservée comme métadonnée : elle est CUITE
DANS LES PIXELS** (auto-rotation sharp avant ré-encodage).

- Pourquoi : après strip, les navigateurs/clients appliquent
  l'orientation EXIF de façon incohérente (certaines plateformes l'ignorent)
  → une image « debout » deviendrait « couchée » chez une partie des
  destinataires. Cuire l'orientation garantit un rendu IDENTIQUE partout,
  sans métadonnée.
- Coût : ré-encodage (accepté — l'upload chiffre de toute façon des octets
  transformés) ; les dimensions finales = dimensions orientées.

### 5.3 Garanties testées

- Une image avec GPS → **GPS absent** après strip (`metadata().exif` vide) ;
- **taille post-strip ≤ taille originale** (fixture photo-like ; pour les
  captures d'écran PNG, taille comparable) ;
- dimensions préservées (orientation cuite) ;
- pixels préservés (comparaison des dimensions + hash par pixel volontairement
  hors V1 — le ré-encodage change les octets par construction).

## 6. Arbitrages

1. **Pas d'AAD en V1** : l'enveloppe ne lie pas l'`objectKey` comme AAD
   (hardening réservé B2 — nécessite que le chiffreur connaisse sa clé de
   stockage au moment du chiffrement ; documenté pour ne pas l'oublier).
2. **SigV4 maison** plutôt qu'AWS SDK : surface minimale (presign + verify),
   zéro dépendance, tests déterministes — la charge de maintenance est
   faible (l'algorithme est figé) et l'alternative (`@aws-sdk/*`) ajoutait
   ~10 Mo de dépendances pour deux appels.
3. **IV 12 octets** (pas 16) : taille GCM recommandée NIST ; les 4 octets
   supplémentaires n'apportent rien en sécurité.
4. **ICC supprimé** : privacy-first (les profils peuvent être signés
   numériquement et traçables) ; sRGB supposé — suffisant en V1 chat.
5. **Quota 500 Mo/compte** : proposition retenue (directive), implémenté à la
   couche upload (B2) — le socle livre les limites par type + les erreurs
   typées.
6. **Branche depuis `main`** : le socle média ne dépend d'aucun code ADM
   (routes admin, panneau) — zéro conflit au merge, déploiement ordonné
   ADM → B1.
7. **« magic bytes » sous E2EE — TRANCHEMENT B2 (2026-11-06)** : la directive
   B2 demande à `finalize` de valider « contenu valide (magic bytes) ». Or
   l'objet stocké est le CIPHERTEXT du client (enveloppe §1) — le serveur
   ne peut mathématiquement PAS lire les magic bytes du plaintext sans
   casser l'E2EE. Le contrôle est donc découpé en trois barrières, chacune
   prouvée :
   - **(i) à l'entrée (client honnête)** : `stripExif` ré-encode via
     sharp/canvas — un PDF renommé `.jpg` est refusé AVANT tout chiffrement
     (decode fail → `bad-image`) ;
   - **(ii) à `finalize` (serveur, aveugle)** : validation structurelle de
     l'enveloppe (v1:iv:ciphertext:tag — IV 12 o, tag 16 o, ciphertext non
     vide, taille = Content-Length signé) + existence réelle de l'objet dans
     le bucket. Un client malveillant qui PUT du chiffré arbitraire passe
     cette barrière — assumé, c'est le prix de l'E2EE ;
   - **(iii) à la lecture (destinataire)** : après decrypt, `sniffImageType`
     vérifie les MAGIC BYTES du plaintext (JPEG FFD8 / PNG 89504E47 /
     WEBP RIFF…WEBP) contre le `mediaType` déclaré dans le dm2 — toute
     divergence → `MediaTypeError("magic-bytes-mismatch")`, rendu REFUSÉ.
     Un PDF déguisé en jpeg n'est donc jamais rendu, même par un client
     malveillant.
   Compromis assumé : un ciphertext de garbage peut OCCUPER du stockage
   (borne : quota 500 Mo + rate limit 20/h + TTL presign 15 min) mais ne
   peut jamais être RENDU comme image à un destinataire.
8. **Presignature GET de lecture — qui peut lire ?** Toute identité
   authentifiée (preuve de possession courte durée) peut obtenir la
   presignature GET d'un média finalisé : le contenu est de toute façon
   indéchiffrable sans le CEK, qui voyage UNIQUEMENT dans le dm2 E2EE (§3).
   Le mediaId (cuid non énumérable) + l'authentification ferment
   l'énumération anonyme ; la confidentialité réelle reste E2EE. Le serveur
   ne fait aucun ACL fin sur les médias — impossible par conception (il ne
   sait pas qui les a reçus).
9. **Portée B2 — web complet, mobile reporté** : le client B2 livre
   `media-client.ts` (module TS pur : WebCrypto + fetch + queue offline)
   et l'UI web minimale. Le client RN (mobile/) partage le socle mais son
   strip EXIF exige expo-image-manipulator et son harness n'est pas
   exécutable dans ce sandbox → **NON TESTÉ** explicitement (extension B3).
   Un code natif non prouvé serait de la preuve fantôme.
10. **Micro-images < 32 Ko — TRANCHEMENT B3 (2026-11-06, clarification
   direction)** : strip canvas appliqué, invariant taille non garanti (le
   ré-encodage peut agrandir). Un mode strip-lossless (réécriture EXIF sans
   ré-encodage) est reporté à **B4+**. Documenté, pas résolu : la garantie
   privacy (aucune métadonnée) reste intégrale, seule la borne « ≤ original »
   est levée sous 32 Ko (le serveur borne le ciphertext de toute façon —
   Content-Length signé ≤ 5 Mo). Implémentation actuelle : garde
   `bytes.length >= 32 * 1024` dans `stripExifClient` (media-client.ts).
   *Note de trace : la directive nommait « docs/specs/MEDIA-ENVELOPE-SPEC.md »
   — la spec vit à `docs/MEDIA-ENVELOPE-SPEC.md` depuis B1 ; le présent
   arbitrage y est appliqué à l'identique.*
11. **Dette de test B1 — MinIO (Clarification 2, vague F)** : Test B1 MinIO
   s'exécute nulle part (skip en CI par absence de pile, skip en local par
   absence de docker). À valider au premier environnement avec MinIO réel
   (VPS ou runner avec `MEDIA_S3_ENDPOINT`). **Dette : le test ne protège
   actuellement aucune régression.** Tracée aussi dans
   `docs/proofs/F16-F17-ci-fixes.md` §7.

---

## 7. Flux B2 — upload présigné → finalize → lecture décryptée (implémenté)

### 7.1 Endpoints serveur (app principale)

| Endpoint | Méthode | Auth | Rôle |
|---|---|---|---|
| `/api/media/upload-url` | POST | preuve `${me}\|media-upload\|${mediaType}\|${sizeBytes}\|${ts}` (15 min) | validations → Media `pending` + presigned PUT |
| `/api/media/finalize` | POST | preuve `${me}\|media-finalize\|${mediaId}\|${ts}` (15 min) | existence bucket + structure enveloppe + taille → `finalized` + presigned GET |
| `/api/media/download-url` | GET | preuve `${me}\|media-dl\|${mediaId}\|${ts}` (15 min) | presigned GET (arbitrage §6.8) |

Chaîne de validation `upload-url` (dans l'ordre) : session configurée (503 si
`MEDIA_S3_*` absent) → rate limit **20 uploads/h/utilisateur** (429) →
`mediaType` whitelist `image/jpeg|png|webp` (400) → `sizeBytes` entier > 0 et
≤ 5 Mo (400) → quota **500 Mo** cumulé `SUM(sizeBytes)` des médias finalisés
de l'owner (429) → création `Media(pending)` + `newObjectKey()` → presigned
PUT `ttl=900 s` avec `contentLength = sizeBytes` **lié par la signature**
(toute taille différente est rejetée par le S3 lui-même).

Chaîne de validation `finalize` : media existe + owner + `pending` (404/403) →
objet présent dans le bucket (fetch presigned GET serveur → 400 si 404) →
taille lue = `sizeBytes` (422) → enveloppe structurellement valide
(`inspectEnvelope` : v1, IV 12 o, tag 16 o, ciphertext non vide — 422) →
`finalized`. Une ligne `pending` non finalisée 20 min après création est
orpheline (jamais comptée au quota).

### 7.2 Client `src/lib/mbote/media-client.ts` (web, RN-compatible)

- `encryptBytes(bytes)` — WebCrypto (`globalThis.crypto.subtle`, RN polyfill
  ok) : CEK 32 o CSPRNG **par objet**, IV 12 o CSPRNG unique + **garde de
  session** (Set — miroir client de la garde serveur §1.3), AES-256-GCM,
  enveloppe `v1:iv:ciphertext:tag` base64url — **identique au format B1**
  (interopérabilité testée : `decryptMedia` B1 lit une enveloppe client).
- `decryptBytes(envelope, cek)` — WebCrypto, échec propre (auth-failed).
- `sniffImageType(bytes)` — magic bytes purs JS (§6.7-iii).
- `uploadImage({ bytes, mediaType, strip?, onProgress? })` — orchestration :
  strip (injectable : `stripExifClient` canvas en web, sharp en harness) →
  chiffrement → `upload-url` → PUT présigné (Content-Length = octets de
  l'enveloppe, ASCII pur) → `finalize` → CEK gardé **en mémoire de session**
  (`sessionCekFor(mediaId)`) pour la relecture de ses propres images →
  `{ mediaId, objectKey, cek, mediaType, bytes, sha256 }`.
- `downloadImage({ mediaId, cek, declaredType? })` — `download-url` → GET →
  decrypt → **sniff magic bytes** (§6.7-iii) → Blob typé.
- `stripExifClient` — ré-encodage canvas SANS aucune métadonnée, orientation
  cuite (`imageOrientation: "from-image"`), jpeg (sans alpha) ou png (avec
  alpha). **Invariant « post-strip ≤ original » appliqué aux images ≥ 32 Ko
  uniquement** (arbitrage B2 : le ré-encodage canvas peut légèrement agrandir
  les micro-images — un JPEG 4×3 px de 517 o ré-encodé → ~760 o — l'invariant
  strict y est mathématiquement irréalisable ; la garantie privacy reste
  intégrale et le serveur borne le ciphertext de toute façon).
- `MediaUploadQueue` (**mémoire de session** — jamais persistée, B2-MVP) :
  uploads interrompus conservés avec leurs OCTETS en mémoire (localStorage
  refusé : plain bytes non persistables + quota DOM) ; à l'événement `online`,
  ré-orchestration COMPLÈTE (re-strip → re-chiffrement → re-présignation :
  les URLs de 15 min sont forcément expirées) en re-signant à chaque tentative.
  Fermeture de l'onglet = perte des médias en file (assumé MVP — l'utilisateur
  refait l'attache ; noté NON TESTÉ → UX).
- Fenêtres : les preuves media sont fenêtres COURTES (15 min, comme dm-read) —
  la queue re-signe à chaque tentative (le geste est effectif au moment du
  fetch, jamais stocké).

### 7.3 Encapsulation DM (payload média)

Le message média est un DM **ordinaire** (sealMessage ECDH existant, A1 v2,
même outbox) dont le plaintext est un JSON :

```jsonc
{ "kind": "media", "text": "…", "mediaId": "…", "cek": "…b64url…",
  "mediaType": "image/jpeg", "bytes": 482133, "objectKey": "media/<uuid>" }
```

Le CEK voyage DONC dans le dm2 E2EE (spec §3) — le serveur reste aveugle. Le
rendu client : `JSON.parse` du plaintext → `kind === "media"` → bulle média
(vignette → full), sinon texte brut (rétro-compat totale : les anciens
plaintexts ne sont pas du JSON `kind:media`).

### 7.4 UI minimale (web — « juste assez pour tester »)

Dans `MessagesView` : bouton 📎 → picker image → preview (nom, taille) →
upload orchestré avec états (`strip → chiffrement → PUT → finalize`, % sur le
PUT) → envoi du dm2 média. Réception : vignette (128 px, lazy via
`downloadImage` + cache mémoire blob) → clic → Dialog plein. Mobile RN :
arbitrage §6.9 (reporté B3).

---

## 8. Voice notes B3 — Opus 6–12 kbps (livré)

### 8.1 Prérequis bloquant PROUVÉ (avant toute UI)

- **Navigateur** (Chromium 1200 headless — playwright-core + fake audio device,
  `scripts/b3-opus-prereq.ts` + `tests/b3-opus-prereq.test.ts`) :
  `MediaRecorder.isTypeSupported("audio/webm;codecs=opus") === true` ·
  enregistrement RÉEL 5 s @ 8 kbps → 3 685 o · `decodeAudioData` décode le
  webm/opus → durée 4,98 s @ 44 100 Hz · 100 peaks calculés depuis les samples.
- **Serveur** (ffmpeg 7.1.5 + libopus) : WAV 30 s encodé à 6/8/12 kbps →
  22/31/46 Ko (budget mesh cohérent : 20–40 Ko pour 30 s à 8 kbps) ·
  décodage → durée ≈ 30 s · intégrité SHA-256 du décodage rejeté/accepté
  documentée dans les assets.

### 8.2 Arbitrages voix (tranchés, tracés en code + tests)

1. **MediaRecorder NATIF en V1 — AUCUN wrapper WASM** : la directive demandait
   de documenter la dépendance SI un wrapper était nécessaire. Il ne l'est PAS
   pour les navigateurs cibles (Chrome/Edge/Firefox produisent opus nativement
   — webm pour Chromium, ogg pour Firefox ; prouvé headless). Safari
   (MediaRecorder sans opus) → bouton micro DÉSACTIVÉ + message explicite
   (`VOICE_UNSUPPORTED_MESSAGE`) — pas de remplacement MP3/AAC (directive :
   Opus est le seul codec viable à 6–12 kbps). Fallback WASM (p. ex.
   `@wasm-audio-encoders/opus`, licence MIT) reporté **B4+** — NON TESTÉ.
2. **Bitrates 6 (mesh) / 8 (défaut) / 12 (confort) kbps** — constante
   `VOICE_BITRATES` ; durée max **60 s** (auto-stop enregistreur + garde
   d'envoi `validateVoiceForSend`, tolérance horloge 250 ms).
3. **Pas de strip EXIF** : Opus n'a PAS de métadonnées EXIF (conteneur audio)
   — rien à nettoyer, la confidentialité reste portée par le chiffrement
   enveloppe v1 (pipeline B2 IDENTIQUE : CEK client, IV unique, presign,
   finalize, sniff à la réception).
4. **Type canonique « audio/opus »** : quel que soit le conteneur réel
   (webm/ogg), l'API porte `audio/opus` ; le destinataire sniffe le plaintext
   (`sniffOpusContainer` : EBML+webm | OggS+OpusHead) et REFUSE tout le reste
   (un MP3 déguisé n'est jamais rendu — miroir §6.7-iii).
5. **Hold-to-record TRANCHÉ** (référence WhatsApp, usage RDC) : pointerdown =
   démarrer, pointerup = stop → preview. Relâchement < 400 ms → bascule
   tap-to-toggle (le tap suivant arrête) — accessibilité clavier (Enter/Space)
   préservée. Documenté dans MessagesView + spec (ce point).
6. **Waveform 100 peaks** calculée à l'arrêt (decodeAudioData du blob
   enregistré, `computePeaksFromSamples` partagé) et voyageant DANS le dm2
   E2EE (durée + peaks) : le destinataire affiche sans re-décoder ; fallback
   re-décodage si absents. Le serveur reste aveugle (payload chiffré).
7. **Mobile RN** : capture (expo-av) + fallback WASM = dette tracée §8
   SCALE-ARCHITECTURE (« Migration mobile RN », 8–12 jp) — NON TESTÉ, hors
   vagues web.
8. **Permissions-Policy : `microphone=(self)` (next.config.ts)** — le
   durcissement historique du template (`microphone=()`) interdisait au
   NAVIGATEUR tout accès micro, même avec consentement utilisateur (header
   niveau navigateur, inécrasable par l'UI) : les notes vocales étaient
   impossibles PAR CONSTRUCTION. Le bug a été attrapé par la preuve
   navigateur B3 (NotAllowedError malgré fake-device). Tranchement :
   `microphone=(self)` (même origine uniquement), camera/geolocation/payment
   RESTENT refusés (aucun usage dans l'app).
   Deuxième barrière du même type, même origine de découverte : la CSP
   historique n'avait PAS de `media-src` → `default-src 'self'` bloquait le
   chargement du blob audio local (`blob:` — la note déchiffrée) : lecture
   muette. Ajout `media-src 'self' blob:` (blob lié à son origine — aucun
   média distant ouvert). Deux preuves de plus que « les preuves navigateur
   voient ce que les tests unitaires ne voient jamais ».
9. **Audit UI non-optimiste (§1.8 ADMIN-RBAC) des composants B3 — TRAITEMENT
   B4 (2026-11-06, clarification direction)** : le correctif anti-rebond
   250 ms (§8.2-5) est un débounce d'ENTRÉE (course pointerdown/click — il ne
   présage d'aucun état serveur, donc ne viole pas l'invariant). Audit des
   surfaces B3 : `VoiceNote` (lecteur pur — zéro mutation serveur) CONFORME ;
   `sendPendingVoice` (toast « envoyée » + bulle uniquement APRÈS
   `uploadVoiceNote` + `apiSendDm` 2xx, spinner pendant le vol) CONFORME.
   **Un cas réel trouvé et corrigé** : `setPendingVoice(null)` était exécuté
   AVANT l'envoi — en cas d'échec (upload ou dm), la preview disparaissait
   comme si la note avait été traitée, l'enregistrement était perdu sans
   retour serveur. Correction : la preview est RESTAURÉE dans le catch
   (l'état UI reflète le résultat réel : échec → rien envoyé, enregistrement
   toujours éditable/envoyable). Invariant : toute mutation UI reflète le
   retour serveur 2xx — y compris l'ÉCHEC qui ne doit pas faire disparaître
   l'objet de la mutation.

### 8.3 Surfaces livrées

| Élément | Fichier | Rôle |
|---|---|---|
| Lib opus | `src/lib/mbote/media/opus.ts` | constantes, sniff conteneurs, validateVoiceForSend (61 s → refus), VoiceRecorder (auto-stop 60 s), computePeaksFromSamples, decodeAndMeasure |
| Client média | `media-client.ts` (+uploadVoiceNote/downloadVoiceNote) | pipeline B2 sans strip ; garde 61 s/10 Mo AVANT tout octet ; sniff à la réception |
| Serveur | `media-server.ts` + `/api/media/upload-url` | whitelist + `audio/opus` (10 Mo, limites PAR TYPE — image reste 5 Mo) |
| UI | `src/components/VoiceNote.tsx` + `MessagesView` | waveform, play/pause, seek par clic, 1x/1.5x/2x, preview annulable, bulle voix |

Payload dm2 voix (plaintext JSON — serveur aveugle) :

```jsonc
{ "kind": "media", "mediaId": "…", "cek": "…", "mediaType": "audio/opus",
  "bytes": 25890, "objectKey": "media/<uuid>", "durationMs": 30240,
  "peaks": [0.42, 0.61, …] }
```

### 8.4 Audit exhaustif Permissions-Policy (clarification direction B4, 2026-11-06)

Le bug `microphone=()` de B3 révèle un problème SYSTÉMIQUE : les policies
historiques étaient copiées du template durci sans révision par cible.
Nuance structurante : **une directive ABSENTE du header n'est pas refusée —
elle retombe sur le défaut navigateur (autorisée en contexte same-origin,
`*` en top-level)**. L'audit porte donc autant sur les directives présentes
que sur les ABSENTES.

| Directive | Valeur actuelle | Utilisé en V1 ? | Valeur cible V1 | Impact futur |
|---|---|---|---|---|
| `camera` | `()` (template durci — BUG B4 latent) | **OUI — B4 vidéo** (getUserMedia vidéo) | `(self)` — **FIX B4 appliqué AVANT le code** (prérequis bloquant) | — |
| `microphone` | `(self)` (fix B3) | OUI — B3 voix, B4 vidéo (piste audio) | `(self)` | — |
| `geolocation` | `()` | NON | `()` | dette : recherche « proximité » mesh envisagée → réviser vers `(self)` LE JOUR de la feature (tracé ici, pas ailleurs) |
| `payment` | `()` | NON | `()` | — |
| `usb` | ABSENTE (= autorisée par défaut) | NON | `()` | fermer le défaut permissif |
| `accelerometer` | ABSENTE | NON | `()` | fingerprinting de mouvement |
| `gyroscope` | ABSENTE | NON | `()` | idem |
| `magnetometer` | ABSENTE | NON | `()` | idem |
| `fullscreen` | ABSENTE (= autorisée) | **OUI — B4** (plein écran vidéo natif) | `(self)` | expliciter la même-origine (l'app n'a pas d'iframe) |
| `display-capture` | ABSENTE | NON | `()` | partage d'écran hors V1 |
| `autoplay` | ABSENTE | NON (lecture toujours après geste utilisateur) | `(self)` | garde : si un jour une preview auto (souris) — aucun autoplay distant possible |
| `clipboard-read` | ABSENTE | NON | `()` | — |
| `clipboard-write` | ABSENTE | NON | `()` | réviser si feature « copier le texte du message » |
| `screen-wake-lock` | ABSENTE | NON | `()` | l'écran allumé pendant l'enregistrement vidéo serait un confort — NON rétenu V1 (non testé), dette UX à évaluer en usage réel |
| `idle-detection` | ABSENTE | NON | `()` | — |
| `bluetooth` | ABSENTE | NON | `()` | le « mesh BLE » de l'app NATIVE ne passe JAMAIS par Web Bluetooth (RN natif) — hors périmètre web à vie |
| `serial` | ABSENTE | NON | `()` | — |
| `midi` | ABSENTE | NON | `()` | — |
| `nfc` | ABSENTE | NON | `()` | — |
| `hid` | ABSENTE | NON | `()` | — |

**Header cible V1 (appliqué en B4, AVANT l'écriture du recorder — directive) :**

```
Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=(self), display-capture=(), autoplay=(self), clipboard-read=(), clipboard-write=(), screen-wake-lock=(), idle-detection=(), bluetooth=(), serial=(), midi=(), nfc=(), hid=()
```

*Note de trace : la directive nommait « §8.3 » — occupé par les surfaces
livrées ; le tableau vit en §8.4, appliqué à l'identique.*

### 8.5 Safari/iOS voice notes — DÉCISION TRANCHÉE (clarification direction B4, 2026-11-06)

**DÉCISION : Option B pour le MVP, Option A jalonnée — les DEUX sont
écrites, rien n'est laissé en suspens.**

- **Option B (retenue MVP — déjà implémentée B3)** : UX différenciée — le
  bouton micro est DÉSACTIVÉ sur Safari + message explicite
  (`VOICE_UNSUPPORTED_MESSAGE`, opus.ts) : « Voice notes disponibles sur
  Chrome/Firefox uniquement ». Acceptable pour le MVP : le navigateur cible
  du déploiement RDC (Chrome Android) supporte Opus nativement.
- **Option A (identifiée + chiffrée + jalonnée)** : fallback WASM
  `@wasm-audio-encoders/opus` (licence MIT, vérifiée) — **estimation 2–3 jp**
  (intégration encodeur + tests Safari réels NON possibles dans le sandbox —
  test manuel requis). Jalon tracé dans SCALE-ARCHITECTURE §8 : **avant
  ouverture publique** (borne dure), même mécanique que la dette RN.

La migration Option B → Option A est purement additive (le mode d'échec
« bouton désactivé » reste la seconde barrière — le sniff conteneur à la
réception refusant tout non-Opus).

---

## 9. Vidéo B4 — upload + lecture, PAS de transcodage V1 (livré)

### 9.1 Prérequis bloquant PROUVÉ (AVANT le code — directive)

- **Permissions-Policy corrigée d'abord** : `camera=(self)` appliqué à
  next.config.ts (audit exhaustif §8.4 — 20 directives, défauts permissifs
  fermés) AVANT toute ligne de code vidéo. Le bug `microphone=()` de B3
  (découvert APRÈS l'écriture) ne se reproduit pas : le prérequis est prouvé
  par `scripts/b4-camera-prereq.ts` — Chromium réel (fake device) :
  getUserMedia({video,audio}) RÉUSSIT → MediaRecorder webm/VP8+opus 10 s →
  515 278 o → thumbnail canvas 320 px (4 179 o) → ffprobe : codec vp8,
  durée 9,96 s. Le header SERVI est vérifié par curl dans le runner
  (H1 du harnais : camera=(self) + microphone=(self) + geolocation=()).
- **Enregistrement réel prouvé** : fixture `tests/fixtures/b4-prereq-10s.webm`
  (fake device Chromium) — la chaîne de tests U1-U5 tourne sur ces octets
  RÉELS, jamais sur des octets synthétiques.

### 9.2 Arbitrages vidéo (tranchés, tracés en code + tests)

1. **Pas de transcodage V1** (directive, à la lettre) : le webm produit par
   MediaRecorder est envoyé TEL QUEL (60 s @ 480p ≈ 5–15 Mo, dans la limite
   100 Mo). Aucun ffmpeg côté serveur — le serveur reste AVEUGLE (chiffré).
2. **Résolution « 480p par défaut (720p si supporté) »** : contrainte
   `getUserMedia({video:{width:{ideal:1280},height:{ideal:720}}})` — le
   navigateur donne la meilleure résolution ≤ 720p que le device supporte
   (webcams modestes → 480p, bonnes caméras → 720p). Bitrate : 1 Mbps fixé
   en entrée, quantification adaptative VP8 en interne ; audio Opus 32 kbps.
3. **Pas de strip EXIF sur la vidéo** : les conteneurs webm/mp4 n'ont pas
   d'EXIF GPS à striper (miroir de l'arbitrage voix §8.2-3). Toute
   métadonnée exotique reste de toute façon CHIFFRÉE et invisible au serveur.
   La THUMBNAIL (JPEG régénéré par canvas côté expéditeur) suit elle le
   chemin image B2 COMPLET avec strip canvas — zéro métadonnée, par
   construction.
4. **« Lecture progressive » TRANCHÉE = téléchargement intégral puis lecture
   locale** : la directive disait « <video src={presignedUrl}> avec
   preload=metadata » — OR l'objet stocké est le CIPHERTEXT E2EE : un player
   pointed sur l'URL présignée lirait du GARBAGE. La vraie lecture progressive
   d'un média E2EE (range requests + démuxage client + MSE) est un chantier
   B5+, pas un réglage. V1 : clic → download-url (TTL 1 h) → GET intégral →
   decrypt → blob → `<video controls preload="metadata">` NATIF. 60 s @ 480p
   ≈ 5–15 Mo : charge en quelques secondes, états visibles (spinner + taille).
   La directive « pas de HLS en V1 » est respectée a fortiori.
5. **Whitelist vidéo : `video/mp4` + `video/webm` — le type déclaré est le
   CONTENEUR RÉEL sniffré** (contrairement à l'opus qui déclarait un type
   canonique unique) : la lecture <video> dépend du conteneur. Rejet
   explicite des autres formats (avi/mov/mkv) → 400 avec message clair
   (« convertissez d'abord ») — testé V2.
6. **Tap-to-start/stop pour la vidéo** (l'inverse de la voix) : la visée
   exige de garder l'œil sur l'écran, pas sur le bouton — hold-to-record
   (voix, §8.2-5) n'a pas de sens caméra ouverte. Documenté MessagesView +
   ce point.
7. **Barrière de rendu vidéo** : sniff du PLAINTEXT à la réception —
   MP4 (ftyp à l'offset 4) ou webm VIDÉO (EBML + ID de codec V_VP8/V_VP9/
   V_AV1 en ASCII dans les 64 premiers Ko). Un webm AUDIO (voice note B3 :
   A_OPUS sans piste V_*) et un MP3 renommé sont REFUSÉS (magic-bytes-
   mismatch) — miroir strict de §6.7-iii, testé V6. Le type déclaré doit
   EN OUTRE correspondre au conteneur sniffré (divergence = client cassé
   ou altération → refus).
8. **TTL de lecture vidéo = 1 h** (directive) : `B2_VIDEO_DOWNLOAD_TTL_S =
   3600` appliqué par TYPE dans /api/media/download-url (video/* → 3600,
   le reste garde 900 s). Testé V4 (vidéo > 3500 s, image ≤ 900 s).
9. **Thumbnail optionnelle à l'envoi** : si la capture canvas échoue
   (harness, metadata en attente), la vidéo reste ENVOYABLE — la bulle
   retombe sur le placeholder player (Film). La perte de vignette n'est
   jamais une erreur d'envoi.
10. **Limite PAR TYPE : vidéo 100 Mo** (directive) — `B2_UPLOAD_LIMITS
    ["video/mp4" | "video/webm"] = 100 Mo` ; garde client miroir
    (validateVideoForSend, 110 Mo → REFUS avant tout octet) ; serveur 400
    testé (V3).

### 9.3 Surfaces livrées

| Élément | Fichier | Rôle |
|---|---|---|
| Prérequis caméra | `scripts/b4-camera-prereq.ts` | getUserMedia + MediaRecorder + thumbnail + ffprobe — BLOQUANT, avant le code |
| Lib vidéo | `src/lib/mbote/media/video.ts` | constantes (60 s, 100 Mo, 320 px), sniff MP4/webm-vidéo (rejette webm audio), validateVideoForSend (61 s), captureVideoThumbnail, VideoRecorder (auto-stop 60 s, tap-to-stop) |
| Client média | `media-client.ts` (+uploadVideoNote/downloadVideoNote) | pipeline B2 sans strip vidéo ; thumb = chemin image B2 complet ; garde 61 s/100 Mo AVANT tout octet |
| Serveur | `media-server.ts` + upload-url + download-url | whitelist video/mp4+webm (100 Mo, limites PAR TYPE), TTL lecture 1 h pour video/* |
| UI | `src/components/VideoBubble.tsx` + `MessagesView` | vignette cliquable → Dialog plein écran player natif, badge durée, états de téléchargement ; bouton 📹 tap-to-start/stop + preview annulable |

Payload dm2 vidéo (plaintext JSON — serveur aveugle) :

```jsonc
{ "kind": "media", "mediaId": "…", "cek": "…", "mediaType": "video/webm",
  "bytes": 515278, "objectKey": "media/<uuid>", "durationMs": 9960,
  "width": 640, "height": 480,
  "thumb": { "mediaId": "…", "cek": "…", "mediaType": "image/jpeg",
             "bytes": 4200, "objectKey": "media/<uuid>" } }
```

### 9.4 NON TESTÉ (explicite)

- **Transcodage** : AUCUN en V1 (arbitrage §9.2-1) — rien à tester.
- **HLS** : V1 = MP4/WebM direct (arbitrage §9.2-4).
- **Dette streaming chiffré — TRANCHÉE 2026-11-06 (clarification direction
  Étape 9+C1)** : la lecture progressive full-blob (§9.2-4) livre la vidéo
  entière avant le premier rendu — acceptable pour des clips ≤ 60 s, pas pour
  des durées longues. La vraie lecture progressive nécessite **HLS chiffré
  segment par segment** (AES-128 par segment via CEK dédiée, manifest
  protégé — compatible E2EE : chaque segment est chiffré côté client avant
  upload, le serveur reste aveugle). Estimation **3–4 jp supplémentaires**.
  **Bloquant pour ouverture publique si la vidéo devient un usage courant** —
  à programmer en **B5+**. Ne pas laisser « full-blob » sans cette trace : la
  dette est assumée, datée et jalonnée (référence croisée SCALE-ARCHITECTURE §8).
- **Vidéo > 60 s** : refusée par construction (auto-stop + garde 61 s) — le
  comportement d'UX au-delà (message, découpage) est hors V1.
- **Mesh BLE** : la vidéo est IMPOSSIBLE par conception sur BLE (budget octets
  du canal mesh) — hors périmètre web, câblé pour Wi-Fi/données uniquement.
- **Migration RN** : dette tracée §8 SCALE-ARCHITECTURE (bloc 8–12 jp).
- **Safari iOS** : MediaRecorder vidéo MP4 (H.264) Y figure via le fallback
  `video/mp4` — mais NON TESTÉ (pas de Safari dans le sandbox) : test manuel
  requis avant ouverture (même jalon que la voix §8.5).
- **Charge réelle** : bench = 10 s réel + 30/60 s par blocs (chaîne mesurée à
  la taille cible, pas le codec — honnêteté documentée §benchmark).
