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

## 2. Worktrees : le superviseur rétablit `main` entre les tours d'outils

L'environnement d'exécution (le « superviseur ») force le checkout de `main`
dans `/home/z/my-project` entre les tours d'outils de l'agent — cause racine de
l'« incident superviseur (main forcé 2×) » documenté dans
`docs/proofs/A1-anti-replay.md` §6.

**Pattern de travail de phase** : worktree git externe, hors de portée du
reset, + génération Prisma explicite (§1) :

```bash
git worktree add ../wt-aN feat/aN-branche
cd ../wt-aN
bun install && bunx prisma generate
DATABASE_URL="file:./db/custom.db" bun run db:push   # DB locale au worktree
```

Le worktree a ses propres `node_modules` et sa propre DB SQLite
(`DATABASE_URL` relatif) — les tests E2E y tournent sans toucher à l'instance
principale.

---

## 3. Rappels stables

- **Port** : le serveur dev principal tourne sur :3000 ; un serveur de test de
  phase se lance sur un port libre (ex. :3100) avec `PORT=3100 bun run dev`.
- **Preuves de possession** : toute mutation utilisateur est signée ECDSA
  (chaînes canoniques dans `src/lib/mbote/proof.ts`) — fraîcheur 7 j / dérive
  future 60 s (`ACTION_MAX_AGE_MS`).
- **Lint** : `bun run lint` (ESLint Next.js) — à passer avant tout commit de
  code, y compris dans les worktrees.
