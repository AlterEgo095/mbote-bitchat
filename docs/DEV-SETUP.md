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
DATABASE_URL="file:/home/z/wt-aN/db/custom.db" bunx prisma db push
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
