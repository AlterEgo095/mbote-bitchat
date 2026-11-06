# PREUVES ADM ÉTAPE 5 — Dashboard (instrument de pilotage, 4 métriques)

**Date** : 2026-11-06 · **Branche** : `feat/adm-mvp` · **Worktree** : `/home/z/wt-adm`
**Directive** : « Le dashboard est un instrument de pilotage, pas une vitrine.
4 métriques, rien de plus. »

## 0. VERDICT

**Étape 5 LIVRÉE ET PROUVÉE.** 22/22 tests e2e dashboard + 128 pass / 0 fail en
suite globale (24 skip = harnais à DB dédiée, skip propre). Preuves navigateur
capturées en **BUILD PRODUCTION** des deux apps (DEV-SETUP §2c), rejouables via
`bash scripts/adm-step5-proof-run.sh` (une commande, un seul tour d'outils).

## 1. CE QUI EST LIVRÉ (fichier : ligne)

| Élément | Fichier | Ancrage |
|---|---|---|
| 4 métriques + seuils documentés (single source of truth) | `src/lib/mbote/dashboard-stats.ts` | `DASHBOARD_THRESHOLDS` :39, `computeDashboardMetrics` :189 |
| Actifs 24 h/7 j — SQL DIRECTE (directive), `Post` par FK, `DirectMessage` par correspondance pubkey (pas de FK — boîte aux lettres aveugle) | id. | `countActiveUsers` :165 |
| Backup — fs.readFile, `BACKUP_STATUS_PATH` configurable, fallback « not configured » | id. | `readBackupStatus` :65 |
| Endpoint interne `/api/internal/admin/stats` — `requireAdmin({minRole:"support"})` | `src/app/api/internal/admin/stats/route.ts` | :28 |
| Endpoint interne dédié `/api/internal/admin/backup-status` (directive) | `src/app/api/internal/admin/backup-status/route.ts` | :25 |
| BFF `/api/dashboard` — proxy authentifié + DÉGRADATION 502 | `admin/src/app/api/dashboard/route.ts` | :26, :34 |
| Page `/dashboard` — auth serveur, rôle ≥ support, données INITIALES SSR, bandeau panne | `admin/src/app/dashboard/page.tsx` | `initialMetrics` :44, `backendDown` :71 |
| Composant client — 4 cartes (valeur + horodatage + couleur + seuil), refresh manuel, états d'erreur | `admin/src/components/DashboardMetrics.tsx` | — |
| Lien « Tableau de bord → » sur la page d'accueil (session active) | `admin/src/app/page.tsx` | — |
| Seed de preuve REJOUABLE | `scripts/adm-step5-proof-seed.ts` | — |
| Runner de preuves REJOUABLE (curl + navigateur + dégradation) | `scripts/adm-step5-proof-run.sh` | — |

**Aucune donnée sensible** dans les payloads (directive) : pas d'email, pas
d'IP, pas de contenu de DM, pas de pubkey, pas de chemin serveur — prouvé en
§3 (grep anti-fuite) et test A7.

## 2. TESTS — `bun test`

- **`tests/admin-dashboard-e2e.test.ts` : 22 pass / 0 fail** (86 expect) —
  harnais auto-hébergé (app principale :3105 + panneau :3106, DB migrations
  0001→0005 dédiée, garde `DATABASE_URL` module-level → **skip propre** en
  suite globale, message console explicite — jamais de faux rouge).
- **Suite globale : 128 pass / 0 fail** (24 skip) — zéro régression
  (Étapes 1–4 intactes, y compris matrice RBAC 55/55).
- Couverture des scénarios de la directive :
  - **A** endpoint interne : token SEUL → 401 (A1) · session sans token → 401
    (A2) · support → 200 avec les 4 clés (A3) · **valeurs conformes aux
    fixtures h24=2, d7=4, reports=2, backup ok** (A4) · **auditor → 403**
    (A5) · acteur mismatch → 401 (A6) · anti-fuite payload (A7) ;
  - **B** backup-status : ok frais → vert (B1) · ancien 48 h → stale orange,
    **relit le fichier à chaque appel (pas de cache — directive)** (B2) ·
    failed → rouge (B3) · fichier absent → not-configured orange (B4) ;
  - **C** BFF : sans cookie → 401 (C1) · support → 200 (C2) · moderator → 200
    (C3) · **auditor → 403** (C4) · 401/403 message UNIFORME « unauthorized »
    (C5) ;
  - **D** page UI : anonyme → redirection `/` sans fuite (D1) · support → 200
    HTML avec les 4 métriques **SERVIES** — valeurs `2 / 4` et « backup
    récent » rendues serveur, sans attendre l'hydratation (D2) · auditor →
    carte « Accès refusé » rendue serveur (D3) ;
  - **E** dégradation : kill backend → **BFF 502 `backend-unreachable`** (E1)
    · page `/dashboard` pendant la panne → **reste sur place + bandeau
    « Backend injoignable »**, PAS de redirection mensongère « session
    expirée » (E1b) · respawn → 200 à nouveau (E2).

## 3. PREUVE CURL — session support valide : les 4 clés (artifact
`assets/adm-step5-dashboard-json.txt`)

