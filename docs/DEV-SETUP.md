# DEV-SETUP — notes d'environnement de développement

Notes opérationnelles pour tout workflow CI/local du repo. Court et factuel —
chaque entrée ici a causé au moins un incident réel.

---

## 1. bun + Prisma : `postinstall` n'est PAS exécuté

**Pattern obligatoire** — `bun install` ne déclenche pas le script `postinstall`
par défaut → le client Prisma n'est **pas** généré automatiquement. Tout
workflow (CI comme local) doit appeler explicitement :

```bash
bun install && bunx prisma generate
```

Sans lui : `@prisma/client` n'exporte pas les modèles du schéma
(`Property 'xxx' does not exist on type 'PrismaClient'`) — erreur déjà
revenue à l'identique dans la CI A1 **et** la CI A2 avant correction
(commits `441c927` puis `0c7d4c3`).

**Endroits où le pattern est appliqué** :
- `.github/workflows/tests.yml` — étape `bunx prisma generate` avant `bun test` ;
- création d'un worktree local (voir §2) ;
- tout nouveau workflow : copier l'étape existante, ne pas supposer `postinstall`.

---

## 2. Worktrees : EXTERNE OBLIGATOIRE + trois pièges PROUVÉS (incidents A3 2026-11-04, ADM 2026-11-05)

### 0. Worktree EXTERNE = OBLIGATOIRE pour toute branche de travail (récidive : 4 flips)

Quatre incidents prouvés (A1/A2, ADM Étape 0, ADM Étapes 1+2, ADM Étape 5 —
2026-11-05) : le superviseur du sandbox a remis `HEAD` du repo principal sur
`main` PENDANT le travail — les commits d'Étape 0 ont atterri sur `main` et
ont dû être réalignés sur `feat/adm-mvp` (reflog 2026-11-05, §3.7 de la preuve
ADM-step1-2). La cause racine est l'environnement, pas les commandes : **la
mitigation par commande atomique ne suffit pas**.

**Récidive #4 (Étape 5) — sans coût grâce à la règle** : le flip a ÉGALEMENT
supprimé le répertoire du worktree `/home/z/wt-adm` (fichiers non commités
du tour précédent). Aucune perte : les commits étaient durables dans le repo
principal. **Récupération canonique** (la seule intervention tolérée sur le
repo principal, cwd HORS de `/home/z/my-project`) :

```bash
git -C /home/z/my-project worktree prune                              # métadonnées orphelines
git -C /home/z/my-project worktree add /home/z/wt-adm feat/adm-mvp    # re-création
# puis dans le worktree : bun install && bunx prisma generate (piège §1)
```

Leçon : **commit tôt, commit souvent** — seul ce qui est commité survit à un
flip (§2b ci-dessous).

**Règle non négociable (ADM et B1, toute branche future)** :

1. Tout le travail d'une branche se fait dans un worktree EXTERNE au repo
   principal — chemin canonique `/home/z/wt-<branche>` (ex. `/home/z/wt-adm`
   pour `feat/adm-mvp`, `/home/z/wt-b1` pour B1).
2. **LA SEULE commande git tolérée dans `/home/z/my-project`** est la création
   du worktree (elle ne touche pas `HEAD` du repo principal) :

   ```bash
   git -C /home/z/my-project worktree add /home/z/wt-adm feat/adm-mvp
   ```

3. Ensuite, **zéro** commande git dans le repo principal. Tout se fait avec
   `git -C /home/z/wt-adm …` (status, add, commit, log, diff). Le repo
   principal reste sur `main` = état déployé ; un flip éventuel redevient
   sans effet (HEAD y est déjà, le worktree est hors de sa portée).
4. Après création du worktree : `bun install && bunx prisma generate` dedans
   (piège postinstall §1) — et surcharge explicite de `DATABASE_URL` sur
   chaque commande (piège §2a ci-dessous).
5. Les artefacts non commités d'un worktree ne survivent pas toujours aux
   tours d'outils (piège §2b) : **commit tôt, commit souvent**, et les
   preuves E2E se rejouent from scratch dans un même tour.

