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
git -C /home/z/my-project worktree add /home/z/wt-adm feat/mbote-v1   # re-création
# puis dans le worktree : bun install && bunx prisma generate (piège §1)
```

Leçon : **commit tôt, commit souvent** — seul ce qui est commité survit à un
flip (§2b ci-dessous).

**Règle non négociable (ADM et B1, toute branche future)** :

1. Tout le travail se fait dans un worktree EXTERNE au repo principal —
   chemin canonique `/home/z/wt-<piste>` (ex. `/home/z/wt-adm` pour la piste
   adm, `/home/z/wt-b1` pour la piste média).

   **Consolidation (2026-11-12, Clarification 1 vague C3+C4)** : il n'y a plus
   qu'UNE branche de travail, `feat/mbote-v1` (ex-`feat/adm-mvp`).
   `feat/b1-media-foundation` est archivée sous `archive/b1-media-foundation`
   (historique conservé, renommage pur — elle était déjà entièrement contenue
   dans l'union D1+C2). **Tous les worktrees travaillent sur
   `feat/mbote-v1`. Un worktree par piste de travail active (adm/média), pas
   par feature.** Git interdisant deux worktrees sur la même branche :
   `wt-adm` porte le checkout de la branche, `wt-b1` est en HEAD détaché sur
   le même commit — les commits faits dans `wt-b1` avancent la branche par
   `git -C /home/z/wt-adm merge --ff-only <hash>` (fast-forward, jamais de
   merge-commit). Preuve : `docs/proofs/CONSOLIDATION.md`.
2. **LA SEULE commande git tolérée dans `/home/z/my-project`** est la création
   du worktree (elle ne touche pas `HEAD` du repo principal) :

   ```bash
   git -C /home/z/my-project worktree add /home/z/wt-adm feat/mbote-v1
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
git -C /home/z/my-project worktree add /home/z/wt-adm feat/mbote-v1
# 1b. piste média : wt-b1 en HEAD détaché (même branche — double checkout
#     interdit par git) ; les commits y avancent la branche par ff-only.
git -C /home/z/my-project worktree add --detach /home/z/wt-b1 feat/mbote-v1
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

## 4b. DB au boot : toute opération de configuration doit valider son résultat (Clarification 1, vague D1+C2)

> **Toute opération de configuration DB au boot doit valider son résultat.
> `$executeRawUnsafe` ne retourne pas de ligne — utiliser `$queryRawUnsafe`
> pour PRAGMA.**

Classe de bug fondatrice (constat Étape 10) :
`$executeRawUnsafe('PRAGMA journal_mode=WAL')` rejetait
« Execute returned results » **sans lever d'erreur côté appelant** — 4
instances de module par process posaient le WAL en silence raté (contenu en
DELETE → convois de verrous). La règle est désormais appliquée dans
`src/lib/db.ts` :

1. le PRAGMA utilise `$queryRawUnsafe` (il retourne une ligne) ;
2. le retour est **inspecté** par `assertBootPragmaResult()` — un mode
   inattendu lève ;
3. tout échec de transport (SQLITE_BUSY, fichier illisible) est **propagé** —
   jamais absorbé par un `console.error` ;
4. au boot, un échec = **fail-fast** (crash loud + restart container) plutôt
   que continuation silencieuse sur une DB mal configurée.

Harnais de non-régression : `tests/db-boot-pragma.test.ts` (S1 validation
pure, S2 happy path WAL persistant, S3 SQLITE_BUSY par process tiers → rejet,
S4 fichier illisible → rejet). Constat de probe : les verrous POSIX advisory
sont **par-process** — bun:sqlite et Prisma dans le même process ne se
disputent JAMAIS un verrou ; le S3 doit verrouiller depuis un process enfant.

Toute future PRAGMA/DDL au boot (ex. PRAGMA synchronous, warmup FTS) doit
suivre les 4 points ci-dessus et étendre `verifyBootPragmas()`.

---

## 4c. Recherche D1 : FTS5 = SQL brut versionné, hors schema.prisma — même précédent que 4b

La table virtuelle `PostFTS` (index plein-texte du fil public) et ses trois
triggers vivent dans la migration
`prisma/migrations/20261110100000_0009_d1_post_fts/migration.sql` — **pas** dans
`schema.prisma` (Prisma ne modélise pas les tables virtuelles FTS5 ; même
précédent que les triggers append-only 0004). Conséquences :

- **Prérequis bloquant** : FTS5 doit être compilé dans le SQLite embarqué de
  Prisma — sonde obligatoire avant tout code : `bun scripts/d1-fts5-probe.ts`
  (exit 1 = D1 s'arrête ; plan B documenté dans la migration).
- **`migrate deploy` lève LOUD** en cas d'échec de la DDL (Clarification 1 :
  aucune config DB silencieuse) — ne pas « réparer » avec un try/catch.
