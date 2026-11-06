# PREUVES ADM ÉTAPES 3+4 — Auth (login + TOTP + break-glass) + RBAC

**Date** : 2026-11-05/06 (Kinshasa WAT) · **Branche** : `feat/adm-mvp` · **Worktree** : `/home/z/wt-adm` (externe — DEV-SETUP §2.0)
**Commits** : `8584487` (DEV-SETUP worktrees) → `4630852` (fondations auth + CLI) → `7258470` (RBAC + BFF + UI + tests) → `0c54a82` (outil DEV) → `39c28f6` (arbitrages §12) → *ce rapport*
**Directive** : « ÉTAPE 3+4 — Auth + RBAC » · **Arbitrages** : docs/specs/ADMIN-RBAC.md §12 (16 points tranchés)

---

## 0. VERDICT

**Étape 3+4 : VERTE.** 128/128 tests `bun test` (dont matrice RBAC 55/55) · e2e A3 réaligné 43/43 · lint + typecheck verts (2 apps) · preuves navigateur capturées (login, cookie HttpOnly, CSRF, logout, break-glass) · zéro secret en DB / en réponse (méthode canari, section I).

C'est « **admin foundation v1** » : après déploiement de 0+3+4 (+ CF Access + O-B/O-A), un super-admin peut se connecter et la surface `/api/moderation/*` est RBAC-complète — les features UI (dashboard, queue) arrivent aux Étapes 5–7.

---

## 1. CE QUI EST LIVRÉ (fichier : ligne)

| Livrable | Où |
|---|---|
| Migration `0005_admin_auth` (100 % additive : `AdminSession.tokenHash @unique`, `AdminSession.revokedReason`, `AdminUser.totpLastCounter`, table `AdminRecoveryCode`) | `prisma/migrations/20261105212940_0005_admin_auth/migration.sql` |
| TOTP RFC 6238 (HMAC-SHA-1 node:crypto, ±1 = ±30 s, anti-rejeu par compteur, base32, otpauth) | `src/lib/mbote/totp.ts` |
| Garde token interne (timing-safe, fail-closed) + IP client + rate-limit glissant 5/5 min/IP | `src/lib/mbote/admin-internal.ts` |
| Sessions token-hash (32 octets aléatoires, SHA-256 seul en DB), idle 30 min tracé, absolu 8 h, révocations nommées, `requireAdmin` 5 contrôles uniformes, `getSessionFromCookie`, `writeAdminAudit`, `revokeAllAdminSessions` | `src/lib/mbote/admin-auth.ts` |
| Vérification credentials (Argon2id @node-rs/argon2 + TOTP + anti-timing hash leurre + premier login = enrôlement) | `src/lib/mbote/admin-login.ts` |
| Endpoints internes (app principale, token interne) : `login` · `verify` · `logout` · `break-glass` · `totp-enroll` | `src/app/api/internal/admin/*/route.ts` |
| Double contrôle `/api/moderation/*` (token interne + X-Admin-Actor + CSRF + rôles PAR ACTION : warn=support, queue=auditor, autres=moderator) | `src/app/api/moderation/action/route.ts:14-21,55-71` · `queue/route.ts:30` |
| BFF admin SANS état (zéro prisma — invariant §1) : `/api/admin/auth/{login,logout,break-glass,totp-enroll}` · `/api/admin/session` · proxy `/api/admin/moderation/queue` | `admin/src/app/api/admin/**` · `admin/src/lib/admin-backend.ts` |
| CLI `admin:bootstrap` (refus si admin existant · garde prod `--allow-prod` bidirectionnelle · QR ASCII + secret + 2 codes hashés Argon2id affichés UNE fois · audit `bootstrap` transactionnel) | `scripts/admin-bootstrap.ts` (+ `bun run admin:bootstrap`) |
| UI panneau : login 3 champs · carte session · logout · break-glass · ré-enrôlement TOTP | `admin/src/components/AdminAuthPanel.tsx` · `admin/src/app/page.tsx` (état de session calculé côté serveur) |
| Compose : `ADMIN_INTERNAL_TOKEN` déjà interpolé vers les 2 services (figé Étape 2) | `docker-compose.yml:31,101` |

## 2. TESTS — `bun test` : **128 pass / 0 fail** (7 fichiers, 335 expect)

```
 128 pass
   0 fail
 335 expect() calls
Ran 128 tests across 7 files. [16.01s]
```

