# Audit statique CI — 8 workflows (.github/workflows)

**Date** : 2026-11-13 · **Commit audité** : `feat/mbote-v1` @ `25aaa56` (post D2+D3)
**Méthode** : lecture intégrale des 8 fichiers YAML + vérification des faits consommables
(scripts référencés, lockfile, SHA d'actions) depuis le sandbox. **Limite assumée** : le
sandbox n'a pas de credentials GitHub — les **runs réels** ne sont pas observables ici ;
l'opérateur confirme les jobs depuis son laptop. Cet audit vérifie la cohérence
*déclencheurs → étapes → artefacts → sortie consommée* et inventorie les échecs
silencieux possibles.

---

## 1. Vérification préalable — SHA des actions épinglées (7/7 ✅)

Méthode : `git ls-remote https://github.com/<repo> refs/tags/<v>` (le proxy sandbox
bloque les pages commit ; le protocole git passe). Toutes les actions sont épinglées
par SHA de commit (condition 6 supply chain) :

| Action | Tag | SHA épinglé | Verdict |
|---|---|---|---|
| `actions/checkout` | v4.4.0 | `11d5960a…` | ✅ identique |
| `oven-sh/setup-bun` | v2.2.0 | `0c5077e5…` | ✅ identique |
| `actions/upload-artifact` | v4.6.2 | `ea165f8d…` | ✅ identique |
| `aquasecurity/trivy-action` | v0.36.0 | `ed142fd0…` | ✅ tag annoté — SHA épinglé = commit peelé (`^{}`) |
| `actions/setup-java` | v4.9.1 | `cf277c60…` | ✅ identique |
| `actions/cache` | v4.3.0 | `0057852b…` | ✅ identique |
| `softprops/action-gh-release` | v2.6.2 | `3bb12739…` | ✅ identique |

---

## 2. Table de synthèse

| Workflow | Déclencheurs | Filtres | Artefacts | Sortie consommée | Verdict |
|---|---|---|---|---|---|
| **tests.yml** | push `main`+`feat/**`, PR→`main`, dispatch | aucun (toujours) | aucun | statut job (blocant) | ✅ F-11, F-10 |
| **security.yml** | schedule lundi 06:00, push `main`+`feat/**`, dispatch | paths : package.json, bun.lock, Dockerfile×3, security.yml | npm-audit-report.json, security-report.sarif | audit prod = gate ; rapport complet = résumé+artefact ; SARIF = artefact seul | ⚠️ F-3, F-2 |
| **weekly-proof-run.yml** | schedule lundi 07:00, push `feat/**`, dispatch | paths : le workflow lui-même + `scripts/*proof-run.sh` | docs/proofs/assets/* | statut job + artefacts + GITHUB_STEP_SUMMARY | ⚠️ F-4, F-2 |
| **schema-guard.yml** | push `main`, PR→`main` | — | aucun | exit 1 = job rouge | ✅ F-6 |
| **build-android.yml** | push `main`, tags `v*.*.*`, PR→`main`, dispatch | — | APK + Release (tags) | artefact/release | ✅ F-5 |
| **build-ios.yml** | push `main`, tags `v*.*.*`, PR→`main`, dispatch | — | simulateur.zip (+IPA), Release (tags) | artefact/release | ✅ |
| **deploy-vps.yml** | push `main` (paths-ignore mobile/docs/*.md), dispatch | paths-ignore | aucun | healthcheck curl `/api/stats` | ⚠️ F-1, F-7, F-8 |
| **setup-backups.yml** | dispatch seul | — | sauvegarde chiffrée + branche `backups` | `result=PASS` requis, sinon exit 1 | ✅ |

---

## 3. Analyse détaillée par workflow

### 3.1 tests.yml — « Tests — harness adversarial »

- **S'exécute-t-il vraiment ?** Oui sur tout push `main`/`feat/**` (aucun filtre
  paths — il ne peut pas être esquivé par un push ciblé). `workflow_dispatch`
  disponible.
- **Étapes** : bun 1.3.14 (pinned) → `bun install --frozen-lockfile` → `prisma db
  push` sur `db/ci-test.db` (exception documentée §4 DEV-SETUP : base éphémère)
  → `bun test tests/` → `bun scripts/check-protocol-parity.ts` → `bunx tsc --noEmit`.
- **Sortie consommée** : le code de sortie de chaque step (échec = job rouge).
  Aucun artefact : les résultats ne survivent pas au run (acceptable — la valeur
  est le gate, pas le rapport).
- **Échec silencieux possible** :
  - Les harnesses `tests/*.ts` SANS suffixe `.test.ts` (`anti-replay-e2e.ts`,
    `moderation-e2e.ts`, `mesh-bridge-e2e.ts`…) ne sont PAS exécutés par
    `bun test tests/` — F-10 (info, couverts par les runners de preuve dédiés).

### 3.2 security.yml — « Analyse des vulnérabilités »

- **S'exécute-t-il vraiment ?** Sur push, OUI si le diff touche les paths listés.
  Le push de feat/mbote-v1 contient les commits D2 (dépendances) et D3 (pins
  package.json) → **déclenché**. ATTENTION (F-2) : le cron lundi 06:00
  n'exécute que la version de la **branche par défaut** — tant que
  feat/mbote-v1 n'est pas merge sur main, la cadence hebdomadaire n'existe pas.
- **Étapes** : audit-npm = génère package-lock.json (`--legacy-peer-deps`
  OBLIGATOIRE — fix D3 du job cassé silencieusement depuis C4) →
  `npm audit --omit=dev --audit-level=high` **BLOQUANT** → arbre complet
  `continue-on-error` → résumé python (compte les sévérités du JSON) →
  artefact. scan-trivy = scan fs (vuln+secret+misconfig, HIGH+CRITICAL,
  `exit-code: "0"`) → artefact SARIF.
- **Sortie consommée** : audit prod = gate réel. Le rapport complet est lu par le
  step résumé (le JSON est réellement consommé, pas juste produit). Le SARIF
  trivy n'est **pas consommé automatiquement** (permissions `contents: read`, pas
  de code scanning) — consultation manuelle de l'artefact → **F-3**.
- **Échec silencieux possible** :
  - `exit-code: "0"` trivy : des findings HIGH/CRITICAL ne rendent JAMAIS le job
    rouge (documenté « resserrage planifié » mais sans ticket ni date) → F-3.
  - `continue-on-error` sur l'arbre complet : vulns dev non bloquantes (décision
    de triage D3 tracée dans docs/SECURITY-TRIAGE.md — chaque vuln a sa ligne) —
    acceptable, non silencieux (F-9).

### 3.3 weekly-proof-run.yml — « Preuves navigateur hebdomadaires »

- **S'exécute-t-il vraiment ?** Push `feat/**` filtré sur le workflow lui-même +
  `scripts/*proof-run.sh` — le push de feat/mbote-v1 ajoute
  `d2-sybil-proof-run.sh` (D2) et `d3-supply-chain-proof-run.sh` (D3) →
  **déclenché** (4 runners D1/C2/C3/C4, timeout 75 min). Même limite F-2 pour le
  cron lundi 07:00 : branche par défaut seulement.
- **Étapes** : bun → install → garde-fou prérequis (docker rapporté pour
  traçabilité ; chromium installé via `bunx playwright-core install --with-deps`,
  version alignée au lockfile — playwright-core 1.65.0 vérifié dans bun.lock) →
  4 runners de preuve conditionnés à `steps.prereqs.outputs.skip == ''` →
  artefacts assets.
- **Sortie consommée** : statut de chaque runner (échec = rouge), artefacts
  captures/JSON/logs, GITHUB_STEP_SUMMARY.
- **Échec silencieux possible** :
  - Le skip (chromium indisponible) rend le job **SUCCESS** avec `::notice::` +
    résumé explicite — conforme à la Clarification 1 (skip documenté, jamais
    silencieux) MAIS dans l'UI Actions un job skip affiche le même ✔️ qu'un job
    vert : la distinction n'existe que dans le résumé/le nom du step → F-4.
  - `if-no-files-found: ignore` sur l'upload : si tous les runners échouent avant
    de produire des assets, l'artefact est vide — le job est déjà rouge à ce
    stade, donc pas d'aveuglement supplémentaire. Acceptable.

### 3.4 schema-guard.yml

- **S'exécute-t-il vraiment ?** Uniquement push `main` et PR→`main` — PAS sur
  `feat/**` (F-6, choix assumé : le garde protège le merge, cf. §4 DEV-SETUP).
  Le pipeline du projet merge en local puis pousse → l'événement `push` est le
  chemin réel ; le fallback `github.event.before` illisible (push initial) est
  géré (`git cat-file -e` → parent).
- **Sortie consommée** : `exit 1` avec `::error::` détaillé (incident I-2 cité)
  → job rouge = blocage. Simple et efficace.
- **Échec silencieux possible** : aucun identifié. La comparaison
  `--diff-filter=A` n'accepte que les fichiers AJOUTÉS sous prisma/migrations
  (modifier une migration existante ne compte pas — correct).

### 3.5 build-android.yml

- **S'exécute-t-il vraiment ?** push `main` + tags + PR→`main`. Non déclenché sur
  feat/mbote-v1 (attendu).
- **Sortie consommée** : APK artefact (tous builds) + GitHub Release sur tags
  (`fail_on_unmatched_files: true`). Portails qualité inline : tsc strict mobile,
  `bun run check:parity` (existe dans package.json racine ✅).
- **Échec silencieux possible** :
  - Job en `contents: write` pour TOUS les builds (PR inclus) alors que seule la
    publication Release sur tag en a besoin → F-5 (least privilege à resserrer :
    scinder le job release ou restreindre aux refs tags).
  - `actions/cache` hashFiles sur un chemin qui peut ne pas exister → clé vide →
    restore-keys de secours : dégradation, pas d'échec. OK.
  - Le staging APK (`ls | head -n1` → `cp`) échoue loud si aucun APK. OK.

### 3.6 build-ios.yml

- **S'exécute-t-il vraiment ?** Mêmes déclencheurs qu'Android (macos-latest,
  gratuit pour repos publics).
- **Sortie consommée** : simulateur.zip TOUJOURS produit + IPA signée seulement
  si certificats → artefact (`if-no-files-found: warn` — l'asymétrie est
  attendue) + Release sur tags (`fail_on_unmatched_files: false` — le zip
  simulateur est toujours présent, donc la Release n'est jamais vide).
- **Échec silencieux possible** : la découverte de schéma Xcode contient le
  garde documenté (workspace ≠ slug ; fallback premier schéma non-Pods ; check
  `.app` produit sinon exit 1) — les pièges précédents ont déjà été corrigés dans
  le workflow lui-même. Rien de nouveau identifié.

### 3.7 deploy-vps.yml — ⚠️ constat principal F-1

- **S'exécute-t-il vraiment ?** push `main` avec paths-ignore (mobile/**, docs/**,
  **.md) + dispatch. NON déclenché par le push feat/mbote-v1 — conforme à la
  pause déploiement post-D3.
- **Sortie consommée** : SEUL le healthcheck post-déploiement (curl
  `/api/stats`, 6 s après up). Pas d'artefact, pas de résumé. Si le curl rate
  (démarrage lent), le job est rouge APRÈS le déploiement — fausse alarme
  possible (F-7), jamais d'échec silencieux dans ce sens.
- **Échec silencieux possible — F-1 (structurel, le plus important)** :
  **le déploiement n'est pas gaté par les tests**. Un push sur `main` déclenche
  tests.yml ET deploy-vps.yml **en parallèle** : si tests.yml est rouge sur le
  SHA déployé, le déploiement part quand même (aucun `needs` possible entre
  workflows séparés, et aucune preuve côté sandbox que des *required checks*
  existent dans les Settings du repo). Le healthcheck ne vérifie que la
  disponibilité de l'API, pas la non-régression.
  **Recommandation (opérateur, Settings repo)** : branch protection sur `main`
  avec tests.yml + security.yml(audit-npm) en required checks — ou passer le
  déploiement en `workflow_run` (déclenché après succès des tests).
- F-8 (mineur, sécurité) : `ssh-keyscan` appended sans vérification (TOFU) —
  MITM théorique au premier déploiement / si le host change. Acceptable pour un
  VPS dédié ; alternative : épingler le host key dans un secret.
- Les exclusions rsync préservent `.env`, `db/`, `backups/`,
  `docker-compose.override.yml` du serveur ✅ (vérifié ligne à ligne).

### 3.8 setup-backups.yml (présent en plus des 7 demandés)

- **S'exécute-t-il vraiment ?** `workflow_dispatch` SEUL — conforme à la
  condition 8 (validation humaine avant action prod). Jamais automatique.
- **Sortie consommée** : `result != "PASS"` → exit 1 loud ; fichier chiffré
  externalisé sur la branche `backups` (permissions `contents: write` justifiées)
  + artefact + résumé.
- **Échec silencieux possible** : `git commit … || echo "aucune différence"` —
  si deux cycles produisent le même fichier, le push est no-op : la branche
  `backups` garde l'ancien fichier, la rétention n'est pas mise à jour.
  Mineur (le statut VPS cron quotidien est la source de vérité).

---

## 4. Scénario concret — push de feat/mbote-v1 par l'opérateur

Checklist de ce qui DOIT apparaître côté GitHub Actions (à confirmer par
l'opérateur, le sandbox ne peut pas les voir) :

| Job attendu | Pourquoi | Critère de vert |
|---|---|---|
| tests.yml / adversarial | push `feat/**`, aucun filtre | bun test + parité + tsc verts |
| security.yml / audit-npm | commits D2/D3 touchent package.json + bun.lock | `npm audit --omit=dev --audit-level=high` exit 0 (le fix D3 doit le prouver EN CI — c'est le point le plus important de la vague) |
| security.yml / scan-trivy | même push | job success (report-only) + artefact SARIF |
| weekly-proof-run.yml / browser-proofs | commits D2/D3 ajoutent des `scripts/*proof-run.sh` | 4 runners D1/C2/C3/C4 verts OU skip documenté (chromium) |
| schema-guard, build-*, deploy-vps, setup-backups | — | **absents** (déclencheurs main/PR/tags/dispatch) — leur ABSENCE est l'état attendu |

Notes de déclenchement :
- Premier push de la branche : GitHub évalue les filtres `paths` sur les commits
  poussés — les commits D2/D3 touchent des paths matchants pour security.yml et
  weekly-proof-run.yml dans toute interprétation documentée (diff du range poussé).
- Si l'opérateur force-push ou repousse sans nouveaux commits touchant ces
  paths, security.yml et weekly-proof-run.yml peuvent NE PAS se déclencher
  (tests.yml, lui, se déclenche toujours) — utiliser `workflow_dispatch` pour
  forcer dans ce cas.

---

## 5. Registre des constats

| ID | Sévérité | Constat | Portée | Recommandation |
|---|---|---|---|---|
| **F-1** | **majeur** | deploy-vps non gaté par tests/security — déploie un SHA potentiellement rouge | deploy-vps.yml | ✅ **CORRIGÉ vague durcissement (commit b4f6b97)** — voir §7.1 |
| **F-2** | majeur | les crons (security 06:00, weekly-proof 07:00 lundi) n'exécutent QUE la branche par défaut — pas de cadence hebdo tant que feat/mbote-v1 n'est pas merge | security.yml, weekly-proof-run.yml | 📄 **DOCUMENTÉ vague durcissement** — voir §7.2 (exécution manuelle en attendant) |
| **F-3** | moyen | scan-trivy `exit-code: "0"` : findings HIGH/CRITICAL jamais bloquants ; SARIF en artefact non consommé automatiquement | security.yml | 📄 **DOCUMENTÉ vague durcissement** — voir §7.3 (bloquant avant ouverture publique) |
| **F-4** | moyen | weekly-proof-run skip = job SUCCESS : indistinguishable d'un vert dans l'UI Actions (la preuve vit dans le résumé) | weekly-proof-run.yml | renommer le job (préfixe `SKIP —`) via output de job, ou `::warning::` + annotation distincte |
| **F-5** | mineur | build-android : `contents: write` au job pour tous les builds (PR inclus), nécessité réelle = Release sur tags | build-android.yml | restreindre (job séparé release, ou condition `startsWith(refs/tags/)`) |
| **F-6** | mineur | schema-guard absent de `feat/**` — un schéma sans migration passe en feat, n'échoue qu'au merge | schema-guard.yml | conforme au flux merge-local (§4 DEV-SETUP) ; option : étendre à `feat/**` si on veut un retour plus tôt |
| **F-7** | mineur | healthcheck 6 s après `up -d --build` : un démarrage lent = job rouge après déploiement réussi (fausse alarme, pas un silence) | deploy-vps.yml | boucle de retry curl (ex. 6 × 5 s) au lieu d'un sleep unique |
| **F-8** | mineur | ssh-keyscan TOFU (host key non vérifiée) | deploy-vps.yml, setup-backups.yml | épingler la host key dans un secret |
| **F-9** | info | npm audit arbre complet `continue-on-error` — décision de triage D3 tracée vuln par vuln (docs/SECURITY-TRIAGE.md) | security.yml | rien (décision assumée) |
| **F-10** | info | `bun test tests/` n'exécute pas les harnesses sans suffixe `.test.ts` (couverts par runners de preuve) | tests.yml | rien (discipline §7 les couvre) |
| **F-11** | info | aucun artefact de résultat de tests (statut seul) | tests.yml | optionnel : uploader un résumé junit/bun pour traçabilité |
| **F-12** | info | `check-merge-clean.sh` (invariant main ⊆ mbote-v1) est un garde LOCAL, pas un job CI | scripts/ | optionnel : step CI au merge (fetch-depth 0 déjà le cas dans schema-guard) |
| **F-13** | info | iOS `fail_on_unmatched_files: false` vs Android `true` — asymétrie bénigne (le zip simulateur garantit un fichier) | build-ios.yml | rien |
| **F-14** | info | bun 1.3.14 épinglé dans les workflows, aligné au sandbox (1.3.14) ; pas de `.bun-version` dans le repo | tous | optionnel : committer `.bun-version` pour aligner les laptops |
| **F-15** | **majeur** | **DÉCOUVERT vague durcissement (simulation CI)** : `bun test tests/` en conditions CI = **31 fails** — c4-groups throw sans APP_URL (beforeAll hors describe), admin-audit-e2e et admin-auth-e2e seedent sur leur DB dédiée mais leurs tests s'exécutent quand même (fail « absent : admin … ») — le premier push de feat/mbote-v1 aurait été ROUGE (et main aussi : même pattern présent sur main) | tests.yml | ✅ **CORRIGÉ (commit a492c44)** — skip PROPRE documenté (pattern D1/D2) : 225 pass / 231 skip / 0 fail ; les suites restent exécutées par leurs runners dédiés (APP_URL / DB harness) et le harness admin-auth-e2e réel passe 83/83 |

---

## 6. Verdict global

1. **Cohérence statique** : les 8 workflows sont correctement câblés — chaque
   script référencé existe (`check-protocol-parity.ts`, `check:parity`,
   4 runners de preuve D1/C2/C3/C4), chaque version épinglée est vérifiée
   (bun 1.3.14, playwright-core 1.65.0, ts-mls 1.6.4), chaque SHA d'action est
   authentique (7/7).
2. **Le fix D3 (job npm audit cassé silencieusement depuis C4) est le point
   critique à prouver EN CI** au prochain push : le job audit-npm avec
   `--legacy-peer-deps` doit passer — c'est la validation rétroactive de la
   pause CI.
3. **Les 2 vraies failles structurelles** restantes sont F-1 (déploiement non
   gaté) et F-3 (trivy jamais bloquant) — toutes deux côté Settings repo /
   resserrage planifié, aucune ne bloque la confirmation CI sur feat/mbote-v1.
4. **Aucun workflow ne s'exécute à vide sans consommer sa sortie** : les sorties
   sont soit des gates (tests, audit prod, schema-guard, backup PASS), soit des
   artefacts/résumés explicitement destinés à la consultation (SARIF, rapport
   audit complet, assets de preuve) — les exceptions (F-3, F-4) sont documentées
   dans ce registre.

NON TESTÉ (hors périmètre statique) : les runs réels GitHub (opérateur), la
branch protection effective du repo (Settings non lisibles sans credentials),
les notifications d'échec (email/watchers), la durée réelle des jobs.

---

## 7. Suivi post-audit — vague durcissement (2026-11-13)

### 7.1 F-1 — CORRIGÉ en code (option (a), commit `b4f6b97`)

Le déploiement est désormais **gâté par la CI en code**, pas en config manuelle :

- **Déclencheur** : `workflow_run` sur « Tests — harness adversarial »
  (`types: [completed]`, `branches: [main]`) — un déploiement ne part qu'après
  une run de tests terminée.
- **Gate de SHA** (step dédié) : le SHA déployé est le **SHA testé**
  (`workflow_run.head_sha`, jamais le HEAD courant de main) ; `tests.yml`
  doit être `success` pour ce SHA — sinon `::error::` + REFUS ; `security.yml`
  doit être `success` SI elle a tourné pour ce SHA (absente = ses paths
  deps/Docker/CI inchangés → l'audit précédent reste valide — pass-through
  documenté) ; `workflow_dispatch` passe par le MÊME gate (l'urgence passe par
  une run de tests d'abord, pas par un contournement).
- **Sémantique paths-ignore conservée** (mobile/**, docs/**, *.md → skip) :
  évaluée par `git diff $SHA^ $SHA` dans le gate.
- **Choix documenté — déclencheur sur tests.yml seul** (et non
  `workflows: [tests, security]`) : la security.yml schedulée du lundi 06:00
  déclencherait sinon un redéploiement idempotent mais inutile chaque lundi ;
  l'exigence security reste ENFORCE par le gate (verte si exécutée).
- Vérification : inspection YAML automatisée dans
  `scripts/hardening-proof-run.sh` (workflow_run + gate + head_sha + if).

**NON TESTÉ en conditions réelles** : nécessite un push sur main (workflow_run
ne s'exécute pas sur les runners locaux) — la logique gate est vérifiée par
inspection YAML statique et les requêtes `gh api` sont standard.

### 7.2 F-2 — DOCUMENTÉ (exécution manuelle en attendant le merge)

Les crons weekly-proof et security ne s'exécutent que sur la **default branch**.
Après merge sur main, ils tourneront. En attendant, exécution manuelle via
`workflow_dispatch` pour les runs critiques :

```bash
gh workflow run weekly-proof-run.yml --ref feat/mbote-v1
gh workflow run security.yml --ref feat/mbote-v1
# suivi :
gh run list --workflow weekly-proof-run.yml --limit 3
gh run watch <run-id>   # ou gh run view <run-id> --log
```

Note : les filtres `paths` du push ne s'appliquent pas à `workflow_dispatch` —
les deux workflows se déclenchent toujours en manuel.

### 7.3 F-3 — DOCUMENTÉ (bloquant avant ouverture publique)

trivy-action `exit-code: 0` — les findings HIGH/CRITICAL ne rendent pas le job
rouge. **À corriger avant ouverture publique** : passer à `exit-code: 1` avec
une allowlist documentée (annotations `# trivy:ignore` par ligne ou `@ref` par
finding dans SECURITY-TRIAGE.md) pour les exceptions — aucune exception sans
ligne de triage signée. Le SARIF reste en artefact d'ici là (consultation
manuelle ; décision code scanning reportée — nécessiterait
`security-events: write`).

### 7.4 F-15 — CORRIGÉ (commit `a492c44`) — voir la ligne du registre

Leçon : « le job s'exécute-t-il vraiment ? » s'applique aussi aux suites de
tests — la simulation `bun test tests/` en conditions CI (DATABASE_URL seul,
sans serveur ni DB harness) fait désormais partie du runner de durcissement
(`scripts/hardening-proof-run.sh`).