- La frontière de recherche est **structurelle** : `/api/search` ne sert que le
  fil public (`type=dms` → 400) ; les DM se cherchent localement
  (`src/lib/mbote/dm-search-index.ts`, IndexedDB, zéro réseau — preuve
  `docs/proofs/D1-search.md` §5) et l'index local est purgé par le panic wipe
  (`identity.ts panicWipe` → `clearDmSearchIndex`).

Runner de preuve rejouable : `bash scripts/d1-search-proof-run.sh` (sonde →
build → migrations → seed piégé → serveur :3163 → 9 tests API → preuve
navigateur Chromium → greps frontière → check-merge-clean).

---

## 4d. INVARIANT SQLite : toute mutation de données dans une route API DOIT être dans une `$transaction` Prisma — `tx` obligatoire pour les appels internes (formalisé vague D2/D3, 3ᵉ occurrence : P2028)

> **INVARIANT NON NÉGOCIABLE** : toute mutation de données dans une route API
> DOIT être dans une `$transaction` Prisma et utiliser `tx` pour les appels
> internes. Les écritures hors transaction sur SQLite provoquent des
> deadlocks/lock timeouts. **Exception documentée** : si l'opération est
> strictement unique et idempotente (ex. AdminAudit séquentiel), justifier par
> commentaire.

### Les 3 occurrences de la classe

Classe de bug récurrente : **écriture via le client global `db` (1) hors
transaction, ou (2) pire — PENDANT qu'une transaction est ouverte**. SQLite
verrouille le fichier à l'écriture : un `db.*` global pendant une `tx` ouverte
se bloque lui-même (pool de connexions distinctes) → deadlock 5 s → P2028
« transaction already closed » ou lock timeout.

