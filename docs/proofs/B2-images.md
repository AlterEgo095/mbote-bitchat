# PREUVES B2 — IMAGES (upload présigné → finalize → lecture décryptée)

**Date** : 2026-11-06 · **Branche** : `feat/b1-media-foundation` (B2 = première
activation du socle B1) · **Worktree** : `/home/z/wt-b1`
**Directive** : « B2 ne démarre pas sans test réel — les presigned URLs
n'ont jamais parlé à un vrai S3. »

## 1. PRÉREQUIS BLOQUANT — SigV4 B1 contre un S3 RÉEL indépendant ✅ LEVIÉ

### 1.1 Arbitrage serveur (tranché, § directive « à toi de choisir »)

| Option | Verdict | Fait |
|---|---|---|
| (a) MinIO local docker | **IMPOSSIBLE** : docker absent du sandbox | constat |
| (a) MinIO binaire | **IMPOSSIBLE** : `dl.min.io` bloqué (HTTP 410 sur tous les chemins) et AUCUN binaire publié sur GitHub releases (404) | constat |
| (b) R2/B2 réel | **IMPOSSIBLE** : credentials opérateur indisponibles (aucun compte) | constat |
| s3rver 3.7.1 | **ÉCARTÉ** : sa source dit `// Signature version 4 calculation is unimplemented` (`lib/middleware/authentication.js`) — il n'aurait PAS validé nos signatures (tests | preuve lecture du code |
| **SeaweedFS 3.80 (weed)** | **RETENU** : serveur S3 indépendant, validation SigV4 **COMPLÈTE** (`weed/s3api/auth_signature_v4.go` — signature re-calculée, expiration appliquée GET **et** PUT, access key vérifiée) | testé §1.3 |

Le compose MinIO (`deploy/docker-compose.minio.yml`) reste la voie de rejeu
sur VPS/dev local ; le test `tests/media-minio-integration.test.ts` (skip sans
docker) est inchangé. Risque résiduel assumé et documenté : MinIO/R2 peuvent
avoir des quirks que SeaweedFS n'a pas — la chaîne SigV4 testée est toutefois
la spécification AWS elle-même, validée par un TIERC.

### 1.2 Infrastructure de preuve (rejouable, une commande)

