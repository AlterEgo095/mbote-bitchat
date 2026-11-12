# SECURITY-TRIAGE — triage des vulnérabilités (D3, 2026-11-13)

**Périmètre** : `bun audit` + `npm audit` (arbre complet et surface production seule) au
commit D2 (0ad0a40) puis après patchs D3. **Référentiel de décision** (directive D3) :
pour chaque vuln high/critical → **patch immédiat** / **mitigation documentée** /
**acceptation justifiée**. Les décisions sont opposables : la surface PRODUCTION est
désormais BLOQUANTE en CI (`security.yml` : `npm audit --omit=dev --audit-level=high` sans
continue-on-error).

## 1. État initial (triage, commit 0ad0a40)

| Périmètre | Critique | High | Modéré | Low | Total |
|---|---|---|---|---|---|
| Arbre complet (`bun audit` / `npm audit`) | 4 | 56 | 33 | 5 | **98** |
| **Surface PRODUCTION seule** (`npm audit --omit=dev`) | **1** | **9** | 1 | 0 | **11** |

Découverte d'outillage (blocant le triage lui-même) : `npm install --package-lock-only`
échouait en ERESOLVE depuis C4 — ts-mls@1.6.4 déclare un peerOptional
`@hpke/chacha20poly1305@"1.8.0"` EXACT alors que le projet dépend de ^1.8.1 (résolu par
bun, refusé par npm). **Le job npm audit de security.yml était donc cassé sans le
savoir.** Fix : `--legacy-peer-deps` (justifié dans le workflow).

## 2. Surface PRODUCTION — 11 vulns → décisions

