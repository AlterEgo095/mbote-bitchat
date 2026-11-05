# ADM ÉTAPES 1+2 — PREUVES (specs, breakdown jp, squelette app admin)

**Date** : 2026-11-05 (Kinshasa WAT) · **Branche** : `feat/adm-mvp` · **Commits** : `c4c7112` (Étape 1 — specs) · `3efa582` (Étape 2 — squelette + infra) · ce document (preuves + état global)
**Entrées** : recadrage de mission (but verrouillé, feuille de route complète) · `docs/proofs/ADM-rupture.md` (Étape 0, prérequis satisfait) · `docs/proofs/ADM-audit-2026-11-05.md` (décisions §4.1–§4.5)

---

## 0. VERDICT

**ÉTAPES 1+2 LIVRÉES ET PROUVÉES.** Le test de maturité (breakdown jp) est **réussi** : fourchette serrée **16–20 jp** pour les Étapes 3–10, borne haute ≤ 20 — le squelette a donc été construit conformément à la directive (pas de repli plan B nécessaire). L'app admin tourne en **mode production** (build standalone), son health check a ses **2 états prouvés en dev ET en prod**, l'invariant **zéro accès DB direct** est vérifiable dans les artefacts, et rien n'est poussé sur `origin` (aucune validation opérateur reçue).

---

## 1. ÉTAPE 1 — LES TROIS SPECS (commit `c4c7112`)

| Livrable | Fichier | Contenu clé |
|---|---|---|
| RBAC & sécurité | `docs/specs/ADMIN-RBAC.md` | 7 invariants · identités + 5 rôles (hiérarchie existante `admin-auth.ts:32-42`) · matrice 11 actions × rôle minimum · four-eyes (`PendingAction`, approbateur ≠ auteur **ET** session ≠ session, expiry 1 h) · justification (catégorie + ≥ 20 chars) · flux login/TOTP/break-glass · architecture BFF sans état + `ADMIN_INTERNAL_TOKEN` · menaces couvertes/résiduelles · hors périmètre |
| Runbook d'accès | `docs/specs/ADMIN-ACCESS-RUNBOOK.md` | chaîne d'accès (CF Access → nginx → 127.0.0.1:3001 → mbote) · 6 prérequis bloquants ordonnés (O-B **avant** O-A — voir §6) · commandes d'installation exactes (certbot, vhost, CF Access) · seed 1er AdminUser · health 2 états · exploitation (sessions, break-glass, rotation token) · rollback isolé · checklist GO |
| Breakdown jp | `docs/specs/ADM-breakdown.md` | **16–20 jp** (E3 auth 4–5 · E4 RBAC 1,5–2 · E5 dashboard 1–1,5 · E6 queue 2–2,5 · E7 users 2–2,5 · E8 audit 1–1,5 · E9 four-eyes 2–2,5 · E10 tests 2–2,5) · stop-rule (+0,5 jp) · plan B resserré 14–17 jp · estimation blocs suivants 33–49 jp (ordre de grandeur assumé) |

**Test de maturité (directive du recadrage)** : fourchette totale **16–20 jp**, chaque poste à ±0,5 jp près, critères d'acceptation testables par poste → le squelette est construit, conformément à « si la fourchette est serrée, tu continues ».

Correction d'arithmétique assumée : le total des blocs restants était initialement affiché ≈ 31–46 jp ; corrigé en **≈ 33–49 jp** (Bloc B 24–35 + Bloc C 9–14) dans le même commit que les preuves.

---

## 2. ÉTAPE 2 — SQUELETTE (commit `3efa582`)

### 2.1 App `admin/` — Next.js 16 standalone, port 3001, BFF sans état