```json
{"generatedAt":"2026-11-06T06:36:08.166Z",
 "activeUsers":{"h24":2,"d7":4,"status":"orange","updatedAt":"2026-11-06T06:36:08.166Z"},
 "openReports":{"value":2,"status":"green","updatedAt":"2026-11-06T06:36:08.166Z"},
 "uptime":{"seconds":1,"status":"red","updatedAt":"2026-11-06T06:36:08.166Z"},
 "backup":{"state":"ok","at":"2026-11-06T05:36:06.891Z","ageHours":1,"status":"green","detail":"backup récent","updatedAt":"2026-11-06T06:36:08.166Z"}}
```

- Les 4 clés de la directive, valeur + horodatage + couleur par métrique.
- Valeurs = fixtures du seed rejouable (2 actifs 24 h, 2 de plus sur 7 j,
  2 reports ouverts sur 3, backup frais 1 h).
- Couleurs = seuils documentés (`DASHBOARD_THRESHOLDS`) : actifs 2 → orange,
  reports 2 → vert, uptime < 1 h → rouge (serveur de preuve démarré),
  backup 1 h → vert.
- **Anti-fuite (grep du payload)** : aucun `step5.proof` (emails), aucun
  ciphertext DM, aucune pubkey, aucune clé `"email"/"ip"/"password"` — PASS.

### §3b Token interne seul → 401 (artifact `assets/adm-step5-internal-token-only.txt`)

`GET /api/internal/admin/stats` avec `x-admin-internal` SANS session →
**HTTP 401** `{"error":"unauthorized"}` — le token interne SEUL ne peut rien
faire (directive Étape 4, ré-appliquée au nouvel endpoint).

### §3c Auditor → 403 (artifact `assets/adm-step5-auditor-403.txt`)

Session auditor valide (login panel 200, rôle auditor) → BFF `/api/dashboard`
→ **HTTP 403** `{"error":"unauthorized"}` — message uniforme, l'auditor ne
découvre pas QUELLE couche a refusé. L'app principale impose le rôle (défense
en profondeur : la page UI refuse aussi, §4.3).

## 4. PREUVES NAVIGATEUR (builds production :3101 principale + :3102 panneau —
DEV-SETUP §2c ; captures `assets/adm-step5-*.png`)

### §4.1 Dashboard avec les 4 métriques remplies — `assets/adm-step5-dashboard.png`