| Vuln | Sév. | Décision | Détail |
|---|---|---|---|
| **next** (Image Optimizer remotePatterns DoS + désérialisation HTTP RSC DoS) | **CRITIQUE** | **PATCH immédiat** | self-hosted = notre deployment VPS → exposé. `next 16.1.3 → 16.4.6` (sort de tous les ranges : <=16.4.0, <16.3.8, <16.2.11…). Build + tsc + suite D2 15/15 re-vérifiés. |
| **sharp** (libvips CVE-2026-33327/33328/35590/35591, libheif, librsvg) | high | **PATCH immédiat** (breaking assumé) | `0.34.x → 0.35.5`. `sharp` traite des images CLIENT (pipeline médias B1) → surface exposée. Adaptation code : `import type { Metadata }` (les types ne s'exportent plus en namespace). Build + lint verts. |
| **prisma / @prisma/config** (deepmerge-ts stack exhaustion, effect ALS contamination) | high | **PATCH immédiat** | `prisma 6.11.1 → 6.19.3` (dernier 6.x ; prisma 7 = major, hors périmètre D3). migrate deploy + generate re-vérifiés. |
| **deepmerge-ts** (stack exhaustion, <8.0.0) | high | **PATCH immédiat (override)** | override `deepmerge-ts: 8.0.0` — API compatible avec @prisma/config@6.19.3 (migrate deploy + generate verts, preuve runner D3). |
| **postcss** (XSS `</style>`, source map disclosure ×2, path traversal) | high | **PATCH immédiat (override)** | `postcss: 8.5.32` — couvre la copie nested de next (`node_modules/next/node_modules/postcss`). |
| **source-map-js** (event-loop DoS, <1.2.2) | high | **PATCH immédiat (override)** | `1.2.2`. |
| **nanoid** (générateurs qui bouclent indéfiniment, <3.3.18) | high | **PATCH immédiat (override)** | `3.3.20`. |
| **defu** (prototype pollution `__proto__`, <=6.1.4) | high | **PATCH immédiat (override)** | `6.1.7`. |
| **baseline-browser-mapping** (DoS entrée invalide) | modéré | **PATCH immédiat (override)** | `2.11.36`. |
| **effect** (ALS contamination sous charge, <3.20.0) | high | **PATCH immédiat** | résolu par le bump prisma 6.19.3 (dépendance de @prisma/config). |

**Résultat : `npm audit --omit=dev` → 0 vulnérabilité.**

## 3. Dépendances de DEV — décisions (jamais déployées en production)

Après patchs : **13 vulns restantes, toutes dev-only** (la surface prod est à 0).
Elles vivent dans la chaîne ESLint (typescript-eslint, picomatch, minimatch,
brace-expansion, flatted, js-yaml, log4js — à travers eslint-config-next) et le
harnais TURN des preuves C2/C3 (`node-turn`).

| Vuln | Sév. | Décision | Justification |
|---|---|---|---|
| brace-expansion (<1.1.21, ReDoS) | high | **PATCH (override 1.1.22)** | bump patch dans la même major (1.x) — zéro risque API. |
| ajv (<6.14.0) | modéré | **PATCH (override 6.15.0)** | bump patch 6.x. |
| minimatch (<3.1.4 et 7-10.x) | high | **ACCEPTATION justifiée** | ReDoS en dev uniquement ; les deux lignes vulnérables exigent des majors DIFFÉRENTES (3.x et 7-10.x) — aucun override unique ne les couvre sans casser la chaîne eslint. Jamais en prod. Re-signalé à chaque `npm audit` (rapport artefact). |
| picomatch (2.x ReDoS + 4.x method injection) | high | **ACCEPTATION justifiée** | idem : consommateurs sur majors différentes (2.x via tinyglobby, 4.x ailleurs) ; override unique = rupture eslint. Dev-only. |
| flatted, js-yaml, log4js | high | **ACCEPTATION justifiée** | AUCUN fix publié à date (2026-11-13) ; transitives de l'outillage dev (chaîne eslint/node-turn). Jamais déployées. Suivi : re-check hebdo via security.yml. |
| node-turn (misconfig DoS) | modéré | **ACCEPTATION justifiée** | harnais TURN des preuves C2/C3 (127.0.0.1, jetable) — jamais en prod ; aucune alternative testée à date. |
| @typescript-eslint/* (5 vulns modérées) | modéré | **ACCEPTATION justifiée** | fix = bump major typescript-eslint (risque de bascule lint mid-wave, cf. incident react-hooks 7.1.1 → règles nouvelles en error) ; dev-only. Suivi hebdo. |

**Règle de resserrage** : toute NOUVELLE vuln high+ en PROD casse la CI (bloquant) ;
les dev-only sont revues chaque lundi (security.yml, artefact npm-audit-report).

## 4. Épinglage des dépendances critiques (directive D3)

`package.json` : les libs critiques de sécurité sont désormais épinglées SANS `^`
(reproductibilité supply chain — une range permet à un registry compromis de servir
une version différente) :

| Lib | Rôle | Épinglage |
|---|---|---|
| web-push | Web Push VAPID (knocks C1) | `4.0.0` exact |
| @node-rs/argon2 | hash des sessions admin | `2.2.2` exact |
| qrcode (+@types/qrcode) | QR du runbook admin | `1.5.4` / `1.5.6` exacts |
| ts-mls | MLS RFC 9420 (C4) | `1.6.4` exact |
| @hpke/chacha20poly1305 | HPKE (ts-mls) | `1.8.1` exact |
| next / prisma / @prisma/client / sharp | runtime | `16.4.6` / `6.19.3` / `0.35.5` exacts (patchs de sécurité §2) |
| eslint-plugin-react-hooks | outil dev | `7.0.1` via override — FIGÉ : la dérive 7.1.1 introduisait de nouvelles règles `error` et changeait la baseline lint mid-wave (incident capturé pendant D3) |

Licences revérifiées (directive) : ts-mls MIT (fichier LICENSE vérifié — Cl. 4 vague C4),
web-push MIT, @node-rs/argon2 MIT, @hpke/* MIT, sharp MIT (licence Apache-2.0 pour
libvips en lien statique — compatible), qrcode MIT. Aucune licence copyleft
contaminante ajoutée pendant D3.

## 5. Digests Docker (renouvellement vérifié — directive D3)

Vérification EN DIRECT via registry API (2026-11-13) :

```
GET https://registry-1.docker.io/v2/oven/bun/manifests/1
→ docker-content-digest: sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
PINNED: sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
→ IDENTIQUES : l'épinglage des 3 Dockerfiles (app, relay, admin) est À JOUR,
  aucun renouvellement nécessaire.
```

## 6. Secrets (scan complet)

`bash scripts/d3-secrets-scan.sh` — motifs sur les **127 commits** de tout
l'historique (`git log --all -p`) + arbre courant + audit `.env.example` :

- clés PEM (RSA/EC/OPENSSH/PGP) : 0 hit
- AKIA AWS / tokens GitHub / Slack / Discord : 0 hit
- VAPID_PRIVATE_KEY / SEED_SECRET / MBOTE_BOT_KEY / tokens internes litéraux : 0 hit
- JWK privées (`"d":`) : 0 hit
- connection strings avec credentials : 0 hit
- `.env.example` : 15 variables documentées, **0 valeur littérale** (placeholders)
- **2 exclusions DOCUMENTÉES** (revues à la main, listées à chaque exécution) :
  `a3-dev-admin-key` (clé DEV historique A3 dans les docs de preuve — le mécanisme
  qu'elle ouvrait a été rupturé à ADM Étape 0 ; prod = clé vide → 403 uniforme) et
  `Passw0rd` (fixtures admin-e2e, DBs de test jetables).
- `trufflehog`/`git-secrets` absents du sandbox → scan par motifs documenté (le scan
  Trivy `secret` de security.yml couvre la même classe à chaque push).

## 7. NON TESTÉ (directive)

- Pentest externe (à faire AVANT ouverture publique).
- Audit supply chain au-delà de npm (registry OCI mis à part : CDN de distribution
  des binaires prisma/sharp, provenance SLSA, attestations build).
- Rotation de clés (VAPID, TURN, sessions admin) — procédure à écrire à la vague D4+.
- `docker run` du conteneur durci : le sandbox N'A PAS de daemon Docker
  (`docker: command not found`) — la validation est faite par (a) YAML compose
  validé + (b) construction statique des Dockerfiles revue + (c) les mêmes
  invariants testés localement (app standalone :3168, routes API 200 — runner D3).
  Le `docker compose build && docker compose up` + `whoami` (uid 10001) est la
  PREMIÈRE case de PRE-DEPLOY-CHECKLIST à cocher sur le VPS.
