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

### 2.3 Création / désactivation des comptes
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
| 1 | `dashboard.view` (4 métriques) | `auditor` | endpoint interne (E5) | Étape 5 |
| 2 | `queue.view` (file de signalements + contexte) | `auditor` | `GET /api/moderation/queue` | **Étape 0** |
| 3 | `users.view` (recherche + fiche) | `auditor` | endpoint interne (E7) | Étape 7 |
| 4 | `audit.view` (journal, lecture seule) | `auditor` | endpoint interne (E8) | Étape 8 |
| 5 | `user.warn` | `support` | endpoint interne (E7) | Étape 7 |
| 6 | `report.dismiss` (sans action) | `support` | `POST /api/moderation/action` | **Étape 0** |
| 7 | `post.hide` / `post.unhide` (réversible) | `moderator` | `POST /api/moderation/action` | **Étape 0** |
| 8 | `user.suspend` / `user.unsuspend` (réversible) | `moderator` | endpoint interne (E7) | Étape 7 |
| 9 | `ban.request` (four-eyes, **définitif**) | `moderator` | endpoint interne (E9) | Étape 9 |
| 10 | `post.purge.request` (four-eyes, irréversible) | `moderator` | endpoint interne (E9) | Étape 9 |
| 11 | `four-eyes.approve` / `.reject` | `moderator` **≠ auteur** | endpoint interne (E9) | Étape 9 |

**Règles structurelles :**
- Les actions **réversibles** (7, 8) restent mono-session (comportement Étape 0 conservé, e2e S10/S14).
- Les actions **irréversibles** (9, 10) exigent **TOUJOURS le four-eyes** — y compris pour un `super-admin` isolé. Deux `moderator` distincts suffisent.
- `post.purge` direct existant (Étape 0, mono-session) est **retiré de la surface UI** à l'Étape 9 : le CLI le conserve (urgence sans panneau), l'UI ne passe plus que par four-eyes.

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
