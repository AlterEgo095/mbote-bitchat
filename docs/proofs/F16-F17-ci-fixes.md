# F-16/F-17 — Réparation CI feat/mbote-v1 (rapport de vague)

> **Date** : vague F-16/F-17 (après push 0d3309e, vague E 9fb798e incluse).
> **Périmètre** : 3 échecs CI signalés par l'opérateur → faire passer
> `tests.yml` et `weekly-proof-run.yml` au vert sur feat/mbote-v1.
> **Rappel protocole** : token GitHub révoqué → **aucun push de cette session**.
> Sorties locales = simulation P4 ; validation CI live = push opérateur.

---

## 1. Verdict

| Item | État |
| --- | --- |
| F-16a (tests.yml — S2/S3 « db boot pragmas ») | ✅ corrigé, cause réelle prouvée, preuve locale vert |
| F-16b (tests.yml — B1 MinIO) | ✅ corrigé, skip documenté prouvé (local + `CI=true`) ; B1 réel avec docker = NON TESTÉ (sandbox sans docker) |
| F-17 (weekly — D1 « 2. build standalone » exit 1) | ✅ corrigé, cause réelle prouvée (TS2345), D1 e2e local EXIT 0 |
| Suite complète locale (P4 simule tests.yml) | ✅ **225 pass / 231 skip / 0 fail** + parité OK + `tsc --noEmit` 0 + lint 0 |
| Runs GitHub réels | ⏳ **en attente du push opérateur** (token révoqué — sorties locales servent de preuve P4, §7 DEV-SETUP) |

**Verdict global : ✅ SUCCESS côté local — ⚠️ PARTIEL tant que la CI live n'a
pas confirmé après push opérateur.** Aucun des 3 symptômes n'est reproductible
localement après fix (mêmes commandes, état frais).

---

## 2. Tableau récapitulatif — cause réelle ≠ hypothèse initiale

