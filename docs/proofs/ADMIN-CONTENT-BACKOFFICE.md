# Back-office « Contenus » — panneau d'administration (2026-11-16)

> **Secrets** : aucun secret dans ce document. Les coordonnées opérateur vivent
> exclusivement dans `/opt/mbote-bitchat/ADMIN-CREDENTIALS.txt` (VPS, 0600).

## 1. Objectif

Réponse à la demande : un panneau d'administration « digne d'une vraie
application » — l'admin voit **tout ce que le serveur voit** du fil public et
peut **supprimer / masquer** les contenus qui ne méritent pas d'être exposés
aux utilisateurs, tout en gardant une trace d'audit complète.

**Périmètre strict (invariant §1.4 ADMIN-RBAC.md)** : fil public uniquement
(posts + commentaires — contenus serveur-visibles **par définition**). Les DM
et les groupes MLS sont chiffrés E2EE : le serveur ne peut ni les lire, ni les
lister, ni les modérer — c'est la promesse produit, aucune fonctionnalité de ce
back-office ne l'affaiblit.

## 2. Ce qui existait déjà (réutilisé sans réécriture)

| Capacité | Endpoints |
|---|---|
| Annuaire utilisateurs (warn/suspend/unsuspend) | `/api/internal/admin/users` |
| Queue de modération (signalements, hide, dismiss) | `/api/internal/admin/queue` |
| Actions hide/unhide/warn/suspend/purge (justification §6, RBAC par action, réputation D2, audit transactionnel) | `/api/moderation/action` |
| Four-eyes (intentions irréversibles : ban_user, purge_post) | `/api/internal/admin/pending-actions` (É9) |
| Journal d'audit append-only (triggers SQLite) + export CSV | `/api/internal/admin/audit` |
| Tableau de bord (métriques) | `/api/internal/admin/stats` |

## 3. Nouveautés de cette session

### 3.1 Backend (app principale)

- **`GET /api/internal/admin/posts`** — annuaire EXHAUSTIF des contenus publics
  (la queue ne montrait que les signalements) : mode recherche (LIKE contenu,
  limite 20) + mode liste (cursor keyset 20/page, `createdAt DESC, id DESC`),
  filtres `status` (all | visible | hidden | reported), `kind` (post | comment),
  `period`, `author` (pubkey). Auth `requireAdmin({minRole:"support"})` —
  auditor strict (403), même arbitrage §13.1 que l'annuaire users. Garde de vue
  cursor + `cursorReset` (sémantique identique users/queue).
- **`GET /api/internal/admin/posts/[id]`** — fiche complète : contenu intégral,
  auteur (pubkey, statut, réputation D2, flaggedCount), parent si commentaire,
  réponses (50 max), TOUS les signalements (ouverts + traités), historique de
  modération (ModerationAction, 20 derniers).

Les mutations ne sont PAS dupliquées : masquer / démasquer passent par
`/api/moderation/action` (justification §6, RBAC hide/unhide = moderator,
pénalités de réputation D2 à l'auteur si reports ouverts, clôture des
signalements, audit) et la purge (irréversible) par l'intention four-eyes
`purge_post` (É9 : approbation d'un SECOND admin DISTINCT dans l'heure).

### 3.2 BFF admin

- `GET /api/posts` et `GET /api/posts/[id]` — proxys de lecture (chaîne
  identique users/queue : cookie → verify → `x-admin-internal` + `x-admin-session`
  + `x-admin-actor`). 401/403 unifiés `unauthorized`, 400/404 propagés, 502
  backend-unreachable.

### 3.3 UI du panneau

- **Page « Contenus »** (`/posts`) : recherche par texte, filtres statut/type/
  période, pagination « Charger la page suivante », badges (commentaire, mesh,
  masqué, N signalements), lien « Voir / agir » par contenu.
- **Fiche contenu** (`/posts/[id]`) : contenu intégral, carte auteur avec lien
  vers la fiche utilisateur, bloc « En réponse à », réponses, signalements,
  historique de modération, actions **Masquer du fil public / Démasquer /
  Demander la purge (four-eyes)** avec formulaire de justification
  (catégorie + ≥ 20 caractères, 422 serveur). Invariant §1.8 : rechargement
  serveur après chaque action, zéro update optimiste.
- Navigation « Contenus » ajoutée sur toutes les pages du panneau.

