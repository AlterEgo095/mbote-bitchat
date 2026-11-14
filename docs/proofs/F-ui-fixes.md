# F-ui-fixes — vague F : corrections UI (Critique + Majeur, UI-AUDIT.md vague E)

> **Vague F — 2026-11-13 · feat/mbote-v1 · 25 écarts corrigés = 6 Critiques + 19 Majeurs
> (sous-ensemble validé par l'opérateur, option a — décompte initial : 6 C + 42 M + 30 m = 78 > 30 → STOP → validation).**
>
> Audit source : `docs/UI-AUDIT.md` (vague E, commit 9fb798e). Preuves : captures
> `docs/proofs/assets/F/avant/` (code pré-fix) et `F/apres/` (code corrigé),
> JSON `F/results-avant.json` + `F/results-apres.json` + `F/axe-resume.json`.
> Runner rejouable : `bash scripts/f-ui-fixes-proof-run.sh [avant|apres]`.

## 1. Verdict

| Item | État |
|---|---|
| 6 Critiques | ✅ corrigés — preuve navigateur obligatoire §7 fournie pour CHACUN (avant/après) |
| 19 Majeurs (3 groupes) | ✅ corrigés — test unitaire/intégration + axe pour les visuels |
| axe-core (5 vues critiques) | ✅ **100 / 100 / 100 / 100 / 100** (0 violation — proxy §2 : score = 100 − 10·serious − 4·moderate − 1·rest) |
| P4 simule tests.yml | ✅ **247 pass / 231 skip / 0 fail** (avant vague : 225 — +22 = test du mapping central) |
| tsc root + panneau admin | ✅ 0 erreur (gate Clarification 1 présent dans les 14 proof-runs) |
| lint | ✅ 0 erreur |
| Critique complexe > 4 h (F-bis) | — aucun (voir §3 : #47 tranché par diagnostic, pas de fix app) |
| CI live (push opérateur) | ⏳ attendue — token révoqué, push opérateur ; sorties locales = preuve de substitution |

## 2. Les 3 clarifications (directive opérateur)

### Clarification 1 — #72 : balayage du pattern « identité comparée à un rôle »

```
grep -rn '=== "super-admin"\|=== "moderator"\|=== "support"\|=== "auditor"' \
  src/app/api/internal/admin/ src/lib/mbote/   → 0 occurrence
grep -rnE '=== role|role ===' admin/src/ src/   → 1 seul cas : le site #72
  (admin/src/components/PendingActionsView.tsx:328) ;
  admin-auth.ts:111 (`session.adminUser.role === "system"`) = rôle vs rôle — CORRECT.
```
**Conclusion : aucun autre cas dans tout l'admin (serveur + panneau) — fix préventif non requis.**
Tracé dans le commit `66e6590` (message F: #72).

### Clarification 2 — #47 : diagnostic AVANT code (reproduction live instrumentée)

`scripts/f47-diagnose.ts` (2 identités réelles via l'UI, capture réseau de B,
vérité DB Prisma) — exécuté contre le build courant (EXIT 0, asset
`docs/proofs/assets/f47-diagnose.json` + capture `f47-bob-liste.png`) :

| Question de la directive | Réponse | Preuve |
|---|---|---|
| Le serveur stocke-t-il le welcome / membership quand A invite B ? | **OUI** — `Group` + `GroupMember(invité)` + enveloppes `welcome` créés au POST `/api/groups` (ET à l'invitation `/invite`) | vérité DB du diagnostic |
| B reçoit-il (poll/socket) ? | **OUI** — le GET `/api/groups` de B renvoie 200 avec le groupe dans le corps | capture réseau de B |
| L'UI de B affiche-t-elle l'invitation ? | **OUI** — groupe visible chez l'invité à **t = +2 s** (poll 4 s) | `f47-bob-liste.png` |

**Verdict : NON REPRODUIT sur le build courant — les 3 causes candidates sont exclues.**
L'observation E était un **double artefact harnais** :
1. la capture E `group-not-visible-bob.png` montre le **dialog d'ONBOARDING** —
   la page de Bob n'était même pas connectée (contexte navigateur frais,
   identité perdue) ;
2. le helper `onboard()` attend le menu identité qui s'affiche **dès
   `setIdentity` (AVANT le PoW + POST /api/identity)** — une navigation
   précoce tue le flux de publication (identité jamais publiée → contacts
   vides). `f47-diagnose.ts` attend la FERMETURE du dialog (leçon retenue).

**Décision : PAS de fix app (le code est déjà correct)** — le fix F = garde
anti-régression (`f47-diagnose.ts`, rejouable) + cette documentation. Le scénario
est aussi intégré au harnais F (P6 : visible chez l'invité à t=+2 s, capture
`F/apres/p47-groupe-visible-chez-bob.png`).

### Clarification 3 — mapping central EXHAUSTIF des status codes

Inventaire réel (grep `'status: [0-9]+'`) :

| Surface | Codes émis |
|---|---|
| App principale | 400 (×66), 401, 403, 404 (×18), 405, 409, 410 (four-eyes + média), 413, 422, 429, 500 (×57), 503 (pile média) |
| BFF admin | 502 (×14), 400 (×11) + 401/403 via `denied()` + passthrough 409/410/422 |

Le mapping `describeApiStatus` (api.ts) couvre **les 13 codes + des défauts
honnêtes 4xx/5xx** — `jsonFetch` n'émet plus jamais « HTTP {status} » brut ;
`describeApiError` route ApiError-brut / message-serveur-FR / AbortError /
réseau / local. Test unitaire d'exhaustivité + unicité :
`tests/f-errors-mapping.test.ts` — **22 pass / 0 fail** (commit `e0d25ef`).

## 3. Tableau des écarts corrigés

### Critiques (6)

| # | Vue | Écart | Fix appliqué | Preuve (commit + captures) |
|---|---|---|---|---|
| **1** | MboteApp (header) | panic wipe sans confirmation | AlertDialog obligatoire (mêmes textes que ProfileView : « Confirmer le panic wipe ? » / Annuler / Effacer définitivement) | `0922b0f` · avant `F/avant/p1-wipe-immediat-sans-confirmation.png` · après `F/apres/p1-dialog-confirmation.png` + `p1-apres-annuler.png` (identité intacte) + `p1-wipe-execute.png` |
| **2** | Onboarding | échec de publication 429 invisible (toast fugace, « publié » mensonger) | bannière PERSISTANTE role=alert : cause FR actionnable + « Réessayer la publication » (flush file courrier) + Masquer | `6fa7b0d` · avant `F/avant/p2-echec-publication-invisible.png` · après `F/apres/p2-banniere-persistante-429.png` + `p2-retry-ok.png` (retry → 200 → bannière disparue) |
| **15** | FeedView | AUCUN état d'erreur — échec réseau = « fil vide » mensonger | branche `feed.isError` AVANT l'état vide : carte role=alert + cause FR + Réessayer (refetch) | `b1a13f2` · avant `F/avant/p3-fil-vide-mensonger.png` · après `F/apres/p3-etat-erreur-feed.png` + `p3-feed-recupere.png` |
| **39** | GroupsView | sélection de groupe impossible au clavier/lecteur d'écran (Card onClick sans rôle) | en-tête de carte = bouton sémantique (role=button + tabIndex + aria-pressed/expanded + Enter/Espace + focus ring) — conversation ouverte HORS du bouton (axe nested-interactive écarté) | `c58a13a` + `97e67f3` · avant `F/avant/p39-carte-inaccessible-clavier.png` (0 role=button) · après `F/apres/p39-carte-focus-clavier-conversation.png` (13 Tabs → carte, Enter → conversation) |
| **47** | GroupsView (MLS) | invitation invisible chez l'invité (constat E) | NON-DÉFAUT prouvé par diagnostic (§2-Clarification 2) + garde anti-régression dédiée rejouable | `6827add` · garde : `F/apres/p47-groupe-visible-chez-bob.png` (t=+2 s) + `docs/proofs/assets/f47-bob-liste.png` + `f47-diagnose.json` |
| **72** | PendingActionsView | `requestedBy.email === role` (email vs rôle) — branche « Vous êtes le demandeur » inatteignable, diagnostic faux | prop `myEmail` (session serveur-vérifiée) : identité vs identité ; diagnostic vrai pour moderator (« approbation réservée aux super-admins (four-eyes) ») ; `data-testid=four-eyes-note` | `66e6590` · avant `F/avant/p72-vue-super-admin.png` (« vous n'êtes pas l'acteur » pour le DEMANDEUR) + `p72-vue-moderateur.png` (silence) · après `F/apres/p72-vue-super-admin.png` (« Vous êtes le demandeur ») + `p72-vue-moderateur.png` (four-eyes) |

### Majeurs — groupe « erreurs honnêtes » (7) — commits `3eed519` + `e0d25ef`

| # | Vue | Fix appliqué |
|---|---|---|
| 3 | Onboarding (PoW) | échec du PoW plus avalé : toast warning (cause + conséquence : identité locale OK, serveur exigera la preuve) |
| 23 | Composer | `describeApiError` (plus de `e.message` brut ; le message serveur FR actionnable reste servi) |
| 26 | MessagesView | 7 toasts → `describeApiError` |
| 35 | ProfileView | échecs `me` / `warnings` / `myPosts` RENDUS (bandeaux alert + carte « Impossible de charger tes publications » + Réessayer au lieu du faux « Rien publié ») |
| 42 | GroupsView | échec de listing rendu (`groups-listing-error` + Réessayer au lieu de `catch {}` — réseau HS ≠ aucun groupe) |
| 43 | GroupsView (MLS) | 4 messages (`Création/Envoi/Invitation/Retrait impossible`) → `describeApiError` |
| 59 | Dashboard (admin) | backend down → les dernières valeurs connues restent affichées (grisées + horodatage figé) au lieu de zéro donnée |

Preuves : test unitaire mapping (22 pass) + intégration dans le runner ;
comportements d'état couverts par les captures P3 (même mécanique) et par la
relecture DOM des sites (`grep describeApiError src/` = tous les sites).

### Majeurs — groupe « touch 44px » (8) — commit `11f84f3`

| # | Vue | Fix appliqué |
|---|---|---|
| 17 | FeedView | 3 toggles de portée 28px → min-h-11 |
| 20 | PostCard | cœur/réponse 32px → min-h-11 |
| 21 | PostCard | fermer fil compact + dismiss courrier 24px → size-11 |
| 29 | CallView | CallButton + agrandir 32px → size-11 |
| 44 | GroupsView | retrait de membre ≈18px (action IRRÉVERSIBLE) → 44×44 |
| 45 | GroupsView | Inviter 28px → min-h-11 ; envoi/rafraîchissement 36px → size-11 |
| 54 | AdminAuthPanel | toggle break-glass lien 16px → bouton min-h-11 ; 3 submits 36px → min-h-11 |
| 70 | AuditView | 7 filtres + Export + Réessayer + Charger plus ≈32px → min-h-11 |

Preuve : inspection DOM (hauteurs ≥ 44px sur les 8 sites) + rendu dans les
captures apres (login panneau, groupes).

### Majeurs — groupe « axe/contraste » (4) — commit `3d07e12`

| # | Vue | Fix appliqué | Preuve |
|---|---|---|---|
| 31 | MessagesView offline | badge 9px/amber-500 (4.4:1) → 11px/amber-300 ; hint 10px/muted (3.79:1) → 11px/zinc-400 ; opacité bulle 70→90 | axe `messages-offline` = **100** (0 violation) · `F/apres/axe-messages-offline.png` |
| 73 | PendingActionsView | zinc-400 → zinc-600 (n° d'intention ×2 + dates — cibles axe exactes) | axe `admin-pending-actions` = **100** · `F/apres/axe-admin-pending-actions.png` |
| 40 | GroupsView | aria-label divergent « Créer un groupe » supprimé → nom accessible = texte visible « Nouveau groupe » (3 vues axe d'un coup) | axe `groups` = **100** |
| 49 | CallView | aria-label « Terminer l'appel » → « Raccrocher » (contient le texte visible) | relecture axe (axe `call-*` non re-audité en rendu — voir NON TESTÉ) |

## 4. Scores axe-core après (proxy ≥ 90 — exécution réelle `F/axe-resume.json`)

| Vue critique | Score | Violations |
|---|---|---|
| feed | **100** | 0 |
| groups (carte + clavier) | **100** | 0 |
| onboarding (dialog) | **100** | 0 |
| messages-offline (bulle file) | **100** | 0 — audit RESTRUCTURÉ post-F (Clarification 1 : contexte jetable auto-contenu, bulle « En attente » garantie dans le DOM — voir §8b) ; score 100 dans les 5 runs de preuve consécutifs (`F/c1-harnais-5runs.txt`) |
| admin-pending-actions | **100** | 0 |

Bilan post-Clarification-1 : **5/5 vues auditées à 100 dans CHAQUE run** (5 runs
consécutifs EXIT 0, skip non toléré — vues attendues forcées dans le harnais) +
toutes les phases P vertes + P4 247/0. Historique honnête : avant le restructure,
la 5ᵉ vue était un artefact double (skip dans les re-runs HEAD ; audit tournant
sur le DIALOG d'onboarding au lieu de la vue Messages dans le run `f258a25`) —
détail et correction en §8b.

NB : au cours du travail, le premier fix #39 (role=button sur la CARTE entière)
provoquait une violation `nested-interactive` (serious) dès que la conversation
était ouverte DANS le bouton — corrigé en portant le bouton sur l'en-tête de
carte uniquement (commit `97e67f3`). Les 5 vues ressortent à 100.

## 5. Captures avant/après (obligatoires §7 — chaque Critique)

| Critique | Avant (code pré-fix) | Après (code corrigé) |
|---|---|---|
| #1 | `F/avant/p1-menu-ouvert.png` + `p1-wipe-immediat-sans-confirmation.png` | `F/apres/p1-dialog-confirmation.png`, `p1-apres-annuler.png`, `p1-wipe-execute.png` |
| #2 | `F/avant/p2-echec-publication-invisible.png` | `F/apres/p2-banniere-persistante-429.png`, `p2-retry-ok.png` |
| #15 | `F/avant/p3-fil-vide-mensonger.png` | `F/apres/p3-etat-erreur-feed.png`, `p3-feed-recupere.png` |
| #39 | `F/avant/p39-carte-inaccessible-clavier.png` | `F/apres/p39-carte-focus-clavier-conversation.png` |
| #47 | artefact E : `assets/E/group-not-visible-bob.png` (dialog onboarding) | `F/apres/p47-groupe-visible-chez-bob.png` + `assets/f47-bob-liste.png` |
| #72 | `F/avant/p72-vue-moderateur.png` + `p72-vue-super-admin.png` | `F/apres/p72-vue-moderateur.png` + `p72-vue-super-admin.png` |

NB honnêteté P3-avant : le harnais avant souffrait du bypass SW (les fetch du
service worker échappaient à l'interception playwright) — l'abort n'était pas
garanti au run avant. Le défait pré-fix est néanmoins établi par le CODE
(aucune branche `isError` dans FeedView : un échec NE POUVAIT pas être rendu),
et le run après (SW bloqués, abort effectif) prouve le fix de bout en bout.
Le harnais corrige ce point (`serviceWorkers: "block"`).

## 6. Non corrigés (hors périmètre F validé)

### ⏳ Mineurs — reportés post-F (règle : F s'arrête au Majeur)

#4, #8, #9, #10, #12, #13, #14, #16, #18, #19, #22, #24, #25, #30, #33, #34,
#36, #38, #46, #50, #51, #65, #66, #75, #77, #78 (26 lignes « Mineur » du
tableau §3 — les 4 lignes « (positif) » #32/#37/#52/#71 sont des modèles à
généraliser, rien à corriger).

### ⏭️ Majeurs reportés (23 — hors sous-ensemble validé)

#5, #6, #7 (mobile : barre 6 items, recherche inaccessible, pastille relay —
nécessitent un rendu mobile réel), #11 (focus ring GlobalSearch), #27
(auto-scroll forcé, 2 h), #28 (indicateur lu/reçu), #41 (window.confirm →
AlertDialog), #48 (CallView dialog pattern — focus trap/aria-live, 2 h), #53
(alerts login admin), #55 (429 client admin), #56 (shell admin dupliqué 7×),
#57 (logout/idle-timeout), #58 (lien bandeau 401), #60 (bouton ban dans la
file), #61 (filtre traités/classés), #62 (focus management queue), #63 (jargon
admin), #64 (scope="col" users), #67 (durées suspension divergentes), #68
(debounce filtre audit), #69 (retry parité admin), #74 (countdown figé), #76
(i18n ~350 littéraux = le chantier G lui-même, « Majeur (pour G) »).

## 7. Commits de la vague (ordre chronologique)

| Commit | Contenu |
|---|---|
| `6827add` | F: #47 — diagnostic MLS (3 questions tranchées) + garde rejouable |
| `d1d6997` | F: harnais de preuves + phase AVANT verte (défauts documentés) |
| `0922b0f` | F: #1 — confirmation panic wipe |
| `6fa7b0d` | F: #2 — bannière persistante + mapping central exhaustif (Clarification 3) |
| `b1a13f2` | F: #15 — état d'erreur FeedView |
| `c58a13a` | F: #39 — sélection groupe au clavier |
| `66e6590` | F: #72 — identité vs identité + balayage Clarification 1 |
| `3eed519` | F: erreurs honnêtes (#3 #23 #26 #35 #42 #43 #59) |
| `e0d25ef` | F: test unitaire du mapping (22 pass) |
| `11f84f3` | F: touch 44px (#17 #20 #21 #29 #44 #45 #54 #70) |
| `3d07e12` | F: axe/contraste (#31 #73 #40 #49) |
| `97e67f3` | F: #39 raidissement (nested-interactive) + harnais (SW block, TOTP offset) |
| `f258a25` | F: captures APRÈS + P4 247/0 + axe 100×5 |
| `80e50ef` | F: harnais — verdict sérialisé dans results-*.json |
| `469ac75` | F: lint |

## 8. NON TESTÉ (documenté — jamais silencieux)

- **Safari/Firefox** (sandbox Chromium uniquement), **lecteurs d'écran réels**
  (axe-core ≠ VoiceOver/NVDA — le label-in-name et le focus management sont
  vérifiés par axe + DOM, pas par un usage NVDA réel), **responsive device
  physique** (les écarts mobiles #5/#6/#7 sont REPORTÉS, pas corrigés à
  l'aveugle), **charge réelle**.
- **axe `call-*` en rendu** : les fixes #49/#29 sont vérifiés par relecture de
  code + unitaire DOM ; l'appel audio réel n'est pas re-rendu dans le harnais F
  (le flux C2 complet est couvert par son propre proof-run, inchangé).
- **Contrastes manuels AA hors axe** (les 2 fixes #31/#73 sont validés par le
  re-score axe = 0 violation sur les états rendus audités).
- **CI live** : push opérateur attendu (token révoqué) — les sorties locales
  (P4 247/0, tsc, lint, runner exit 0 ×5 post-C1) sont la preuve de substitution.
- Le **429 réel de D2** dans le harnais P2 : le garde (3/h/IP) saturerait à
  cause des onboardings du harnais lui-même — le 429 est reproduit avec le
  corps EXACT du serveur (mock), le succès du retry est mocké 200 (même forme)
  pour rester déterministe ; le chemin réel 429→bannière→retry est exercé côté
  client de bout en bout. Depuis la Clarification 1, le serveur du harnais
  tourne avec `SYBIL_BYPASS=1` (le harnais crée 4 identités/run) — le mock P2
  reste inchangé et reste nécessaire pour la détermination du run ; la portée
  du bypass (plafond 3/h/IP SEUL) est documentée en DEV-SETUP §7b.
- ~~Audit axe messages-offline dans les re-runs HEAD finals : sauté~~ —
  **CORRIGÉ post-validation (Clarification 1)** : cause racine double identifiée
  (flux fragile en contexte partagé + re-onboard de secours tué par le garde D2
  réel ; ET l'audit « passant » de `f258a25` tournait en réalité sur le dialog
  d'onboarding, pas sur la vue Messages) ; bloc restructuré auto-contenu,
  skips désormais NON tolérés — détail complet §8b.

## 8b. Clarification 1 post-validation — l'artefact harnais est CORRIGÉ, pas skippé

Directive opérateur : « #47 (E) et 5ᵉ-vue-axe (F) ont la même cause : contexte
Playwright partagé qui casse l'identité après une action destructive. Le skip
"documenté" n'est pas une solution — la 6ᵉ occurrence arriverait en G. »

### Diagnostic (avant code)

1. **Sonde d'isolation IndexedDB** (`scripts/c1-idb-isolation-probe.ts`, sortie
   `F/c1-idb-isolation-probe.out`) : chromium-1200 headless Isole IndexedDB par
   browserContext (écriture croisée + `deleteDatabase` inter-contexte : le
   contexte 1 garde son record). Conclusion : le contexte jetable de P1-wipe
   SUFFIT — la perte d'identité de pageA venait d'ailleurs.
2. **Capture de diagnostic au saut** (`debug-messages-offline-saut.png`) : le
   dialog de re-onboard F-Alice ouvert et BLOQUÉ — la republication réelle (4ᵉ
   création du run) tombait sous le garde D2 (3/h/IP) : 429 → le harnais
   restait attendre la fermeture d'un dialog qui ne venait pas.
3. **Découverte aggravante** : dans le run « passant » `f258a25`, la capture
   `axe-messages-offline.png` de l'époque montre le DIALOG d'onboarding au-dessus
   du feed — l'audit « à 100 » tournait sur le mauvais DOM (pas la vue Messages).
   L'ancien sélecteur de composer (`placeholder^="Message privé"`) était de plus
   faux (le vrai placeholder : « Message chiffré (ECDH + AES-GCM)… »), donc le
   send hors-ligne pouvait ne jamais partir sans que le harnais ne le voie.

### Corrections (harnais + serveur de test)

| Correctif | Où | Détail |
|---|---|---|
| Bloc messages-offline AUTO-CONTENU | `f-ui-fixes-proof.ts` | contexte jetable dédié + identité fraîche « F-Offline » ; conversation ouverte via le picker « Nouvelle conversation » → F-Bob ; mode mesh activé SUR PLACE (sans reload) ; bulle « En attente » GARANTIE dans le DOM avant l'audit (`waitFor` explicite — jamais d'audit sur un état vide) |
| Composer localisé par aria-label | `f-ui-fixes-proof.ts` | `[aria-label="Message privé"]` (stable) au lieu du placeholder faux |
| Overlays Radix purgés avant audit | `f-ui-fixes-proof.ts` | `mouse.move` hors du chrome + Escape + attente bornée du détachement des wrappers popper ; un popper persistant >3 s = ÉCHEC explicite (diagnostic dumpé) — l'artefact d'overlay (`aria-hidden-focus` + `region`, score 66 au run de mise au point) est désormais impossible à manquer en silence |
| Skip NON silencieux | `f-ui-fixes-proof.ts` | `EXPECTED_AXE_VIEWS` (5 vues) forcées : `axeMissingViews` non vide → verdict ÉCHEC — « si un skip persiste, ne pas clore » est maintenant mécanique (DEV-SETUP §7b.4) |
| Bypass test du garde D2 | `src/app/api/identity/route.ts` + runner | `SYBIL_BYPASS=1` court-circuite UNIQUEMENT le plafond de création 3/h/IP ; PoW, preuve ECDSA et plafonds par minute INTACTS ; variable explicite opt-in (jamais `NODE_ENV=test`), warn console au chargement ; runner F démarre le serveur app avec `SYBIL_BYPASS=1` ; documenté DEV-SETUP §7b.3 |
| onboard() (déjà correct depuis 8dcaf14) | `f-ui-fixes-proof.ts` | attend la FERMETURE du dialog (`state: "detached"`) avant le menu — conservé, vérifié |

### Preuve : 5 runs consécutifs EXIT 0, zéro skip

`F/c1-harnais-5runs.txt` — 5 exécutions consécutives de
`bash scripts/f-ui-fixes-proof-run.sh apres` :

- **exit 0 ×5** ; `VERDICT phase apres : TOUTES PREUVES OK` ×5 ;
- axe : **5 vues attendues × score 100, présentes dans CHAQUE run**
  (`axeMissingViews=[]` forcé — un saut rendrait le verdict ÉCHEC) ;
- P4 simule tests.yml : **247 pass / 231 skip / 0 fail** à chaque run (les
  « skip » du résumé P4 = skips préexistants de la suite CI, sans rapport avec
  les audits axe) ;
- capture finale `F/apres/axe-messages-offline.png` : la VRAIE vue Messages
  hors-ligne (conversation F-Bob, bulle « Message hors-ligne preuve F » badge
  « En attente », composer « Hors-ligne — ton courrier partira au retour du
  réseau », badge « Mesh — file locale 1 »).

La 6ᵉ occurrence en G est structurellement bloquée : toute future vue ajoutée
aux audits DOIT figer son bloc auto-contenu (contexte jetable + cible garantie)
et entrer dans `EXPECTED_AXE_VIEWS` — sinon verdict ÉCHEC.

## 9. Verdict

**SUCCESS local** — 25/25 écarts du sous-ensemble validé sont corrigés avec la
preuve de la bonne sévérité (navigateur pour les 6 Critiques, unitaire/axe pour
les Majeurs) ; 0 régression détectée (P4 247/0, tsc, lint, axe 100×5 — désormais
**100×5 dans chacun des 5 runs consécutifs post-Clarification-1**, skip non
toléré mécaniquement). Le statut restera « PARTIEL tant que CI live non
confirmée » (push opérateur) — même convention que F-16/F-17. SUITE : STOP —
démarrage de G uniquement après push opérateur + CI verte confirmée
(Clarification 2 post-F).