- **`tests/admin-totp.test.ts` (11/11)** : 6 vecteurs NORMATIFS RFC 6238 Appendice B (SHA-1 : T=59→287082, T=1111111109→081804, T=1111111111→050471, T=1234567890→005924, T=2000000000→279037, T=20000000000→353130) · base32 RFC 4648 · fenêtre ±1 (±30 s pas plus : ±60 s refusé) · anti-rejeu compteur · entrées invalides.
- **`tests/admin-bootstrap.test.ts` (5/5)** : B1 premier run (super-admin + QR + 2 codes affichés, hash vérifiés par Argon2id contre le stdout, audit `bootstrap` actorId=1/system) · B2 second run REFUSÉ · B3 `--allow-prod` hors prod REFUSÉ · B4 prod sans `--allow-prod` REFUSÉ · B5 aucun secret en clair en DB.
- **`tests/admin-auth-e2e.test.ts` (83/83)** — deux serveurs RÉELS (app principale :3101 + panneau :3102, DB migrations 0001→0005) :
  - **A** login : valide → 200 + cookie (HttpOnly, SameSite=strict, Path=/) + csrfToken, token ABSENT du body · email faux / password faux / TOTP faux / TOTP expiré (−90 s) / TOTP rejoué / admin désactivé → **6× 401 identiques** `{invalid credentials}` · premier login → `totp_enrolled` audité.
  - **B** rate limit : 5 tentatives OK puis **6ᵉ → 429** `{too many attempts}` même avec des identifiants valides.
  - **C** sessions : cookie absent/inconnu → 401 · idle >30 min → 401 + `revokedReason='idle-timeout'` EN DB · absolu 8 h → 401 · logout → révoqué + audité · DB ne contient QUE le hash (le token n'apparaît dans AUCUN champ).
  - **D** CSRF : mutation sans header → 403 · mauvais token → 403 · **même message que 401** (anti-fuite de couche) · logout BFF sans CSRF → 403.
  - **E** break-glass : code valide → 200 + nouveau secret ≠ ancien + ancienne session morte + code brûlé (`usedAt`/`usedIp`) + audit · même code re-soumis → 401 · code invalide → 401 uniforme · ré-enrôlement (nouveau secret) → `totpEnrolled=true` et l'ANCIEN secret est mort (login ancien TOTP → 401).
  - **F** token interne : token SEUL → 401 · cookie SEUL → 401 · mauvais token → 401 · sans X-Admin-Actor → 401 · actor mismatch → 401 · complet → 200 · **chaîne BFF complète** (cookie navigateur → proxy → app principale) → 200.
  - **G** sessions indépendantes : 2 admins simultanés, csrfTokens distincts, audits nominatifs distincts (actorId).
  - **H** **MATRICE RBAC : 11 actions × 5 rôles = 55 cellules, 55/55 PASS** (tableau §3).
  - **I** preuve anti-fuite : scan de TOUS les payloads de réponse — aucun password, aucun secret TOTP, aucun code de secours, aucun token de session (hors break-glass : nouveau secret PAR CONCEPTION, sur HTTPS admin).
- **`tests/moderation-e2e.ts` (script, réaligné Étape 4) : tous les scénarios PASS** — y compris S13 mis à jour : CSRF absent/faux → 403 avec token interne + acteur PRÉSENTS (ordre requireAdmin : token → session → acteur → CSRF → rôle).

## 3. MATRICE RBAC — 55/55 PASS

Rôles (hiérarchie) : super-admin(4) > moderator(3) > support(2) > auditor(1) + **anonymous** (sans session). `system` exclu (jamais de HTTP). Minimaux : matrice §4 câblée (`action/route.ts:14-21`, `queue/route.ts:30`).

| # | Action | super-admin | moderator | support | auditor | anonymous |
|---|---|---|---|---|---|---|
| 1 | `queue.view` (GET /api/moderation/queue) | 200 | 200 | 200 | 200 | 401 |
| 2 | `user.warn` (min support) | 200 | 200 | 200 | **403** | 401 |
| 3 | `post.hide` (min moderator) | 200 | 200 | **403** | **403** | 401 |
| 4 | `post.unhide` | 200 | 200 | **403** | **403** | 401 |
| 5 | `user.suspend` | 200 | 200 | **403** | **403** | 401 |
| 6 | `user.unsuspend` | 200 | 200 | **403** | **403** | 401 |
| 7 | `post.purge` | 200 | 200 | **403** | **403** | 401 |
| 8 | `auth.login` (BFF, pré-auth) | 200 | 200 | 200 | 200 | 401 |
| 9 | `auth.logout` (interne : token+session+CSRF) | 200 | 200 | 200 | 200 | 401 |
| 10 | `auth.break-glass` (BFF, pré-auth code) | 200 | 200 | 200 | 200 | 401 |
| 11 | `internal.verify` (token + session) | 200 | 200 | 200 | 200 | 401 |

Chaque cellule = un `test()` bun (section H de `tests/admin-auth-e2e.test.ts`) : 200 = autorisé · 403 = rôle insuffisant · 401 = anonyme/sans session. Ordre volontaire : les actions qui révoquent des sessions (9, 10) passent en DERNIER.

## 4. PREUVES NAVIGATEUR (agent-browser, app admin en BUILD PRODUCTION :3102 ↔ app principale :3101, DB preuve dédiée)

| Capture | Fichier | Preuve |
|---|---|---|
| Session authentifiée | `docs/proofs/assets/adm-step3-login-authed.png` | Carte : `operateur@mbote.test` · `super-admin` · TOTP enrôlé (login 3 champs, un round-trip) |
| Cookie posé + HttpOnly | sortie terminal (§4.1) | `agent-browser cookies` → `mbote_admin_session=…` existe ; **`document.cookie` = `""`** — invisible au JS |
| CSRF reçu | e2e A1 + flux UI | `{csrfToken}` dans le body du login (43 chars base64url) — utilisé par logout/enrôlement |
| Déconnexion | flux UI (snapshot) | Retour au formulaire anonyme ; DB : `revokedReason='logout'` |
| Break-glass utilisé | `docs/proofs/assets/adm-step3-breakglass-form.png` + `adm-step3-breakglass-enroll.png` | Code 1 soumis dans l'UI → panneau « Ré-enrôlement TOTP requis » + NOUVEAU secret affiché une fois |

### §4.1 Sortie brute `admin:bootstrap` (secrets masqués — fichier : `assets/adm-step3-bootstrap-output.txt`)

```
✅ Super-admin créé : id=2 role=super-admin totpEnrolled=false
Mot de passe : [MOT-DE-PASSE-MASQUÉ]
── Enrôlement TOTP (obligatoire à la première connexion) ──
[QR ASCII — bloc ▄▀ rendu par le paquet qrcode, type terminal, présent dans le fichier]
Secret base32 (saisie manuelle) : [SECRET-TOTP-MASQUÉ]
URI otpauth : otpauth://totp/Mbote%20Admin:operateur%40mbote.test?secret=…&issuer=Mbote%20Admin&algorithm=SHA1&digits=6&period=30
── Codes de secours break-glass (2, chacun utilisable UNE fois) ──
1. [CODE-1-MASQUÉ]
2. [CODE-2-MASQUÉ]
```

Refus au 2ᵉ run (`assets/adm-step3-bootstrap-refus.txt`, exit 1) :
```
REFUSÉ : un AdminUser existe déjà (1) — bootstrap réservé au PREMIER compte.
```

### §4.2 Vérifications DB (après les flux navigateur ci-dessus)

```
AdminSession:   { adminUserId: 2, tokenHash: "c4febfed4e31fc913eeb…", revokedAt: null }
                → le hash ≠ token du cookie (1ch9mWXT…) : seul le hash vit en DB
AdminAudit:     [{ action:"login_success", actorId:2 }, { action:"totp_enrolled", actorId:2 }]
AdminRecoveryCode: [{ id:1, usedAt:"2026-11-05T22:06:10.801Z", usedIp:"::ffff:127.0.0.1" },   ← code 1 BRÛLÉ
                    { id:2, usedAt:null }]                                                      ← code 2 intact
AdminAudit[break-glass]: { actorId:2, actorRole:"super-admin", targetType:"AdminUser", targetId:"2",
                           afterJson:{recoveryCodeId:1, sessionsRevoked:…, newSecretIssued:true, totpEnrolled:false} }
AdminUser:      { totpEnrolled:false, secret:"5YLTXZL7…" }  ← NOUVEAU secret (ré-enrôlement forcé)
```

Rejet du code brûlé depuis le navigateur : `POST /api/admin/auth/break-glass` (code 1) → **401** `{"error":"invalid credentials"}`.

### §4.3 Preuve pas de fuite (grep payloads)

Méthode canari automatisée (e2e, section I) : le harness enregistre CHAQUE payload de réponse (login, session, logout, queue, break-glass) puis vérifie qu'aucun ne contient : les mots de passe seedés, les secrets TOTP d'origine, les 2 codes de secours, l'un des tokens de session émis. **Résultat : 0 violation.** Seule exception PAR CONCEPTION : la réponse break-glass porte le NOUVEAU secret (réseau interne + HTTPS admin, montré une fois — arbitrage §12.5). En DB : `AdminRecoveryCode.codeHash` et `AdminUser.passwordHash` Argon2id ; `AdminSession.tokenHash` SHA-256 ; aucun champ ne contient un secret en clair.

## 5. QUALITÉ

- `bunx tsc --noEmit` : vert (app principale + admin).
- `bun run lint` : vert (app principale + admin) — zéro `!` non-null dans les tests (helper `must()`), règle `react-hooks/set-state-in-effect` respectée (état de session calculé côté serveur, zéro effet de chargement).
- `bun run build` admin : vert (sortie standalone).

## 6. INCIDENTS PENDANT L'ÉTAPE (transparence)

1. **Hydratation dev Turbopack muette** : en `next dev`, l'app admin ne s'hydratait pas (aucune erreur console — vérifié par sonde `__reactFiber$`). Rejoué en **build production** (`next build` + `next start`) → hydratation OK, preuves capturées en prod-build (plus représentatif). À surveiller à l'Étape 5 (dashboard) ; aucun impact prod (déploiement en standalone).
2. **`callBackend` méthode par défaut** : les appels internes SANS body partaient en GET (405 sur verify) — corrigé (POST par défaut dès qu'une session/csrf/acteur est présente) ; c'est ce qui a fait passer D3/E4/F7 au vert.
3. **Harness eager-promise** (section A) : les 6 scénarios d'échec s'exécutaient en parallèle et se marchaient sur l'anti-rejeu TOTP — convertis en thunks séquentiels.

## 7. NOT TESTÉ À DOCUMENTER (attendu par la directive)

- **SMTP** (notifications break-glass aux autres super-admins) — fallback `console.warn` en place (`break-glass/route.ts`), à câbler au Bloc C.
- **CF Access** — au déploiement (action opérateur, runbook §2 P4).
- **Rate limit en charge réelle** — le test unitaire/e2e (6ᵉ → 429) suffit pour cette étape ; limiteur en mémoire locale : un redémarrage réinitialise les compteurs (fenêtre 5 min, acceptable mono-VPS).
- **Rotation self-service du mot de passe** — Étape 7 (gestion des admins).
- **Secure cookie en dev** — posé uniquement en `NODE_ENV=production` (arbitrage §12.10) ; à revérifier derrière CF Access.
- **Implémentation TOTP maison** validée par les vecteurs RFC 6238 App. B — **revue sécurité indépendante recommandée avant ouverture publique** (note de validation Étape 3+4, 2026-11-05 : acceptable pour l'usage actuel admin interne, pas public ; traçabilité uniquement, pas de re-travail).

## 8. DISCIPLINE

- Worktree EXTERNE `/home/z/wt-adm` du début à la fin — **zéro commande git dans `/home/z/my-project`** (hormis la création du worktree, seule tolérée, documentée DEV-SETUP §2.0). Le repo principal est resté sur `main`.
- Une étape = une série de commits sur `feat/adm-mvp` (6 commits, aucun push).
- Migrations versionnées (`migrate dev` — jamais `db push` pour évoluer, DEV-SETUP §4).
- Condition de déploiement à ajouter au check O-B : `SELECT COUNT(*) FROM AdminSession` doit être **0** avant `migrate deploy` (0005 exige la table vide — vrai aujourd'hui).
- Dépendances ajoutées : `@node-rs/argon2`, `qrcode`, `@types/qrcode` (dev). Aucune dépendance ajoutée à `admin/` (invariant §1 intact — vérifiable par grep).

## 9. PROCHAINE ÉTAPE

**Étape 5 — dashboard** (1–1,5 jp) + **démarrage B1 en parallèle** (worktree `/home/z/wt-b1`, branche dédiée, rien ne déploie) — conformément aux clarifications 1 et 2 de la directive.