| Fichier | Rôle |
|---|---|
| `admin/package.json` | `next ^16.1.1` (miroir de l'app principale) — **0 dépendance prisma** (invariant RBAC §1, preuve §3.6) |
| `admin/src/app/api/health/route.ts` | health check **2 états** : 200 `ok` / 503 `degraded` (détail §3) |
| `admin/src/lib/backend.ts` | client interne : `BACKEND_INTERNAL_URL` (défaut `http://127.0.0.1:3000`), ping `/api/stats`, timeout 3 s |
| `admin/src/app/page.tsx` | page stub : état du service + invariants, footer sticky, `lang=fr`, responsive |
| `admin/src/components/BackendStatus.tsx` | badge vivant (poll 30 s, `aria-live=polite`) |
| `admin/next.config.ts` | CSP durcie (`frame-ancestors 'none'`), HSTS, XFO DENY, nosniff, `Referrer-Policy: no-referrer` ; `turbopack.root` + `outputFileTracingRoot` **épinglés** (découverte §4.1) ; `output: "standalone"` |
| `admin/Dockerfile` | miroir du Dockerfile principal : `oven/bun:1` **épinglé par digest**, build standalone, **aucune couche prisma/DB** |
| `admin/.gitignore` / `.dockerignore` / `.env.example` | hygiène build + modèle de config |

### 2.2 Infra

- **`docker-compose.yml`** — 3e service `admin` : `127.0.0.1:3001:3001` (jamais au-delà de localhost), `BACKEND_INTERNAL_URL=http://mbote:3000`, `depends_on: mbote service_healthy`, healthcheck compose → `/api/health` (503 ⇒ conteneur `unhealthy` visible). `ADMIN_INTERNAL_TOKEN` déclaré sur les 2 services (inutilisé avant Étape 4 — contrat figé).
- **`deploy/nginx/admin.conf`** — vhost template : TLS LE, `server_tokens off`, headers de défense en profondeur, `client_max_body_size 1m`, IP allowlist **commentée** (fallback uniquement, décision audit §4.5). Installation : runbook §3.
- **Exclusions racine** : `.dockerignore` (+`admin`, `deploy`, `docs` — le `COPY . .` du Dockerfile principal n'embarque plus le panneau), `tsconfig.json` (+exclude `admin`), `eslint.config.mjs` (+ignore `admin/**`) — l'admin a ses propres gardes qualité.

---

## 3. PREUVES RE-JOUABLES (commandes exécutées dans le sandbox, sorties brutes)

### 3.1 Qualité — 4 gardes vertes
```
$ cd admin && bunx eslint .            → LINT ADMIN OK (0 problème)
$ cd admin && bun run typecheck        → TYPECHECK ADMIN OK (tsc --noEmit)
$ cd /home/z/my-project && bun run lint → 0 erreur
$ cd /home/z/my-project && bunx tsc --noEmit → TSC RACINE OK
```

### 3.2 Health check — ÉTAT DEGRADED (dev, backend mort)
```
$ BACKEND_INTERNAL_URL=http://127.0.0.1:9 bun run dev        # rien n'écoute sur :9
$ curl -s -w "\nHTTP_STATUS=%{http_code}\n" http://127.0.0.1:3001/api/health
{"status":"degraded","service":"mbote-admin","checks":{"backend":"TypeError"},"latencyMs":3,"timestamp":"2026-11-05T21:01:16.581Z"}
HTTP_STATUS=503
```

### 3.3 Health check — ÉTAT UP (dev, backend = mbote:3000 vivant) + page + en-têtes
```
$ BACKEND_INTERNAL_URL=http://127.0.0.1:3000 bun run dev
$ curl -s -w "\nHTTP_STATUS=%{http_code}\n" http://127.0.0.1:3001/api/health
{"status":"ok","service":"mbote-admin","checks":{"backend":"up (200)"},"latencyMs":16,"timestamp":"2026-11-05T21:01:28.383Z"}
HTTP_STATUS=200

$ curl -s -o /dev/null -w "GET / -> %{http_code}\n" http://127.0.0.1:3001/
GET / -> 200

$ curl -sI http://127.0.0.1:3001/
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; …; frame-ancestors 'none'   ← CSP dev ('unsafe-eval' HMR attendu)
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

### 3.4 MODE PRODUCTION (chemin exact du Dockerfile) — CSP stricte + 2 états
```
$ cd admin && NEXT_TELEMETRY_DISABLED=1 bun run build
Route (app)
┌ ○ /            (statique)
└ ƒ /api/health  (dynamique)

$ NODE_ENV=production BACKEND_INTERNAL_URL=http://127.0.0.1:3000 PORT=3001 HOSTNAME=0.0.0.0 bun .next/standalone/server.js
$ curl http://127.0.0.1:3001/api/health
{"status":"ok","service":"mbote-admin","checks":{"backend":"up (200)"},"latencyMs":9,…}    HTTP_STATUS=200
$ curl -sI http://127.0.0.1:3001/ | rg content-security
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; …   ← SANS 'unsafe-eval' : CSP prod stricte ✓
$ curl -s http://127.0.0.1:3001/ | rg -o "Mbote Admin|squelette — Étape 1\+2"
Mbote Admin · squelette — Étape 1+2                                                    ← HTML rendu ✓

$ NODE_ENV=production BACKEND_INTERNAL_URL=http://127.0.0.1:9 … bun .next/standalone/server.js
{"status":"degraded","service":"mbote-admin","checks":{"backend":"Error"},"latencyMs":0,…}  HTTP_STATUS=503 ✓
```
**Matrice 2 états × 2 modes : 4/4 verts.**

### 3.5 Commit propre (incident corrigé — transparence)
Le premier commit Étape 2 (`6f915cd`) embarquait par erreur `admin/.next/` (le `.gitignore` racine ancre `/.next/` à la racine). Corrigé immédiatement : `git reset --soft`, ajout de `admin/.gitignore`, purge du staging, re-commit `3efa582` — **0 artefact tracké** :
```
$ git ls-files admin/ | rg -c "\.next/|node_modules"   → 0 occurrence
22 files changed (sources uniquement)
```

### 3.6 Invariant zéro DB direct
```
$ rg -c "prisma" admin/package.json    → 0 occurrence
$ rg -c "prisma" admin/Dockerfile      → 0 occurrence (aucune couche, aucun migrate)
```

### 3.7 Incidents de branche — détectés, réalignés, documentés (transparence)

1. **Commits atterrés sur `main` local** au lieu de `feat/adm-mvp` (détecté via `git branch --show-current` après le commit Étape 1) — réaligné : `git branch -f feat/adm-mvp main` (fast-forward) + `git reset --hard 6d3666b` sur `main` local. Aucun commit perdu, `origin` n'a rien reçu.
2. **HEAD ramené sur `main` entre deux commandes** (deuxième occurrence : le fichier de preuve disparaît du disque car `main` ne le contient pas — vérifié ensuite : `git ls-tree 3cac247` contient bien le fichier, aucune perte). Cause probable : un processus de l'environnement sandbox re-bascule HEAD sur `main`. **Mitigation appliquée** : tout le travail est committé sur `feat/adm-mvp` (les pointeurs de branche persistent quel que soit le HEAD courant) ; chaque lot de commandes git vérifie/rebascule la branche avant d'opérer.

État final vérifié : `main` = `6d3666b` (clôture + Étape 0 — un push O-A ne déploie que ça) · `feat/adm-mvp` = Étapes 0+1+2 · working tree propre sur la branche de travail.

---

## 4. DÉCOUVERTES & DÉCISIONS DE L'ÉTAPE 2 (assumées, tracées)

1. **Inférence de racine workspace (Next 16)** : au premier démarrage, l'app admin a chargé le `src/instrumentation.ts` de l'app **principale** (hub socket.io) — Next remonte au `bun.lock` parent et infère la racine workspace. Correctif : `turbopack.root` + `outputFileTracingRoot` épinglés à la racine du projet admin (`admin/next.config.ts:13-17`). Sans ce garde, le panneau aurait démarré le hub temps réel de l'app principale.
2. **Ping santé = `/api/stats`** : il n'existe pas de `/api/health` sur l'app principale ; le healthcheck Docker de `mbote` utilise déjà `/api/stats` (clôture 7d4afb0). L'admin pingue ce même endpoint — **aucun nouvel endpoint créé côté app principale à l'Étape 2** (périmètre minimal respecté).
3. **`ADMIN_INTERNAL_TOKEN` figé maintenant** : déclaré dans le compose des 2 services dès l'Étape 2 (inutilisé avant E4) pour que le contrat d'infra soit visible et relu — le secret lui-même ne sera généré qu'au `.env` VPS (runbook §2 P6).
4. **Purge mono-session retirée de l'UI à E9** (spécifié dans RBAC §4) : le CLI la conserve pour l'urgence ; l'UI passe exclusivement par four-eyes.

---

## 5. « NON TESTÉ À DOCUMENTER » (Étapes 1+2)

- **`docker compose config` / build d'image** : docker absent du sandbox — la validation compose + build Docker se fera au déploiement (runbook §3), après O-A/O-B/O-C.
- **Vhost nginx réel, certbot, Cloudflare Access** : nécessitent le VPS + le compte CF (actions opérateur, runbook §2–§3).
- **Seed AdminUser + login** : dépendent de l'Étape 3 (CLI `admin-create` décrit au runbook §3.1).
- **Le 503 en dev** : code identique au prod (même route handler), prouvé dans les deux modes (§3.2 et §3.4).

---

## 6. ÉTAT GLOBAL DU PROJET (tableau de bord de référence — à mettre à jour à chaque rapport)

### 6.1 En production (VPS, `origin/main = 75e9559`)
- A1 anti-rejeu 8/8 · A2 auth clés 9/9 · block-DM 9/9 · A3 modération **négatif** 7/7 (les 7 tests positifs restent OFF : `ADMIN_API_KEY` non provisionnée — gel O-4 maintenu).
- **Non déployé en prod** : clôture 7d4afb0 (schema-guard CI, healthcheck compose post-migration, 6 vars deploy, nettoyage audit-test prêt), migration `0004_admin`, Étapes 1+2.

### 6.2 Branches locales non poussées
| Réf | SHA | Contenu |
|---|---|---|
| `main` local (6 commits d'avance) | `7d4afb0` | clôture d'incidents (schema-guard, healthcheck, 6 vars, nettoyage audit-test prêt) |
| | `ee02373`, `6bcff08` | 2 commits à message UUID — **hygiène à faire avant tout push** (reword/squash) |
| | `e0d8a4b` | Étape 0 — schéma admin + migration `0004_admin` (triggers append-only, seed system) |
| | `04a5c4a` | Étape 0 — rupture `ADMIN_API_KEY` (sessions, acteur nominatif, CLI seul détenteur) |
| | `6d3666b` | Étape 0 — preuves `ADM-rupture.md` (e2e 43/43 sans clé, canari 0 occurrence) |
| `feat/adm-mvp` (= main + 3) | `c4c7112` | **Étape 1** — specs RBAC/runbook/breakdown (16–20 jp) |
| | `3efa582` | **Étape 2** — squelette `admin/` (:3001, zéro DB, health 2 états ×2 modes), compose 3e service, vhost nginx |
| | *(ce commit)* | preuves `ADM-step1-2.md` + état global |

**⚠️ Nuance de déploiement (drift par rapport à ADM-rupture §8)** : le `main` local contient **désormais aussi l'Étape 0** — pousser `main` aujourd'hui déclenche `deploy-vps.yml` et **applique la migration 0004 en prod**. Le code Étape 0 est fail-safe (surface admin fermée aux humains sans sessions), mais la séquence opérateur doit rester : **O-B (SELECT counts) AVANT O-A (push)**.

### 6.3 Reste à faire, par bloc (efforts estimés)
| Bloc | Contenu | Effort restant |
|---|---|---|
| **A — Admin** | Étapes 3–10 (auth+TOTP+break-glass, RBAC+token, dashboard, queue UI, users UI, audit viewer, four-eyes, tests+preuves) | **16–20 jp** (breakdown fin : `docs/specs/ADM-breakdown.md`) |
| **B — Médias & services** | B1 socle · B2 images · B3 vocal · C1 push · C2 appels audio · C3 vidéo · C4 groupes MLS · D1 recherche · D2 Sybil · D3 durcissement | **24–35 jp** (ordres de grandeur — breakdown fin à chaque démarrage) |
| **C — Frontend mature** | E cohérence écrans · F UI des services · G multi-appareils + i18n | **9–14 jp** (ordres de grandeur) |
| **Total projet après ADM** | | **≈ 49–69 jp** |

Dépendances fermes (rappel) : Étapes 3+4 **avant** tout déploiement admin · ADM vert **avant** déploiement B1 · dev parallèle OK (worktree B1 possible dès validation des présentes), déploiement ordonné ADM → B1 · frontend mature après A+B.

### 6.4 Actions opérateur ouvertes
| ID | Action | Note |
|---|---|---|
| **O-B** | Confirmer counts legacy prod = 0 (4 SELECT, en-tête migration 0004) | **À faire AVANT O-A** |
| **O-A** | Pousser `main` (⚠️ déclenche deploy + migration 0004 en prod ; reword des 2 commits UUID avant) | après O-B |
| **O-C** | Pousser `feat/adm-mvp` + PR schema-guard (verte, fermée sans merge) | démonstration CI du garde sur le cas réel 0004 |
| **O-D** | Risque résiduel token GitHub assumé (décision opérateur documentée) | — |
| — | CF Access (application CF sur `admin.mbotemesh.aenews.online`) | au déploiement ADM (runbook §3) |
| — | O-4 (provision `ADMIN_API_KEY`) | **gel maintenu** — la rupture rend la clé inutile |

### 6.5 Prochaine étape développeur
**Étape 3+4 livrées ensemble** (login+TOTP+sessions+break-glass, puis RBAC+token interne) dès validation des présentes — c'est ce qui ouvre l'admin fonctionnellement. B1 ne démarre qu'après, en worktree parallèle, sans jamais devancer le déploiement ADM.
