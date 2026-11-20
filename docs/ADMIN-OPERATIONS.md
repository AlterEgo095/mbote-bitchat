# ADMIN-OPERATIONS — Guide opérateur du panneau d'administration

**Version** : 1.0 · **Date** : 2026-11-08 (Kinshasa WAT) · **Étape 10**
**Pour qui** : la personne qui exploite le panneau au quotidien (support, modérateur, super-admin).
**Références** : `docs/specs/ADMIN-RBAC.md` (matrice complète) · `docs/specs/ADMIN-ACCESS-RUNBOOK.md` (installation) · `docs/PRE-DEPLOY-CHECKLIST.md` (mise en route) · `docs/ADMIN-TROUBLESHOOTING.md` (pannes).

---

## 1. Se connecter

1. Ouvrir `https://admin.mbotemesh.aenews.online/` — Cloudflare Access demande d'abord votre email (OTP).
2. Puis le panneau demande : **email + mot de passe + code TOTP** (6 chiffres, app d'authentification). Un seul round-trip ; tout échec est uniforme (aucune cause révélée).
3. Rate-limit : 5 tentatives / 5 min / IP → au-delà, 429 et attente.
4. La session vit **30 min sans activité** (idle) puis est révoquée — se reconnecter suffit, rien n'est perdu.

Rôles (hiérarchie) : `auditor` (lecture audit seul) < `support` (queue lecture, dismiss, dashboard) < `moderator` (hide/unhide, warn, suspend) < `super-admin` (intentions four-eyes : ban définitif, purge).

## 2. Ajouter un modérateur (ou tout autre compte admin)

**Aucune UI** — c'est un CLI, sur le VPS, dans le conteneur app :

```bash
docker exec -it mbote-mesh bun run admin:create -- --email=moderateur@exemple.cd --role=moderator --allow-prod
# → mot de passe + secret TOTP (QR) affichés UNE SEULE FOIS — transmettre hors canal public
```

- Rôles possibles : `auditor | support | moderator | super-admin` (défaut : moderator).
- Le premier compte de l'installation se crée avec `admin:bootstrap` (une seule fois — voir `PRE-DEPLOY-CHECKLIST.md` §5).
- Garde-fous : refuse sans `--allow-prod` en production, refuse un email déjà pris, refuse si le bootstrap n'a pas été fait, écrit une ligne d'audit `admin_created`.
- Le nouveau compte enrole son TOTP au premier login (code demandé puis confirmé).

### 2.1 Créer le SECOND super-admin (four-eyes exercable — audit 2026-11 §4.7)

Le four-eyes (§4) exige **deux super-admins DISTINCTS** ; à un seul compte, la fonctionnalité est inertée (aucune purge/ban possible). État au 2026-11-20 : **1 seul super-admin réel** — créer le second est la première priorité opérationnelle :

```bash
docker exec -it mbote-mesh bun run admin:create -- --email=superadmin2@exemple.cd --role=super-admin --allow-prod
# → mot de passe généré + secret TOTP (QR) affichés UNE FOIS — remettre au second
#   titulaire par un canal privé (jamais le panneau, jamais un post public).
```

1. Choisir un titulaire DIFFÉRENT de la personne qui détient le compte n°1 (le four-eyes est un contrôle humain, pas technique — deux comptes pour la même personne ne le rétablit pas).
2. Le second titulaire se connecte au panneau, enrole son TOTP, et conserve ses codes de secours.
3. Vérification : `docker exec mbote-mesh bun run admin:list 2>/dev/null || true` ou contrôle dans `/users` du panneau — deux comptes `super-admin` actifs.
4. L'audit `admin_created` trace la création ; une révocation éventuelle se fait via la suspension du compte (§4-§7) + suppression DB manuelle si nécessaire.

## 3. Investiguer un signalement (queue)

`/queue` — la file pèse chaque contenu par son **nombre de reports ouverts** (les plus signalés d'abord, puis ancienneté). Filtres : période (24h/7d/30d/all), type (post/comment).

Pour chaque entrée, actions (justification **obligatoire**, format `CATÉGORIE: texte` — catégories : SPAM, HARASSMENT, … — texte ≥ 20 caractères) :

| Action | Effet | Qui |
|---|---|---|
| **Masquer** (hide) | post retiré du fil public, reports clos (`actioned`) — réversible | moderator+ |
| **Rejeter** (dismiss) | report clos sans action sur le contenu | support+ |
| **Avertir** (warn) | avertissement visible sur le profil de l'utilisateur (pas de DM — E2EE) | moderator+ |
| **Suspendre** | 24h / 7j / 30j : posts absents du fil + publication refusée 403 ; DM toujours possible (E2EE préservée) | moderator+ |
| **Purger** (purge) | **irréversible** (post supprimé, traces conservées) — passe par four-eyes | super-admin ×2 |

Après chaque action, la liste se recharge depuis le serveur (aucun optimisme UI). L'utilisateur masqué/suspendu redevient visible à l'expiration (évaluation paresseuse, pas de cron).

Investigation type : lire le post dans la queue → vérifier l'historique de l'auteur dans `/users` (reports ouverts, warnings, statut) → décider → justifier précisément (« HARASSMENT: propos visant … »). La justification est visible dans l'audit — écrire pour un collègue qui lira dans 6 mois.

## 4. Ban définitif & purge — four-eyes (deux super-admins)

Les actions **irréversibles** exigent DEUX super-admins distincts (id ET session différents — s'approuver soi-même depuis un 2ᵉ onglet est refusé) :

1. Super-admin A : fiche utilisateur → **Ban définitif…** (ou purge depuis la queue) → intention justifiée → `pending` (expire dans **1 h**).
2. Les autres super-admins actifs sont notifiés par log (`[pending-action:notify]` — email à venir).
3. Super-admin B : `/pending-actions` → **Approuver** → exécution TRANSACTIONNELLE : user banni (publication 403, posts masqués par l'exécutant, reports clos) OU post purgé (contenu conservé en `beforeJson` d'audit).
4. A peut **Annuler** sa propre intention tant qu'elle est pending ; une intention expirée → 410 (recréer).
5. Cycle complet = **exactement 2 lignes d'audit** (`pendingaction_created` + `ban|purge` avec requestedBy/approvedBy).

Pas d'unban UI : le ban définitif est définitif (décision de conception — voir ADMIN-RBAC §5).

## 5. Consulter l'audit

`/audit` — journal **append-only au niveau moteur** (triggers SQLite : aucune ligne modifiable/supprimable, même en SQL direct). Lecture seule ; l'auditor n'a accès qu'à ça.

- Liste triée par date (20/page), filtres : acteur, action, type de cible, période (24h/7j/30d ou dates custom), recherche cible.
- Fiche d'une ligne : TOUS les champs, `beforeJson`/`afterJson` en accordéons, lien vers la fiche utilisateur.
- **Export CSV** (RFC 4180, sans before/after) — limite 10 000 lignes (au-delà : 422, affiner la période).
- Actions auditées : login_success/login_failed, logout, totp_enrolled, break-glass, bootstrap/admin_created, warn/suspend/unsuspend, hide/unhide/purge, dismiss, pendingaction_created/cancelled/expired, ban.

## 6. Métriques (dashboard)

`/dashboard` — 4 métriques agrégées, **aucune donnée sensible** (pas d'email, pas d'IP, pas de contenu) :

| Métrique | Vert | Orange | Rouge |
|---|---|---|---|
| Utilisateurs actifs 24h/7j | ≥ 5 | 1–4 | 0 |
| Reports ouverts | ≤ 10 | 11–50 | > 50 |
| Uptime conteneur | ≥ 24 h | 1–24 h | < 1 h |
| Dernier backup | < 24 h | > 24 h | échec |

Pas d'historique, pas d'alerte automatique — regard humain + bouton Rafraîchir. Le backup est lu du fichier écrit par le cron VPS (`BACKUP_STATUS_PATH` — voir `scripts/backup-mbote.sh`).

## 7. Sessions & incidents d'accès

- **Logout** : bouton « Se déconnecter » (révocation tracée).
- **TOTP perdu** : code de secours (break-glass) — procédure complète dans `ADMIN-ACCESS-RUNBOOK.md` §4 ; un break-glass révoque TOUTES les sessions du compte, régénère le TOTP et est audité + notifié aux autres super-admins.
- **Compte compromis suspecté** : un autre super-admin demande la désactivation via CLI (`admin:bootstrap --disable` n'existe pas — voir runbook §5 : désactivation CLI, jamais DELETE) — toutes les sessions meurent instantanément.
- **Session d'un autre admin visible ?** Non — l'audit trace les actions (acteur = AdminUser.id), jamais les sessions des autres.

## 8. Limites connues (assumées, tracées)

- Notifications admin par **log structuré** uniquement (`[pending-action:notify]`, `[ADMIN-ALERT]`) — pas de SMTP.
- Pas d'unban, pas de gestion des comptes admin par UI (CLI), pas d'alertes automatiques.
- Pendant un **verrou DB** (migration courte), le panneau peut afficher « session invalide » (fail-closed) au lieu de « backend occupé » — se reconnecter après la fenêtre ; voir TROUBLESHOOTING §4.
- Panneau en français uniquement (i18n NON TESTÉ, post-déploiement).
