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

## 2. Worktrees : trois pièges PROUVÉS (incident A3 du 2026-11-04)

Le travail de phase se fait dans des **worktrees git externes** (`git worktree
add`), hors de portée du reset `main` du superviseur (trace de l'incident
d'origine : `docs/proofs/A1-anti-replay.md` §6). Mais trois pièges ont été
prouvés pendant A3 — ils sont la raison des patterns ci-dessous.

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

### Création d'un worktree (procédure complète)

```bash
git worktree add ../wt-aN feat/aN-branche
cd ../wt-aN
bun install && bunx prisma generate
DATABASE_URL="file:$(pwd)/db/custom.db" bunx prisma db push
```

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
