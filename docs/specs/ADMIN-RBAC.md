# SPEC — RBAC & SÉCURITÉ DU PANNEAU D'ADMINISTRATION (ADM MVP)

**Version** : 1.0 · **Date** : 2026-11-05 (Kinshasa WAT) · **Portée** : Étapes 3–10 du breakdown (`docs/specs/ADM-breakdown.md`)
**Entrées** : `docs/proofs/ADM-audit-2026-11-05.md` (décisions §4.1–§4.5) · `docs/proofs/ADM-rupture.md` (Étape 0) · code : `src/lib/mbote/admin-auth.ts`

---

## 1. INVARIANTS NON NÉGOCIABLES

1. **L'app admin n'accède JAMAIS à la DB directement.** Aucune dépendance `prisma`/`@prisma/client` dans `admin/package.json` (vérifiable par grep à chaque preuve). Toute donnée passe par HTTP interne vers l'app principale.
2. **Aucun secret en DB, en réponse HTTP, ni comme acteur d'audit** — rupture Étape 0 (`docs/proofs/ADM-rupture.md` §6) : l'acteur est toujours `AdminUser.id`.
3. **`AdminAudit` est append-only au niveau moteur** (triggers SQLite `admin_audit_no_update` / `admin_audit_no_delete`, migration `20261105202309_0004_admin`). Aucune feature ne doit contourner.
4. **Aucune modération DM** (E2EE par conception). Aucun impersonate user. Aucune lecture de contenu de DM.
5. **Le panneau n'est jamais exposé sans Cloudflare Access** (décision §4.5). L'IP allowlist nginx est un fallback documenté, pas un remplaçant.
6. **`ADMIN_API_KEY` reste détruite** : seul le CLI de purge la lit (timing-safe, jamais stocké, jamais renvoyé).
7. **Toute mutation = justification** (catégorie + ≥ 20 caractères, §6) et **ligne `AdminAudit`** dans la même transaction que l'action.
8. **Toute mutation UI reflète le retour serveur 2xx — pas d'optimistic update avant confirmation.** (Directive Étape 6, clarification 1.) Première occurrence de la classe : défaut logout `AdminAuthPanel` — l'UI basculait en « anonymous » sans vérifier `res.ok`, mentant sur l'état de la session (ADM-step5.md §6.2, corrigé). L'invariant s'applique à tout composant client présent et futur : auth panel (Étape 3+4), dashboard (Étape 5), queue (Étape 6) — chaque action attend la réponse serveur puis reflète son résultat, erreur comprise.
   **Formulation générique (clarification 4 Étape 9+C1, 2026-11-06)** : *« Aucun state ne bascule à son état "succès" avant retour serveur 2xx. »* Corollaires : (a) tout `setX(null)/setX(initial)` précoce dans un handler de mutation doit restaurer `X` dans le `catch` (sinon la donnée est perdue sans aucun retour serveur — cas fondateur `setPendingVoice(null)` B3, corrigé B4) ; (b) audit exhaustif 2026-11-06 côté app principale : voix/vidéo conformes (preview restaurée), **image corrigée** (`attachAndSend` MessagesView jetait `pendingFile` en échec non-réseau), likes PostCard exemptés (optimisme offline-first documenté F-28 avec rollback sur rejet définitif) ; (c) l'invariant s'applique aussi aux boutons four-eyes « Approuver »/« Annuler » (Étape 9) — refetch serveur après chaque action.
