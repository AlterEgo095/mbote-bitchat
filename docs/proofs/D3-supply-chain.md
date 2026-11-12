# D3 — SUPPLY CHAIN : triage vulns, Docker durci, épinglage, secrets

**Directive** : 2026-11-13 (vague D2+D3, worktree wt-b1 sur feat/mbote-v1) · **Statut** : VERT
**Runner rejouable** : `bash scripts/d3-supply-chain-proof-run.sh` (exit 0)
**Docs de décision** : `docs/SECURITY-TRIAGE.md` · `docs/DOCKER-HARDENING.md`

---

## 1. Triage des vulnérabilités → `docs/SECURITY-TRIAGE.md`

**État initial** (commit D2, 0ad0a40) : arbre complet 98 vulns (4 critical · 56 high ·
33 moderate · 5 low) ; **surface production seule : 11 (1 critical · 9 high · 1 moderate)**.

**Décisions (directive : patch / mitigation / acceptation)** :

- **CRITIQUE next** (DoS Image Optimizer remotePatterns + désérialisation HTTP RSC —
  self-hosted exposé) → **PATCH** : `next 16.1.3 → 16.4.6`.
- **sharp** (libvips/libheif/librsvg, traitement d'images clients) → **PATCH breaking
  assumé** : `0.34.x → 0.35.5` + adaptation `import type { Metadata }` (exif.ts).
- **prisma** (deepmerge-ts/effect via @prisma/config) → **PATCH** : `6.11.1 → 6.19.3`.
- transitives prod (postcss, source-map-js, nanoid, defu, baseline-browser-mapping,
  deepmerge-ts) → **OVERRIDES épinglés** (8.5.32 / 1.2.2 / 3.3.20 / 6.1.7 / 2.11.36 / 8.0.0).
- 13 vulns **dev-only** restantes (chaîne eslint, node-turn) → **acceptations
  justifiées** par vuln (§3 du triage) ; 2 patch-safe (brace-expansion 1.1.22, ajv 6.15.0).

**Résultat mesuré** : `npm audit --omit=dev` → **found 0 vulnerabilities**
(`docs/proofs/assets/d3-audit-prod.txt`) — et la CI resserre : `security.yml` rend
l'audit prod **BLOQUANT** (`--omit=dev --audit-level=high`, sans continue-on-error).

**Décision lockfile** : le package-lock.json généré pour npm audit n'est PAS suivi
(.gitignore) — bun.lock reste la source de vérité unique ; security.yml le régénère
à chaque run (--package-lock-only).

**Incident d'outillage découvert et corrigé** : le job npm audit de `security.yml`
était **cassé depuis C4 sans le savoir** — `npm install --package-lock-only` échouait
en ERESOLVE (ts-mls@1.6.4 exige un peerOptional @hpke/chacha20poly1305@"1.8.0" EXACT,
le projet dépend de ^1.8.1). Fix : `--legacy-peer-deps` documenté dans le workflow.

## 2. Docker hardening → `docs/DOCKER-HARDENING.md`

| Check (sorties réelles du runner) | Résultat |
|---|---|
| `USER` non-root ×3 | `Dockerfile → USER mbote` · `relay → USER relay` · `admin → USER admpannel` (`d3-dockerfiles-user.txt`) |
| `read_only: true` ×3 | mbote + relay + admin (`d3-compose-config.json`) |
| `security_opt: no-new-privileges:true` ×3 | idem |
| `cap_drop: [ALL]` ×3 (pas de cap_add : ports > 1024) | idem |
| écritures autorisées | `/app/db` (volume) · `/tmp` + `/app/.next/cache` (tmpfs) |
| YAML validé par parser | `d3-compose-config.json` (3 services, tous les champs verts) |

**Procédure VPS pour le volume existant** (reprise du TODO historique du Dockerfile,
exécutée en D3) : `compose down` → `chown -R 10001:10001 <volume mbote-data>` →
`compose up` → garde `/api/stats` + `docker exec mbote-mesh id` → uid=10001.

## 3. Dépendances épinglées + licences

- Épinglage **exact (sans ^)** des libs critiques : `web-push 4.0.0`, `@node-rs/argon2
  2.2.2`, `qrcode 1.5.4` (+@types 1.5.6), `ts-mls 1.6.4`, `@hpke/chacha20poly1305 1.8.1`
  — plus les patchs runtime exacts (next/prisma/sharp) et les overrides transitives
  (§ SECURITY-TRIAGE.md §2 et §4).
- Licences revérifiées : MIT partout (ts-mls au fichier LICENSE — leçon web-push
  MPL-2.0), sharp MIT + libvips Apache-2.0 en lien statique ; aucune copyleft
  contaminante ajoutée en D3.
- Incident lint capturé : la dérive transitive `eslint-plugin-react-hooks 7.0.1 →
  7.1.1` (via le bump d'outillage) introduisait de nouvelles règles `error` et
  changeait la baseline lint — **figé à 7.0.1 par override** (outil dev, aucune
  règle de sécurité : la baseline lint doit rester stable par vague).

## 4. Digests Docker — renouvellement VÉRIFIÉ EN DIRECT

`docs/proofs/assets/d3-bun-digest.json` (registry API, 2026-11-12T21:36Z puis re-check) :

```
pinned            : sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
currentTag1Digest : sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
upToDate          : true
```

**Bug d'extraction capturé au premier passage** : le runner prenait le 1ᵉʳ sha256 du
Dockerfile (frontend BuildKit `docker/dockerfile:1@sha256:4edf89…`) au lieu du digest
oven/bun:1 → `upToDate: false` FAUX. Corrigé (grep ancré `oven/bun:1@sha256:`) —
l'asset régénéré fait foi.

## 5. Secrets → `d3-secrets-scan.txt`

`bash scripts/d3-secrets-scan.sh` (motifs documentés — trufflehog/git-secrets absents
du sandbox, le scan Trivy `secret` de security.yml couvre la même classe à chaque push) :

- **0 secret réel dans les 127 commits** (`git log --all -p` + arbre courant) —
  clés PEM · AKIA · tokens GitHub/Slack/Discord · VAPID privées · SEED_SECRET /
  ADMIN_API_KEY / MBOTE_BOT_KEY litéraux · JWK `"d":` · connection strings.
- `.env.example` : 15 variables documentées, **0 valeur littérale**.
- **2 exclusions DOCUMENTÉES** (revues à la main, listées à CHAQUE exécution — pas des
  filtres silencieux) : `a3-dev-admin-key` (clé DEV historique A3 dans les docs de
  preuve — mécanisme rupturé à ADM Étape 0 ; prod = clé vide → 403 uniforme) et
  `Passw0rd` (fixtures admin-e2e, DBs de test jetables).

## 6. Non-régression applicative (miroir du `docker run` impossible en sandbox)

- Build standalone vert avec les patchs : next 16.4.6 · sharp 0.35.5 · prisma 6.19.3
  (`tsc --noEmit` + lint verts — étapes 6-7 du runner).
- Smoke API : toutes les routes répondent comme avant les patchs
  (`d3-api-smoke.json`) : `/api/stats`, `/api/posts`, `/api/users`, `/api/channels`,
  `/api/search`, `/api/identity` → 200 ; `/api/push/config` → 503 fail-closed
  attendu (VAPID absentes en preuve).
- **Suite D2 complète re-jouée sur ce build : 15 pass / 0 fail** (PoW, plafonds,
  rate-limit, T0 mesh) — les patchs de supply chain n'ont rien régressé.
- **NON TESTÉ** : `docker run` du conteneur durci (pas de daemon Docker dans le
  sandbox — première case de PRE-DEPLOY-CHECKLIST §0 sur le VPS) ; pentest externe ;
  audit supply chain hors npm (CDN binaires prisma/sharp, provenance SLSA) ;
  rotation de clés.

## 7. Runner

```
$ bash scripts/d3-supply-chain-proof-run.sh
[d3-proof] … 1. scan secrets … 2. audits … 3. digest … 4. compose durci …
5. USER non-root … 6. build + serveur :3168 + smoke API … 7. tsc + lint
[d3-proof] OK — preuve D3 complète (assets docs/proofs/assets/d3-*)
RUNNER_EXIT=0
```

Assets : `d3-secrets-scan.txt` · `d3-audit-prod.txt` · `d3-audit-full.txt` ·
`d3-audit-bun.txt` · `d3-bun-digest.json` · `d3-compose-config.json` ·
`d3-dockerfiles-user.txt` · `d3-api-smoke.json` · `d3-summary.json` · `d3-migrate.txt`.
