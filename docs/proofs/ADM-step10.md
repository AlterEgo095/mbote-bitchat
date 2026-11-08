# ADM Étape 10 — TESTS FINAUX (intégré + charge light + résilience) : preuves

**Statut** : LIVRÉ et PROUVÉ — runner rejouable `scripts/adm-step10-proof-run.sh` **exit 0** (2026-11-08, Kinshasa WAT).
**Branche** `feat/adm-mvp` (worktree `/home/z/wt-adm`). **Discipline** : un livrable → un test → une preuve ; tout constat cite fichier:ligne.

---

## 1. Livrables (directive Étape 10) → tests → preuves

| Livrable | Test | Preuve |
|---|---|---|
| **Suite E2E intégrée** : parcours admin complet sur DB vierge | `tests/admin-step10-integrated-e2e.test.ts` — **17/17** (60 asserts) : bootstrap CLI RÉEL → login TOTP réel (email+password+code, pas de court-circuit de session) → dashboard 4 métriques → queue contient le post signalé → hide (feed sans le post, report `actioned`) → warn (`UserWarning`) → suspend 24h (`suspendedAt` posé, publication 403) → audit liste + filtre acteur + porte EXACTE (moderator 403) → four-eyes : intention 201, auto-approbation 403, 2ᵉ approbation par un AUTRE super-admin (login réel) → banni (`bannedAt`+`bannedById` = approbateur, posts masqués, **exactement 2 lignes d'audit** `pendingaction_created`+`ban`, publication 403) → logout → BFF 401 + SSR redirect | journal runner §1a (`/tmp/step10-integrated.log`) |
| **Charge light** (sanity, pas benchmark) | `scripts/adm-step10-load-light.ts` contre le build PROD standalone : **L1** 10 admins simultanés × 5 actions (queue-view, hide, warn, suspend, audit-view — 50 requêtes) → **50/50 en 200, vague 397 ms, max 143 ms** · **L2** 100 requêtes `/audit?since=24h` parallèles → **100/200, max 434 ms < 2000 ms** | `docs/proofs/assets/adm-step10-load-light.txt` |
| **Résilience** | R1 backend down → BFF **502** (session valide) + `/api/health` **503**, panneau vivant (200), **récupération 200** après relance · R2 verrou DB exclusif 6 s (migration simulée) → refus uniforme sans crash, **récupération 200** · R3 session expirée → BFF **401**, SSR **307 → login**, **zéro donnée** dans le corps | `assets/adm-step10-r1-backend-down.{txt,png}` · `assets/adm-step10-resilience-r2-r3.txt` · `assets/adm-step10-r3-session-expiree.png` |
| **Documentation opérateur** | `docs/ADMIN-OPERATIONS.md` (login, création de compte, queue, four-eyes, audit, dashboard, sessions, limites) · `docs/ADMIN-TROUBLESHOOTING.md` → `docs/ADMIN-TROUBLESHOOTING.md` (12 symptômes→résolutions) | ces fichiers |
| **Non-régression** | 6 suites : auth 83 + audit 30 + queue 30 + dashboard 22 + users 42 + four-eyes 29 = **236 verts** | journal runner §1c |
| **Captures build prod** (1440×900) | dashboard sain (4 métriques + badges), queue, audit, R1 bandeau « Backend injoignable », R3 écran de login après expiration | `assets/adm-step10-{dashboard,queue,audit,r1-backend-down,r3-session-expiree}.png` |
| **NON TESTÉ** (assumé) | charge massive (100 admins — le stress couvre 4-way et 10×5) · pentest (AVANT ouverture publique) · i18n du panneau | §5 |

Compte total : **260 tests verts** (236 + 17 + 7).

---

## 2. Point 1 — Audit exhaustif `writeAdminAudit` (directive opérateur)

**Preuve grep** : `docs/proofs/assets/adm-step10-grep-writeAdminAudit.txt` (sortie brute `rg -n`).

**14/14 sites d'appel vérifiés** (fichier:ligne au moment de l'audit) :

| Contexte | Sites | tx ? | Verdict |
|---|---|---|---|
| Dans `$transaction` | user-moderation.ts:131,194,239 (warn/suspend/unsuspend) · pending-action.ts:638 (cancel) · moderation/action/route.ts:159,227,267 (dismiss/hide/unhide) | **TOUS avec `tx`** | ✅ (fix É9 tient) |
| Hors transaction | pending-action.ts:282 (création intention — VOLONTAIRE, l'audit d'intention n'est pas lié à l'effet réversible) · break-glass:99,147 · totp-enroll:55 · login:51,66,77 · logout:39 | — (aucune tx ouverte) | ✅ zéro risque deadlock |
| Écritures directes `tx.adminAudit.create` | pending-action.ts:162 (expire), :550 (ban exécuté) | dans tx | ✅ |

**Invariant ajouté** : ADMIN-RBAC §1.9 — « Toute écriture AdminAudit dans une transaction Prisma DOIT utiliser tx, jamais le client global » + l'exception documentée de la création d'intention.

**Test stress (directive : 2 admins simultanés, même cible)** : `tests/admin-audit-stress.test.ts` — **7/7** — S1 warn+suspend simultanés (même user, 200+200, 2 lignes d'audit, reports clos une fois) · S2 hide+hide (même post) · S3 cancel-vs-approve concurrents ×3 (paires + 4-way) · S4 création simultanée (une 201, une 409) · S5 dismiss concurrent (un 200, un 409) · **zéro « database is locked » au log serveur**.

## 3. Constats RÉELS de l'Étape 10 (4 bugs corrigés + 3 constats de harnais)

Chacun attrapé par un test AVANT d'être corrigé (preuve : l'historique des runs de ce document) :

