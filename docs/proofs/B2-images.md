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

## 2. LIVRABLES B2 (upload-url / finalize / client / UI)

> ← SECTION RÉSERVÉE À L'IMPLÉMENTATION B2 (remplie après livraison) —
> structure attendue : endpoint `/api/media/upload-url` (auth session
> dm2, whitelist image/jpeg|png|webp, ≤ 5 Mo, quota, rate limit 20/h),
> `/api/media/finalize` (existence + taille + magic bytes anti-spoof),
> client `src/lib/mbote/media-client.ts` (uploadImage/downloadImage,
> queue offline), UI minimale conversation, tests, benchmark 100 Ko /
> 1 Mo / 5 Mo, captures navigateur (credentials masqués),
> runner `scripts/b2-images-proof-run.sh`, NON TESTÉ (charge 100 uploads
> simultanés, migration médias existants, antivirus scan).

## 3. NON TESTÉ (reporté — directive B2)

- MinIO réel (docker absent — compose prêt pour rejeu VPS ; SeaweedFS
  garantit déjà une validation tierce complète, §1.1).
- Charge réelle (100 uploads simultanés) — hors périmètre B2.
- Migration de médias existants — aucun (socle neuf).
- Antivirus scan (ClamAV ou équivalent) — à ajouter avant ouverture
  publique (directive : « pas de MIME spoofing » couvert par magic bytes
  à finalize, pas par un AV).