- **Runner** : `bash scripts/b2-s3-real-proof-run.sh` — télécharge `weed` 3.80
  si absent (binaire épinglé, sha256 `b8eec95b…ed76f` vérifié), démarre en
  phase ANONYME, crée le bucket, injecte les credentials jetables
  (`-s3.config`), redémarre AUTHENTIFIÉ (une requête non signée → 403 prouve
  que l'auth est active), lance les tests, capture les sorties.
- **Tests** : `tests/media-real-s3.test.ts` — G1…G6 (gate module-level
  `MEDIA_REAL_S3=1`, sinon skip propre — jamais de faux rouge).

### 1.3 Résultats — 4 pass / 0 fail (artifact `assets/b2-s3-real-test-output.txt`)

| # | Scénario (directive B2) | Résultat |
|---|---|---|
| G1 | Upload via code B1 (`generatePresignedUrl` + HTTP PUT) | **200** |
| G2 | Le fichier existe dans le bucket | GET 200 taille exacte ; clé absente → 404 |
| G3 | URL GET présignée → téléchargement → intégrité | SHA-256 identique (2 Mio aléatoires) |
| G4 | Contrôle de réalité : signature FALSIFIÉE | **403** — le serveur S3 valide VRAIMENT SigV4 |
| G5 | Flux B1 complet : stripExif → CEK → PUT → GET → décryptage | hash identique avant/après |
| G6 | TTL court (60 s) + attente 61 s réelle | GET **403** `Request has expired` · PUT **403** · objet NON écrit (GET frais → 404) |

Sortie scriptée complémentaire : `assets/b2-s3-real-smoke-output.txt`
(PUT 200 · GET 200 sha256 match · falsifié 403 · expirés 403/403).

**Le SigV4 maison B1 parle correctement à un serveur S3 indépendant — B2
démarre sur du roc, pas sur du sable.**

### 1.4 Incident de preuve (transparence — faux défaut, résolu)

Le premier run du scénario scripté a montré « PUT expiré → 200 ACCEPTÉ »
(soupçon de défaut SeaweedFS sur l'expiration des PUT). Investigation :
la source Go prouve que l'expiration s'applique aux DEUX méthodes
(`doesPresignedSignatureMatch` — sans branche GET/PUT). Repro ciblée → 403.
Cause réelle : **mon script** présignait le PUT d'expiration SANS `ttlSec`
→ TTL par défaut 900 s → à 61 s il était encore valide → 200 CORRECT.
Corrigé (`ttlSec: 60`), re-runs → 403/403 constants. Leçon : accuser le
serveur avant d'avoir relu ses propres paramètres = non. (Le contrôle
« signature falsifiée → 403 » (G4) a été ajouté pour prouver que la
validation tierce est réelle, pas décorative.)

## 2. LIVRABLES B2 — RÉALISÉS ET PROUVÉS (runner exit 0, 2026-11-06)

### 2.1 Ce qui tourne (branche `feat/b1-media-foundation` — B2 = 1re activation B1)

| Livrable | Fichier | État |
|---|---|---|
| POST `/api/media/upload-url` | `src/app/api/media/upload-url/route.ts` | whitelist jpeg/png/webp · ≤ 5 Mo · quota 500 Mo finalisés · rate 20/h/clé + 120/h/IP · preuve `${me}\|media-upload\|…` 15 min · Media `pending` · presigned PUT ttl 900 s **content-length signé** |
| POST `/api/media/finalize` | `src/app/api/media/finalize/route.ts` | existence bucket réelle (presigned GET serveur→S3) + taille = Content-Length signé (422) + enveloppe v1 structurelle via `inspectEnvelope` (422) + fenêtre 20 min (410) → `finalized` |
| GET `/api/media/download-url` | `src/app/api/media/download-url/route.ts` | preuve 15 min, media finalized seul, presigned GET 15 min (arbitrage §6.8) |
| Relay média même-origine | `src/app/api/media/proxy/[...path]/route.ts` + rewrite `/media-proxy/:bucket/media/:key*` (next.config.ts) | relay AVEUGLE PUT/GET : whitelist bucket + uuid v4, body ≤ 6 Mo, header HOST d'origine transmis (la signature SigV4 couvre le host reçu — SeaweedFS re-calcule → match). AUCUN credential ajouté : la validation reste celle du S3 |
| Client | `src/lib/mbote/media-client.ts` | `encryptBytes`/`decryptBytes` (WebCrypto, enveloppe v1 IDENTIQUE au socle — interop testée), garde IV de session, `sniffImageType` + `assertRenderableImage` (magic bytes §6.7-iii), `stripExifClient` (canvas, orientation cuite), `uploadImage` orchestré (5 étapes observables), `downloadImage`, `sessionCekFor`, `MediaUploadQueue` mémoire + `flushUploadQueue` (re-orchestration au retour réseau) |
| UI minimale | `src/components/mbote/MessagesView.tsx` | bouton 📎 → picker (sr-only) → preview (nom/taille, annulable) → bandeau d'étapes → dm2 média (CEK dans le canal E2EE §7.3) → bulle vignette lazy (download→decrypt→sniff→Blob) → Dialog plein écran ; file hors-ligne reprise au retour `online` |

### 2.2 Harnais — 15 pass / 0 fail (`assets/b2-images-test-output.txt`, gate `MEDIA_B2_E2E=1`)

| # | Scénario (directive B2) | Résultat |
|---|---|---|
| U1 | Chaîne COMPLÈTE : stripExif(sharp injecté) → encryptBytes (WebCrypto) → upload-url → PUT via proxy → finalize → download-url → GET → decrypt : SHA-256 du plaintext = round-trip exact, TTL presign 900 s ±5 | **pass** |
| U2 | EXIF absent APRÈS le voyage complet : la fixture GPS → `inspectMetadata` après decrypt : exif vide (GPS mort) | **pass** (dans U1) |
| U3 | Interop format : `decryptMedia` socle B1 (node:crypto) lit EXACTEMENT une enveloppe `encryptBytes` client (WebCrypto) | **pass** |
| U4 | **2 appareils simulés** : A (ECDSA+ECDH) upload + scelle le dm2 média (CEK dans le canal E2EE) → serveur → B lit SA boîte (preuve dm-read), déchiffre le dm2 avec SA clé ECDH, obtient mediaId+CEK, présume sa lecture (SA preuve media-dl), decrypt, sniff : SHA-256 identique inter-appareils | **pass** |
| R1 | application/pdf → 400 « hors whitelist » | **pass** |
| R2 | 6 Mo → 400 | **pass** |
| R3 | Preuve signée par une AUTRE clé → 401 | **pass** |
| R4 | 21e upload de l'heure → 429 (20/h) | **pass** |
| R5 | Quota : 501 Mo finalized (lignes DB synthétiques) → 429 « Quota » | **pass** |
| R6 | finalize SANS PUT → 400 « objet absent du bucket » | **pass** |
| R7 | Enveloppe garbage (taille exacte signée) → finalize 422 | **pass** |
| R8 | Fenêtre finalize > 20 min (DB horizon −21 min) → 410 | **pass** |
| R9 | **MIME SPOOFING E2E** : PDF chiffré déclaré image/jpeg → PUT 200 + finalize 200 (serveur aveugle, assumé §6.7) → destinataire : decrypt OK puis `assertRenderableImage` → **`magic-bytes-mismatch` — rendu REFUSÉ** | **pass** |
| R10 | download-url sans preuve → 401 · média inconnu → 404 | **pass** |
| R11 | File hors-ligne : flush rejoue (re-strip/re-chiffre/re-signe) → upload réussi + dequeue ; item pdf → `failed` + lastError | **pass** |
| P1 | Proxy : routes API NON captées par le rewrite (préfixe `/media-proxy/` dédié) ; bucket fantôme → 404 ; traversée de chemin → refus | **pass** |

### 2.3 Benchmark E2E (`assets/b2-images-bench.txt`, sandbox — la chaîne COMPLÈTE incluant strip/shiffrement/presign/PUT/finalize/lecture/decrypt/sniff)

| taille réelle | chiffrement | presign | PUT | finalize | lecture | decrypt | TOTAL |
|---|---|---|---|---|---|---|---|
| 164 Ko | 8 ms | 6 ms | 12 ms | 10 ms | 14 ms | 19 ms | **71 ms** |
| 1778 Ko | 56 ms | 69 ms | 10 ms | 51 ms | 33 ms | 114 ms | **347 ms** |
| 5042 Ko | 116 ms | 138 ms | 9 ms | 112 ms | 59 ms | 221 ms | **676 ms** |

### 2.4 Preuve navigateur (`assets/b2-images-*.png`, headless Chromium, build standalone :3103 + weed :9100)

- `b2-images-preview.png` : dialog preview (nom + taille, « Chiffrer et envoyer »).
- `b2-images-sent-thumbnail.png` : toast **« Image envoyée · Chiffrée (AES-256-GCM) · 760 o · EXIF nettoyé »**, conversation A→B avec badge **E2E actif**, bulle média envoyée (vignette déchiffrée).
- `b2-images-full-view.png` : Dialog plein écran **« Image chiffrée · 760 o · image/jpeg — Déchiffrée localement (AES-256-GCM) — magic bytes vérifiés avant rendu »**.
- `b2-images-db.txt` : Media finalized + dm2 en DB.
- Le pair destinataire est publié par `scripts/b2-publish-peer.ts` (ECDSA+ECDH réels, preuve identity) — le dm2 part réellement sur le serveur.

### 2.5 Bugs découverts PENDANT la preuve navigateur (et corrigés — transparence)

1. **`decryptBytes` (WebCrypto) avalait le tag** : `subtle.decrypt` attend
   ciphertext‖tag CONCATÉNÉS ; l'enveloppe v1 les sépare — le ré-assemblage
   manquait → tout decrypt client échouait (`auth-failed`) alors que le socle
   B1 (node:crypto) lisait la même enveloppe. Corrigé (ré-assemblage) ; les
   tests U1/U4/R9 le couvrent des deux côtés.
2. **Le Dialog « Nouvelle conversation » était mort depuis l'état vide**
   (bug PRÉEXISTANT, découvert par le parcours UI) : le JSX du Dialog
   n'existait que dans le return principal — l'état vide (early return) le
   rendait jamais : `setNewConvOpen(true)` montait le state sans rendu
   (`convOpen: true`, zéro portal — constat instrumenté). Corrigé : Dialog
   extrait en variable partagée par les deux returns.
3. **Invariant « post-strip ≤ original » irréalisable pour micro-images**
   via canvas : un JPEG 4×3 px (517 o) ré-encodé → 760 o (headers + Huffman
   recalculés). Arbitrage §7.2 : l'invariant s'applique aux images ≥ 32 Ko ;
   dessous, la taille peut croître (privacy intégrale, serveur borne le
   ciphertext).
4. **Le proxy même-origine est OBLIGATOIRE** : CSP `connect-src 'self'` +
   pas de preflight CORS sur MinIO/SeaweedFS → les presigned URLs sont
   signées pour l'origine PUBLIQUE et relayées par `/media-proxy/…`
   (whitelist, HOST transmis). Le rewrite `/:bucket/media/:key*` initial
   captait `/api/media/*` (bucket=api) — préfixe dédié tranché.
5. **Le standalone Next doit copier `.next/static` + `public/`** — sans
   quoi 404 sur tous les chunks → jamais d'hydratation (capture noire,
   skeletons figés). Le runner le fait (comme le runbook de déploiement).