1. **Course dismiss (stress S5)** : garde `handledById` HORS transaction — deux dismiss simultanés écrivaient DEUX lignes d'audit pour un report (dernier écrivain gagne). FIX : garde `updateMany where handledById: null` DANS la tx + `DismissRaceError` → 409 propre (`src/app/api/moderation/action/route.ts:150-154`).
2. **Course de création d'intention (stress S4)** : `findFirst`→`create` TOCTOU — deux super-admins créaient 2 pendings sur la même cible. FIX : index unique **partiel** `pending_action_unique_open` (migration `0008_etape10_audit_stress` — précédent : triggers append-only 0004) + catch P2002 → 409 (`src/lib/mbote/pending-action.ts:280-300`).
3. **Contention 4-way (stress S3)** : 4 transactions interactives concurrentes → 3/4 dépassent le timeout Prisma 5 s → **4×500 en 10,3 s** (log : 5,3/5,4/10,2/10,3 s ; `busy_timeout=20s` INEfficace en expérience). FIX : `src/lib/mbote/write-mutex.ts` — **94 ms, 0 erreur**.
4. **Charge light 10-way (L1)** — trois couches de cause, chacune prouvée empiriquement :
   a. **mutex dupliqué par bundle de route** (Turbopack/webpack bundlent par route — un `tail` module-level = une chaîne PAR ROUTE) → chaîne sur **globalThis** (pattern globalForPrisma) ;
   b. **journal_mode=DELETE** : tout lecteur ouvert bloque le COMMIT des écrivains (verrou EXCLUSIVE) → **WAL au boot** dans `db.ts` — et au passage : `$executeRawUnsafe('PRAGMA journal_mode=WAL')` rejette (« Execute returned results ») — il faut `$queryRawUnsafe` (4 instances/module échouaient en silence) ;
   c. **pool Prisma ≈ 5 connexions (2 CPU)** : itx et requêtes globales se disputent connexions + verrou → timeouts en cascade P2028/P1008 quantifiés à 5 s (26/50 échecs observés sur build prod) → **`connection_limit=1` forcé dans `db.ts`** : file FIFO déterministe — le MÊME trafic passe **50/50 en 451 ms** ; 100 lectures sérialisées = 434 ms (< 2 s). Le mutex applicatif reste : il évite d'immobiliser l'unique connexion pendant l'attente d'un écrivain.
5. **P2021 « table does not exist » dans le runner** : le PRAGMA WAL de `db.ts` **ouvrait le fichier DB à l'import** — sur un harnais qui recrée sa DB, le client parlait à l'INODE SUPPRIMÉ. FIX : garde `existsSync` (`db.ts:48-54`).
6. **Side-cars WAL stale** : `rmSync(db)` seul laisse `-wal`/`-shm` — contre une DB fraîche, la visibilité du schéma se corrompt. FIX : les harnais nettoient les 3 fichiers.
7. **Le build crée un fichier DB VIDE** (prerender → première requête Prisma) : le runner exécute `migrate deploy` APRÈS le build, avant les CLI.

## 4. Résilience — ce qui est prouvé, ce qui est une limite assumée

- **R1 (backend down)** : 502/503, panneau vivant, bandeau rouge capturé (`adm-step10-r1-backend-down.png`), récupération automatique. La doctrine existe déjà dans le code (`admin/src/app/api/dashboard/route.ts:1-17` : « une erreur réseau n'est PAS une session invalide »).
- **R2 (verrou DB = migration simulée)** : refus uniforme **401 fail-closed** pendant le verrou (le verify du panneau reçoit un 5xx du backend → null → 401), récupération 200 prouvée. **LIMITE ASSUMÉE** : l'opérateur voit « session invalide » au lieu de « backend occupé » — documenté (ADMIN-TROUBLESHOOTING §4) ; le raffinement (5xx ≠ 401 au verify) toucherait ~20 sites d'appel de `verifyPanelSession` — volontairement non entrepris en Étape 10 (aucune feature, sécurité fail-closed préservée).
- **R3 (session expirée)** : BFF 401 · SSR 307 → login · **zéro donnée** dans le corps (3 clés de métriques cherchées, 0 trouvée).

## 5. NON TESTÉ (explicite)

- **Charge massive** (100 admins simultanés) : le périmètre É10 = sanity (10×5 + 100 lectures). SQLite le justifie (palier 1 — SCALE-ARCHITECTURE §8) ; le passage palier 2 = Postgres.
- **Pentest / attaques ciblées** : à faire AVANT ouverture publique (checklist §8).
- **i18n UI admin** : français uniquement.
- **Refinement 5xx≠401 au verify du panneau** (R2 — post-déploiement).
- **FCM device réel** : procédure obligatoire au premier déploiement (`C1-push.md` §4 + checklist §6.5).

## 6. Replay

```bash
bash scripts/adm-step10-proof-run.sh
# → exit 0 attendu ; assets régénérés dans docs/proofs/assets/adm-step10-*
# Durée observée : ~4-5 min (2 builds standalone + 8 suites + charge + résilience + 5 captures)
```

Après cette étape : **PAUSE DÉVELOPPEMENT** — l'opérateur exécute `docs/PRE-DEPLOY-CHECKLIST.md` (O-B → O-A → CF Access → bootstrap → tests manuels). Aucun nouveau code tant que la prod n'est pas vérifiée (décision stratégique).
