# PREUVES B1 — Socle média (enveloppe chiffrée, strip EXIF, stockage présigné)

**Date** : 2026-11-06 · **Branche** : `feat/b1-media-foundation` (depuis `main`) ·
**Worktree** : `/home/z/wt-b1` (discipline worktree externe — DEV-SETUP §2)
**Directive** : socle uniquement, **aucune route API activée** — dev en branche,
rien ne déploie (séquence ADM → B1, jamais l'inverse).

## 0. VERDICT

**SOCLE B1 LIVRÉ ET PROUVÉ.** 35/35 tests (1 109 expect) + 2 skip (MinIO :
docker absent du sandbox — NON TESTÉ documenté, compose + test rejouables
fournis). Couverture des nouveaux fichiers : **98,48 % lignes / 96,67 % fonc**
(cible ≥ 80 %). Benchmark RÉEL 1/10/100 Mo (chiffres, pas estimations).
Régression globale branche : 64 pass / 0 fail.

## 1. CE QUI EST LIVRÉ (fichier : ligne)

| Élément | Fichier | Ancrage |
|---|---|---|
| **SPEC** enveloppe + CEK/IV + dm2 + présignés + EXIF + limites | `docs/MEDIA-ENVELOPE-SPEC.md` | v1, 6 arbitrages §6 |
| Enveloppe `v1:iv:ciphertext:tag` — AES-256-GCM, CEK 32 o/objet, IV 12 o unique | `src/lib/mbote/media/crypto.ts` | `encryptMedia` :120, `decryptMedia` :137 |
| **Garde anti-réutilisation d'IV** (LRU process-wide 10 000) — refus explicite | id. | `registerIv` :63, erreur `iv-reused` |
| Parse strict (préfixe, segments, longueurs) → erreurs typées, jamais de crash | id. | `b64urlToBytes` :130 |
| `stripExif` — GPS/dates/appareil/thumbnail/ICC supprimés, **orientation CUITE** | `src/lib/mbote/media/exif.ts` | `stripExif` :64 |
| Garde taille ≤ originale + limite 5 Mo avant sharp (DoS guard) | id. | :85, :36 |
| SigV4 présignature **zéro dépendance** (node:crypto) — PUT/GET, TTL 15 min défaut, Content-Length signé | `src/lib/mbote/media/storage.ts` | `generatePresignedUrl` :170 |
| `verifyPresignedUrl` — re-calcul timing-safe + expiration (tests + route B2) | id. | :249 |
| Limites par type (5/10/100 Mo) + whitelist clés `media/<uuid>` sans identité | id. | `MEDIA_LIMITS` :50, `assertObjectKey` :90 |
| Tests (35) | `tests/media-foundation.test.ts` | A crypto · B altération · C IV · D EXIF · E présignés · F limites |
| Test MinIO (skippé sans docker) + compose | `tests/media-minio-integration.test.ts`, `deploy/docker-compose.minio.yml` | skip propre + message |
| Benchmark rejouable | `scripts/b1-media-bench.ts` | 1/10/100 Mo, médiane + p95 |
| Fixture EXIF+GPS+orientation 6 (assemblée à la main, vérifiée sharp) | `tests/fixtures/media-gps-sample.jpg`, `scripts/b1-make-gps-fixture.ts` | 517 o, orientation 6 |

**Aucune dépendance ajoutée** : sharp était déjà présent (^0.34.3) ; SigV4 est
écrit sur `node:crypto` (arbitrage spec §6.2 — pas d'`@aws-sdk/*`).

## 2. TESTS — `bun test tests/media-foundation.test.ts` : **35 pass / 0 fail**
(1 109 expect — sortie complète dans le journal de session ; rejouable :
`bun test tests/media-foundation.test.ts`)

- **A — round-trip** : 10 Ko / 1 Mo / **5 Mo** → octets IDENTIQUES ; format
  `v1:iv:ciphertext:tag` vérifié (4 segments, IV 12 o, tag 16 o, base64url
  sans `+/=`) ; CEK 32 o distincts par appel ; mauvais CEK → `auth-failed`.
- **B — altération** (directive : « échoue proprement, pas de crash ») :
  ciphertext / tag / IV altérés → `MediaCryptoError("auth-failed")` TOUJOURS ;
  8 enveloppes malformées (préfixe, 3 segments, 5 segments, IV court, tag
  court, vide, string quelconque, vide) → `bad-envelope` ; CEK court →
  `bad-cek` (chiffrement ET déchiffrement).
- **C — IV réutilisé → refus explicite** : même IV deux fois →
  `MediaCryptoError("iv-reused")` (garde porte sur l'IV, même à travers des
  CEKs différents) ; **1 000 scellés aléatoires → 1 000 IV distincts**.
- **D — strip EXIF** (directive : « GPS absent, taille post-strip ≤ ») :
  fixture GPS → `metadata().exif` ABSENT après strip (IFD GPS complet, dates,
  appareil) ; **orientation 6 → dimensions 3×4 en sortie** (tranchage spec
  §5.2 : cuite dans les pixels, PAS conservée comme métadonnée —
  `orientation` aussi absente des métadonnées finales) ; taille post-strip ≤
  originale (fixture GPS ET image photo-like 1200×800) ; PNG OK ; non-image →
  `bad-image` ; > 5 Mo → `too-large` AVANT sharp.
- **E — URLs présignées** (directive : « TTL respecté, méthode respectée, URL
  expirée → refus ») : TTL par défaut **900 s = 15 min** ; verify fraîche → ok
  + objectKey round-trip ; **expirée (+900 s + 1 s) → `expired`** ; encore
  valide à 900 s exactement → ok ; URL PUT vérifiée en GET → refus (signed
  headers ≠) ; signature flip → `bad-signature` ; objectKey altéré dans le
  chemin → `bad-signature` ; TTL borné 60…3600 ; PUT sans `contentLength` →
  refus (taille imposée) ; driver `r2` OK ; config env manquante →
  `not-configured`.
- **F — limites** : image 5 Mo / audio 10 Mo / vidéo 100 Mo (directive) ;
  dépassement → `too-large` ; `image/gif` hors whitelist → `bad-media-type` ;
  clés : uuid v4 OK, `media/../secret`, `users/…`, non-uuid → refus ;
  `newObjectKey` sans identité utilisateur.

**Couverture (bun test --coverage)** :

```
File                            | % Funcs | % Lines
All files                       |   96.67 |   98.48
 src/lib/mbote/media/crypto.ts  |   90.00 |   95.45   (lignes 168-171 : branche
 src/lib/mbote/media/exif.ts    |   100.00 |  100.00    « CSPRNG suspect » — non
 src/lib/mbote/media/storage.ts |   100.00 |  100.00    testable déterministement)
```

## 3. BENCHMARK — chiffres RÉELS (médiane + p95, machine sandbox ;
artifact `assets/b1-benchmark.json`, rejouable : `bun scripts/b1-media-bench.ts`)

| Taille | runs | encrypt médiane | encrypt p95 | decrypt médiane | decrypt p95 | débit (e/d) |
|---|---|---|---|---|---|---|
| 1 Mo | 30 | **1,05 ms** | 2,77 ms | 4,35 ms | 6,22 ms | 952 / 230 Mo/s |
| 10 Mo | 15 | **10,28 ms** | 17,34 ms | 46,19 ms | 62,12 ms | 973 / 217 Mo/s |
| 100 Mo | 5 | **118,58 ms** | 178,35 ms | 571,55 ms | 629,90 ms | 843 / 175 Mo/s |

- Entrée = bruit pseudo-aléatoire (worst case crypto, pas de zéros
  compressibles) ; warmup JIT hors compte ; intégrité vérifiée après bench.
- Lecture : AES-256-GCM matériel (AES-NI) → ~0,85–1 Go/s en chiffrement ;
  5 Mo = ~6 ms median → sans impact sur l'UX chat ; 100 Mo vidéo = ~0,7 s
  (acceptable pour la limite supérieure).

## 4. MINIO LOCAL — NON EXÉCUTABLE DANS LE SANDBOX (transparence)

`docker version` échoue : **pas de docker dans le sandbox** — le test
d'intégration est SKIPPÉ (message explicite, `describe.skipIf`). Livré
rejouable tel quel (directive : « upload → check → delete ») :

```bash
docker compose -f deploy/docker-compose.minio.yml up -d
bun test tests/media-minio-integration.test.ts
# → presign PUT → HTTP PUT réel → presign GET → HTTP GET réel → octets
#   identiques → déchiffrement → mc rm (delete) → GET → 404
```

NON TESTÉ (à documenter — attendu) :
- **R2/B2 réel** — MinIO en local uniquement (directive B1 : NON TESTÉ assumé) ;
- **E2E avec device réel** (B2) ;
- **Quota 500 Mo/compte en charge** (B3+) — le socle livre les limites par
  type et les erreurs typées ; le quota par compte est une règle de la couche
  upload (B2) ;
- **intégration MinIO exécutée** (docker absent — ci-dessus) ;
- **AAD objectKey sur l'enveloppe** (hardening B2 — arbitrage spec §6.1).

## 5. INCIDENTS PENDANT L'ÉTAPE (transparence — tous résolus)

1. **Double enregistrement dans la garde IV** : `freshIv()` enregistrait l'IV
   PUIS `sealWithIv()` le ré-enregistrait → la garde se refusait elle-même au
   2ᵉ chiffrement. Corrigé : point d'enregistrement UNIQUE (`sealWithIv`),
   `freshIv()` ne fait que produire un IV absent de la registry. Attrapé par
   les tests (5 échecs rouges avant correction) — la garde fonctionne, elle
   refusait juste trop.
2. **Fixture EXIF** (assemblage TIFF à la main) : count d'IFD non écrit
   (entrées décalées de 2 o) → sharp lisait l'EXIF mais pas l'orientation ;
   entrées non triées par tag (TIFF strict). Corrigé (layout `u16 count |
   n×12 | u32 next` + tri) — le générateur vérifie lui-même son output
   (échec si sharp ne lit pas orientation 6 + pointeur GPS).
3. **Test floconneux** « signature altérée » : flip de hex conditionnel (1/16
   de no-op). Corrigé : flip déterministe + garde `expect(evil).not.toBe(url)`.
4. **Lint** : `admin/.next/build` scanné (branche B1 depuis `main` qui n'a pas
   l'ignore `admin/**` ajouté par ADM) → même liste d'ignores que la branche
   ADM (merge trivial à venir).

## 6. DISCIPLINE

- Worktree EXTERNE `/home/z/wt-b1`, branche `feat/b1-media-foundation` créée
  depuis `main` (arbitrage spec §6.6 : le socle média ne dépend d'aucun code
  ADM — zéro conflit, déploiement ordonné ADM → B1).
- La SEULE commande git dans le repo principal : la création du worktree
  (`git -C /home/z/my-project worktree add -b feat/b1-media-foundation
  /home/z/wt-b1 main`). Tout le reste : `git -C /home/z/wt-b1 …`.
- **Aucune route API activée** (directive) — le socle est une bibliothèque
  testée, pas un endpoint. Aucun déploiement, aucun push.
- Lint vert (`bun run lint`), régression globale 64 pass / 0 fail / 2 skip.
- Une livraison = commits propres sur la branche B1, preuves incluses.

## 7. PROCHAINE ÉTAPE

- **ADM Étapes 6–10** (queue UI, users, audit, four-eyes — alternance
  wt-adm/wt-b1 selon la directive) ;
- **B2** (à la demande) : routes upload/download + CEK wrappé ECDH + AAD +
  intégration device réel.