Session support (login 3 champs + TOTP, un round-trip). Les 4 cartes affichent
valeur, badge de couleur, horodatage « Mise à jour », seuils : « 2 / 4 »
(orange vigilance), « 2 » reports (OK), uptime « 5 s » (critique — serveur de
preuve démarré à l'instant, seuil < 1 h), « backup récent » (OK). Pied de page
sticky. Capture complémentaire après **clic Rafraîchir** :
`assets/adm-step5-dashboard-refresh.png` (rafraîchissement manuel OK, photo
instantanée re-horodatée).

### §4.2 Auditor — `assets/adm-step5-auditor-refused.png`

Session auditor sur `/dashboard` : carte « Accès refusé » rendue serveur —
« Le rôle auditor est limité à la consultation de l'audit … exige support
minimum — la même règle est appliquée par l'API (403), défense en profondeur. »

### §4.3 DÉGRADATION — kill backend : `assets/adm-step5-degradation.png`

1. `kill` du serveur principal ;
2. curl BFF → **HTTP 502** `{"error":"backend-unreachable"}`
   (`assets/adm-step5-degradation-502.txt`) — ni 500 brut, ni crash de route ;
3. rechargement de `/dashboard` : la page **reste sur place** (badge « liaison
   app principale perdue ») et affiche le bandeau rouge **« Backend
   injoignable — L'app principale ne répond pas… Réessayez avec le bouton
   Rafraîchir »** — PAS de redirection vers / (qui mentirait : « session
   expirée » pendant une panne).

## 5. ARBITRAGES (§ suite de ADM-step3-4 §12)

1. **Uptime = `process.uptime()` local** (arbitrage) : la même source que
   `/api/stats` (consommé par le health check Étape 2) — pas d'appel HTTP de
   l'app à elle-même pour se lire son propre uptime.
2. **Reports ouverts = `handledById IS NULL`** à la lettre (directive). Le
   champ `status` coïncide aujourd'hui ; le COUNT suit la directive, pas
   l'indexation.
3. **Deux endpoints internes** : `/stats` (agrège les 4 métriques) ET
   `/backup-status` dédié (lecture isolée) — la directive mentionne les deux ;
   le second réutilise le même helper.
4. **Actifs = Post OU DirectMessage** : les DM ne portent pas de FK User
   (boîte aux lettres aveugle E2EE) — la correspondance se fait sur la pubkey
   (sender OU recipient). SQL directe en `$queryRaw` (directive explicite,
   pas de cache).
5. **Données initiales SSR** sur la page : un instrument de pilotage doit
   afficher ses valeurs au premier rendu (et les captures n'y perdent pas si
   l'hydratation flanche) ; le bouton Rafraîchir repasse par le BFF.
6. **502 ≠ 401 en cas de panne** : une erreur RÉSEAU au verify n'est pas une
   session invalide — 502 `backend-unreachable` sur les deux chemins (BFF et
   page), testé (E1, E1b).
7. **Harnais à DB dédiée = `describe.skipIf`** au lieu d'un throw : la suite
   globale (`bun test`) reste verte, chaque harness garde sa DB — le garde dur
   reste en défense dans `beforeAll`.
8. **Seuils documentés dans le code** (`DASHBOARD_THRESHOLDS`, en-tête de
   `dashboard-stats.ts`) — single source of truth, repris tels quels dans
   l'UI (sous-texte des cartes). L'alerte AUTO reste l'Étape 8 (NON TESTÉ).

## 6. INCIDENTS PENDANT L'ÉTAPE (transparence — tous résolus)

1. **Flip sandbox #4 au début de l'étape** : `/home/z/wt-adm` supprimé, HEAD
   principal remis sur `main`. **Zéro perte** (commits durables) — récupéré
   par la procédure canonique (`worktree prune` + `worktree add`, la seule
   commande git tolérée dans le repo principal). Documenté DEV-SETUP §2.0.
2. **Défaut AdminAuthPanel (logout) — DÉCOUVERT par les preuves, CORRIGÉ** :
   `handleLogout` basculait l'UI en « anonymous » SANS vérifier `res.ok` — sur
   une page fraîchement chargée (csrf en mémoire vide), le serveur refusait
   (403) mais l'UI affichait le formulaire de login ALORS QUE LA SESSION VIVAIT
   ENCORE (mensonge de sécurité). Corrigé : `res.ok` exigé, message d'erreur
   sinon. (`admin/src/components/AdminAuthPanel.tsx` — commentaire DÉFAUT
   CORRIGÉ.)
3. **Fenêtres TOTP du runner de preuves** : réutiliser le code du login curl
   pour le login navigateur = REJEU (garde Étape 3, 401 — c'est elle qui
   fonctionne) ; un offset +2 sort de la tolérance ±1. Le runner final ne
   re-login plus du tout (session curl réinjectée en cookie) — leçon notée
   dans le script.
4. **Panel fantôme sur :3102** (runs 3→5) : le `$!` d'un sous-shell n'est pas
   le pid du serveur bun → le trap ne tuait que le sous-shell ; le panel
   survivait aux runs, servait un build périmé depuis un répertoire supprimé,
   et `fuser` est ABSENT du sandbox (le kill silencieux ne faisait rien).
   Corrigé : `exec` dans le sous-shell (vrai pid) + kill par PID via `ss` +
   assertion ports libres avant démarrage.
5. **Le « panel phantom » explique aussi le « This page couldn't load »** du
   run 5 : le navigateur parlait au vieux process dont les assets statiques
   venaient d'un répertoire effacé.

## 7. NON TESTÉ (attendu par la directive)

- **Seuils d'alerte automatiques** — c'est l'Étape 8 (alerting) ; ici on ne
  fait que COLORER selon les seuils documentés.
- **Historique / graphiques** — dashboard = photo instantanée (directive), pas
  de série temporelle.
- **Backup réel du VPS** — le fichier `last-backup-status.json` est simulé par
  le seed (rejouable) ; le cron de backup réel est côté opérateur.
- **Charge réelle sur `/stats`** — volumétrie de preuve (5 users) ; les index
  existent (`@@index createdAt`, `recipientKey+createdAt`), le load test est
  hors périmètre de l'étape.

## 8. DISCIPLINE

- Worktree EXTERNE `/home/z/wt-adm` du début à la fin — zéro commande git dans
  `/home/z/my-project` (hormis `worktree prune/add` de récupération post-flip,
  procédure documentée DEV-SETUP §2.0).
- Une étape = des commits propres sur `feat/adm-mvp`, aucun push, aucun
  déploiement.
- Preuves navigateur en BUILD PRODUCTION des deux apps (DEV-SETUP §2c) — le
  runner `scripts/adm-step5-proof-run.sh` reconstruit si absent et rejoue tout
  dans un seul tour d'outils (piège §2b).
- Lint des DEUX apps vert (`eslint` principal + admin, `tsc --noEmit` admin).
- Aucune dépendance ajoutée (admin comme principale).

## 9. PROCHAINE ÉTAPE

**Ouverture B1** — worktree `/home/z/wt-b1`, branche `feat/b1-media-foundation`
(socle média : enveloppe CEK/IV, strip EXIF, presigned URLs, tests + bench),
puis alternance avec ADM Étapes 6–10 (clarification 2 — B1 ne déploie rien :
séquence de déploiement ADM → B1, jamais l'inverse).
