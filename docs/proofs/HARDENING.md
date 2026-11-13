# Preuve vague durcissement — HARDENING (2026-11-13)

**Branche** : `feat/mbote-v1` · **Base** : post CI-AUDIT + invariant §4d (`893428f`)
**Runner rejouable** : `bash scripts/hardening-proof-run.sh` — **7/7 phases vertes, exit 0**

---

## 1. Livrables → commits

| Livrable | Décision | Commit |
|---|---|---|
| **F-1 deploy gate** (option (a) — code, pas config) | `deploy-vps.yml` : `workflow_run` sur « Tests — harness adversarial » (main) + gate de SHA (tests verte OBLIGATOIRE ; security verte si exécutée — pass-through documenté quand ses paths sont inchangés) ; SHA déployé = SHA testé (`head_sha`, jamais le HEAD courant) ; paths-ignore préservés via `git diff` ; `workflow_dispatch` sous le MÊME gate | `b4f6b97` |
| **break-glass ATOMIQUE** (écart majeur §4d) | `executeBreakGlass` : withWriteLock + `$transaction` (burn→revoke→reset→session→audit) ; `tx?` ajouté à `createAdminSession`/`revokeAllAdminSessions` ; crash = rollback complet | `640893a` |
| **F-15 — bloqueur CI DÉCOUVERT** | `bun test tests/` en conditions CI = **31 fails** (c4-groups throw sans APP_URL ; admin-audit-e2e/admin-auth-e2e s'exécutaient sans leur DB harness) → le premier push de feat/mbote-v1 aurait été ROUGE. Fix : skip PROPRE documenté (pattern D1/D2) | `a492c44` |
| **totp-enroll ATOMIQUE** | enrollment + audit dans la même `$transaction` (withWriteLock) | `3a7c073` |
| **dms/bot ATOMIQUE** | 2 creates dans une `$transaction` ; chiffrement de la réponse préparé AVANT la tx (jamais de verrou SQLite pendant la crypto) | `83277a5` |
| **mesh/bridge ATOMIQUE par paquet** | analyse directive : le retry idempotent NE fonctionnait pas (marque persistée sans contenu → dédup hash masquait la perte définitivement) → marque `meshIngest` + contenu dans la même `$transaction` ; garde anti-rejeu DM DANS la tx (`prismaReplayStoreFor(tx)`) ; P2002 course de marque → duplicate propre ; `relayNotify` APRÈS commit | `16fe0c4` |
| **mls/keypackages prune ACCEPTÉ** | exception §4d justifiée EN COMMENTAIRE sur le site (prune périodique, auto-rattrapée, sans risque) | `15c0a84` |
| **CI-AUDIT mis à jour** | F-1 → CORRIGÉ (§7.1) ; F-2 → DOCUMENTÉ avec commandes `gh workflow run` (§7.2) ; F-3 → DOCUMENTÉ « bloquant avant ouverture publique » (§7.3) ; F-15 ajouté (§7.4) | `343ec17` |
| **DEV-SETUP §4d** | registre de résolution des 5 écarts (4 corrigés, 1 accepté) — aucun ne disparaît sans trace | `343ec17` |
| **hygiène repo** | `admin/.next` dé-tracké (455 artefacts de build) — ils salissaient l'arbre à chaque harness admin-e2e et bloquaient `check-merge-clean` | `5c51a6d` |

## 2. Tests exigés par la directive → résultats

| Test exigé | Résultat | Preuve |
|---|---|---|
| **Break-glass : crash simulé entre burn et reset → rollback complet** | ✅ R2 — `mock.module` fait throw `revokeAllAdminSessions` APRÈS le burn : exécution rejetée ET `AdminRecoveryCode.usedAt` null (code réutilisable), `AdminUser.totpSecret`/`totpEnrolled` INCHANGÉS, AUCUNE révocation de session persistée, AUCUNE trace d'audit partielle. Trace SQL : `BEGIN IMMEDIATE → UPDATE AdminRecoveryCode → ROLLBACK` | `tests/admin-break-glass-tx.test.ts` R1/R2/R3 — **3/3** ; assets `hardening-bg-test.txt` |
| **F-1 : deploy-vps attend le résultat de tests** (inspection YAML, pas de run réel sans push) | ✅ P1 — inspection python du YAML : `workflow_run{workflows:[Tests — harness adversarial], types:[completed], branches:[main]}` + gate (head_sha, tests.yml OBLIGATOIRE, security.yml si exécutée) + checkout `ref: head_sha` + `permissions actions: read` + if `workflow_run.conclusion == 'success'` | asset `hardening-summary.json` (P1) ; CI-AUDIT §7.1 |
| **Non-régression : au moins une suite représentative (D2)** | ✅ P5 — **D2 15/15** sur serveur prod standalone :3185 (build → migrate deploy → serveur → suite). Le test M1 (T0 mesh) **exerce le bridge refactorisé** (`/api/mesh/bridge` announce → user.create) sur le code patché | asset `hardening-d2-test.txt` |
| **Vérifier chaque site §4d** | ✅ P2 — greps structurels : executeBreakGlass (withWriteLock+tx×3), totp-enroll (`$transaction`+audit tx), dms/bot (`$transaction`), bridge (`prismaReplayStoreFor(tx)`+`tx.meshIngest.create`), prune (exception documentée), helpers `tx?` | asset `hardening-greps.txt` |

## 3. Non-régression élargie (au-delà du minimum exigé)

| Phase | Résultat |
|---|---|
| P4 — simulation CI complète (`bun test tests/`, conditions tests.yml) | **225 pass / 231 skip / 0 fail** (avant fix F-15 : 31 fail) — anti-replay 14/14 (dont l'atomicité transactionnelle du store A1), db-boot 4/4 |
| P6 — harness admin-auth-e2e sur 2 serveurs RÉELS (app :3101 + panel :3102) | **83/83** — la suite E break-glass exerce le route refactorisé de bout en bout (HTTP réel, Argon2id, burn, révocation, ré-enrôlement) |
| P7 — `check-merge-clean.sh` | exit 0 — invariant main ⊆ feat/mbote-v1 intact |

## 4. Assets de preuve (docs/proofs/assets/)

- `hardening-recap.md` — récapitulatif des 7 phases
- `hardening-summary.json` — une ligne par phase (P1..P7)
- `hardening-greps.txt` — greps structurels §4d (P2)
- `hardening-bg-test.txt` — harnais break-glass 3/3 avec R2 rollback (P3)
- `hardening-ci-sim.txt` — simulation CI 225/231/0 (P4)
- `hardening-d2-test.txt` — D2 15/15 serveur prod (P5)
- `hardening-admin-e2e.txt` — harness admin 83/83 (P6)
- `hardening-merge-clean.txt` — check-merge-clean exit 0 (P7)

## 5. NON TESTÉ (honnête)

- **F-1 en conditions réelles** : `workflow_run` + gate ne s'exécutent que sur GitHub après un **push sur main** — impossible depuis le sandbox (pas de credentials). La logique est vérifiée par inspection YAML (P1) ; les appels `gh api` du gate sont des endpoints standards (`/actions/workflows/{file}/runs?head_sha=`). Première validation réelle : le merge futur sur main.
- **F-2 (crons)** : nécessite le merge sur main (les crons n'exécutent que la default branch) — en attendant : `gh workflow run weekly-proof-run.yml --ref feat/mbote-v1` (CI-AUDIT §7.2).
- **F-3 (trivy bloquant)** : décision documentée, correction programmée AVANT ouverture publique (CI-AUDIT §7.3).
- **Charge réelle multi-utilisateurs** : les benchmarks restent mono-client (note SCALE-ARCHITECTURE §8.2).
- **P2002 de course sur la marque mesh** : le chemin « course concurrente inter-passerelles » est couvert par le catch P2002 (code) mais pas par un test de contention dédié — la garde primaire reste le `findUnique` pré-transaction + l'unicité hash.
- **mock.module** : le crash simulé R2 remplace une seule fonction (`revokeAllAdminSessions`) — il prouve le ROLLBACK de la tx réelle (trace SQL `BEGIN IMMEDIATE → ROLLBACK`), pas un kill -9 du process (le comportement SQLite sous crash process est garanti par le journal WAL lui-même).