1. **Deadlock** — `writeAdminAudit` appelé via le client global DANS une
   `$transaction` ouverte (cancel d'intention admin, vague Étape 10) :
   pool bloqué 5 s par cancel, attrapé par le harnais au 2ᵉ run. Fix :
   `writeAdminAudit({ tx, … })` — commentaire `⚠️ tx OBLIGATOIRE` sur le site
   (`src/lib/mbote/pending-action.ts`).
2. **TOCTOU** — deux super-admins créent la même intention concurrente : le
   `findFirst` de doublon passe des deux côtés. Fix STRUCTUREL : index unique
   partiel `pending_action_unique_open` (migration 0008) + catch P2002 → 409
   avec l'intention gagnante. Leçon : le TOCTOU se règle par une contrainte
   DB, pas par un test préalable (`src/lib/mbote/pending-action.ts`).
3. **P2028** — `commitUsageIncrement` appelé hors `tx` (vague D2, plafonds
   Sybil) : l'incrément du compteur partait sur le client global pendant que la
   tx du post était ouverte → P2028 à l'écriture concurrente. Fix : signature
   `commitUsageIncrement(userId, verdict, kind, tx?)` + appelants
   `/api/posts` et `/api/dms` passent leur `tx`.

### Pattern obligatoire

```ts
// ✅ CORRECT — une seule $transaction, tx passé aux appels internes
const created = await db.$transaction(async (tx) => {
  const post = await tx.post.create({ data });
  await commitUsageIncrement(author.id, quota, "posts", tx); // tx OBLIGATOIRE
  await writeAdminAudit({ tx, action: "…", … });             // tx OBLIGATOIRE
  return post;
});
```

Règles dérivées :
1. Tout helper qui écrit (`writeAdminAudit`, `commitUsageIncrement`,
   `revokeAdminSession`…) accepte un paramètre `tx?` et écrit via `tx ?? db` —
   **l'appelant dans une `$transaction` DOIT passer son `tx`**.
2. Pour les sections critiques admin multi-écritures, enchaîner
   `withWriteLock(() => db.$transaction(...))` (mutex process global,
   `src/lib/mbote/write-mutex.ts`) — l'ordre global des écritures reste
   séquentiel et le pool ne s'auto-bloque jamais.
3. Le TOCTOU se règle par contrainte DB (index unique partiel) + catch P2002,
   jamais par un seul `findFirst` préalable.
4. Jamais de `await db.*` (client global) à l'intérieur d'un callback
   `$transaction` — c'est exactement le deadlock de l'occurrence 1.

### Exception documentée (classe « unique + idempotent »)

Une **écriture unique atomique** (un seul statement) hors toute transaction
ouverte n'entre pas dans la classe de bug : le statement est son propre
monde transactionnel. Condition cumulatives : (a) UNE seule écriture, (b)
idempotente par contrainte (PK/unique) ou par sémantique (`update: {}`,
`deleteMany` par clé), (c) aucune `$transaction` ouverte au moment de l'appel,
(d) **justification par commentaire** sur le site. Exemples conformes :
`consumePowChallenge` (PK unique + fail-closed), `report.create` (P2002 →
idempotence), `block.upsert` (`update: {}`), read-receipts `updateMany`.

### Constat d'application — grep `writeAdminAudit|commitUsageIncrement|db\.\w+\.(create|update|delete)` (2026-11-13, commit 25aaa56, 25 fichiers src/)

**Conformes en `$transaction` + `tx`** :

| Site | Structure |
|---|---|
| `src/app/api/posts/route.ts` | `$transaction` : post.create + replyCount + `commitUsageIncrement(tx)` ✅ |
| `src/app/api/dms/route.ts` | `$transaction` DM + `commitUsageIncrement(tx)` ✅ |
| `src/lib/mbote/user-moderation.ts` ×3 | `withWriteLock` + `$transaction` + `writeAdminAudit({ tx })` ✅ |
| `src/lib/mbote/pending-action.ts` (execute/cancel) | `withWriteLock` + `$transaction` + `writeAdminAudit({ tx })` ✅ |
| `src/lib/mbote/sybil-server.ts` `sweepPostReputation` | `$transaction` (updateMany + user.update) ✅ |
| `src/app/api/follows/route.ts` (follow) | `$transaction` (upsert + FollowCredit anti-farm) ✅ |
| `src/app/api/groups/route.ts` | create nested (membres + enveloppes) = tx implicite Prisma ✅ |
| `src/app/api/seed/route.ts` (replies/likes) | `$transaction([])` array (create + compteur) ✅ |

**Exception classe « unique + idempotent » (conformes, commentaire présent)** :
`consumePowChallenge` (PK unique fail-closed), `/api/report` (P2002 idempotent),
`/api/block` (upsert `update:{}` / deleteMany), `/api/follows` unfollow
(deleteMany), `/api/media/upload-url` + `/finalize` (machine à états single),
`/api/push/unsubscribe` (updateMany), `/api/dms` read-receipts (updateMany),
`state-store.ts` purge (deleteMany), `/api/mls/keypackages/[userKey]` (delete
unique), groupes messages (create unique), audits séquentiels login/logout/
break-glass `auditFailure`/`totp-enroll` audit (AdminAudit séquentiel, aucune tx
ouverte), `admin-auth.ts` `lastSeenAt` (single-row par requête).

**ÉCARTS identifiés lors de l'audit (grep 2026-11-13) — RÉSOLUTIONS vague
durcissement (aucun ne disparaît sans trace ; fixés OU acceptés avec
justification en commentaire sur le site)** :

| Site | Écritures | Résolution (vague durcissement) | Commit |
|---|---|---|---|
| `/api/internal/admin/break-glass` | burn code → revoke sessions → reset TOTP (3 writes) | ✅ **CORRIGÉ — ATOMIQUE** : `executeBreakGlass` (src/lib/mbote/admin-break-glass.ts) = withWriteLock + `$transaction` (burn→revoke→reset→session→audit, `tx` aux 3 helpers via nouvelles signatures `tx?` de createAdminSession/revokeAllAdminSessions). Crash = rollback complet (code réutilisable, sessions actives, TOTP inchangé). Harnais R1/R2 (crash simulé mock.module)/R3 : 3/3 | `640893a` |
| `/api/internal/admin/totp-enroll` | update TOTP + audit (2 writes) | ✅ **CORRIGÉ — ATOMIQUE** : enrollment + audit dans la même `$transaction` (withWriteLock) | `3a7c073` |
| `/api/dms/bot` | create msg user + create réponse bot (2 writes) | ✅ **CORRIGÉ — ATOMIQUE** : les 2 creates dans une `$transaction` ; le chiffrement de la réponse est préparé AVANT la tx (jamais de verrou SQLite tenu pendant la crypto) | `83277a5` |
| `/api/mesh/bridge` | marque `meshIngest.create` AVANT post/DM create | ✅ **CORRIGÉ — ATOMIQUE par paquet** : analyse = le retry idempotent NE fonctionnait pas (marque persistée sans contenu → dédup hash masquait la perte définitivement) → marque + contenu dans la même `$transaction` par paquet ; échec = rollback complet = re-remise possible ; garde anti-rejeu DM dans la tx (`prismaReplayStoreFor(tx)`) ; P2002 course de marque → duplicate propre ; relayNotify APRÈS commit | `16fe0c4` |
| `/api/mls/keypackages` | create + prune deleteMany | 📄 **ACCEPTÉ — exception documentée en commentaire sur le site** : create = écriture essentielle ; prune = ramassage périodique auto-rattrapé au publish suivant ; état intermédiaire sans risque (keypackages valides, single-use) | `15c0a84` |

Leçon transverse : trois des cinq écarts étaient des séquences multi-écritures
« brûler/consommer puis régénérer » — la même forme de bug que les 3
occurrences fondatrices (§4d). Toute NOUVELLE séquence d'écriture passe par le
pattern `$transaction` + `tx` DÈS L'ÉCRITURE (ce constat est vérifié par le
runner `scripts/hardening-proof-run.sh` : grep des sites à sites corrigés).

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

