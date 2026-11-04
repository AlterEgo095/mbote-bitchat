# RAPPORT DE PREUVE — A3 MODÉRATION (recadrage, phase A3)

**Branche** : `feat/a3-moderation` (construite SUR `feat/a2-key-auth` → contient A1 + A2 + ajouts documentaires de validation) · **Statut** : en attente de validation · **Base** : `main` = `7b51fd5`
**Référence** : R4 (modération) · Exigences de validation : endpoints report/block/moderation-action + purge tooling, file lisible admin, preuves re-jouables, périmètre fil public STRICT.

---

## 0. Périmètre — deux limites ASSUMÉES et documentées

1. **AUCUNE modération DM — impossible par conception.** Le serveur ne stocke que du chiffré E2EE (boîte aux lettres aveugle, cf. `/api/dms`) : il ne peut ni lire, ni qualifier, ni « modérer » un message privé. Ce périmètre est rappelé DANS CHAQUE endpoint concerné (`/api/report` : `targetKind` refuse `"dm"` → 400 avec rappel E2EE ; `/api/moderation/action` : `targetKind` n'admet que `post` | `user` → 400 sinon ; commentaires du schéma Prisma), et vérifié par le test S5.
2. **Auth admin PROVISOIRE** : clé API dans l'env (`ADMIN_API_KEY`, header `x-admin-key` ou `Authorization: Bearer`), comparaison timing-safe (SHA-256 + `crypto.timingSafeEqual`), **403 UNIFORME** (clé absente ou invalide — on ne distingue pas la présence de la validité). À remplacer par un RBAC complet **avant ouverture publique** (voir §4).

## 1. Ce qui a été fait

**Composants livrés** :

| Composant | Fichier | Rôle |
|---|---|---|
| Signalement utilisateur | `POST /api/report` | preuve ECDSA `${reporter}\|report\|${targetKind}\|${targetId}\|${reason}\|${ts}` (401 sinon) · cible = post/commentaire PUBLIC uniquement · idempotence `@@unique(reporter, targetKind, targetId)` (201 créé / 200 déjà-présent, convention posts) · rate limit 20/min/clé + 60/min/IP · file jamais gonflée par un même signaleur |
| Blocage de pair | `POST /api/block` | preuve ECDSA **l'action est signée** (`…\|block\|${blocked}\|${action}\|${ts}`) → un rejeu `block` ne peut pas devenir `unblock` · `action: block\|unblock` (défaut block) · idempotent (upsert/deleteMany) |
| File de modération | `GET /api/moderation/queue` | admin only (403) · chaque entrée = signalement + **CONTEXTE** : extrait du post, auteur (pubkey, nickname, suspendu ?), état hidden, **openReportsOnTarget** (poids du signalement) · `?status=open\|actioned\|dismissed\|all` |
| Actions admin | `POST /api/moderation/action` | admin only (403) · `hide` / `unhide` / `purge` (post) · `warn` / `suspend` / `unsuspend` (user) · chaque action écrit UNE trace `ModerationAction` et clôture les signalements ouverts liés (`status=actioned`, `handledAt`, `handledBy`) |
| **Purge tooling** | `scripts/moderation-purge.ts` | CLI ops : `--list [--min-reports N]` (candidates triées par poids), `--purge <id> [--execute]` (**dry-run par défaut**) · utilise le MÊME helper transactionnel que l'API (`purgePostWithAudit`) → un seul comportement d'audit · `--admin-label` tracé dans l'audit |
| Helper d'audit partagé | `src/lib/mbote/moderation.ts` | vocabulaire fermé (raisons, actions), garde admin timing-safe, `auditSnippet` (≤ 280), `purgePostWithAudit` (transaction : suppression cascade + trace + clôture reports + décrément du compteur parent D5) |
| Fil public modéré | `GET /api/posts` | exclut : posts masqués (`hiddenAt`), auteurs suspendus, **pairs bloqués par le lecteur déclaré** (`myPub`) · un fil de réponses dont le parent est masqué/suspendu/purgé → **404** (plus une surface publique) |
| Publication suspendue | `POST /api/posts` | auteur suspendu → **403** |
| DM marqués | `GET /api/dms`, `GET /api/dms/conversations` | messages du pair bloqué **RESTENT reçus mais MARQUÉS** (`fromBlocked: true`, conversation `blocked: true`) — aucun filtrage de contenu E2EE |

**Décision tranchée (demandée à la validation)** : les DMs d'un pair bloqué sont **reçus, avec option « bloquer » distincte de « masquer »** — recommandation validée : le blocage n'est NI un rejet réseau NI de la confidentialité (le fil est public par nature ; le canal DM reste E2EE et aveugle). Implémenté : flag `fromBlocked` côté API ; l'affichage UI du badge viendra avec la surface DM médias (B1) — non bloquant pour A3.

**Schéma** (Prisma) : `Report` (statut open/actioned/dismissed, indexé), `PeerBlock` (`@@unique[blocker, blocked]`), `ModerationAction` (audit : adminKey, action, cible, `reportIds` JSON, `meta` JSON), `Post.hiddenAt/hiddenBy`, `User.suspendedAt/suspendedBy`.

## 2. Ce qui a été testé — PASS/FAIL par scénario

### Harness unitaire + persistance — `bun test tests/moderation.test.ts` → **6 pass / 0 fail**

| # | Scénario | Résultat |
|---|---|---|
| U1a | `ADMIN_API_KEY` absente → aucun accès admin (même avec une clé fournie) | PASS |
| U1b | mauvaise clé → refusé · bonne clé → accepté (timing-safe) | PASS |
| U2 | `auditSnippet` : court inchangé · long tronqué ≤ 280 avec ellipsis | PASS |
| U3 | **purge transactionnelle** : post supprimé, cascade (réponse + like partis), trace `ModerationAction(action=purge)` avec auteur/extrait/compteurs, 2 reports clôturés `actioned`, compteur `replyCount` du parent décrémenté | PASS |
| U3b | purge d'un post déjà purgé/inexistant → `POST_NOT_FOUND`, **aucune double trace** | PASS |
| U4 | idempotence signalement : `@@unique(reporter, targetKind, targetId)` → P2002, la file ne gonfle pas | PASS |

### E2E API réel — `bun tests/moderation-e2e.ts` → **42/42 vérifications PASS** (serveur dev vivant + DB)

| # | Scénario (exigence de validation) | Résultat |
|---|---|---|
| S1 | 3 identités ECDSA réelles (Alice signaleuse, Bob auteur, Carol signaleuse) | PASS |
| S2 | contenu public : post P1, post P2, commentaire C1 | PASS |
| S3 | **report → entrée visible dans la file AVEC contexte** (post concerné + extrait, reporter, timestamp) | PASS |
| S4 | re-signalement idempotent (200 + `duplicate`) · 2 signaleurs sur P1 → `openReportsOnTarget = 2` | PASS |
| S5 | **targetKind "dm" → 400 + rappel E2EE** (aucune modération DM) | PASS |
| S6 | report sans preuve → **401** · cible inconnue → **404** | PASS |
| S7 | file SANS clé → **403** · mauvaise clé → **403** | PASS |
| S8 | **block → le pair bloqué n'apparaît plus dans le fil public du bloqueur** (le fil sans lecteur déclaré l'affiche toujours — filtrage par bloqueur uniquement) | PASS |
| S9 | **DM du bloqué : REÇU mais MARQUÉ** (`fromBlocked=true`, conversation `blocked=true`) | PASS |
| S10 | **hide → post disparu du fil public, RESTE en DB** (`hiddenAt` + `hiddenBy` posés, vérification DB) | PASS |
| S11 | **purge → post SUPPRIMÉ en DB**, trace `ModerationAction` conservée (auteur, extrait, compteur) — vérification DB | PASS |
| S12 | **intégration report → file → action(hide) → DB** : report clôturé (`status=actioned`, `handledBy=admin`, `handledAt`) · fil de réponses du parent masqué → 404 | PASS |
| S13 | **négatif : non-admin sur /api/moderation/action → 403** (sans clé · mauvaise clé · clé publique d'un utilisateur) | PASS |
| S14 | suspend → posts absents du fil + **publication refusée 403** · unsuspend → retour à la normale · warn → trace d'audit en DB | PASS |
| S15 | unblock → posts du pair redeviennent visibles · `fromBlocked` repasse à faux | PASS |

### Purge tooling (CLI) — exécuté sur scénario réel

```
bun scripts/moderation-purge.ts --list --min-reports 2
  → « cmw2rrx7p…  reports=2  hidden=non  auteur=CLI2-B-… »
bun scripts/moderation-purge.ts --purge <id> --admin-label ops:cli-a3        (dry-run)
  → affiche auteur, extrait, likes, signalements ouverts — AUCUNE écriture
bun scripts/moderation-purge.ts --purge <id> --admin-label ops:cli-a3 --execute
  → PURGÉ … signalements clôturés=2
Vérification DB : post SUPPRIMÉ · ModerationAction(action=purge, adminKey=ops:cli-a3,
  meta={authorKey, nickname, snippet, closedReports:2}) · reports = actioned,actioned
```

### Portefeuille qualité (l'ensemble des tests du repo)
- `bun test tests/` → **29 pass / 0 fail** (13 A1 + 10 A2 + 6 A3) · `bunx tsc --noEmit` **OK** · `bun run lint` **OK** · parité protocole web ↔ mobile **OK**.

## 3. Commandes exactes de reproduction

```bash
# (worktree feat/a3-moderation) bun install && bunx prisma generate && bunx prisma db push

# 1. harness unitaire (SQLite fichier temporaire)
bun test tests/moderation.test.ts

# 2. serveur de test avec clé admin (dans un autre terminal)
ADMIN_API_KEY=a3-dev-admin-key bunx next dev -p 3100

# 3. E2E API réel (42 vérifications, incl. vérifications DB directes)
ADMIN_API_KEY=a3-dev-admin-key MBOTE_BASE_URL=http://127.0.0.1:3100 bun tests/moderation-e2e.ts

# 4. purge tooling
bun scripts/moderation-purge.ts --list --min-reports 2
bun scripts/moderation-purge.ts --purge <postId> --reason "…" --admin-label ops:cli --execute

# 5. portefeuille complet
bun test tests/ && bunx tsc --noEmit && bun run lint && bun scripts/check-protocol-parity.ts
```

## 4. Ce qui n'a PAS été testé — et pourquoi

- **RBAC complet** : l'auth admin actuelle = clé API env (PROVISOIRE, assumé §0). Rôles granulaires (plusieurs modérateurs, permissions par action, révocation) → **à faire avant ouverture publique** (jalon à figer avec le Bloc 2). La trace `adminKey` est déjà structurée pour recevoir un identifiant de rôle.
- **Auto-modération par IA** : hors scope A3 (décision de validation). Aucune classification automatique n'appelle quoi que ce soit.
- **Modération des médias** : dépend du verrou médias (B1/B2) — A1/A2 (anti-rejeu + authentification des clés) en sont les prérequis livrés.
- **Notification à l'auteur** (warn/hide/suspend) : l'action est tracée pour l'audit mais aucun message n'est envoyé à l'auteur — surface produit à venir, hors périmètre A3.
- **UI admin de la file** : la file est un endpoint (exigence « lisible par l'admin ») — l'interface d'administration n'est pas construite ; les preuves passent par l'API + DB.
- **UI des badges `fromBlocked`/`blocked`** : les marqueurs sont livrés côté API (types inclus) ; l'affichage viendra avec la surface DM médias (B1).
- **Filtrage anti-blocage côté mesh bridge** : le pont mesh (`/api/mesh/bridge`) ingère des événements signés hors bande ; le filtrage par bloqueur s'applique aux LECTURES du fil (`GET /api/posts`) — un post bloqué reste dans la base et dans les flux temps réel. Cohérent avec le modèle « préférence d'affichage » ; le même filtrage côté relay socket.io est une optimisation future.

## 5. Tracabilité et gouvernance

- **Incident superviseur** (main forcé 2×, SHAs concernés, restauration `main = 7b51fd5 = origin/main`, portée strictement locale) : traces complètes et re-jouables dans `docs/proofs/A1-anti-replay.md` §6 et `docs/proofs/A2-key-auth.md` §6 — cette phase (A3) a été développée dans un **worktree externe** (`docs/DEV-SETUP.md` §2), la mesure corrective durable : aucun mouvement de `main` pendant A3, vérifiable par `git reflog show main` (aucune entrée hors commits validés).
- **Preuves signées** : report/block réutilisent le socle ECDSA des actions (fraîcheur 7 j / dérive future 60 s) — un signalement ou un blocage est opposable (porté par une clé), pas un vote anonyme.
- **Numérotation** : A3 (recadrage) = **R4** (modération) du plan de recadrage.