### 3.4 Correctifs cosmétiques (capture mobile de l'opérateur)

- En-têtes : `flex-wrap` (les boutons passent à la ligne au lieu de déborder),
  badge « auth — Étape 3+4 » masqué sur mobile.
- Pied de page : « port 3001 » → « conteneur 3001 · publié sur l'hôte
  uniquement sur 127.0.0.1:3392 » (reflète l'override compose réel).

## 4. Qualité

- `eslint` (les 2 apps) : 0 erreur.
- `tsc --noEmit` (les 2 apps) : 0 erreur.
- Commit : `feat(admin): back-office contenus…` (`4c28e01`), merge main
  (`89b7af9`).

## 5. Déploiement (procédure CI répliquée manuellement — token GitHub absent)

Chaîne identique au workflow `deploy-vps.yml` (rsync du SHA → `docker compose
up -d --build` → prune) exécutée en SSH :

- SHA déployé : `89b7af9ea827cd44714d6272734e4e8d3466deb4` (`.deploy-commit`
  VPS mis à jour — aucun push origin : voir §7).
- rsync avec les EXCLUDES exacts de la CI (`.env`, `docker-compose.override.yml`,
  `db`, `public/downloads`, `docs`, `tests`, `backups`… préservés) ;
  `git diff --diff-filter=D cb9f880..main` = **0 suppression** → équivalence
  chirurgicale.
- Build en arrière-plan (journal `/tmp/mbote-deploy-89b7af9e.log`),
  `DEPLOY_EXIT_CODE=0`, images `mbote` + `admin` + `relay` reconstruites,
  `mbote-mesh` et `mbote-admin` recréés → **healthy**, relay inchangé (27 h).

## 6. Vérifications post-déploiement

| Test | Résultat |
|---|---|
| `docker compose ps` | `mbote-admin healthy · mbote-mesh healthy · mbote-relay healthy` — **3/3** |
| `curl 127.0.0.1:3390/api/stats` | **200** (67 ms) |
| `curl 127.0.0.1:3390/api/internal/admin/posts` (sans session) | **401** `{"error":"unauthorized"}` — identique au témoin préexistant `/users` |
| `curl 127.0.0.1:3392/console-16bd6307/posts` (sans session) | **307** → `/console-16bd6307/` (redirection login — la route existe en prod) |
| `curl 127.0.0.1:3392/console-16bd6307/api/health` | **200** (healthcheck basePath-aware) |
| Externe (Cloudflare + Basic Auth) `…/console-16bd6307/posts` | **200** (« Mbote Admin » rendu) |
| Externe `…/console-16bd6307/api/posts` sans session | **401** |
| Landing `https://mbotemesh.aenews.online/` | **200** |

Note VPS : mbote-mesh est publié sur `127.0.0.1:3390` et mbote-admin sur
`127.0.0.1:3392` (override compose — les ports 3000/3001 de l'hôte sont occupés
par d'autres applications du serveur partagé). Un `curl` sur
`127.0.0.1:3000/api/stats` touche UNE AUTRE application (401 de son cru) — le
healthcheck CI passe par le secret `VPS_WEB_PORT=3390`.

## 7. Écarts et suite

1. **Push origin en attente** — main local (`89b7af9`) contient le
   back-office ; le push GitHub (→ CI tests.yml → deploy-vps.yml) sera fait
   dès que l'opérateur re-procure le token. En attendant, prod et local sont
   au même niveau de code ; toute future push main re-déployera le même
   contenu (rsync identique).
2. **Purge four-eyes** : exige un second compte admin distinct (id + session).
   Recommandation : créer le compte via `scripts/admin-create.ts` (runbook
   `docs/specs/ADMIN-ACCESS-RUNBOOK.md`) pour permettre les purges depuis le
   panneau. Sans second admin, le pouvoir de suppression directe reste le
   **masquage** (réversible, audité) — conformément à la conception É9.
3. **E2EE** : les DM et messages de groupe restent hors de portée (chiffrés) —
   l'admin gère le fil public et les métadonnées, jamais les contenus privés.
4. **Disque VPS à 96 %** (8,9 Gio libres) : `docker image prune -f` exécuté
   (0 B récupéré — images en usage). Nettoyage plus profond à planifier
   (anciens layers buildx, snapshots) — non fait unilatéralement.