---

## 6. Règle composant client — ZÉRO import node dans un fichier `'use client'` (2026-11-06, clarification direction Étape 9+C1)

> **« Aucun import node (`Buffer`, `process`, `fs`, `path`, `node:crypto`,
> `require`) dans un fichier commençant par `'use client'`. Utiliser
> exclusivement les helpers de `src/lib/mbote/`. »**

Classe de bug récurrente côté app principale — **3 occurrences** (B2/B3/B4,
dont `Buffer` dans `VideoBubble.tsx` B4 : vidéo indéchiffrable côté expéditeur)
attrapées à chaque fois par les preuves navigateur et **JAMAIS par le harnais
bun** (le harnais tourne sous bun, où `Buffer` existe — la classe est
invisible côté tests).

**Garde systémique (la 4ᵉ occurrence est désormais impossible)** :

- Règle ESLint custom `mbote-client-guard/no-node-in-client` (activée dans les
  DEUX `eslint.config.mjs` — racine ET `admin/`) : échoue le lint dès qu'un
  fichier dont la 1ʳᵉ instruction est `'use client'` importe/requiert un
  module node (`buffer|fs|path|crypto|os|child_process|util|stream|http|https|url`,
  avec ou sans préfixe `node:`), appelle `require()`, ou référence les
  globals `Buffer` / `process` (sauf `process.env.*`, remplacé inline par
  Next). Le choix « règle custom inline » plutôt que `no-restricted-imports`
  est tranché : `no-restricted-imports` ne peut pas cibler la directive
  `'use client'` (il frapperait tout le code serveur légitime).
- Grep exhaustif du 2026-11-06 (renouvelable en une ligne) :
  `rg -l "^'use client'" src/ admin/src/` croisé avec
  `rg "from '(node:)?(buffer|fs|path|crypto|os)"` — **43 fichiers
  `'use client'` (36 app principale + 7 panneau admin), 0 occurrence**
  (classe éteinte).

## 7. Discipline preuve navigateur — tout nouveau flux utilisateur (2026-11-12, Clarification 2, vague C3+C4)

> **« Tout nouveau flux utilisateur (pas seulement les fonctions isolées) doit
> avoir une preuve navigateur réelle avant validation. Les harnais bun
> valident la logique métier, pas l'intégration runtime (CSP, WebSocket, fake
> devices, hydratation). 3 vagues consécutives ont vu des bugs critiques
> (Buffer, Permissions-Policy, CSP ws://, call:offer, dialog mort) invisibles
> aux harnais — la discipline est maintenant formalisée. »**

Historique de la classe (chaque ligne = bug critique ATTRAPÉ par la preuve
navigateur, INVISIBLE au harnais bun) :

1. **B4 (Buffer)** — `Buffer` côté browser dans `VideoBubble.tsx` : vidéo
   indéchiffrable côté expéditeur. Le harnais tourne sous bun, où `Buffer`
   existe → classe invisible aux tests (§6, garde ESLint depuis).
2. **B3 (Permissions-Policy)** — `microphone=()` dans le header durci :
   MediaRecorder muet en prod, harnais vert (hors navigateur).
3. **B3 (CSP media-src)** — `blob:` manquant pour la lecture voix.
4. **C2 (CSP ws://)** — WebSocket du hub de signalisation bloqué par la CSP
   durcie : TUÉ tout le temps réel en prod (appels + DMs + relay), détecté
   uniquement par les captures navigateur C2.
5. **C2 (call:offer)** — événement de signalisation jamais reçu côté
   destinataire : flux complet vert au harnais, mort dans le navigateur réel.
6. **C2 (dialog mort)** — panneau d'appel rendu mais non cliquable (overlay
   invisible), uniquement visible en vraie session.

**Conséquence opératoire** : la check-list de validation d'une vague est
harnais + preuve navigateur + runner rejouable — une vague sans capture
navigateur du flux complet n'est pas validée, même si tous les tests passent.
Les harnais restent nécessaires (logique métier, adversarial, régression) mais
suffisants JAMAIS.
