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