## 3. NON TESTÉ (reporté — directive B2)

- MinIO réel (docker absent — compose prêt pour rejeu VPS ; SeaweedFS
  garantit déjà une validation tierce complète, §1.1).
- Charge réelle (100 uploads simultanés) — hors périmètre B2.
- Migration de médias existants — aucun (socle neuf).
- Antivirus scan (ClamAV ou équivalent) — à ajouter avant ouverture
  publique (directive : « pas de MIME spoofing » couvert par magic bytes
  à finalize, pas par un AV).
- Client mobile RN (`mobile/`) — arbitrage §6.9 : le socle client
  (`media-client.ts`, TS pur) est réutilisable tel quel, mais le strip
  EXIF RN exige expo-image-manipulator et le harness mobile n'est pas
  exécutable dans ce sandbox → extension B3 (un code natif non prouvé
  serait une preuve fantôme).
- Fermeture d'onglet pendant un upload en file — les octets sont en
  mémoire de session (arbitrage §7.2) : perte assumée MVP, UX à définir
  en B3 (persist du plaintext refusée pour raisons de sécurité).
- R2 en prod R2 (presignature host R2 direct + CORS bucket) — la voie
  est implémentée (`MEDIA_S3_PUBLIC_ENDPOINT`) mais non exécutable ici
  (credentials opérateur indisponibles, §1.1).