Le travail de phase se fait donc dans des **worktrees git externes** (`git
worktree add`), hors de portée du reset `main` du superviseur (trace de
l'incident d'origine : `docs/proofs/A1-anti-replay.md` §6). Trois pièges ont
été prouvés pendant A3 — ils sont la raison des patterns ci-dessous.

### a. `DATABASE_URL` est exporté GLOBALEMENT par le sandbox — il écrase tout `.env`

Le shell fournit `DATABASE_URL=file:/home/z/my-project/db/custom.db`. Toute
commande qui ne le surcharge **pas explicitement** (serveur de test, CLI
Prisma, scripts bun) écrit dans la DB du repo **principal** — même lancée
depuis un worktree avec son propre `.env` (précédence : variable d'environnement
du processus > fichier `.env`).

**Incident réel** : les données de test A3 (identités, posts, signalements,
traces d'audit) ont été écrites dans la DB de l'app :3000 — nettoyées depuis,
et l'isolation est désormais prouvée par le système de fichiers (point c).

**Pattern obligatoire — surcharge explicite sur CHAQUE commande** :

```bash
DATABASE_URL="file:/home/z/wt-aN/db/custom.db" bunx prisma db push  # ⚠️ §4 : provisioning d'une DB éphémère UNIQUEMENT — jamais pour faire évoluer le schéma
DATABASE_URL="file:/home/z/wt-aN/db/custom.db" ADMIN_API_KEY=… bunx next dev -p 3100
DATABASE_URL="file:/home/z/wt-aN/db/custom.db" bun scripts/…  # et les tests E2E qui vérifient la DB
```

### b. Les artefacts non commités des worktrees ne survivent pas aux tours d'outils

Le superviseur restaure l'espace de travail entre les tours d'outils : un
fichier SQLite créé dans un worktree peut disparaître d'un tour au suivant
(seuls les COMMITS sont durables). **Conséquence** : les preuves E2E se rejouent
from scratch DANS UN MÊME tour (db:push → serveur → tests → vérifs → kill) —
c'est le protocole des rapports de preuves.

### c. Vérifier l'isolation par le système de fichiers (re-jouable)

```bash
touch /tmp/marker
# … toutes les preuves (serveur + E2E + CLI) …
find /home/z /tmp -name "*.db" -newer /tmp/marker -not -path "*/node_modules/*"
# → seul le .db du worktree doit apparaître ; celui du repo principal ne bouge pas
```

### Création d'un worktree (procédure complète — canonique)

```bash
# 1. LA SEULE commande git dans le repo principal (ne touche pas son HEAD) :
git -C /home/z/my-project worktree add /home/z/wt-adm feat/adm-mvp
# 2. Tout le reste se fait DANS le worktree :
cd /home/z/wt-adm
bun install && bunx prisma generate
DATABASE_URL="file:$(pwd)/db/custom.db" bunx prisma migrate deploy
# 3. Chaque commande (serveur, CLI, tests) surcharge DATABASE_URL explicitement :
DATABASE_URL="file:$(pwd)/db/custom.db" ADMIN_INTERNAL_TOKEN=… bunx next dev -p 3100
# 4. git exclusivement via -C :
git -C /home/z/wt-adm add … && git -C /home/z/wt-adm commit …
```

---

## 2c. Captures navigateur : BUILD PRODUCTION obligatoire (hydratation dev Turbopack muette)

**Incidents prouvés (ADM Étapes 3+4 puis Étape 5)** : en `next dev`
(Turbopack), l'app admin **ne s'hydrate pas** — SILENCIEUSEMENT (aucune erreur
console ; détecté par sonde `__reactFiber$` sur le DOM). Les clics ne
produisent aucun effet, les états client ne se montent pas. En **build
production** (`next build` + `next start`) l'hydratation fonctionne.

**Pattern obligatoire pour toute preuve navigateur (agent-browser)** :

```bash
# dans le worktree — JAMAIS next dev pour capturer :
bunx next build                            # app principale OU admin selon la preuve
bunx next start -p 3102                    # (ou le port de preuve) — NODE_ENV=production
```

- Les captures sont prises contre les builds production des DEUX apps quand la
  chaîne complète est en jeu (panneau :3102 ↔ principale :3101).
- Cause racine suspectée : frontière `use client` mal placée ou composant
  serveur/client mélangé — **non déboguée volontairement** (aucun impact prod :
  le déploiement est standalone/build). Si un jour elle bloque les preuves,
  la tracer comme incident à part entière.

---

## 3. Rappels stables

- **Port** : le serveur dev principal tourne sur :3000 ; un serveur de test de
  phase se lance sur un port libre (ex. :3100) avec `PORT=3100 bun run dev`.
- **Preuves de possession** : toute mutation utilisateur est signée ECDSA
  (chaînes canoniques dans `src/lib/mbote/proof.ts`) — fraîcheur 7 j / dérive
  future 60 s (`ACTION_MAX_AGE_MS`).
- **Lint** : `bun run lint` (ESLint Next.js) — à passer avant tout commit de
  code, y compris dans les worktrees.

---

## 4. Schéma : migrations versionnées OBLIGATOIRES — `db push` interdit pour évoluer (incident I-2)

**Incident (2026-11-05, audit I-2)** : prod en 500 pendant ~12 min — le delta
A1/A2/A3 n'avait jamais été versionné : dev en `prisma db push`, prod en
`prisma migrate deploy` (CMD du conteneur, F-36) → no-op → nouveau client
Prisma sur ancien schéma (`suspendedAt`/`hiddenAt`… absentes). Cause
**systémique, pas ponctuelle** : tant que le processus n'est pas durci, la
prochaine modification de schéma recassera la prod à l'identique.

**Interdiction stricte** : `prisma db push` est interdit pour toute
**modification** de `prisma/schema.prisma` (en dev comme « plus rapide »).

**Pattern obligatoire** :

```bash
DATABASE_URL="file:$(pwd)/db/custom.db" bunx prisma migrate dev --name <phase>
# → commit du dossier généré prisma/migrations/<n>_<phase>/ DANS LA PR DE LA PHASE
```

**Garde CI non négociable** : `.github/workflows/schema-guard.yml` — ROUGE si
`prisma/schema.prisma` change sans qu'aucun fichier `prisma/migrations/**`
soit ajouté (déclenché sur PR vers `main` ET sur push `main` — le pipeline de
ce projet merge en local puis pousse directement, les PR seules ne
suffiraient pas).

**Seule exception autorisée** : provisionner une base ÉPHÉMÈRE jetable sur un
schéma **déjà versionné** — le `db/ci-test.db` de `tests.yml` et le `db push`
des worktrees (§2a). Jamais pour faire évoluer le schéma.

**Filet de sécurité prod** : le healthcheck du service `mbote`
(`docker-compose.yml`) exécute
`SELECT 1 FROM _prisma_migrations WHERE finished_at IS NOT NULL LIMIT 1` —
le conteneur ne passe `healthy` que si au moins une migration est réellement
appliquée (plus le check HTTP `/api/stats`). Un `migrate deploy` no-op ou en
échec rend le conteneur visiblement unhealthy au lieu de laisser un 500
silencieux.

---

## 5. `mobile/` : le miroir est synchronisé au VPS — ne pas ré-exclure (incident I-1)

Le rsync du déploiement (`deploy-vps.yml`) synchronise `mobile/` vers le VPS.
**`mobile/src/core/` est sync vers le VPS car le build Docker typecheck le
miroir pour la parité protocole. Ne pas ré-exclure sans mettre à jour le
script de parité.**

Historique : l'exclusion rsync `mobile/` (avant `4d24909`) laissait un miroir
périmé sans `dedupFingerprint` (A1) → typecheck Docker en échec (run CI
41940394873). La garde de parité a joué son rôle : elle refusera de nouveau de
construire si le miroir diverge. La parité est de plus vérifiée en CI à chaque
push (`tests.yml` → `bun scripts/check-protocol-parity.ts`).