9. **Toute écriture `AdminAudit` dans une transaction Prisma DOIT utiliser `tx`, jamais le client global.** (Clarification Étape 9+C1, 2026-11-06 — invariant systémique issu d'un bug réel.) `writeAdminAudit` accepte un `tx` optionnel (`admin-auth.ts:258`) : quand l'appel est fait DANS une transaction ouverte (`db.$transaction(async (tx) => …)`) et que `tx` est omis, l'écriture passe par le client global, dont le pool SQLite est verrouillé par la transaction en cours → *database is locked* → deadlock (constaté Étape 9 : `cancelPendingAction` écrivait `pendingaction_cancelled` sans `tx`, pool bloqué 5 s, corrigé `pending-action.ts:638`). Deux conséquences opératoires : (a) tout NOUVEAU site d'appel de `writeAdminAudit` à l'intérieur d'un `$transaction` doit passer `tx` — revue obligatoire à chaque revue de code ; (b) l'audit exhaustif des sites d'appel (Étape 9+C1, preuve ADM-step10 §A) conclut : 14/14 sites vérifiés — 9 en transaction TOUS avec `tx`, 5 hors transaction (opérations séquentielles, aucune tx ouverte, zéro risque deadlock). Exception documentée : `createPendingAction` (`pending-action.ts:282`) écrit l'audit `pendingaction_created` HORS transaction VOLONTAIREMENT — la pending est réversible (cancel/expire), l'audit d'intention ne doit pas être atomiquement lié à l'effet ; c'est le seul site d'appel autorisé sans `tx` dans une logique d'intention four-eyes.

---

## 2. IDENTITÉS

### 2.1 AdminUser (schéma 0004 — existant)
`id` · `email` (unique) · `passwordHash` (Argon2id, null pour `system`) · `totpSecret` · `totpEnrolled` · `role` · `createdAt` · `disabledAt`.

### 2.2 Rôles (hiérarchie déjà codée — `admin-auth.ts:32-42`)
```
system (0) < auditor (1) < support (2) < moderator (3) < super-admin (4)
```
- `roleAtLeast(role, min)` : la porte générique existante. Le MVP n'ajoute **aucun** rôle.
- Le pseudo-user **`system`** (seed migration 0004, id 1) : `passwordHash = null`, **jamais de login, jamais de session, jamais de chemin HTTP** (`admin-auth.ts:80`). Acteur exclusif du CLI.

### 2.3 Rôles futurs (traçabilité, PAS d'implémentation MVP)
> « Rôle compliance (lecture seule stats + backup status + audit) à considérer si certification SOC 2 / ISO 27001. » — directive Étape 6, clarification 2. L'`auditor` du MVP reste strictement lecture seule sur `AdminAudit` uniquement (arbitrage §12.17) ; un éventuel rôle `compliance` étendrait la lecture aux métriques dashboard SANS aucune mutation — à trancher au moment d'une certification, pas avant.

### 2.4 Création / désactivation des comptes
- **Création : CLI uniquement** (Étape 3 : `scripts/admin-create.ts` → mot de passe temporaire + secret TOTP affichés une fois). **Pas d'UI de gestion des comptes dans le MVP** (hors périmètre §11).
- **Désactivation : CLI** (`--disable`) — jamais de `DELETE` (les FK `hiddenBy`/`suspendedBy`/`handledBy` et l'audit référencent l'id). Un admin désactivé → toutes ses sessions deviennent instantanément invalides (`admin-auth.ts:79`).

---

## 3. SESSION & ANTI-CSRF (base Étape 0, étendue Étape 3)

| Propriété | Valeur | Source |
|---|---|---|
| Cookie | `mbote_admin_session`, valeur = `AdminSession.id` (cuid opaque) | `admin-auth.ts:28` |
| Flags | `HttpOnly` · `Secure` · `SameSite=Strict` · `Path=/` · domaine **admin dédié** | Étape 3 (routage app admin) |
| TTL | 8 h (`expiresAt`), `lastSeenAt` maj fire-and-forget | `admin-auth.ts:141`, `:83-85` |
| Révocation | immédiate (`revokedAt`) — logout, logout-all, disable admin | `admin-auth.ts:77` |
| Anti-CSRF | header `x-admin-csrf` = `csrfToken` de la session, **timing-safe**, exigé sur TOUTE mutation | `admin-auth.ts:117-121` |
| Métadonnées | `ip` + `userAgent` capturés à la création | `admin-auth.ts:146-147` |

Le cookie n'est émis QUE par le domaine admin (`admin.mbotemesh.aenews.online`) — jamais partagé avec l'app principale. Le navigateur ne l'envoie qu'au panneau ; l'app admin le réinjecte côté serveur vers l'app principale **via le réseau Docker interne** (§8).

---

## 4. MATRICE DE PERMISSIONS (rôle minimum requis)

| # | Action | Rôle min | Chemin | Livrée |
|---|---|---|---|---|
| 1 | `dashboard.view` (4 métriques) | `support` | endpoint interne (E5) | Étape 5 — matrice v1.0 disait `auditor` ; l'implémentation testée (A5 : auditor → 403) impose support, alignée ici sous arbitrage §12.17 |
| 2 | `queue.view` (file de signalements + contexte) | `support` | `GET /api/moderation/queue` + `GET /api/internal/admin/queue` (E6, cursor) | **Étape 0** — rôle resserré à l'Étape 6 (arbitrage §12.17 : auditor strict = lecture seule `AdminAudit`) |
| 3 | `users.view` (recherche + fiche) | `support` | `GET /api/internal/admin/users` + `/[id]` (E7) | Étape 7 — RE-TRANCHÉ par la directive explicite (« requireAdmin('support') ») : arbitrage §13.1 ; l'auditor strict reste 403 (tests E7) |
| 4 | `audit.view` (journal, lecture seule) | `auditor` | endpoint interne (E8) | **Étape 8** — porte EXACTE auditor + super-admin (PAS une hiérarchie — arbitrage §14.1 : support/moderator → 403 testés) |
| 5 | `user.warn` | `support` (endpoint legacy) · `moderator` (endpoints E7) | `POST /api/moderation/action` (legacy) · `POST /api/internal/admin/users/[id]/warn` (E7) | Étape 0 (legacy) · **Étape 7** — la directive « Warn (1 modérateur) » impose moderator sur les endpoints E7 : arbitrage §13.1 (harmonisation à l'Étape 8 — la queue UI utilise encore le chemin legacy) |
| 6 | `report.dismiss` (sans action) | `support` | `POST /api/moderation/action` | **Étape 0** |
| 7 | `post.hide` / `post.unhide` (réversible) | `moderator` | `POST /api/moderation/action` | **Étape 0** |
| 8 | `user.suspend` / `user.unsuspend` (réversible) | `moderator` | `POST /api/internal/admin/users/[id]/{suspend,unsuspend}` (E7) + legacy `POST /api/moderation/action` | Étape 0 (legacy) · **Étape 7** (E7, durées 24h/7d/30d — arbitrage §13.3) |
| 9 | `ban.request` (four-eyes, **définitif**) | `super-admin` | `POST /api/internal/admin/pending-actions` (E9) | **Étape 9** — RE-TRANCHÉ par la directive É9 explicite (« Rôle super-admin requis ») : arbitrage §15.1 — la matrice v1.0 (`moderator`) est réalignée |
| 10 | `post.purge.request` (four-eyes, irréversible) | `super-admin` | `POST /api/internal/admin/pending-actions` (E9, depuis la queue ou la fiche) | **Étape 9** — même tranchement §15.1 |
| 11 | `four-eyes.approve` / `.cancel` | `super-admin` **≠ demandeur (id ET session)** | `POST /api/internal/admin/pending-actions/[id]/{approve,cancel}` (E9) | **Étape 9** — annulation par le DEMANDEUR seul (directive É9 : bouton « Annuler » si currentUser === requestedBy) ; le `reject` par l'approbateur de la v1.0 §5 fusionne dans `cancelled` (§15.2) |

**Règles structurelles :**
- Les actions **réversibles** (7, 8) restent mono-session (comportement Étape 0 conservé, e2e S10/S14).
- Les actions **irréversibles** (9, 10) exigent **TOUJOURS le four-eyes** — y compris pour un `super-admin` isolé. Deux `super-admin` DISTINCTS (id ET session) sont requis (É9).
- `post.purge` direct existant (Étape 0, mono-session) est **retiré de la surface UI** à l'Étape 9 : le CLI le conserve (urgence sans panneau), l'UI ne passe plus que par four-eyes.
- La file `/pending-actions` est visible dès `moderator` (les admins observent la chaîne) ; créer/approuver/annuler = super-admin (É9).

---

## 5. FOUR-EYES (décision d'audit §4.1)

Nouvelle table **`PendingAction`** (migration `0005_four_eyes`, Étape 9 — 100 % additive) :

```
id                  Int        (autoincrement)
type                String     "ban_user" | "purge_post"
targetType          String     "user" | "post"
targetId            String
payloadJson         String?    (contexte figé au moment de la demande)
justification       String     (catégorie + ≥ 20 chars, §6)
createdById         Int        FK AdminUser (auteur)
createdBySessionId  String
status              String     "pending" | "approved" | "rejected" | "expired" | "executed"
approvedById        Int?       FK AdminUser (approbateur)
approvedBySessionId String?
executedAt          DateTime?
createdAt           DateTime   (défaut now)
expiresAt           DateTime   (createdAt + 1 h — décision §4.1)
```

**Règles d'exécution :**
1. **Approbateur ≠ auteur** : `approvedById ≠ createdById` **ET** `approvedBySessionId ≠ createdBySessionId` (les deux conditions, arbitrage le plus strict).
2. **Expiry 1 h** : évaluation paresseuse à la lecture/écriture — un `pending` dont `expiresAt < now` passe à `expired` (mutation auditée).
3. **`rejected` est terminal** ; un nouvel intent peut être créé.
4. **Exécution transactionnelle** : l'effet (ban ou purge) + la ligne `AdminAudit` écrits dans la MÊME transaction que le passage à `executed` (pattern `purgePostWithAudit`, Étape 0).
5. **Cycle de vie 100 % audité** : `pendingaction_created` · `_approved` · `_rejected` · `_expired` · `_executed`.

**Ban définitif** : la migration 0005 ajoute aussi `User.bannedAt DateTime?` + `User.bannedBy Int?` (FK AdminUser). Distinct de la suspension révocable (`suspendedAt/suspendedBy`, existante) : un utilisateur banni ne peut plus se connecter/publier, sans chemin de déblocage UI.

---

## 6. JUSTIFICATION (décision d'audit §4.4)

- **Catégorie** (enum fermé) : `SPAM | HARASSMENT | SCAM | CSAM | OTHER`.
- **Texte libre ≥ 20 caractères** — validation **serveur**, refus `422` sinon (le client peut pré-valider).
- Format stocké : `"CATÉGORIE: texte"` dans `AdminAudit.justification` et `PendingAction.justification`.
- Applicable à : hide, dismiss, suspend, warn, ban, purge — et à tout nouveau type de mutation.

---

## 7. FLUX D'AUTHENTIFICATION (Étape 3)

### 7.1 Login (une seule étape)
`POST /api/internal/admin/login` (app principale, gardé par le token interne §8) avec `{email, password, totp}` :
1. Vérif **Argon2id** (dépendance `@node-rs/argon2`) — comparaison du hash.
2. Vérif **TOTP** (dépendance `otplib`, fenêtre ±1 période) si `totpEnrolled`.
3. **Rate-limit** : 5 échecs / 15 min par couple `(email, ip normalisée)` → `429` ; compteur en mémoire locale (pas de Redis).
4. Succès → `createAdminSession()` (existant) + cookies posés par l'app admin + `AdminAudit{action:"login_success"}`.
5. Échec → `422` uniforme (pas de détail « email inconnu vs mauvais mot de passe ») + `AdminAudit{action:"login_failed"}` (email cible, IP, UA).

### 7.2 Enrôlement TOTP (premier login)
Mot de passe temporaire du CLI → login accepté uniquement pour **finaliser l'enrôlement** tant que `totpEnrolled = false` : génération du secret, QR `otpauth://totp/Mbote Admin:<email>` affiché **une seule fois**, confirmation par un code valide → `totpEnrolled = true` + audit `totp_enrolled`. Aucune autre surface tant que l'enrôlement n'est pas fait.

### 7.3 Break-glass (décision d'audit §4.2)
- À l'enrôlement : **2 codes de secours** générés (32 caractères), montrés **une fois**, stockés **hashés** (SHA-256 + sel par code).
- Usage : login `email + mot de passe + code de secours` **sans TOTP** (perte du téléphone). Le code est **brûlé** à l'usage (audit `breakglass_used`).
- Régénération : CLI + justification (audit). Si les 2 codes sont brûlés et le TOTP perdu : seul le CLI peut poser un nouveau secret (`admin-reset-totp`, Étape 3) — procédure au runbook §5.

### 7.4 Cycle de session
- `POST /api/internal/admin/verify` — validé à chaque requête admin (middleware app admin) : session vivante + admin actif → `{adminUserId, role, csrfToken}`.
- `POST /api/internal/admin/logout` — révocation de la session courante ; `logout-all` en CLI.

---

## 8. ÉCHANGES ADMIN ↔ MBOTE (architecture de référence)

```
navigateur ── HTTPS ──▶ CF Access ──▶ nginx vhost ──▶ 127.0.0.1:3001 (conteneur admin, BFF sans état)
                                                              │ réseau Docker interne
                                                              ▼
                                                     mbote:3000  /api/moderation/*        (cookie session + CSRF rejoués)
                                                              │           /api/internal/admin/* (x-admin-internal requis)
                                                              ▼
                                                          DB SQLite (inaccessible depuis l'app admin)
```

- **L'app admin est un BFF sans état** : elle reçoit le cookie (domaine admin), le **rejoue** vers `/api/moderation/*` existants (qui font déjà `requireAdmin`) et vers les nouveaux endpoints internes.
- **Nouveaux endpoints internes** (app principale) : `/api/internal/admin/{login,verify,logout,dashboard,users,audit,four-eyes}` — gardés par `requireInternal()` (Étape 4) : header **`x-admin-internal`** = `ADMIN_INTERNAL_TOKEN`, comparaison **timing-safe**.
- **`ADMIN_INTERNAL_TOKEN`** (nouveau secret, 32 octets hex) : déclaré dans le `.env` VPS + `docker-compose.yml` (interpolé vers les 2 services). Il n'identifie **jamais** un acteur : l'acteur reste `AdminUser.id` validé par la session. Jamais en DB, jamais en réponse HTTP, jamais loggué. **Il ne ressuscite pas `ADMIN_API_KEY`** : portée = réseau interne, endpoints internes uniquement.
- **Risque résiduel assumé + durcissement planifié** : `mbote` publie aujourd'hui `3000:3000` sur `0.0.0.0` — `/api/moderation/*` (session-gated) et `/api/internal/admin/*` (token-gated) sont atteignables depuis Internet, protégés par leur secret respectif. Recommandation (item D3) : publier `mbote` sur `127.0.0.1:3000:3000` au déploiement ADM, nginx restant le seul point d'entrée public.

---

## 9. AUDIT (décision d'audit §4.3 — rétention illimitée)

Événements tracés (aucune suppression possible — triggers) :
`login_success` · `login_failed` · `totp_enrolled` · `breakglass_used` · `logout` · toutes les actions de la matrice §4 · cycle four-eyes complet (§5.5).

Champs figés : `actorId` + `actorRole` (copie au moment de l'action), `action`, `targetType/targetId`, `beforeJson/afterJson`, `ip`, `userAgent`, `justification` (§6). Rétention : **illimitée** (arbitrage §4.3 — volume faible, table indexée).

---

## 10. MENACES COUVERTES / RÉSIDUELLES

**Couvertes** : usurpation d'acteur (session nominative + audit append-only) · CSRF (token timing-safe sur toute mutation) · falsification d'audit (triggers moteur) · secret en DB / en réponse HTTP (rupture Étape 0, méthode canari) · accès DB depuis le panneau (invariant n°1) · force brute login (rate-limit + TOTP).

**Résiduelles (documentées, à surveiller)** :
1. Compromission root VPS = game over (hors périmètre applicatif).
2. `totpSecret` au repos dans SQLite lisible par root (chiffrement champ-niveau = post-MVP).
3. Cookie de session fuité → TTL 8 h + CF Access + révocation CLI réduisent la fenêtre.
4. Surface `/api/moderation/*` publiée sur `0.0.0.0` (§8 — durcissement D3).

---

## 11. HORS PÉRIMÈTRE MVP (arbitré, ne pas dériver)

UI de gestion des comptes admin (CLI seulement) · rôle « viewer » dédié (`auditor` couvre le besoin) · i18n du panneau (FR uniquement) · WebAuthn/clés matérielles · mTLS interne (token timing-safe sur réseau Docker privé) · chiffrement champ-niveau des secrets au repos · dashboard temps réel (les 4 métriques sont des compteurs à la demande).

---

## 12. ARBITRAGES ÉTAPE 3+4 (2026-11-06 — directive « auth + RBAC », tracés en code + tests)

Points ambigus entre la directive Étape 3+4 et cette spec v1.0 — TRANCHÉS
explicitement ici, implémentés et testés (preuve : docs/proofs/ADM-step3-4.md) :

1. **Login — double surface, un seul cerveau** : la surface NAVIGATEUR est
   `POST /api/admin/auth/login` (BFF admin, 3 champs, un seul round-trip) ; la
   VÉRIFICATION vit dans l'app principale (`POST /api/internal/admin/login`,
   gardée par le token interne §8). Invariant §1 conservé : l'app admin n'a
   ni prisma ni accès DB. Le BFF pose le cookie et ne renvoie que
   `{csrfToken}` + état non sensible.
2. **Sessions token-hash** : le cookie porte un token ALÉATOIRE 32 octets ;
   seul son HASH SHA-256 vit en DB (`AdminSession.tokenHash`, migration
   `0005_admin_auth`). REMPLACE le modèle Étape 0 (cookie = `AdminSession.id`)
   — les sessions pré-Étape-3 meurent au déploiement (aucune en prod).
3. **TOTP au bootstrap** : le secret est généré par `admin:bootstrap` (QR
   ASCII affiché UNE fois) ; le PREMIER login validé (fenêtre ±1) bascule
   `totpEnrolled=true` + audit `totp_enrolled`. Implémentation RFC 6238 maison
   (`src/lib/mbote/totp.ts`, HMAC-SHA-1 de `node:crypto`) validée contre les
   vecteurs NORMATIFS du RFC 6238 Appendice B — `otplib` (spec v1.0) écarté :
   contrôle du compteur requis par l'anti-rejeu + risque de bundling CJS dans
   Next 16. La primitive crypto reste node:crypto.
4. **Anti-rejeu TOTP** : `AdminUser.totpLastCounter` (migration 0005) — un
   code de compteur ≤ au dernier VALIDÉ est un rejeu → 401 uniforme.
5. **Break-glass** : 2 codes générés AU BOOTSTRAP (32 chars base32 groupés,
   hashés Argon2id, montrés une fois — la spec v1.0 disait « à l'enrôlement »
   et SHA-256 : la directive Étape 3 prime). Usage = bypass TOTP + burn
   (`usedAt`/`usedIp`/`usedUserAgent`) + révocation de TOUTES les sessions de
   l'admin + NOUVEAU secret TOTP immédiat (`totpEnrolled=false`) + ré-enrôlement
   via `POST /api/admin/auth/totp-enroll` (session+CSRF) + audit `break-glass`
   + notification aux autres super-admins (LOG — SMTP en attente, NOT TESTÉ).
6. **Rate limit** : 5 tentatives / 5 min / IP (fenêtre glissante EN MÉMOIRE
   dans l'app principale — mono-VPS, pas de Redis). TOUTES les tentatives
   comptent (succès inclus) ; un 429 ne consomme pas (pas de prolongation).
   La directive disait « 5/5 min » (la v1.0 disait 5 échecs/15 min — directive
   prime). nginx `limit_req` = durcissement optionnel au déploiement.
7. **Messages uniformes** : échecs d'IDENTIFIANTS (login/break-glass, y
   compris token interne absent — camouflage total) → 401
   `{error:"invalid credentials"}`. Échecs RBAC (`/api/moderation/*` et
   verify/logout/enroll) → 401/403 `{error:"unauthorized"}` — MÊME message
   pour 401 et 403 (aucune fuite de couche).
8. **Double contrôle `/api/moderation/*`** (ordre des contrôles) : token
   interne → session → `X-Admin-Actor` == session → CSRF (mutation) → rôle.
   Le token SEUL ne peut RIEN faire ET le cookie SEUL ne peut rien faire —
   la surface est fermée à tout autre appelant HTTP (le panneau est le seul
   client légitime en prod).
9. **Rôles par action** (aligne le code Étape 0 sur la matrice §4) :
   `user.warn` = support (était moderator) · `queue.view` = auditor (était
   support) · hide/unhide/suspend/unsuspend/purge = moderator. support et
   auditor = lecture seule (directive Étape 4).
10. **Cookie** : `HttpOnly · SameSite=Strict · Path=/` + `Secure` EN
    PRODUCTION UNIQUEMENT (dev sandbox en http://localhost — exception
    documentée, à revérifier au déploiement derrière CF Access).
11. **Idle 30 min** : révocation PARESSEUSE TRACÉE — la première requête qui
    découvre une session idle > 30 min la passe `revokedAt` +
    `revokedReason='idle-timeout'` (preuve en DB). TTL absolu 8 h inchangé.
12. **`report.dismiss`** : n'existe PAS dans `MODERATION_ACTIONS` (Étape 0) —
    reste au périmètre E6 (queue UI). La matrice 55 (§13) est câblée sur les
    11 actions EXISTANTES après Étape 4.
13. **`post.purge`** : reste mono-session moderator jusqu'à E9 (four-eyes le
    retirera de l'UI) — comportement Étape 0 conservé, testé en matrice.
14. **Déploiement** : la migration 0005 exige `AdminSession` VIDE en prod
    (vrai aujourd'hui — aucun login n'existait) : à vérifier par SELECT COUNT
    avant `migrate deploy` (à ajouter au check O-B de l'opérateur).
15. **`ADMIN_INTERNAL_TOKEN`** : figé à l'Étape 2 (compose interpole vers les
    2 services). En dev, il DOIT être passé explicitement au serveur ET aux
    harness (fail-closed : token absent de l'env → tout est refusé).
16. **Matrice RBAC 55** : 11 actions × 5 rôles — les 4 rôles humains
    (super-admin > moderator > support > auditor) + `anonymous` (sans
    session) ; le pseudo-user `system` est exclu (jamais de chemin HTTP).
    Actions : queue.view · user.warn · post.hide · post.unhide · user.suspend ·
    user.unsuspend · post.purge · auth.login · auth.logout · auth.break-glass ·
    internal.verify (tests/admin-auth-e2e.test.ts, section H).
17. **Auditor STRICT (directive Étape 6, clarification 2)** : l'auditor est
    lecture seule sur `AdminAudit` UNIQUEMENT. `queue.view` passe de `auditor`
    (spec v1.0, matrice Étape 4) à `support` — appliqué aux DEUX surfaces :
    `/api/moderation/queue` (Étape 0) et le nouvel endpoint interne cursor
    `/api/internal/admin/queue` (Étape 6). La matrice 55 est ré-alignée :
    auditor → 403 sur queue.view (les tests sont mis à jour, pas affaiblis —
    la contrainte monte d'un cran).
18. **« Warn : 1 modérateur » (directive Étape 6)** : « 1 modérateur » désigne
    le MODE (mono-session immédiat, pas four-eyes), pas un changement de
    rôle — le plancher matrice §4 reste `user.warn = support`, hérité de
    l'arbitrage Étape 4 n°9. hide/unhide/suspend : moderator (inchangé).
19. **UI non-optimiste (directive Étape 6, clarification 1)** : invariant §1.8
    codé dans la queue UI — chaque action attend le 2xx (ou l'erreur) du
    serveur puis REJETTE la page depuis la réponse authentifiée ; aucun état
    local ne présage du résultat. Bug §6.2 ADM-step5.md = cas fondateur.

---

## 13. ARBITRAGES ÉTAPE 7 (2026-11-06 — directive « gestion utilisateurs », tracés en code + tests)

1. **`users.view` = support (matrice §4 #3 re-tranchée)** : la directive Étape 7
   explicite (« page /users protégée requireAdmin('support') ») prime sur la
   matrice v1.0 (`auditor`) qui anticipait elle-même ce re-tranchement
   (« à RE-TRANCHER sous arbitrage §12.17 »). L'auditor strict (§12.17) reste
   403 sur l'annuaire et les fiches — testé (E7·A).
2. **Identifiant opératoire = PUBKEY** : les URLs `/users/[id]` portent la
   pubkey (identité publique stable), pas le cuid interne. Raison : les traces
   ModerationAction/AdminAudit des Étapes 0+6 écrivent déjà
   `targetType='user'`/`targetKind='user'` avec `targetId=<pubkey>` — la fiche
   filtre l'historique sur exactement cette clé (aucune migration de traces).
3. **Durées E7 = 24h | 7d | 30d (pas `indefinite`)** : la directive (« dropdown
   24h/7j/30j ») ferme le jeu des endpoints `/users/[id]/suspend` — une
   suspension « indéfinie » n'est pas offertable sur la fiche MVP ; la levée
   passe par `unsuspend` (§13.5). L'endpoint legacy `/api/moderation/action`
   conserve `indefinite` (comportement A3, non cassé). `SUSPEND_DURATIONS_MS`
   est unifiée dans `user-moderation.ts` ("30d" ajouté au jeu Étape 6).
4. **« sessions révoquées si applicable » = NO-OP documenté** : il n'existe
   AUCUNE session utilisateur (identité = paire de clés locale, pas de login).
   La réponse suspend porte `sessionsRevoked: 0` — le champ prépare la forme
   future sans promettre un effet inexistant.
5. **`unsuspend` exposé sur la fiche (hors lettre de la directive)** : le
   périmètre strict dit « view/suspend/warn », mais sans levée une suspension
   30d est irréversible 30 jours — intenable en exploitation. La sémantique
   existait déjà (Étape 0) : la fiche l'expose (moderator + justification §6).
6. **« Reports reçus » = reports OUVERTS** (colonne annuaire + fiche) : cohérent
   avec le poids de la queue (Étape 6) — la colonne pilote l'action, la
   statistique historique (tous reports confondus) n'est pas rendue.
7. **Filtre statut `banni` accepté → 0 ligne** : aucun champ schéma avant
   l'Étape 9 (four-eyes). Le filtre ne renvoie PAS 400 — l'UI peut l'afficher
   et l'état « banni » apparaîtra à l'Étape 9 sans nouvelle validation.
8. **Tri `inscription` = DESC (plus récents d'abord)** : tranché pour le flux
   de travail support (les comptes récents sont les plus suspects — sybil).
   Tri `reports` = poids DESC puis ancienneté ASC (tiebreak identique queue).
   Garde de VUE : un curseur émis sous un tri est REFUSÉ (400) sous l'autre
   (le `k` du curseur est croisé avec le tri courant).
9. **AUCUNE route ban** (interne ni BFF) : `POST */ban` → 404 — testé (E7·G,
   les deux surfaces). Le bouton UI est désactivé avec tooltip « approbation
   par 2 admins requise — Étape 9 ». Unban (= unsuspend) reste un bouton
   distinct ; l'Étape 9 ajoutera ban définitif + purge en four-eyes.
10. **Recherche LIKE, limite 20, sans pagination** : la directive borne la
    recherche à 20 résultats — le mode recherche ne rend PAS de curseur
    (affiner la requête plutôt que paginer). `%`/`_` échappés (testés).
11. **Transaction unifiée `user-moderation.ts`** : warn/suspend/unsuspend
    exécutent la MÊME transaction (User.update + UserWarning + reports clos +
    ModerationAction + AdminAudit) depuis les DEUX surfaces (legacy
    `/api/moderation/action` et endpoints E7). Prouvé : les suites E3-4 (83),
    E6 (30) et E7 (42) passent à l'identique après extraction.

---

## 14. ARBITRAGES ÉTAPE 8 (2026-11-06 — directive « audit viewer », tracés en code + tests)

1. **`audit.view` = porte EXACTE `auditor` + `super-admin` (PAS une
   hiérarchie)** : la directive Étape 8 teste explicitement support → 403
   ET moderator → 403 (« auditor est plus restrictif que les autres ») —
   incompatible avec un `minRole` (auditor est le PLUS BAS des rôles humains :
   tout `minRole ≥ auditor` les admettrait). Implémentation : option
   `exactRoles` de `requireAdmin` (additive — le mode `minRole` historique
   est inchangé pour les 10 autres actions de la matrice). Le super-admin
   conserve l'accès (règle structurelle : le rôle sommet n'est jamais exclu —
   il a déjà break-glass sur tout le reste).
2. **Export CSV sans beforeJson/afterJson** (directive, à la lettre) : les
   états avant/après restent accessibles par la fiche `/audit/[id]` — l'export
   est un INSTRUMENT DE LECTURE (tableur, jointe de signalement), pas un miroir
   de la table.
3. **Limite export = 10 000 lignes → 422 avec message** (COUNT préalable,
   jamais de troncature silencieuse : un export tronqué serait une preuve
   incomplète). La UI affiche le message et invite à affiner les filtres.
4. **CSV RFC 4180 strict, PAS de BOM** : CRLF, guillemets doublés,
   `charset=utf-8` déclaré — parsable automatisable (les tests le prouvent) ;
   le BOM casserait des parseurs stricts. Chiffrement du CSV à l'export :
   **reporté, tranché** — le panneau est derrière Cloudflare Access + HTTPS ;
   un chiffrement ajouterait une clé à gérer sans menace réelle documentée.
   À ré-évaluer avec le rôle compliance (§2.3) si certification — NON TESTÉ
   (aucune fuite prouvée possible tant que CF Access couvre le panneau).
5. **Lien cible : `targetType='user'` → `/users/<pubkey>`** (arbitrage §13.2 —
   les traces écrivent la pubkey) ; post/report/AdminUser/AdminSession n'ont
   PAS de fiche admin → texte brut (l'Étape 9 ajoutera la cible post au
   four-eyes le cas échéant).
6. **Période : `since` (24h|7d|30d) OU `from/to` custom — from/to PRIME**
   (la plage explicite est plus précise) ; les deux ensemble → 400 (jamais
   d'union ambiguë). Plage custom bornée à 366 jours (garde anti-scan).
7. **Export côté UI = fetch JS (pas `<a href>`)** : le 422 (limite) doit être
   AFFICHABLE — un `<a>` laisse le navigateur montrer un JSON nu. 200 → blob
   téléchargé avec le nom de Content-Disposition (même mécanique que les
   médias B2). Le BFF relaye le CSV OCTET POUR OCTET (callBackend parse du
   JSON — inadapté ; fetch dédié avec les mêmes en-têtes).
8. **FACETS dans la réponse liste** (acteurs, actions, targetTypes distincts
   de l'ensemble FILTRÉ) : les dropdowns de la UI n'exigent aucun second
   endpoint — un seul cerveau de filtres (lib `admin-audit.ts` partagée liste
   + export).
9. **Recherche cible : `type:id` (égalité double) OU sous-chaîne de targetId**
   — la directive illustre avec « user:123 » : le format combiné est le cas
   nominal ; la sous-chaîne couvre les cuids partiels. `targetType`/`targetId`
   sont indexés (migration 0004, `@@index([targetType, targetId])`).
10. **L'export n'écrit RIEN** — pas même une ligne d'audit « export » : lire
    n'est pas une action modératoire ; une trace d'export pourrait en outre
    gonfler le journal de bruit à chaque refresh. (Ré-évaluer en Étape 9 si
    le four-eyes exige la traçabilité des lectures sensibles.)

---

## 15. ARBITRAGES ÉTAPE 9 (2026-11-06 — directive « four-eyes », tracés en code + tests)

1. **Rôle = SUPER-ADMIN pour créer ET approuver (matrice §4 #9-11 réalignée)**
   : la directive É9 dit explicitement « Rôle super-admin requis » pour
   `POST /pending-actions` ET pour l'approbation, et « le bouton Ban définitif
   est actif pour super-admin (plus grisé) ». La matrice v1.0 (#9-11
   `moderator`, « deux moderator distincts suffisent ») anticipait elle-même
   son re-tranchement — fait ici : la chaîne ban/purge exige deux super-admins
   DISTINCTS (id **ET** session différents). Testé : moderator → 403 sur
   create ET approve (E9·T1/E9·T9) ; support/auditor → 403 sur la file.
2. **Statuts `pending | executed | cancelled | expired` (le `rejected` de la
   v1.0 §5 fusionne dans `cancelled`)** : la directive É9 définit le bouton
   « Annuler » (demandeur) et ne décrit AUCUN bouton « Rejeter » côté
   approbateur — un approbateur qui refuse n'a qu'à ne pas agir (l'intention
   expire en 1 h). Le cycle reste 100 % audité : `pendingaction_created`,
   `_cancelled`, `_expired`, et l'EXÉCUTION porte la ligne de la VRAIE action
   (`ban` | `purge`) — cycle nominal = **2 lignes AdminAudit exactement**
   (request + execute), après requestedBy/approvedBy en afterJson.
3. **« user disabledAt rempli » (directive) = `User.bannedAt` + `bannedById`**
   : sémantique identique (compte désactivé définitivement), nom aligné sur le
   schéma §5 v1.0 (`bannedAt/bannedBy`) déjà engagé dans les arbres de
   décision. Pas de unban UI (§5 conservé) — un débannissement exigerait un
   autre four-eyes ou un CLI (hors périmètre É9).
4. **Ban = publication 403 + posts masqués** : la directive (« ses
   posts/commentaires masqués, hiddenBy = admin qui a exécuté ») est implémentée
   `Post.updateMany({hiddenAt: null}, {hiddenAt: now, hiddenById: exécutant})`
   dans la même transaction ; double barrière feed (`bannedAt: null` sur
   l'auteur) et publication (403 « banni définitivement » distincte du
   message suspension — le message ne doit pas prêter à un recours inutile).
5. **Timeout = évaluation PARESSEUSE (pas de cron)** — tranché à la directive
   (« à trancher ») : expiresAt est évalué aux points d'application
   (approbation → 410 Gone ; GET liste → balayage paresseux audité
   `pendingaction_expired`, lignes grisées côté UI puis disparition du statut
   pending au rejeu). Zéro job de fond — cohérent avec le pattern É6
   (suspension paresseuse). NON TESTÉ : purge SQL des lignes expirées
   (conservées pour l'audit — append-only de fait).
6. **Doublon : 409 si une intention OUVERTE existe pour (actionType, cible)**
   — sinon deux intentions identiques seraient approuvables successivement ;
   un ban sur un utilisateur DÉJÀ banni → 409 aussi. La purge d'un post
   supprimé entre-temps → 404 à l'approbation (cible disparue, ligne
   d'audit créée à la demande reste tracée).
7. **Notification = log structuré (`[pending-action:notify]`)** en attendant
   SMTP — loggue les emails des autres super-admins actifs à CHAQUE création.
   NON TESTÉ : envoi email réel (SMTP absent, fallback log assumé — directive).