| # | Workflow / step | Symptôme signalé | Hypothèse initiale opérateur | **Cause réelle (prouvée par reproduction)** | Fix |
| --- | --- | --- | --- | --- | --- |
| F-16a | tests.yml / `bun test` | S2/S3 « db boot pragmas » échouent sur runner | FS runner (ext4 éphémère) avec comportements WAL différents | `db/` **gitignoré** (`/db/`, `*.db`) → ABSENT d'un checkout frais ; Prisma crée le FICHIER SQLite mais jamais les répertoires parents → **SQLITE_CANTOPEN (errno 14)**. La sonde `DATABASE_URL` de tests.yml résout `file:./db/ci-test.db` **par rapport au schéma** → crée `prisma/db/ci-test.db`, pas `./db/` (prouvé par sonde locale) | `mkdirSync(TMP, { recursive: true })` dans `tests/db-boot-pragma.test.ts` (même pattern que `admin-dashboard-e2e.test.ts`, vague précédente). **Pas de skip FS-dynamique** — rejeté, il masquerait un échec de boot réel (§4b DEV-SETUP) |
| F-16b | tests.yml / `bun test` | B1 · G MinIO échoue sans MinIO sur runner | « le runner GitHub n'a pas de docker daemon » | **ubuntu-latest POSSÈDE docker** — le garde historique `docker version` ne skippait donc PAS en CI ; le `beforeAll` tentait `docker compose -f deploy/docker-compose.minio.yml up -d` (pull Docker Hub non garanti sur runner éphémère, pile non provisionnée) → FAIL | Gate « pile utilisable » : `MEDIA_S3_ENDPOINT` externe **OU** (docker + compose du repo + **hors CI hébergée**) ; sinon `describe.skipIf` + message documenté. En CI : provisionner `MEDIA_S3_ENDPOINT` pour activer |
| F-17 | weekly-proof-run.yml / D1 « 2. build standalone » exit 1 | échec silencieux, C2/C3/C4 skippés en cascade | `NEXT_TELEMETRY_DISABLED` / cache / dépendance absente | **TS2345 dans `scripts/axe-audit.ts:82`** (livré vague E 9fb798e) : `nodes: unknown[]` rendait le callback `.map` contravariant-incompatible → `next build` « Failed to type check » → exit 1. Invisible dans tests.yml (le step `bun test` échouait AVANT le typecheck) et silencieux dans weekly (build redirigé vers `/tmp/d1-build.log` jamais affiché) | Type `AxeNode` correct dans le cast + **instrumentation jamais-silencieuse** des builds des 7 proof-runs (D1·D2·D3·C2·C3·C4·hardening — hardening l'avait déjà) : `|| { say "build ÉCHOUÉ…" ; tail -40 /tmp/X-build.log ; exit 1 ; }` |

Leçon transversale (tracée §8 DEV-SETUP) : toute vague qui livre des fichiers
`.ts` doit rejouer `bunx tsc --noEmit` **et** un `bun run build` complet avant
commit — le harnais `bun scripts/axe-audit.ts` (exécution sans typecheck) ne
les remplace pas.

---

## 3. Preuves F-16a (S2/S3)

### 3.1 Reproduction (état runner simulé : `rm -rf db`)

```
$ rm -rf db && bun test tests/db-boot-pragma.test.ts
(fail) db boot pragmas (Clarification 1) > S2 — happy path : DB fraîche → WAL posé et persistant [4.32ms]
      PrismaClient … handleRequestError … (Error code 14: Unable to open the database file)
(fail) db boot pragmas (Clarification 1) > S3 — DB verrouillée EXCLUSIVE par un PROCESS TIERS … [0.64ms]
      SQLiteError: unable to open database file
      errno: 14, code: "SQLITE_CANTOPEN"
  2 pass / 2 fail
```

Suite complète sans `db/` (= état checkout frais) : **220 pass / 231 skip /
3 fail** (S2, S3, + break-glass-tx — ce dernier échouait ici uniquement à
cause du piège du `DATABASE_URL` global du sandbox pointant hors worktree,
DEV-SETUP §2a ; en CI il passe car `db push` crée `prisma/db/ci-test.db` avec
schéma — **aucun fix requis pour lui**).

### 3.2 Sonde de résolution de chemin Prisma (cause du dossier manquant)

```
$ DATABASE_URL="file:./db/ci-probe.db" bunx prisma db push --skip-generate
$ ls db/ci-probe.db        → absent
$ ls prisma/db/ci-probe.db → PRÉSENT   ← résolution schéma-relative
```

### 3.3 Après fix (même état runner : `rm -rf db`)

```
$ rm -rf db && bun test tests/db-boot-pragma.test.ts
  4 pass / 0 fail / 9 expect() calls   ← S1 S2 S3 S4, auto-suffisant
```

Décision documentée (DEV-SETUP §4b « Incident F-16a ») : l'option
« skip si le FS ne supporte pas WAL (détection dynamique) » a été **examinée
puis rejetée** — WAL fonctionne sur le runner (S2 passe dès que le répertoire
existe) et un skip dynamique masquerait exactement la classe d'échec de boot
que §4b chasse. Si un FS refuse WAL un jour, S2 doit rester ROUGE.

---

## 4. Preuves F-16b (B1 MinIO)

Gate module-level dans `tests/media-minio-integration.test.ts` :

```
MINIO_USABLE = MEDIA_S3_ENDPOINT explicite
             OU (docker OK + compose du repo présent + HORS CI hébergée)
```

| Condition | Résultat observé | Exit |
| --- | --- | --- |
| Sandbox local (docker absent) | `(skip) B1 · G — intégration MinIO locale` + message documenté (causes + commande rejouable) | 0 |
| `CI=true` (simulation runner hébergé) | `(skip)` idem — docker même présent ne changerait rien (branche hostedCI) | 0 |
| Local avec docker + compose | **NON TESTÉ** — sandbox sans docker ; rejouable : `docker compose -f deploy/docker-compose.minio.yml up -d && bun test tests/media-minio-integration.test.ts` | — |
| CI avec `MEDIA_S3_ENDPOINT` externe | NON TESTÉ (aucun endpoint provisionné) — le `beforeAll` ne monte PAS la pile contre un endpoint externe (bucket pré-créé contractuel) | — |

Règle documentée : « Test B1 MinIO : skip en CI sans pile provisionnée —
**reste actif en local** via `deploy/docker-compose.minio.yml` ; la preuve B1
réelle reste OBLIGATOIRE en local avant livraison (§7 DEV-SETUP). »

---

## 5. Preuves F-17 (D1 build + sweep des autres runners)

### 5.1 Capture de la cause exacte (reproduction locale = identique runner)

```
$ rm -rf db .next && NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="file:/home/z/wt-adm/db/d1-search-proof.db" bun run build
✓ Compiled successfully in 12.4s
  Running TypeScript ...
scripts/axe-audit.ts(82,40): error TS2345: Argument of type '(n: { target?: unknown; … })' is not assignable to parameter of type '(value: unknown, …)'.
  Types of parameters 'n' and 'value' are incompatible.
    Type 'unknown' is not assignable to type '{ target?: unknown; html?: string | undefined; failureSummary?: string | undefined; }'.
Failed to type check.
error: script "build" exited with code 1
```

### 5.2 Fix type (minimal — aucun refactor)

`scripts/axe-audit.ts` : sous-ensemble consommé d'axe-core typé dans le cast
(`type AxeNode = { target?: unknown; html?: string; failureSummary?: string }`)
→ `violations/passes/incomplete: { nodes: AxeNode[] }[]` — le callback `.map`
redevient compatible (contravariance respectée).

### 5.3 Sweep « même défaut latent » — 7 proof-runs

| Script | Build avant | Build après |
| --- | --- | --- |
| `d1-search-proof-run.sh` | silencieux (`> /tmp/d1-build.log 2>&1`) | `|| { say …; tail -40; exit 1; }` |
| `c2-audio-calls-proof-run.sh` | silencieux | instrumenté |
| `c3-video-calls-proof-run.sh` | silencieux | instrumenté |
| `c4-mls-groups-proof-run.sh` | silencieux | instrumenté |
| `d2-sybil-proof-run.sh` | silencieux | instrumenté |
| `d3-supply-chain-proof-run.sh` | silencieux | instrumenté |
| `hardening-proof-run.sh` | déjà instrumenté (référence du pattern) | inchangé |

Les erreurs TS sont **globales au repo** : le fix axe-audit.ts débloque D1,
C2, C3, C4 simultanément (même `bun run build`). Syntaxe vérifiée :
`bash -n` OK sur les 6 scripts édités.

### 5.4 Re-run D1 end-to-end (après fix, état frais)

```
$ bash scripts/d1-search-proof-run.sh      → EXIT=0
[d1-proof] 1. sonde FTS5 (prérequis bloquant)
[d1-proof] 2. build standalone            ← passait plus (10 s)
[d1-proof] 3. migrations + seed           ← 3 users / 10010 posts / DM trap
[d1-proof] 4. serveur :3163 (run 1)
[d1-proof] 5. tests API (hits, diacritiques, frontière DM, triggers, pagination, benchmark, 429)
[d1-proof] 6. preuve navigateur (run 2 — rate store frais)
[d1-proof] 7. preuves grep (frontière DM locale)
[d1-proof] 8. check-merge-clean           (exit 2 — non bloquant, règle §8.1 : > 3)
[d1-proof] 9. tsc + lint
[d1-proof] OK — preuve D1 complète (assets dans docs/proofs/assets/d1-*)
```

Assets D1 rafraîchis par ce run vert et commités avec le fix (captures +
logs `docs/proofs/assets/d1-*`).

---

## 6. Preuve globale — P4 simule tests.yml (protocole exact du workflow)

```
$ rm -rf db                                  # état checkout frais CI
$ DATABASE_URL="file:./db/ci-test.db" bunx prisma db push --skip-generate   → EXIT 0
$ DATABASE_URL="file:./db/ci-test.db" bun test tests/
  225 pass / 231 skip / 0 fail  (456 tests, 28 fichiers)  → EXIT 0
$ bun scripts/check-protocol-parity.ts       → « Parité protocole web ↔ mobile : OK » → EXIT 0
$ bunx tsc --noEmit                          → EXIT 0
$ bun run lint                               → EXIT 0 (hygiène, hors workflow)
```

**CI verte attendue après push opérateur — sorties locales = P4 simule
tests.yml à 0 fail** (§7 DEV-SETUP). Check-list attendue côté GitHub après
push de cette branche :

- `tests.yml` ✅ (les 2 échecs F-16 corrigés ; les steps parité + typecheck,
  jamais atteints avant, sont verts localement)
- `security.yml` ✅ (inchangée — aucune dépendance modifiée)
- `weekly-proof-run.yml` ✅ **ou** skip documenté si l'install chromium
  échoue (prévu par le workflow) ; D1 prouvé vert localement e2e
- `deploy-vps.yml`, `schema-guard.yml`, `build-android.yml`, `build-ios.yml`
  → **ne doivent PAS apparaître** (déclencheurs main/archive uniquement)

---

## 7. NON TESTÉ (documenté — jamais silencieux)

- **Runs GitHub réels** (`workflow_dispatch` weekly, push feat/mbote-v1) :
  impossible cette session — token révoqué ; l'opérateur pousse et confirme.
  Si un échec subsiste, les builds des 7 proof-runs affichent désormais
  l'extrait du log (jamais-silencieux) — plus de diagnostic impossible.
- **B1 avec docker = PASS** : sandbox sans docker (rejouable VPS/dev local).
- **Safari/Firefox, lecteurs d'écran réels, device physique** : hors périmètre
  de cette vague (cf. E-ui-audit §NON TESTÉ).
- Le handler d'échec `tail -40` : vérifié `bash -n` + pattern identique à
  `hardening-proof-run.sh` (déjà exercé en vague durcissement) ; pas de test
  d'échec volontaire injecté dans le repo (risque de pollution de l'arbre).

## 8. Fichiers modifiés (4 commits séparés)

| Commit | Contenu |
| --- | --- |
| `fix(ci): F-16a …` | `tests/db-boot-pragma.test.ts` (mkdirSync auto-suffisant) |
| `fix(ci): F-16b …` | `tests/media-minio-integration.test.ts` (gate pile utilisable) |
| `fix(ci): F-17 …` | `scripts/axe-audit.ts` (AxeNode) + 6 proof-runs instrumentés + assets D1 verts |
| `docs(ci): F-16/F-17 …` | `docs/DEV-SETUP.md` (§4b incident + §8 weekly-ci) + `docs/proofs/F16-F17-ci-fixes.md` (ce rapport) |

**Prochaine étape bloquante** : push opérateur → confirmation CI verte →
alors seulement la vague F démarre (lire `docs/UI-AUDIT.md`, compter
Critiques/Majeurs, STOP si > 30 écarts au total).
