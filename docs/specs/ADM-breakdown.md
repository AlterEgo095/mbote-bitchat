# BREAKDOWN ADM MVP — ÉTAPES 3–10 (test de maturité de l'Étape 1)

**Version** : 1.0 · **Date** : 2026-11-05 (Kinshasa WAT) · **Total : 16–20 jp** (borne haute ≤ 20, conforme à la directive)
**Hypothèses de charge** : 1 dev, mono-VPS. 1 jp = 1 jour-personne effectif (6–7 h focalisées), **tests + preuve inclus dans chaque poste** (jamais une ligne à part).
**Socle déjà en place (Étape 0, preuve `ADM-rupture.md`)** : schéma `AdminUser/AdminSession/AdminAudit` + triggers append-only · `requireAdmin()` session+CSRF+rôles · endpoints `/api/moderation/*` session-based (e2e 43/43) · CLI purge audité · squelette app admin + compose + vhost (Étape 2). **L'app admin ne touche pas la DB** — les données passent par endpoints internes de l'app principale (RBAC §8).

---

## 1. TABLE DE CHARGE

| Poste | Contenu livré | Critère d'acceptation (testable, re-jouable) | jp |
|---|---|---|---|
| **E3 — auth** | endpoints internes `login/verify/logout` (app principale) · lib Argon2id (`@node-rs/argon2`) + TOTP (`otplib`) · rate-limit 5/15 min · UI login + enrôlement TOTP forcé (QR une fois) · 2 codes break-glass hashés + burn · CLI `admin-create` / `admin-reset-totp` | e2e : login ok → cookies posés ; login ko → 422 uniforme + audit `login_failed` ; 6e échec → 429 ; enroll une seule fois ; break-glass brûle et ne re-sert pas ; session expirée/révokée/admin désactivé → 401 | **4–5** |
| **E4 — RBAC + token interne** | `requireInternal()` (header `x-admin-internal`, timing-safe) sur `/api/internal/admin/*` · middleware de l'app admin (verify par requête + rejeu cookie/CSRF vers mbote) · matrice RBAC §4 câblée sur les routes | e2e : sans token interne → 401 uniforme ; mauvais token → 401 ; `auditor` lit tout mais toute mutation → 403 ; CSRF manquant/faux → 403 | **1,5–2** |
| **E5 — dashboard** | 1 endpoint interne (4 compteurs : users, posts, reports pending, actions 7 j) + carte UI unique | `curl` du compteur == résultat des mêmes COUNT en SQL direct (écart = 0) ; UI rend les 4 valeurs ; < 500 ms | **1–1,5** |
| **E6 — queue UI** | liste signalements (pagination 20, contexte post + auteur) · actions hide / dismiss avec justification (catégorie + ≥ 20 chars, serveur) | e2e : hide → post absent du fil + `hiddenBy` = admin ; dismiss → report clôturé ; justification courte → 422 ; chaque action = 1 ligne `AdminAudit` | **2–2,5** |
| **E7 — users UI** | recherche préfixe · fiche (posts, reports émis/subis, statut) · warn / suspend / unsuspend · demande de ban (création `PendingAction`) | e2e : suspendu → publication 403 ; unsuspend → retour ; warn audité ; ban demandé → `PendingAction` `pending` (pas d'effet immédiat) | **2–2,5** |
| **E8 — audit viewer** | table paginée (50/page) + filtres acteur / action / date — lecture seule stricte | `curl` pagination + 3 filtres ; UI rend ; **zéro** bouton de mutation dans l'écran ; 0 écriture DB depuis ce chemin | **1–1,5** |
| **E9 — four-eyes** | UI + backend approve/reject · expiration lazy (1 h) · exécution transactionnelle purge + ban · `User.bannedAt/bannedBy` (migration `0005_four_eyes`, 100 % additive) · purge directe retirée de l'UI | e2e : auto-approbation (même user ou même session) → refus ; 2e admin → exécution + audit ; expiry → `expired` audité ; ban → user bloqué en écriture ; migration rejouée sur DB vierge | **2–2,5** |
| **E10 — tests + preuves finales** | suites consolidées (unit + e2e admin) · garde CI `sqlite_master` (triggers toujours présents) · `docs/proofs/ADM-mvp.md` · runbook à jour (retours réels) | `bun test` + e2e verts en une commande ; grep 0 secret dans DB + réponses ; preuve avec SHAs ; checklist runbook §7 cochée | **2–2,5** |
| **TOTAL** | | | **16–20** |

---

## 2. RÈGLES DE PILOTAGE (non négociables)

1. **Stop-rule** : si un poste dépasse sa borne haute de **+0,5 jp**, STOP — re-estimation écrite du poste et du total avant de continuer (le total doit rester ≤ 20 ou déclencher le plan B §3).
2. **Definition of Done par poste** : code + tests re-jouables + rapport de preuve (`docs/proofs/ADM-step<N>.md`) + commit propre. Pas de « ça marche chez moi ».
3. **Dépendances** : E3 → E4 → (E5, E6, E7, E8 parallélisables) → E9 (dépend E6+E7) → E10. Rien de l'Étape N+1 ne démarre avant la preuve verte de l'Étape N.
4. **Déploiement** : rien ne part en prod avant E4 verte (auth+RBAC = prérecquis du runbook §2 P4) — conformément au recadrage §4.
5. **Ordre de déploiement global** : ADM → B1 (rien ne déploie avant que la chaîne amont soit verte).

---

## 3. PLAN B — MVP RESSERRÉ (déclenché si E3 explose)

Si la stop-rule s'applique deux fois sur E3 (le poste le plus risqué : crypto + deps natives), le périmètre sort **E5 (dashboard)** et **E8 (audit viewer)** — lecture seule, aucune perte de capacité de modération :

| Poste | jp |
|---|---|
| E3 auth · E4 RBAC · E6 queue · E7 users · E9 four-eyes · E10 tests | 4–5 · 1,5–2 · 2–2,5 · 2–2,5 · 2–2,5 · 2–2,5 |
| **TOTAL plan B** | **14–17** |

Dashboard et audit viewer restent dans la feuille de route post-MVP (bloc A, avant B2). La décision de basculer en plan B est **écrite et justifiée** dans le rapport de preuve du poste concerné — jamais silencieuse.

---

## 4. HORS PÉRIMÈTRE (rappel — `ADMIN-RBAC.md` §11)

Gestion des comptes admin via UI · i18n du panneau · WebAuthn · mTLS interne · chiffrement champ-niveau au repos · dashboard temps réel. Toute demande d'ajout = re-estimation écrite du total avant accord.

---

## 5. ESTIMATION BLOCS SUIVANTS (ordres de grandeur — breakdown fin produit au démarrage de chaque item, même méthode)

| Bloc | Contenu | Estimation grossière |
|---|---|---|
| B1 socle média | CEK, URLs présignées, EXIF strip, limites, benchmark | 3–4 jp |
| B2 images · B3 notes vocales (Opus) | vignette mesh + original · 6–12 kbps | 2–3 · 2–3 jp |
| C1 push (VAPID+FCM+APNs) | 2–3 jp · C2 appels audio WebRTC+TURN 3–4 jp · C3 vidéo 3–4 jp · C4 groupes MLS 4–6 jp | 12–17 jp |
| D1 recherche FTS5 · D2 Sybil Phase 0 · D3 durcissement | 2–3 · 2–3 · 1–2 jp | 5–8 jp |
| Bloc C frontend mature (E, F, G) | cohérence écrans, UI médias, multi-appareils + i18n | 9–14 jp |
| **Reste total projet (après ADM)** | | **≈ 31–46 jp** |

Ces fourchettes sont des ordres de grandeur assumés : **chaque item produit son breakdown fin (même format que ce document) au moment de son démarrage** — jamais avant, jamais au feeling à la semaine 3.
