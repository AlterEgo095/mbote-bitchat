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
