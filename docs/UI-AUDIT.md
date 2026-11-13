# UI-AUDIT — audit écran par écran, état par état (vague E)

> **Vague E — 2026-11-13 · feat/mbote-v1 @ 611c7af+ · PAS DE FIX DANS E (E identifie, F corrigera).**
>
> **Mise à jour vague F (2026-11-13, commit `f258a25`+) : 25 écarts corrigés
> (6 Critiques + 19 Majeurs — sous-ensemble validé par l'opérateur, option a).
> Le statut de CHAQUE écart (#1 → #78) est tenu dans le registre §9
> « Statuts vague F » (✅ corrigé / ⏳ mineur reporté / ⏭️ reporté). Preuves :
> `docs/proofs/F-ui-fixes.md` + captures `docs/proofs/assets/F/`.**
>
> Ce document n'est PAS un audit de code : c'est un audit **écran par écran,
> état par état**, croisant (1) la lecture intégrale des 12 vues et de leur
> socle, et (2) un **passage rendu réel** automatisé (Playwright + axe-core +
> flux multi-identités) sur l'application en **production standalone** —
> preuves : `docs/proofs/E-ui-audit.md`, JSON `docs/proofs/E-axe/`, captures
> `docs/proofs/assets/E/`.

## 0. Méthode et environnement de rendu

| Élément | Valeur |
|---|---|
| App principale | production standalone :3110 (build 2026-11-13, `NEXT_PUBLIC_SOCKET_URL` baké) |
| Panneau admin | production :3104 (`BACKEND_INTERNAL_URL` → :3110), login TOTP réel |
| Hub relay | mini-service :3040 (socket.io), TURN harnais :3478 (C2) |
| DB | `db/ui-audit.db` (migrations 0001→0005 + seed : 3 users, 5 posts, 3 reports, 3 pending-actions, 3 audits, 2 admins TOTP) |
| Navigateur | Chromium-1200 headless (playwright-core 1.65), résolutions 1280×800 et 375×667 |
| Flux réels exercés | onboarding PoW ×4 → post au fil → like → DM E2EE aller-retour Alice↔Bob (2 identités réelles) → **appel audio réel** (sonnerie → actif + timer → raccroché) → **groupe MLS réel** (création + invitation) → **hors-ligne** (bulle file locale + flush reconnexion) → **dégradation relay** (SIGSTOP hub) → panneau admin (5 vues + formulaire justification) |
| axe-core | v4 injecté par vue, 18 audits, résultat JSON compact + cibles |

**NON TESTÉ** : Safari/Firefox (sandbox Chromium uniquement) ; lecteurs d'écran
réels (VoiceOver/NVDA — axe-core ne les remplace pas) ; charge réelle
utilisateurs ; responsive sur device physique ; contrastes validés uniquement
par axe (pas de mesure manuelle AA complète hors axe) ; états admin
dégradés-exhaustifs (backend down simulé par code, pas rendu) ; Safari iOS
safe-areas.

---

## 1. Synthèse chiffrée

- **78 problèmes** recensés : **6 Critiques**, **42 Majeurs**, **30 Mineurs** (tableau §3).
- **axe-core : 18 vues auditées, 6 types de violation, 9 nœuds — 0 critical**,
  9 serious (contraste ×5, label-in-name ×4). 12 vues sur 18 sont **à 0
  violation** (le travail F-14 des vagues précédentes se voit).
- Motifs dominants : cibles tactiles < 44 px (≈ 25 sites), `e.message` brut
  exposé à l'utilisateur (14+ sites), états d'erreur de fetch absents (6
  vues), ~350 littéraux FR codés en dur (préparation G).
- **2 découvertes rendu hors code** (§6) : publication d'identité 429
  silencieuse à l'onboarding ; groupe MLS créé mais non visible chez
  l'invité après 25 s.
- **1 découverte environnementale** (§6) : `next dev` du checkout wt-adm ne
  s'hydrate pas (production standalone saine) — l'audit rendu a donc été
  mené en build production (pattern harness C2/C3).

---

## 2. Scores axe-core par vue (cible ≥ 90 — axe n'expose pas de score : proxy = violations)

| # | Vue (état audité) | Violations | Nœuds | Détail |
|---|---|---|---|---|
| 1 | onboarding (dialog, PoW) | 0 | 0 | ✅ progressbar ARIA correcte |
| 2 | feed (chargé) | 0 | 0 | ✅ |
| 3 | messages-vide | 0 | 0 | ✅ |
| 4 | dm-conversation-alice | 0 | 0 | ✅ |
| 5 | dm-conversation-bob | 0 | 0 | ✅ |
| 6 | messages-offline (bulle file) | 1 | 2 | color-contrast (badge ambre + hint 10px) |
| 7 | profile | 0 | 0 | ✅ |
| 8 | groups-vide | 1 | 1 | label-content-name-mismatch (« Créer un groupe » vs « Nouveau groupe ») |
| 9 | groupe-cree | 1 | 1 | idem (même bouton) |
| 10 | channels | 0 | 0 | ✅ |
| 11 | network | 0 | 0 | ✅ |
| 12 | recherche-dialog | 0 | 0 | ✅ |
| 13 | call-entrant (sonnerie) | 1 | 1 | label-in-name (bouton « Nouveau groupe » sous l'overlay) |
| 14 | call-actif (timer visible) | 1 | 1 | label-in-name (« Terminer l'appel » vs « Raccrocher ») |
| 15 | admin-dashboard | 0 | 0 | ✅ |
| 16 | admin-queue | 0 | 0 | ✅ |
| 17 | admin-users | 0 | 0 | ✅ |
| 18 | admin-audit | 0 | 0 | ✅ |
| 19 | admin-pending-actions | 1 | 3 | color-contrast (text-zinc-400 : n° d'intention, dates) |

**Total : 6 types / 9 nœuds / 0 critical / 9 serious.** JSON : `docs/proofs/E-axe/<vue>.json` (cibles CSS exactes incluses).

---

## 3. Tableau exhaustif des problèmes

Catégories : UX / A11y / Erreur / i18n / Cohérence. Sévérité : **Critique**
(bloque l'ouverture publique) / **Majeur** (dégrade l'expérience) /
**Mineur** (polish). Cible = norme ou exigence à satisfaire.

### App mbote — socle et onboarding

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 1 | MboteApp (header) | menu identité | « Panic wipe » exécute la destruction **sans aucune confirmation** (`MboteApp.tsx:931-937`) alors que ProfileView en exige une (AlertDialog L537-559) — deux chemins, un seul protégé | UX | **Critique** | 30min | Ergo / action destructive |
| 2 | Onboarding | publication | **L'échec de publication de l'identité est invisible** : 429/réseau → toast info fugace « Clés créées localement » (`MboteApp.tsx:515-517`), aucun état persistant, aucun retry — l'utilisateur croit être publié, ses contacts ne le voient jamais (constaté en rendu réel, §6.2) | Erreur | **Critique** | 1h | UX / feedback d'état |
| 3 | Onboarding | PoW en cours | échec du PoW avalé sans message (`MboteApp.tsx:504-506` avale les littéraux `pow-client.ts:53/58/63/98`) — l'utilisateur ne comprend pas un futur refus serveur | Erreur | Majeur | 30min | UX |
| 4 | Onboarding | création | bouton principal « Générer mes clés et entrer » à 36px (`OnboardingDialog.tsx:124-126`) | A11y | Mineur | 15min | 44×44 px (2.5.8) |
| 5 | MboteApp (mobile) | navigation | barre mobile `grid-cols-5` pour **6 items** (`MboteApp.tsx:1082` vs L125-132) — le 6ᵉ onglet passe à la ligne et casse la barre (constaté en rendu 375) | UX | Majeur | 30min | Ergo |
| 6 | MboteApp (mobile) | recherche | recherche globale inaccessible < 640px (`hidden sm:block`, `MboteApp.tsx:856`) — la fonctionnalité D1 n'existe pas sur mobile | A11y | Majeur | 1h | WCAG / parité |
| 7 | MboteApp (mobile) | déconnecté | pastille temps réel « relay… » en `md:flex` (`MboteApp.tsx:840`) — invisible sur mobile, l'état de déconnexion est muet sur le format le plus fragile | UX | Majeur | 30min | §e états réseau |
| 8 | MboteApp | thème | bouton thème `size-9` = 36px (`MboteApp.tsx:890`) | A11y | Mineur | 10min | 44×44 px |
| 9 | MboteApp | navigation latérale | items `px-3 py-2.5` ≈ 41px sans min-h (`MboteApp.tsx:960`) | A11y | Mineur | 15min | 44×44 px |
| 10 | MboteApp | mutations | `<main aria-live="polite">` sur la vue ENTIÈRE (`MboteApp.tsx:1042`) — toute mutation re-annonce toute la vue aux lecteurs d'écran (verbeux, bruyant) | A11y | Mineur | 1h | aria-live ciblé |
| 11 | GlobalSearch (trigger) | focus | bouton déclencheur sans `focus-visible:ring` (`GlobalSearch.tsx:156-166`) | A11y | Majeur | 15min | 2.4.7 focus visible |
| 12 | GlobalSearch | erreur | banner d'erreur inclut `error.message` brut (`GlobalSearch.tsx:213-217`) — « HTTP 429 » possible à l'écran | Erreur | Mineur | 20min | messages actionnables FR |
| 13 | GlobalSearch | chargement | pendant un fetch serveur lent, rien n'indique que la section locale est déjà terminée (état vide global attend les 2 sources, `GlobalSearch.tsx:150-151,295-299`) | UX | Mineur | 30min | feedback |
| 14 | error.tsx | erreur | boundary : titre + message tronqué à 140 chars + 2 CTA (`error.tsx:41-69`) — correct, mais le message d'erreur brut tronqué peut couper au milieu d'un mot technique | Erreur | Mineur | 20min | UX |

### FeedView / PostCard / Composer (fil public)

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 15 | FeedView | erreur | **AUCUN état d'erreur sur le fetch du fil** (`FeedView.tsx:87-112`, aucun `isError` rendu) — un échec réseau après premier rendu laisse « Le fil global attend ton premier message » : le mensonge d'état vide | Erreur | **Critique** | 1h | état d'erreur honnête |
| 16 | FeedView | like | rollback optimiste correct (F-28, `PostCard.tsx:60-75`) mais le refus passe par toast « Like refusé » + `e.message` brut (`MboteApp.tsx:604-606`) | Erreur | Mineur | 20min | messages FR |
| 17 | FeedView | interactions | toggles de portée à `h-7` = 28px (`FeedView.tsx:259,274,286`) | A11y | Majeur | 30min | 44×44 px |
| 18 | FeedView | focus | `<span tabIndex={0}>` focusable sans rôle autour du tooltip abonnements (`FeedView.tsx:280`) — tab-stop muet | A11y | Mineur | 15min | 4.1.2 rôle |
| 19 | FeedView | canal | barre canal : `aria-label` sur un `div` sans rôle (`FeedView.tsx:306-308`) | A11y | Mineur | 10min | 4.1.2 |
| 20 | PostCard | interactions | boutons cœur/réponse `h-8` = 32px (`PostCard.tsx:176,198`) | A11y | Majeur | 30min | 44×44 px |
| 21 | PostCard | interactions | fermer fil compact + dismiss courrier à `size-6` = 24px (`PostCard.tsx:271,331`) — plus petites cibles du fil | A11y | Majeur | 20min | 44×44 px |
| 22 | PostCard | i18n | pluriel par concaténation `` `saut${n>1?"s":""}` `` (`PostCard.tsx:146`) | i18n | Mineur | G | Intl.PluralRules |
| 23 | Composer | erreur | toast montre `e.message` brut assumé (`Composer.tsx:51-53`) — texte restauré ✓ mais code HTTP possible | Erreur | Majeur | 30min | messages actionnables FR |
| 24 | Composer | interactions | « Publier » à `h-9` = 36px (`Composer.tsx:124`) | A11y | Mineur | 10min | 44×44 px |
| 25 | FeedView | offline | file locale bien rendue (PendingPostCard L398-410) ✓ — mais compteur d'attente uniquement dans le header global, pas dans le fil | UX | Mineur | 30min | §e compteur visible |

### MessagesView (conversations + composer DM)

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 26 | MessagesView | erreurs | **6+ toasts affichent `e.message` verbatim** (`MessagesView.tsx:778,892,1032,1123…`) — « HTTP 401 » possible, aucun bouton réessayer | Erreur | Majeur | 1h | messages actionnables FR |
| 27 | MessagesView | lecture | **auto-scroll forcé** au moindre changement (`MessagesView.tsx:630-632`) — la position de lecture est écrasée en remontant l'historique | UX | Majeur | 2h | UX lecture |
| 28 | MessagesView | lecture | **aucun indicateur lu/reçu** malgré `readAt` disponible (DTO `socket.ts:67`, jamais affiché) | UX | Majeur | 1h | UX messagerie |
| 29 | MessagesView | appel | CallButton du header à `size-8` = 32px (`CallView.tsx:405-408`) — adjacent au micro 44px, erreur de tap probable | A11y | Majeur | 15min | 44×44 px |
| 30 | MessagesView | aria | arrivée de nouveaux messages **sans aria-live** sur la liste (`MessagesView.tsx:1358-1459`) — l'annonce repose sur le `main` global (bruyant) | A11y | Mineur | 30min | aria-live ciblé |
| 31 | MessagesView | offline | bulle hors-ligne ✓ (« En attente » + « Sera envoyé dès le retour du réseau », `MessagesView.tsx:1438-1456`) MAIS badge ambre + hint 10px **échouent au contraste** (axe : 2 nœuds, `messages-offline.json`) | A11y | Majeur | 30min | 1.4.3 AA |
| 32 | MessagesView | erreurs média | erreurs média inline correctes et spécifiques (MIME spoofing, CEK, `MessagesView.tsx:235-247,321-328`) ✓ — modèle à généraliser | — | (positif) | — | — |
| 33 | MessagesView | upload | upload par étapes avec progression chiffrée ✓ (`MessagesView.tsx:1463-1483`) — mais pas de bouton annuler pendant l'envoi | UX | Mineur | 1h | actions longues |
| 34 | MessagesView | i18n | ~60 littéraux FR + tailles manuelles « o/Ko/Mo » (`MessagesView.tsx:172-176`) | i18n | Mineur | G | catalogue |

### ProfileView

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 35 | ProfileView | erreur | échecs de chargement `me`/`warnings`/`myPosts` **jamais rendus** (`ProfileView.tsx:102` jette « avertissements indisponibles » mais rien ne l'affiche ; L425-430 état vide trompeur) | Erreur | Majeur | 1h | état d'erreur honnête |
| 36 | ProfileView | interactions | boutons size="sm"/h-9 = 36px partout (`ProfileView.tsx:398,492,502,530`) + copie d'empreinte ≈ 30px (`L329-331`) | A11y | Mineur | 30min | 44×44 px |
| 37 | ProfileView | notifications | 4 états push inline spécifiques et actionnables ✓ (`ProfileView.tsx:469-485`) — modèle à généraliser | — | (positif) | — | — |
| 38 | ProfileView | i18n | ~45 littéraux FR, pluriels `(s)` (`ProfileView.tsx:264,383`) | i18n | Mineur | G | catalogue |

### GroupsView (MLS)

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 39 | GroupsView | sélection | **la sélection de groupe est un Card onClick SANS role="button", tabIndex ni keydown** (`GroupsView.tsx:204-211`) — ouvrir une conversation de groupe est impossible au clavier et au lecteur d'écran | A11y | **Critique** | 1h | 2.1.1 / 4.1.2 |
| 40 | GroupsView | label-in-name | bouton visible « Nouveau groupe » avec `aria-label="Créer un groupe"` (`GroupsView.tsx:291`) — le nom accessible ne contient pas le texte visible (axe : 3 vues touchées) | A11y | Majeur | 10min | 2.5.3 label-in-name |
| 41 | GroupsView | exclusion | confirmation par **`window.confirm` natif** (`GroupsView.tsx:474`) — hors design system, non stylé, incohérent avec les AlertDialog de ProfileView | Cohérence | Majeur | 30min | design system |
| 42 | GroupsView | erreurs | échecs de listing **totalement silencieux** (`catch {}` L111-113, `console.warn` L95/L414) — « réseau HS » indistinguable d'« aucun groupe » | Erreur | Majeur | 30min | état d'erreur |
| 43 | GroupsView | erreurs | erreurs MLS brutes exposées : `` `Création impossible : ${e.message}` ``, `` `Envoi impossible : ${e.message}` ``, `` `Invitation impossible…` ``, `` `Retrait impossible…` `` (`GroupsView.tsx:277-279,448,462-464,480-482`) | Erreur | Majeur | 45min | messages FR |
| 44 | GroupsView | interactions | bouton retirer membre ≈ **18-20px** (`p-0.5` + icône size-3, `GroupsView.tsx:519-527`) — la plus petite cible de l'app, action irréversible (forward secrecy) | A11y | Majeur | 20min | 44×44 px |
| 45 | GroupsView | interactions | boutons « Inviter » à `h-7` = 28px (`GroupsView.tsx:541-545`) ; envoi/refresh `size="icon"` = 36px (`L615-632`) | A11y | Majeur | 20min | 44×44 px |
| 46 | GroupsView | chargement | aucun skeleton sur la liste (poll 4s `L66,119`) — premier affichage = état vide avant données | UX | Mineur | 30min | skeleton |
| 47 | GroupsView | invitation | **le groupe créé n'est pas visible chez l'invité après 25 s** (rendu réel pass 7/8 : `group-not-visible-bob.png`) — la liste ne rafraîchit pas / le welcome n'est pas consommé tant qu'on reste sur la vue ; constaté, non diagnostiqué (F) | UX | **Critique** | 2h | UX MLS |

### CallView (audio/vidéo)

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 48 | CallView | overlay | `role="dialog"` **sans focus trap, sans aria-modal, sans aria-live** (`CallView.tsx:150-159,173-189`) — le focus reste dans la page derrière, les transitions sonnerie→connexion→actif ne sont pas annoncées | A11y | Majeur | 2h | dialog pattern |
| 49 | CallView | raccrocher | bouton actif : `aria-label="Terminer l'appel"` ≠ texte visible « Raccrocher » (`CallView.tsx:317-334`, axe label-in-name `call-actif.json`) | A11y | Majeur | 10min | 2.5.3 |
| 50 | CallView | erreur | `call.error` rendu verbatim du callManager sans action (`role="alert"`, `CallView.tsx:283-287`) — pas de bouton « Rappeler »/« Fermer » | Erreur | Mineur | 30min | erreurs actionnables |
| 51 | CallView | sonnerie | aucun timer ni timeout de sonnerie visible côté UI (gestion interne seulement) — l'appelant ne sait pas si ça sonne encore | UX | Mineur | 1h | feedback |
| 52 | CallView | états | boutons in-call tous ≥ 48px ✓, aria-pressed ✓, indicateurs TURN/qualité/caméra ✓ (`CallView.tsx:66-76,295-365`) — l'inverse des problèmes 48-49 | — | (positif) | — | — |

### Panneau admin

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 53 | Login | erreurs | **erreurs de login non annoncées** : `<p>` sans `role="alert"` ni aria-live (`AdminAuthPanel.tsx:224,282`), pas d'`aria-invalid`, pas de focus management — le seul formulaire critique sans a11y d'erreur | A11y | Majeur | 30min | 4.1.3 |
| 54 | Login | interactions | toggle break-glass = lien texte ≈ 16px (`AdminAuthPanel.tsx:290`) ; submits ≈ 36px (`:276,200,220,328`) | A11y | Majeur | 30min | 44×44 px |
| 55 | Login | rate-limit | aucune gestion client du 429 (pas de compte à rebours, « réessayez dans quelques minutes » vague, `Retry-After` ignoré, `AdminAuthPanel.tsx:64`) | UX | Majeur | 1h | feedback 429 |
| 56 | Shell admin | nav | shell dupliqué **7× à la main**, header dashboard sans `<nav>`, libellé « liaison perdue » vs « liaison app principale perdue » (`audit/[id]:140` vs autres) | Cohérence | Majeur | 1h | composant partagé |
| 57 | Shell admin | session | **aucun logout dans les vues internes** (uniquement sur `/`), aucun idle-timeout annoncé, `expiresAt` du login jamais consommé (`login route:50` inutilisé) — l'expiration ne se voit qu'en 401 réactif | UX | Majeur | 1h | gestion de session |
| 58 | 5 vues | 401 | bandeau « Session expirée — reconnectez-vous depuis la page d'authentification. » **sans lien cliable** (`DashboardMetrics:194` etc.) — l'admin doit deviner le chemin | UX | Majeur | 20min | action de récupération |
| 59 | Dashboard | dégradation | backend down → **zéro donnée rendue** (cartes absentes, `DashboardMetrics:207`) — ni dernière valeur connue, ni horodatage, ni valeurs grisées ; page vide + bandeau | Erreur | Majeur | 1h | dégradation honnête |
| 60 | Queue | périmètre | **« Demander un ban définitif » n'a aucun bouton dans la file** (`QueueView.tsx:103,200-236` orphelins) — le four-eyes purge l'est, le ban non : l'admin super ne découvre le ban que sur la fiche | Cohérence | Majeur | 30min | parité des actions |
| 61 | Queue | filtres | pas de filtre « traités/classés » (`status: "open"|"all"` seulement, `QueueView.ts:69`) — impossible de rejouer ses actions ; statuts backend affichés bruts (`:422`) | UX | Majeur | 1h | traçabilité UI |
| 62 | Queue | focus | ouverture/fermeture du formulaire de justification sans focus management ni `aria-expanded` (`QueueView.tsx:580-586,618-641`) — après succès le focus tombe au body | A11y | Majeur | 1h | focus management |
| 63 | Queue/UserDetail | jargon | « — OK (2xx). », « Liste rejetée depuis le serveur. », « Rejet en cours depuis le serveur… » (`QueueView:272`, `UserDetailView:235,359`) — le registre dev est parlé à l'admin | Erreur | Majeur | 1h | FR naturel |
| 64 | Users | tableau | `<th>` **sans `scope="col"` ni `<caption>`** (`UsersView.tsx:332-339`) — seule vue tableau sans scope (AuditView l'a, `:432`) | A11y | Majeur | 15min | 1.3.1 |
| 65 | Users | recherche | la recherche écrase la liste paginée sans retour avant recherche (le « ← Annuaire complet » n'apparaît qu'après, `UsersView.tsx:248`), pagination masquée en mode search (`:401`) | UX | Mineur | 30min | contexte |
| 66 | Users | filtres | filtre « bannis (Étape 9) » proposé alors qu'il retourne toujours vide avant É9 (`UsersView.tsx:271-274,348`) — filtre mort exposé | UX | Mineur | 15min | honnêteté UI |
| 67 | Fiche/Queue | cohérence | durées de suspension divergentes : file « 24 h / 7 j / illimitée » (`QueueView:495-497`) vs fiche « 24 h / 7 j / 30 j » (`UserDetailView:482-484`) — deux modèles mentaux | Cohérence | Majeur | 20min | parité |
| 68 | Audit | filtres | **filtre Cible : fetch à chaque frappe sans debounce** (`AuditView.tsx:392`) — rafales BFF→backend par caractère ; incohérent avec la recherche users (soumission explicite) | UX | Majeur | 30min | debounce |
| 69 | Audit | erreurs | page d'erreur au design distinct + seul « Réessayer » du panneau (`AuditView.tsx:267-287`) — les 5 autres vues n'ont pas de retry après 502 | Cohérence | Majeur | 1h | parité de récupération |
| 70 | Audit | interactions | les 7 contrôles de filtre ≈ 32px (`px-2 py-1.5`, `AuditView.tsx:308-393`) — contrairement à queue/users (`min-h-11`) ; Export/Réessayer/Charger plus ≈ 32px (`:281,402,487`) | A11y | Majeur | 30min | 44×44 px |
| 71 | Audit | i18n | pluriel correct « ligne{s} affichée{s} » (`AuditView.tsx:407-408`) ✓ — le seul pluriel bien géré du codebase | — | (positif) | — | — |
| 72 | Pending-actions | logique | **bug : `item.requestedBy.email === role` compare un email à un rôle** (`PendingActionsView.tsx:328`) — la branche « Vous êtes le demandeur… » est inatteignable ; diagnostic faux pour les moderators | Erreur | **Critique** | 30min | logique RBAC UI |
| 73 | Pending-actions | a11y | **contraste** : `text-zinc-400` pour n° d'intention et dates (`PendingActionsView.tsx`, axe 3 nœuds sur `admin-pending-actions.json`) | A11y | Majeur | 20min | 1.4.3 AA |
| 74 | Pending-actions | compte à rebours | countdown 1h **figé** (calculé au rendu, aucun tick, `PendingActionsView.tsx:66-73`) — « expire dans 42 min » reste affiché pendant que l'intention expire ; l'admin découvre le 410 en cliquant | UX | Majeur | 1h | vérité temps réel |
| 75 | Pending-actions | i18n | statuts techniques EN bruts (`pending/executed/cancelled/expired`, `:273,347-349`) au milieu de libellés FR | i18n | Mineur | 30min | mapping FR |

### Transverse i18n (préparation G)

| # | Vue | État | Problème | Catégorie | Sévérité | Effort | Cible |
|---|---|---|---|---|---|---|---|
| 76 | ~25 fichiers | tous | **~350 littéraux FR codés en dur**, 0 framework i18n (estimation détaillée §5) — l'extraction est le chantier G lui-même | i18n | Majeur (pour G) | G | catalogue FR/EN |
| 77 | mbote | dates | dates OK mais **hétérogènes** : date-fns `fr` (PostCard:130, MessagesView:1427, GlobalSearch:243, ChannelsView:159) vs `toLocaleString("fr-FR")` (PostCard:128, ProfileView:278, GroupsView:594) vs `toLocaleTimeString()` **sans locale** (RouteurPanel:183) | i18n | Mineur | G | Intl unifié |
| 78 | mbote+admin | pluriels | pluriels par concaténation `(s)`/ternaires ≥ 10 sites (MboteApp:290, PostCard:146, ProfileView:264/383, GroupsView:216/347, QueueView:378/272, UsersView:166/306, PendingActionsView) — « 1 signalement(s) » possible | i18n | Mineur | G | Intl.PluralRules |

---

## 4. Motifs transverses (6)

1. **`e.message` brut exposé** — 14+ sites (api.ts:49 `body.error ?? \`HTTP ${res.status}\`` rend l'exposition possible partout) : MboteApp 282/605, Composer 51, MessagesView 778/892/1032/1123, GlobalSearch 215, GroupsView 278/448/463/481, NetworkView 157/221, CallView 284. *Cible F : mapping central statut→message FR actionnable.*
2. **Cibles tactiles < 44 px** — ≈ 25 sites (28px toggles, 32px actions, 24px dismiss, 18px exclusion membre, 36px submits, 16px toggle break-glass, 32px headers admin, filtres audit). *Cible : 2.5.8 (24px min) au minimum, 44px visé.*
3. **États d'erreur de fetch absents** (chargement ok, échec invisible) — FeedView 87-112, GroupsView 111-113, ProfileView 102/425-430, ChannelsView 33-37, Dashboard (down = vide). *Cible : chaque requête a un état erreur rendu + action.*
4. **Conteneurs cliquables non sémantiques / live regions grossières** — GroupsView Card onClick (39), FeedView span tabIndex (18), CallView overlay sans trap (48), `<main aria-live="polite">` global (10).
5. **i18n FR codé en dur** — ~350 littéraux, pluriels concaténés, formats de date hétérogènes. *Préparation G : §5.*
6. **Jargon technique à l'écran** — « (2xx) », « Rejet en cours », « Liste rejetée depuis le serveur », « HTTP {status} — réessayez. », badge « auth — Étape 3+4 », statuts EN bruts. *Cible : registre admin naturel.*

---

## 5. Préparation G — estimation i18n

| Fichier | Littéraux FR (est.) | Notes |
|---|---|---|
| MessagesView.tsx | ~60 | le plus dense (toasts média/voix/vidéo) |
| MboteApp.tsx | ~50 | nav, toasts, CTA |
| GroupsView.tsx | ~30 | + messages système MLS |
| ProfileView.tsx | ~45 | warnings, push, danger zone |
| QueueView.tsx | ~50 | notices jargon incluses |
| UserDetailView.tsx | ~45 | |
| UsersView.tsx | ~35 | |
| FeedView.tsx | ~25 | |
| PendingActionsView.tsx | ~40 | + statuts EN à mapper |
| CallView.tsx | ~20 | |
| DashboardMetrics.tsx | ~30 | |
| AuditView.tsx (+page) | ~35 | |
| AdminAuthPanel.tsx | ~35 | |
| GlobalSearch.tsx | ~15 | |
| OnboardingDialog.tsx | ~15 | |
| PostCard/Composer/Channels/Network/BitChatBridge/MeshSimulation/RouteurPanel | ~90 cumulés | |
| **Total** | **≈ 350** | **≈ 25 fichiers** — date-fns `fr` + `Intl.DateTimeFormat` déjà utilisés (9 sites) : le socle Intl existe |

---

## 6. Découvertes rendu réel (hors code)

### 6.1 Environnement : `next dev` du checkout wt-adm ne s'hydrate pas

Les deux `next dev` de wt-adm (app :3100, panel :3103) rendent le SSR
(squelettes/formulaire) mais **React ne monte jamais** — DOM = coquille +
flight payload, zéro erreur console, IndexedDB/crypto sains, tous les chunks
chargés. Le checkout principal (vintage antérieure) s'hydrate normalement en
dev. **Production standalone saine** (18 vues rendues et interactives). Cause
non identifiée — l'audit rendu a été mené en production standalone (pattern
harness C2/C3). À investiguer dans F si reproduit (impact : DX uniquement).

### 6.2 Onboarding : la publication d'identité peut échouer en silence (429)

La garde anti-Sybil D2 limite la création de comptes serveur à
**3/heure/IP** (`IDENTITY_CREATIONS_PER_HOUR_PER_IP`, `identity/route.ts:85-98`,
`Retry-After` 3600). En rendu réel, le 4ᵉ onboarding de l'heure a produit :
clés locales créées, app « entrée », **POST /api/identity → 429**, toast info
fugace seulement — et l'identité **absente de /api/users** : ses contacts ne
peuvent jamais l'appeler. Croise le problème #2 (Critique). C'est la garde qui
a bien travaillé ; c'est le silence de l'UI qui est le défaut.

### 6.3 Groupe MLS : le groupe créé n'est pas visible chez l'invité (25 s)

Passes 7/8 : création MLS réussie côté Alice (commit + welcome diffusés, toast
« Groupe créé »), **la liste de Bob ne montre pas le groupe après 25 s** même
en restant sur la vue (poll 4 s actif) ni après navigation fraîche. La
keypackage de Bob a bien été consommée. Constaté, non diagnostiqué —
problème #47. Avant ouverture publique, l'invitation MLS doit être visible
chez l'invité sans action magique.

### 6.4 Vérifications rendues positives (les flux qui tiennent)

- **B2-fix re-vérifié** : le dialog « Choisir un contact » s'ouvre depuis
  l'état vide Messages (`messages-newconv-dialog.png`).
- **DM E2EE aller-retour réel** : Alice→Bob→Alice, 2 identités réelles,
  socket :3040, bulles rendues des deux côtés (`dm-conversation-alice.png`,
  `dm-recu-bob.png`).
- **Appel audio réel** : knock → sonnerie Bob (`call-ringing-bob.png`) →
  accepter → **actif** avec timer + « Relais TURN actif (CGNAT) »
  (`call-active-bob.png`) → raccrocher propre.
- **Hors-ligne** : pastille « Mesh · file locale (1) », toast « Le courrier
  chiffré attend dans la file locale, comme chez BitChat », bulle « En
  attente » + placeholder composer dédié (`messages-offline-bulle.png`), flush
  à la reconnexion (`messages-reconnect-flush.png`).
- **Dégradation relay** : SIGSTOP du hub → pastille « relay… » dans le header
  (`relay-degrade-header.png`), reconnexion auto sans reload.
- **Panneau admin production** : login TOTP réel 200 → 4 métriques dashboard,
  queue + formulaire justification (compteur n/20), users, audit,
  pending-actions — tous rendus avec seed (reports/pending/audit).
- **Responsive 375** : onboarding, feed, messages, profile capturés —
  confirme le débordement du 6ᵉ onglet (#5) et l'inaccessibilité mobile de la
  recherche (#6).

---

## 7. Priorisation pour F

### Bloc Critique — obligatoire avant ouverture publique (6)

1. **#1** Panic wipe sans confirmation depuis le header (UX)
2. **#2** Publication d'identité : échec silencieux, état « publié » mensonger (Erreur)
3. **#15** Feed : aucun état d'erreur — échec réseau = « fil vide » mensonger (Erreur)
4. **#39** GroupsView : sélection de groupe impossible au clavier/lecteur d'écran (A11y)
5. **#72** PendingActionsView : bug logique email === rôle, message demandeur inatteignable (Erreur)
6. **#47** Invitation MLS invisible chez l'invité (UX — rendu réel §6.3)

### Bloc Majeur — à corriger dans F si le temps le permet (42)

Touch < 44 px en masse (#17,20,21,29,44,45,54,70 + 8,9,24,36), erreurs brutes
#23,26,43, errors de fetch silencieux #3,35,42,59, aria/focus #11,40,48,49,53,62,64,
73, offline/contraste #31, mobile #5,6,7, session admin #55,57,58,74,
cohérences #41,56,60,61,67,68,69,63, i18n pour G #76.

### Bloc Mineur — polish (30)

Le reste du tableau (14,16,18,19,22,25,30,33,34,37,38,46,50,51,65,66,71,75,77,78…).

---

## 8. NON TESTÉ

- Safari/Firefox, lecteurs d'écran réels (VoiceOver/NVDA), device physique
  responsive, safe-areas iOS.
- Contrastes validés par axe-core uniquement (5 combinaisons relevées) —
  mesure manuelle AA complète non faite.
- États admin « backend down » rendus (seul le code et la carte auditor ont
  été vérifiés ; la dégradation rendue nécessiterait de couper :3110 — fait
  pour le hub mbote, pas pour le BFF admin).
- Charge réelle (pagination profonde, 200+ messages), WebSocket sous
  instabilité réseau réelle (uniquement setOffline/SIGSTOP synthétiques).
- Le diagnostic exact du §6.3 (welcome MLS non consommé) et du §6.1 (stall dev)
  — constatés, causes non isolées.

---

## 9. Statuts vague F (registre de correction — preuves dans `docs/proofs/F-ui-fixes.md`)

Conventions : ✅ Corrigé (vague F, commit + preuve) · ⏳ Mineur reporté post-F ·
⏭️ Reporté (Majeur hors sous-ensemble validé) · ✓ (positif) = modèle à
généraliser, rien à corriger.

| # | Sévérité E | Statut F | Détail |
|---|---|---|---|
| 1 | Critique | ✅ Corrigé (`0922b0f`) | AlertDialog de confirmation — preuve navigateur avant/après |
| 2 | Critique | ✅ Corrigé (`6fa7b0d`) | bannière persistante 429 + retry — preuve navigateur |
| 3 | Majeur | ✅ Corrigé (`3eed519`) | PoW avalé → toast warning cause + conséquence |
| 4 | Mineur | ⏳ Mineur reporté post-F | bouton onboarding 36px |
| 5 | Majeur | ⏭️ Reporté | barre mobile 6 items — rendu mobile réel requis |
| 6 | Majeur | ⏭️ Reporté | recherche inaccessible < 640px |
| 7 | Majeur | ⏭️ Reporté | pastille relay invisible sur mobile |
| 8 | Mineur | ⏳ Mineur reporté post-F | bouton thème 36px |
| 9 | Mineur | ⏳ Mineur reporté post-F | items nav 41px |
| 10 | Mineur | ⏳ Mineur reporté post-F | aria-live global verbeux |
| 11 | Majeur | ⏭️ Reporté | focus ring GlobalSearch |
| 12 | Mineur | ⏳ Mineur reporté post-F | banner erreur e.message brut |
| 13 | Mineur | ⏳ Mineur reporté post-F | feedback chargement recherche |
| 14 | Mineur | ⏳ Mineur reporté post-F | troncature message boundary |
| 15 | Critique | ✅ Corrigé (`b1a13f2`) | état d'erreur feed — preuve navigateur |
| 16 | Mineur | ⏳ Mineur reporté post-F | like toast + e.message (mapping central déjà appliqué au chemin) |
| 17 | Majeur | ✅ Corrigé (`11f84f3`) | toggles portée → min-h-11 |
| 18 | Mineur | ⏳ Mineur reporté post-F | span tabIndex sans rôle |
| 19 | Mineur | ⏳ Mineur reporté post-F | aria-label sur div sans rôle |
| 20 | Majeur | ✅ Corrigé (`11f84f3`) | cœur/réponse → min-h-11 |
| 21 | Majeur | ✅ Corrigé (`11f84f3`) | dismiss 24px → size-11 |
| 22 | Mineur | ⏳ Mineur reporté post-F | pluriel concaténé (G) |
| 23 | Majeur | ✅ Corrigé (`3eed519`) | Composer → describeApiError |
| 24 | Mineur | ⏳ Mineur reporté post-F | Publier 36px |
| 25 | Mineur | ⏳ Mineur reporté post-F | compteur file locale |
| 26 | Majeur | ✅ Corrigé (`3eed519`) | toasts MessagesView → describeApiError |
| 27 | Majeur | ⏭️ Reporté | auto-scroll forcé (2 h) |
| 28 | Majeur | ⏭️ Reporté | indicateur lu/reçu |
| 29 | Majeur | ✅ Corrigé (`11f84f3`) | CallButton → size-11 |
| 30 | Mineur | ⏳ Mineur reporté post-F | aria-live liste messages |
| 31 | Majeur | ✅ Corrigé (`3d07e12`) | contraste bulle offline — axe 100 |
| 32 | (positif) | ✓ modèle | erreurs média inline — à généraliser |
| 33 | Mineur | ⏳ Mineur reporté post-F | annuler upload |
| 34 | Mineur | ⏳ Mineur reporté post-F | littéraux FR (G) |
| 35 | Majeur | ✅ Corrigé (`3eed519`) | échecs me/warnings/myPosts rendus |
| 36 | Mineur | ⏳ Mineur reporté post-F | boutons profil 36px |
| 37 | (positif) | ✓ modèle | états push inline |
| 38 | Mineur | ⏳ Mineur reporté post-F | littéraux FR (G) |
| 39 | Critique | ✅ Corrigé (`c58a13a` + `97e67f3`) | bouton sémantique clavier — preuve navigateur (13 Tabs + Enter) |
| 40 | Majeur | ✅ Corrigé (`3d07e12`) | label-in-name « Nouveau groupe » |
| 41 | Majeur | ⏭️ Reporté | window.confirm → AlertDialog |
| 42 | Majeur | ✅ Corrigé (`3eed519`) | listing erreur rendu + Réessayer |
| 43 | Majeur | ✅ Corrigé (`3eed519`) | erreurs MLS → describeApiError |
| 44 | Majeur | ✅ Corrigé (`11f84f3`) | retrait membre → 44×44 |
| 45 | Majeur | ✅ Corrigé (`11f84f3`) | Inviter/envoyer/refresh → 44px |
| 46 | Mineur | ⏳ Mineur reporté post-F | skeleton liste groupes |
| 47 | Critique | ✅ Non-défaut prouvé (`6827add`) | diagnostic live : serveur stocke ✓, B poll ✓, UI rend ✓ (t=+2 s) — artefact harnais E + garde anti-régression rejouable |
| 48 | Majeur | ⏭️ Reporté | dialog pattern CallView (focus trap, 2 h) |
| 49 | Majeur | ✅ Corrigé (`3d07e12`) | aria-label « Raccrocher » |
| 50 | Mineur | ⏳ Mineur reporté post-F | erreurs call actionnables |
| 51 | Mineur | ⏳ Mineur reporté post-F | timer sonnerie |
| 52 | (positif) | ✓ modèle | boutons in-call ≥ 48px |
| 53 | Majeur | ⏭️ Reporté | alerts login admin |
| 54 | Majeur | ✅ Corrigé (`11f84f3`) | toggle break-glass + submits → min-h-11 |
| 55 | Majeur | ⏭️ Reporté | gestion client du 429 admin |
| 56 | Majeur | ⏭️ Reporté | shell admin dupliqué |
| 57 | Majeur | ⏭️ Reporté | logout/idle-timeout |
| 58 | Majeur | ⏭️ Reporté | lien bandeau 401 |
| 59 | Majeur | ✅ Corrigé (`3eed519`) | dégradation honnête dashboard (dernières valeurs grisées) |
| 60 | Majeur | ⏭️ Reporté | bouton ban dans la file |
| 61 | Majeur | ⏭️ Reporté | filtre traités/classés |
| 62 | Majeur | ⏭️ Reporté | focus management queue |
| 63 | Majeur | ⏭️ Reporté | jargon admin → FR naturel |
| 64 | Majeur | ⏭️ Reporté | scope="col" users |
| 65 | Mineur | ⏳ Mineur reporté post-F | contexte recherche users |
| 66 | Mineur | ⏳ Mineur reporté post-F | filtre bannis vide |
| 67 | Majeur | ⏭️ Reporté | durées suspension divergentes |
| 68 | Majeur | ⏭️ Reporté | debounce filtre audit |
| 69 | Majeur | ⏭️ Reporté | retry parité admin |
| 70 | Majeur | ✅ Corrigé (`11f84f3`) | filtres + actions audit → min-h-11 |
| 71 | (positif) | ✓ modèle | pluriel correct audit |
| 72 | Critique | ✅ Corrigé (`66e6590`) | identité vs identité (myEmail) + diagnostic moderator |
| 73 | Majeur | ✅ Corrigé (`3d07e12`) | contraste zinc-600 — axe 100 |
| 74 | Majeur | ⏭️ Reporté | countdown figé |
| 75 | Mineur | ⏳ Mineur reporté post-F | statuts EN bruts |
| 76 | Majeur (pour G) | ⏭️ Reporté | extraction i18n = le chantier G lui-même |
| 77 | Mineur | ⏳ Mineur reporté post-F | formats de dates hétérogènes (G) |
| 78 | Mineur | ⏳ Mineur reporté post-F | pluriels concaténés (G) |

**Bilan : 25 corrigés (6 C + 19 M) · 23 Majeurs reportés ⏭️ · 26 Mineurs ⏳ ·
4 lignes ✓ (positif).**
