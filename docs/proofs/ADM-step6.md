# PREUVES ADM ÉTAPE 6 — Queue de modération UI (cursor, poids, actions §6)

**Date** : 2026-11-06 · **Branche** : `feat/adm-mvp` · **Worktree** : `/home/z/wt-adm`
**Directive** : « Page /queue (protégée), liste paginée cursor-based 20/page des
Report où handledById IS NULL, tri poids décroissant puis ancienneté
croissante, filtres période/type/statut, badge rouge ≥ 5, actions par rôle
avec justification §6, four-eyes désactivé (Étape 9). »

## 0. VERDICT

**Étape 6 LIVRÉE ET PROUVÉE.** Harnais e2e **30/30** (92 expect) + matrice RBAC
55/55 ré-alignée (auditor strict §12.17) + suite globale **128 pass / 0 fail**
(55 skip = harnais à DB dédiées, skip propre). Preuves navigateur en **BUILD
PRODUCTION** (DEV-SETUP §2c), rejouables via `bash scripts/adm-step6-proof-run.sh`
(une commande, exit 0).

## 1. CE QUI EST LIVRÉ (fichier : ligne)

| Élément | Fichier | Ancrage |
|---|---|---|
| Migration `0006_etape6_queue` — `User.suspendedUntil` + table `UserWarning` (100 % additive) | `prisma/migrations/20261106092200_0006_etape6_queue/migration.sql` | — |
| Endpoint interne `/api/internal/admin/queue` — cursor keyset paramétré, poids = COUNT reports ouverts, filtres, 20/page | `src/app/api/internal/admin/queue/route.ts` | `PAGE_SIZE` :50, `decodeCursor` :64, keyset :141, `requireAdmin({minRole:"support"})` :109 |
| Curseur OPAQUE base64url {w,c,i} + ancre expirée → restart page 1 (`cursorReset`) | id. | :64-92, :122-134 |
| Justification §6 — catégorie fermée + ≥ 20 chars, validation SERVEUR 422, format « CATÉGORIE: texte » | `src/lib/mbote/justification.ts` | :36-77 |
| `/api/moderation/action` — justification §6 obligatoire, `dismiss` (report), `suspend` 24h/7d/indéfinie (`suspendedUntil`), `warn` → `UserWarning` | `src/app/api/moderation/action/route.ts` | :29-40, :88-92, :104-140 (dismiss), :258-264 (suspend), :300-306 (warn) |
| `MODERATION_ACTIONS` + `dismiss` (sort du périmètre E6 — arbitrage §12.12) | `src/lib/mbote/moderation.ts` | :34-45 |
| Suspension temporaire — évaluation PARESSEUSE (fil, parent, publication) | `src/app/api/posts/route.ts` | :122-149 (fil), :159-168 (parent), :291-306 (publication 403) |
| `/api/moderation/queue` (Étape 0) — rôle resserré auditor → support (§12.17) | `src/app/api/moderation/queue/route.ts` | :14-18, :31 |
| Warnings utilisateur — lecture par preuve de possession ECDSA (`me\|warnings-read\|ts`) | `src/app/api/moderation/warnings/route.ts` | :37-38, :62-71 |
| BFF `/api/queue` — proxy GET, **502 ≠ 401/403** (directive) | `admin/src/app/api/queue/route.ts` | :27-52 |
| BFF `/api/admin/moderation/action` — proxy POST mutation (CSRF exigé à l'entrée, validé côté app principale) | `admin/src/app/api/admin/moderation/action/route.ts` | :30-52 |
| Page `/queue` — SSR (page 1 servie au premier rendu), refus auditor rendu serveur | `admin/src/app/queue/page.tsx` | `initialQueue` :44, refusal :117 |
| `QueueView` — badges poids (rouge ≥ 5), formulaires justification, pagination, **zéro optimistic update (invariant §1.8)** | `admin/src/components/QueueView.tsx` | :172-215 (`submitAction`), :407-417 (actions par rôle), :596 (four-eyes désactivé) |
| Lien « File de modération → » sur l'accueil | `admin/src/app/page.tsx` | :28-35 |
| Warnings visibles dans le profil utilisateur (app principale) | `src/components/mbote/ProfileView.tsx` | :81-99 (query signée), :152-183 (carte) |
| Seed de preuve REJOUABLE | `scripts/adm-step6-proof-seed.ts` | — |
| Runner de preuves REJOUABLE (curl + navigateur + DB + dégradation) | `scripts/adm-step6-proof-run.sh` | — |

## 2. CLARIFICATIONS DEMANDÉES (exécutées AVANT l'étape)

1. **Audit du pattern « UI optimiste »** — revue des 3 composants client du
   panneau : `AdminAuthPanel.tsx` (login/break-glass/enroll/logout — tous les
   changements d'état sont derrière `res.status === 200` / `res.ok`, le bug
   logout ayant été corrigé à l'Étape 5), `DashboardMetrics.tsx` (setState
   après `res.ok` + garde de forme), `BackendStatus.tsx` (badge d'état,
   setState derrière `res.ok`). **Aucun autre cas trouvé** — l'invariant est
   désormais écrit dans `ADMIN-RBAC.md §1.8` : « toute mutation UI reflète le
   retour serveur 2xx — pas d'optimistic update avant confirmation » (bug
   §6.2 d'ADM-step5.md documenté comme cas fondateur de la classe). La queue
   UI le met en œuvre mécaniquement : après CHAQUE action (2xx OU erreur), la
   page est rejetée depuis la réponse authentifiée — preuve §4.4.
2. **auditor strict** — `ADMIN-RBAC.md §2.3` : note compliance (SOC 2 /
   ISO 27001) ajoutée, SANS implémentation ; arbitrage §12.17 : queue.view
   passe de `auditor` à `support` sur les DEUX surfaces (Étape 0 + interne) ;
   matrice 55 ré-alignée (la cellule auditor×queue.view : 200 → 403 — la
   contrainte monte d'un cran, testée F7 + A5 + H).
3. **MinIO/S3 réel (B2)** — traité dans le worktree wt-b1 (commit `cac691a`,
   `docs/proofs/B2-images.md §1`) : SigV4 B1 validé contre SeaweedFS 3.80
   (S3 réel indépendant, validation complète) — B2 démarre sur preuve, pas
   sur du sable.

## 3. TESTS — `bun test`

- **`tests/admin-queue-e2e.test.ts` : 30 pass / 0 fail** (92 expect) —
  harnais auto-hébergé (app :3107 + panneau :3108, DB dédiée 0001→0006,
  garde module-level → skip propre, pattern Étape 5) :
  - **A** auth/RBAC : token seul → 401 (A1) · session sans token → 401 (A2) ·
    anonymous → 401 (A3) · support → 200 avec items/openTotal/page (A4) ·
    **auditor → 403** §12.17 (A5) · paramètres invalides → 400 (A6) ;
  - **B** tri : 3 reports sur postA + 1 sur postB → A en premier, weight=3
    sur chaque item (B1) ;
  - **C** pagination : page 1 = 20 + nextCursor (C1) · page 2 = 0
    chevauchement (C2) · cursor malformé → 400 ×3 variantes (C3) · **cursor
    expiré → restart page 1 + cursorReset=true** — sémantique : identique à
    une requête fraîche, aucun item de la cible fermée (C4) ;
  - **D** filtres : 24h exclut 48h, 7d l'inclut (D1/D2) · type=comment
    exclusif (D3) · status=open exclut les traités (D4) ;
  - **E** actions : justification < 20 → 422 (E1) · catégorie invalide /
    absente → 422 (E2) · hide → 200 + AdminAudit « SPAM: … » + report ne
    réapparaît PAS (E3) · dismiss → 200 + status=dismissed + les 2 autres
    reports du même post restent (poids 3→2) + re-dismiss → 409 (E4) ·
    dismiss × auditor → 403 (E5) ;
  - **F** warn : UserWarning en DB (catégorie + note, createdById) (F1) ·
    lecture sans preuve → 401 (F2) · avec preuve ECDSA valide → 200 (F3) ·
    signature d'une autre clé (usurpation) → 401 (F4) ;
  - **G** suspension temporaire : 24h → suspendedUntil ∈ [23h;25h] +
    **publication signée valide → 403** + feed exclut (G1) · 7d → ≈ +7j ·
    durée invalide → 400 (G2) · **expiration backdatée → publication 200 +
    post de retour au fil + DB non réécrite** (lazy, pas de cron) (G3) ·
    unsuspend → cleared (G4) ;
  - **H** four-eyes : action `ban` → 400 hors enum — la surface UI (bouton
    désactivé + tooltip) est prouvée par capture §4.6 ;
  - **I** anti-fuite : aucun email/password/« ip » dans le payload.
- **Matrice RBAC 55/55** (`tests/admin-auth-e2e.test.ts`) : ré-alignée §12.17
  (queue.view = support ; auditor → 403) + F7 étendu (chaîne BFF support →
  200 ET auditor → 403 propagé uniforme) + G1 mis au format §6.
- **Suite globale : 128 pass / 0 fail** (55 skip) — zéro régression Étapes
  1–5. Harnais A3 (`tests/moderation-e2e.ts`) mis au format justification §6
  (5 call-sites).

## 4. PREUVES NAVIGATEUR (builds production :3101 + :3102 — runner §0, exit 0)

### §4.1 File remplie + badge rouge — `assets/adm-step6-queue.png`

Session support. 33 signalements ouverts, page 1 = 20 items, tri poids
décroissant : les 4 items visibles en tête portent le badge rouge **« poids
5 »** (seuil ≥ 5 — directive), extrait 60 caractères, auteur (pseudo),
signaleur (pseudo), timestamp, motif. Filtres période/type/statut. Bouton
« Bannir + purger (four-eyes) » désactivé (grisé).

### §4.2 Pagination — `assets/adm-step6-queue-page2.png`

Clic « Page suivante → » → curseur actif (« ← Retour page 1 ») ; preuve curl
de l'absence de chevauchement page 1/page 2 (section 3b du runner).

### §4.3 RBAC rendu dans l'UI — `assets/adm-step6-rbac-support-buttons.png`

Session support : seuls « Classer sans suite » et « Avertir l'auteur » sont
proposés — **« Masquer le contenu » et « Suspendre l'auteur » n'existent pas**
dans le DOM de cette session (matrice §4 rendue, pas seulement imposée par
l'API — le runner Étape 6 v1 a échoué ICI avant correction : preuve que le
gating est réel).

### §4.4 Action hide avec justification (moderator) — `assets/adm-step6-justification-form.png` + `assets/adm-step6-after-hide.png`

Re-login moderator (directive : « Hide : 1 modérateur ») → clic « Masquer le
contenu » sur l'item poids 5 → formulaire §6 (catégorie SPAM + texte ≥ 20
chars, compteur visible) → confirmation → la notice affiche **« Masquer le
contenu — OK (2xx). 5 signalement(s) clos par le serveur. Liste rejetée
depuis le serveur. »** — l'invariant §1.8 est visible : l'UI annonce le retour
serveur, jamais une intention. Le compteur passe 33 → **28** et les items
poids 5 ont disparu (les reports de la cible fermée sortent de la file —
comportement Étape 0 conservé).

### §4.5 Preuve DB — `assets/adm-step6-audit-db.txt`

`AdminAudit{action:"hide", justification:"SPAM: Spam répété massif — masqué
après vérification des 5 signalements"}` + 5 reports `status=actioned` avec
`handledById` posé — l'audit append-only et la clôture des signalements dans
la MÊME transaction (invariant §1.7).

### §4.6 Four-eyes désactivé — visible dans §4.1/§4.4

Bouton « Bannir + purger (four-eyes) » grisé, `title="approbation requise"`,
`data-testid="four-eyes-disabled"` (Étape 9). Côté API : action `ban` → 400
(hors enum, test H1).

### §4.7 DÉGRADATION — kill backend : `assets/adm-step6-degradation.png` + `assets/adm-step6-degradation-502.txt`

Kill de l'app principale → BFF `/api/queue` → **502 `backend-unreachable`**
(distinct de 401, directive) → rechargement de /queue : bandeau « Backend
injoignable », PAS de redirection mensongère.

## 5. ARBITRAGES (§ suite §12 d'ADMIN-RBAC.md — numéros 17-19 déjà posés ; 20-24 ci-dessous)

20. **Curseur = base64url{w,c,i}** (poids + createdAt ms + id) : la directive
    disait « base64 de (createdAt, id) » — un keyset limité à (createdAt, id)
    est INSTABLE dès qu'un poids change entre deux pages (tri vivant). Le
    curseur reste opaque ; la clé complète garantit la cohérence de l'ordre.
    Testé C1-C4.
21. **« cursor expiré » = ancre absente OU ne satisfaisant plus les filtres**
    → restart page 1 + flag `cursorReset` (l'UI toast « La file a changé… »).
    Un décodage malformé reste un 400 (jamais de restart silencieux — C3).
22. **Pagination approximative sous mutation concurrente** (documenté) : le
    poids est recomputé à chaque requête ; le keyset est exact sur
    l'instantané du tri, pas sur un ordre figé — propriété assumée d'une
    file vivante (C4 prouve le cas le plus brutal : cible fermée entre deux
    pages).
23. **Un item = un Report** (lecture littérale de la directive) — le poids
    agrège par cible et une action hide ferme tous les reports de la cible
    (les lignes disparaissent ensemble, §4.4). `dismiss`, lui, ne clôture
    QUE le report visé (E4 : poids 3→2 sur les restants).
24. **Warn = support (matrice §4 inchangée)** — « 1 modérateur » de la
    directive désigne le MODE (mono-session, pas four-eyes), arbitrage
    §12.18. La notification utilisateur vit dans `UserWarning` (migration
    0006), lisible par preuve de possession — **pas de DM** (E2EE).
25. **Suspend** : durées 24h/7j (directive) + `indefinite` conservé
    (comportement A3 historique, l'UI offre les trois) ; expiration
    ÉVALUÉE PARESSEUSEMENT (fil/publication) — la DB n'est pas réécrite
    (G3 le prouve), pas de cron.
26. **`report.dismiss` = targetKind "report"** (nouveau) — clôture sans
    action sur le contenu, rôle support (matrice §4 #6) ; idempotence
    refusée proprement (409 sur re-dismiss, E4).
27. **Pubkeys dans le payload queue** : identités PUBLIQUES du mesh —
    nécessaires comme cibles opératoires des actions warn/suspend ; les
    pseudos servent à l'affichage. Aucun email/IP/DM (test I1). L'anti-fuite
    Étape 5 portait sur le dashboard (agrégats) — la queue est un outil
    d'action, pas une vitrine.

## 6. INCIDENTS PENDANT L'ÉTAPE (transparence — tous résolus)

1. **Flip sandbox #5 en début d'étape** (pendant le travail B2 parallèle) :
   `/home/z/wt-adm` et `/home/z/wt-b1` supprimés, HEAD principal sur main.
   **Zéro perte** (commits durables a1bab2b / cac691a) — récupération par la
   procédure canonique (DEV-SETUP §2.0) + `bun install` des deux worktrees
   ET du sous-projet `admin/` (le `next dev` du harnais ne trouvait plus
   `next/package.json` — node_modules absent).
2. **`$queryRaw` n'est pas une fonction d'appel** : la première version de
   l'endpoint appelait `db.$queryRaw(sql, params)` → 500 silencieux en page 2
   uniquement (la page 1 n'exécute pas la requête d'ancre). Corrigé en
   `$queryRawUnsafe` + params positionnels, et TOUT le keyset est désormais
   100 % paramétré (aucune interpolation du curseur). Détecté par le harnais
   (C2/C4), repro hors serveur avant fix.
3. **Le runner Étape 6 v1 a échoué au clic « Masquer le contenu » en session
   support** — pas un bug : le gating RBAC de l'UI fonctionne (hide =
   moderator). Le runner a été corrigé (re-login moderator) et la capture
   §4.3 de la surface limitée support est devenue une preuve.
4. **Seed : signaleurs uniques** — la première passe du seed réutilisait le
   même `reporterKey` (contrainte d'unicité (reporterKey, targetKind,
   targetId) violée) ; corrigé, 34 signaleurs réels créés (pseudos affichés
   dans les captures).

## 7. NON TESTÉ (attendu par la directive)

- **Four-eyes ban/purge** — Étape 9 (bouton désactivé + tooltip, API hors
  enum — H1 + §4.6).
- **Notifications par email** (SMTP absent) — la notification warn vit dans
  le profil utilisateur (F1-F4) ; l'email reste NON TESTÉ.
- **Charge réelle** — la pagination est testée sur 33 fixtures (2 pages) ;
  un test unitaire suffit pour le keyset (directive explicite).
- **UI mobile native** — la page /queue est responsive (grilles Tailwind) ;
  le panneau reste un outil desktop-first, captures en 1440×900.

## 8. DISCIPLINE

- Worktree EXTERNE `/home/z/wt-adm` — zéro commande git dans
  `/home/z/my-project` (hormis `worktree prune/add` de récupération post-flip
  #5, procédure documentée DEV-SETUP §2.0).
- Une étape = commits propres sur `feat/adm-mvp`, aucun push, aucun
  déploiement.
- Lint des DEUX apps vert (`eslint` principal + admin, `tsc --noEmit` admin).
- Preuves rejouables : `bash scripts/adm-step6-proof-run.sh` (exit 0 constaté
  deux fois de suite, y compris après correction du seed).
