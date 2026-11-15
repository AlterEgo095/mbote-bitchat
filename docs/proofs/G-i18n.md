# Vague G — i18n FR/EN + non-régression C1 (reload post-MLS) + multi-appareils (timebox)

**Statut : SUCCESS — preuve navigateur EXIT 0 (33 checks), axe EN 100×3, P4 sim 247 pass / 0 fail, gates tsc + i18n verts.**
Date : 2026-11-15 · Branche : `feat/mbote-v1` · main intouché · Base CI verte : `1773e7d`

---

## §0 — Verdict et livrables

| Livrable demandé (directive G) | Livré | Preuve |
|---|---|---|
| Clarification 1 : investiguer + corriger le reload post-MLS perdant l'identité (1-2 h) | **CORRIGÉ** (cause racine trouvée + 3 défauts latents découverts par la preuve elle-même) | §1 + §2 (C1 : 5 checks verts, envoi MLS après reload) |
| Clarification 2 : licence d'une lib i18n vérifiée, choix documenté | next-intl@4.15.1 = **MIT vérifié** (`package/LICENSE` du tarball) ; **approche MAISON retenue**, justification argumentée | §3 |
| Infrastructure i18n (maison), `locales/fr.json` + `locales/en.json`, `Intl.DateTimeFormat` / `Intl.NumberFormat` / `Intl.PluralRules` | 661 clés par locale, parité fr/en + placeholders vérifiée programmatiquement ; runtime ~300 lignes auditable (`src/lib/mbote/i18n.tsx`) | §3 + gate i18n |
| Sélecteur de langue dans `ProfileView` | Carte « Préférences » + Select fr/en (`data-testid="lang-select"`) | §4 + captures |
| Persistance locale **et** serveur (`/api/preferences`) | LS `mbote_locale` + POST signé ECDSA ; GET public `{locale, explicit}` ; migration `0012` (`User.locale`, `User.localeExplicit`) | §4 + §5 |
| Détection auto du navigateur (fallback FR) | Chaîne LS > serveur (choix explicite) > `navigator.languages` > `fr`, prouvée avec contexts Playwright `fr-FR`/`en-US` | §5 (4 checks détection) |
| Switch FR↔EN sur 3 vues + reload → préférence persistée | 5 checks switch/persistance verts, y compris **adoption serveur** (roaming) prouvée sans ambiguïté de détection | §5 |
| Axe-core EN ≥ 90 | **100 / 100 / 100** (0 violation) sur feed/messages/profile EN | §2 + `axe-resume-g.json` |
| Dates « 14 novembre 2026 » / « November 14, 2026 » | Tooltip `fmtDate` des PostCards — comparaison **DOM vs Intl calculé dans la page** (au bit près), les deux locales | §5 |
| Pluriels corrects | `Intl.PluralRules` réel (CLDR) sur 20+ surfaces ; preuve harnais sur les badges de recherche (« 2 résultats »/« 1 résultat » / « 2 results »/« 1 result ») | §5 |
| `grep` prouvant l'extraction des textes en dur | Gate i18n : **28 sentinelles FR historiques → 0 occurrence** dans le code de `src/components/` (commentaires strippés) + toutes les clés `t()/tp()` du code résolues au catalogue | §3.3 (`scripts/g-i18n-gate.ts`) |
| Runner `scripts/g-i18n-proof-run.sh` avec gate `tsc` avant build | Livré — gate tsc root+admin, **puis** gate i18n, build standalone, serveurs réels, harnais (timeout 420 s), P4 sim `tests.yml` (247 pass / 231 skip / **0 fail**) | §2.3 |
| Multi-appareils : si > 2 jp → STOP + dette `SCALE-ARCHITECTURE.md §8` | **Timebox déclenchée : STOP appliqué** — sessions indépendantes V1 garanties, portage Signal-style estimé 5–8 jp et documenté en **§8.3** | §6 |

**Commits** (sur `feat/mbote-v1`, dans l'ordre) :
`c02e209` fix(C1) conflit de version IndexedDB → `82d18cf` feat(G) i18n maison complet → `9b91d06` feat(G) preuve verte + 3 défauts latents corrigés + workflow hebdo → (docs, ce fichier).

---

## §1 — Clarification 1 : le reload post-MLS ne perd plus l'identité

### §1.1 Cause racine (famille #47, observation F §9)

Deux modules ouvraient **la même base IndexedDB `mbote-secure` avec deux versions différentes** :

| Module | Version demandée | Store |
|---|---|---|
| `secure-keys.ts` (clés identité) | **1** | `keys` |
| `mls/store.ts` (état MLS scellé, C4) | **2** | `mls` |

Chaîne de défaillance déterministe après le **premier** flux MLS :

1. le flux MLS fait le premier `open("mbote-secure", 2)` → upgrade 1→2 ;
2. au reload, `loadIdentity()` → `getSecureKeys()` → `open(v1)` → **`VersionError`** (spec IndexedDB : version demandée < version existante) ;
3. l'erreur est **avalée** par `catch → return null` (muets) ;
4. `loadIdentity()` : `keys === null` → `return null` **même si le localStorage `mbote_identity_v1` contenait encore l'identité** (fail-closed correct, mais déclenché pour la mauvaise raison) ;
5. `MboteApp` : `if (!id) setOnboardingOpen(true)` → dialog d'onboarding + `createGroupCount: 0` (le bouton `create-group` n'existe que dans `GroupsView`, rendu seulement avec identité).

Cohérent avec l'observation F : P3/P4 re-naviguaient pageA **avant** MLS sans perte (la base était encore v1).

### §1.2 Fix principal (commit `c02e209`)

- **`secure-db.ts` (nouveau)** : ouvreur UNIQUE — `SECURE_DB_VERSION = 2`, création **idempotente** des deux stores (`keys`, `mls`) quel que soit le chemin d'upgrade (0→2, 1→2) et le module appelant. Politique : tout nouveau store passe PAR ICI, plus jamais de constante de version locale.
- `secure-keys.ts` + `mls/store.ts` : ouvertures locales supprimées ; le `catch` muet de `getSecureKeys` logge désormais (`console.warn`, doctrine « jamais silencieux » — le null fail-closed reste voulu : sans clés privées, l'onboarding est le bon comportement).
- Connexes (même famille) : `setMlsIdentity` branche désormais `setStoreIdentity` (le cache KP scellé est réellement persisté/rechargé) et `panicWipe` appelle `wipeMls()` (jusqu'ici dead code — les singletons MLS mémoire survivaient au wipe).

### §1.3 Trois défauts latents RÉVÉLÉS par la preuve (corrigés, commit `9b91d06`)

Le fix C1 a rendu atteignables des chemins jamais exercés (le reload tuait l'identité avant). Le harnais G les a trouvés un par un — diagnostic jamais silencieux :

1. **Double-décodage de l'état MLS** — `runtimeFor()` appliquait `decodeValue` sur la sortie **déjà décodée** de `loadGroupState()` (qui fait `decodeValue∘JSON.parse`). Au 2ᵉ passage, les `Uint8Array` (déjà réels) tombaient dans la branche objet générique → `{0:number,…}`, les `Map/Set` → `{}` — d'où `createApplicationMessage` → **« Length too large to encode (max is 2^30 - 1) »** (longueur `undefined` → NaN) au premier envoi post-reload. Capté par le toast du harnais puis confirmé par l'empreinte de forme (`shapeOf`, types/longueurs uniquement — aucun octet secret) branchée en permanence dans `sendGroupMessage`.
2. **`saveKpCache` sérialisait en JSON brut** — le `privatePackage` ts-mls contient des `bigint` (JSON.stringify **throw**) et des `Uint8Array` (corrompus en `{"0":…}`). Dead code jusqu'au branchement de `setStoreIdentity` — devenu réel en G → la publication des key packages rejetait → bouton `create-group` désactivé pour toujours. Fix : codec C4 (`encodeValue`/`decodeValue`) pour le cache KP + échec de persistence **non bloquant** (optimisation, jamais une condition de réussite de la publication).
3. **Adoption serveur écrasait la détection navigateur** — un compte tout neuf a `User.locale = 'fr'` par DÉFAUT ; l'adoption roaming de l'I18nProvider l'appliquait par-dessus la détection `en-US` (onboarding EN basculé en FR, constaté par capture). Fix : colonne **`User.localeExplicit`** (migration `0012` complétée), posée UNIQUEMENT par `POST /api/preferences` ; `GET` renvoie `{locale, explicit}` ; le client n'adopte que `explicit === true`. La détection d'un nouvel appareil ne peut plus être écrasée par une valeur que l'utilisateur n'a jamais choisie.

### §1.4 Non-régression exécutée en conditions réelles

Le harnais G rejoue le scénario exact de F §9 puis va plus loin :

```
onboarding A + B → vue groups → groupe MLS créé par A (B invité)
→ RELOAD pageA → identité présente (zéro dialog), create-group ≥ 1,
  groupe listé → OUVERTURE de la conversation → ENVOI « Msg après reload C1 »
  → bulle visible (l'état scellé IDB v2 est rechargé, le ratchet avance)
→ RELOAD pageB → identité présente.
```

Checks verts : `c1_reloadKeepsIdentityAlice`, `c1_createGroupCountAtLeastOne` (=1),
`c1_groupListedAfterReload`, `c1_mlsSendAfterReload`, `c1_reloadKeepsIdentityBob`.
Captures : `assets/G/c1-reload-alice.png`, `c1-reload-bob.png`.

---

## §2 — Preuves navigateur (harnais `scripts/g-i18n-proof.ts`)

### §2.1 Ce que le harnais prouve (33 checks, `results-g.json`)

| Bloc | Checks | Résultat |
|---|---|---|
| C1 reload post-MLS | 5 | ✅ (dont envoi MLS post-reload) |
| Détection navigateur `fr-FR` (sans LS) | 2 | ✅ onboarding FR + `<html lang="fr">` |
| Rendu FR + dates + pluriels | 6 | ✅ fmtDate long form DOM↔Intl, fmtRelative, pluriels « 2 résultats »/« 1 résultat » |
| Switch FR→EN (sélecteur Profil) | 5 | ✅ html lang, nav EN, carte Preferences, LS `mbote_locale=en`, serveur `{locale:"en"}` |
| Dates/relatifs EN | 2 | ✅ « November 15, 2026 » + « ago/now » sur le MÊME post publié côté FR |
| Persistance reload + roaming | 4 | ✅ reload → EN (LS) ; **effacement LS → EN par adoption serveur** (contexte `fr-FR` : la détection ne peut pas expliquer l'EN) ; retour FR + serveur `fr` |
| Détection navigateur `en-US` (sans LS) | 2 | ✅ onboarding EN + `<html lang="en">` |
| Axe-core EN (≥ 90) | 3 | ✅ **100 / 100 / 100** (0 violation) |
| Pluriels EN | 2 | ✅ « 2 results » / « 1 result » |

### §2.2 Captures (`docs/proofs/assets/G/`)

| Fichier | Contenu |
|---|---|
| `fr/onboarding-fr.png`, `en/onboarding-en.png` | détection navigateur : le dialog d'onboarding dans la langue du contexte (aucun LS) |
| `fr/feed-fr.png`, `en/feed-en.png` | les 3 vues en FR puis EN (même session, bascule par le sélecteur) |
| `fr/messages-fr.png`, `en/messages-en.png` | état vide messages FR/EN |
| `fr/profile-fr.png`, `en/profile-en.png` | profil complet FR/EN — carte **Préférences** + sélecteur (« Français » / « English ») |
| `en/axe-feed-en.png`, `axe-messages-en.png`, `axe-profile-en.png` | états EXACTS audités par axe (marqueurs avant audit — leçon f258a25 appliquée) |
| `c1-reload-alice.png`, `c1-reload-bob.png` | identité + groupe MLS + conversation PRÈS reload (fix C1) |
| `debug-c1-mls-send.png`, `debug-en-messages.png` | diagnostics des itérations (captures du débogage — gardées : elles documentent la découverte des défauts §1.3) |

### §2.3 Runner rejouable (`scripts/g-i18n-proof-run.sh`)

Étapes : gate `tsc` (root + admin) → **gate i18n** (`scripts/g-i18n-gate.ts`, §3.3) → build standalone → migrations (`0012`) + seed → serveurs réels (hub :3047, app :3130, `SYBIL_BYPASS=1` + `SYBIL_BYPASS_TEST=1` — uniquement le plafond D2 3/h/IP, jamais PoW ni ECDSA) → harnais navigateur (`timeout 420`) → **P4 simule `tests.yml`** : `bun test tests/` sur DB dédiée → 247 pass / 231 skip / **0 fail** → EXIT 0.

Logs du dernier run : `/tmp/g-run-full10.log` ; verdict `results-g.json.ok = true`.

---

## §3 — Clarification 2 : licence vérifiée, choix documenté

### §3.1 Audit de licence

- Package candidat : `next-intl@4.15.1` (dist-tag latest).
- **Vérification dans le package réel** (tarball npm téléchargé, fichier `package/LICENSE` extrait et lu — pas seulement les métadonnées du registre, leçon `web-push` MPL-2.0 appliquée) : **MIT License, Copyright (c) 2024 Jan Amann** → compatible avec tout usage.

### §3.2 Décision : approche MAISON (React.Context + JSON, zéro dépendance)

La licence MIT n'excluait pas next-intl ; le choix maison est néanmoins retenu, pour quatre raisons argumentées :

1. **Posture supply-chain (D3)** : zéro nouvelle dépendance runtime à auditer — chaque paquet est un risque au-delà de sa licence (leçon web-push appliquée jusqu'au bout) ;
2. **SPA mono-route** : le routage/middleware de next-intl est du poids mort ici (aucune URL localisée) ;
3. **Le livrable G exige explicitement `Intl.DateTimeFormat` / `Intl.NumberFormat` / `Intl.PluralRules`** — l'implémentation maison les câble directement (pluriels CLDR réels via `Intl.PluralRules` du tag `fr-FR`/`en-US`, pas un mini-format maison) ;
4. **Auditabilité** : ~300 lignes de runtime 100 % relisibles pour une messagerie sécurisée.

### §3.3 Gate i18n (`scripts/g-i18n-gate.ts`) — le `grep` de preuve d'extraction

Exécuté par le runner AVANT le build (comme le gate tsc) :

1. **Parité stricte** des catalogues `locales/fr.json` / `locales/en.json` : 661 clés identiques, **placeholders `{var}` paritaires** clé par clé, zéro clé dupliquée (détection au niveau du TEXTE JSON — `JSON.parse` dédupliquerait en silence) ;
2. **Toute clé `t()`/`tp()` du code existe dans les DEUX catalogues** (une typo de clé ne peut plus passer ; clés plurielles référencées par leur base, résolues via `k.one`/`k.other`) ;
3. **28 sentinelles FR historiques → 0 occurrence** dans le CODE de `src/components/` (« Crée ton identité locale », « Nouvelle conversation », « Nouveau groupe », « Tout effacer », « Envoyer le message chiffré », « Résultats du fil public », « Préférences », etc.) — les commentaires développeur sont strippés avant comparaison (les mentions de sélecteurs harnais dans les commentaires sont légitimes).

---

## §4 — Livrables i18n

### §4.1 Runtime (`src/lib/mbote/i18n.tsx`)

- `I18nProvider` (React.Context, wrap dans `page.tsx`) — premier rendu = `fr` côté serveur ET client (zéro divergence d'hydratation) ; détection dans une microtask post-monture (règle `react-hooks/set-state-in-effect` respectée) ;
- priorité **LS `mbote_locale` > préférence serveur (choix explicite) > `navigator.languages` > `fr`** ;
- `t(key, vars)` interpolation `{nom}` ; `tp(key, count, vars)` pluriel CLDR (`Intl.PluralRules` du tag, repli `key.other`) ; `fmt` = `fmtDate` (long), `fmtDateTime`, `fmtTime`, `fmtNumber`, `fmtRelative` (`Intl.RelativeTimeFormat`) ;
- clé absente → warn + clé retournée (jamais silencieux, jamais crash) ;
- `<html lang>` toujours à jour (axe + lecteurs d'écran) ;
- `setLocale` = LS immédiat + push serveur **signé ECDSA** best effort (l'i18n n'est pas critique : un échec réseau ne casse rien) ;
- `mbote_locale` ajouté à l'état local effacé par le **panic wipe** (promesse UI tenue).

### §4.2 Persistance serveur (`/api/preferences`)

- `GET ?pubkey=…` public → `{locale, explicit}` (classe d'exposition du profil) ;
- `POST {pubkey, locale, ts, signature}` — preuve de possession ECDSA sur la chaîne canonique `` `${pubkey}|preferences|${locale}|${ts}` `` (proof.ts, même mécanique que identity) ;
- **ne crée JAMAIS de compte** (404 si inconnu — le PoW/anti-Sybil D2 reste le seul chemin de création) ; rate limit (pattern F-18) ;
- Prisma : `User.locale` (défaut `fr`) + `User.localeExplicit` (défaut `false`) — migration `20261115100000_0012_g_i18n_preferences`.

### §4.3 UI

- **Carte « Préférences »** dans `ProfileView` (entre Notifications push et Panic wipe) : Select shadcn fr/en (`data-testid="lang-select"`), libellés traduits, hint « Choix enregistré sur cet appareil et sur ton compte (roaming multi-appareils) » ;
- **extraction complète** : 17 composants (`MboteApp`, `OnboardingDialog`, `FeedView`, `Composer`, `PostCard`, `MessagesView`, `ProfileView`, `GroupsView`, `ChannelsView`, `NetworkView`, `RouteurPanel`, `CallView`, `VoiceNote`, `VideoBubble`, `BitChatBridge`, `MeshSimulation` — canvas traduit via `drawSim(translate)` —, `GlobalSearch`) — `date-fns` **éradiqué** de `src/` (0 import restant) au profit des `Intl.*` ;
- **valeurs FR byte-identiques** aux chaînes d'origine → tous les sélecteurs texte des harnais existants continuent de matcher sous locale fr.

---

## §5 — Comportements prouvés (détails)

- **Détection** : contexts Playwright `locale: "fr-FR"` / `"en-US"` sans aucun LS → onboarding dans la bonne langue + `html lang` correct, AVANT toute identité (aucune préférence serveur possible) ;
- **Switch** : sélecteur Profil → EN : `html lang`, nav (« Feed »), carte « Preferences », LS `mbote_locale=en`, serveur persiste (`GET` → `{"locale":"en","explicit":true}`) ;
- **Reload** : LS garde EN ;
- **Roaming** : LS effacé + reload dans un contexte `fr-FR` → l'app démarre FR (détection) puis bascule EN par **adoption serveur** — la détection ne pouvant pas produire l'EN dans ce contexte, la preuve est sans ambiguïté (rendu possible par le fix `localeExplicit` §1.3.3) ;
- **Dates** : tooltip `fmtDate` du PostCard « Post date GFR » comparé à `Intl.DateTimeFormat(tag, {day:"numeric",month:"long",year:"numeric"})` **calculé dans la page** (même moteur) — égalité au bit près en FR (« 15 novembre 2026 ») et EN (« November 15, 2026 ») ; relatifs : « il y a …/à l'instant/maintenant » vs « … ago/now » sur le même post ;
- **Pluriels** : 4 posts publiés (2× « ZqpunaiseA », 1× « ZqpunaiseB », tokens FTS sans préfixe partagé) → recherche → `aria-label` du badge du fil public = « 2 résultats » / « 1 résultat » (FR) et « 2 results » / « 1 result » (EN) — surfaces `tp()` réelles (le Badge garde son nombre visible, l'aria est le texte pluriel complet pour les lecteurs d'écran).

---

## §6 — Multi-appareils : timebox déclenchée, dette documentée (Clarification 3)

**STOP appliqué conformément à la directive.** Estimation honnête du portage Signal-style : **5–8 jp** (clés non-extractibles à ré-architecter, re-scellement MLS par appareil cible, canal QR + anti-QR-swap, pools de key packages multi-appareils côté serveur, preuves adversariales) — largement au-delà des 2 jp.

Ce qui est livré et garanti en V1 :
- **sessions indépendantes par appareil** (modèle identité = clés locales non-extractibles) — le harnais G fait vivre 4 identités en parallèle sans interférence ;
- **roaming des préférences roammable** : la locale suit le compte (`/api/preferences` signé + adoption `localeExplicit`) ;
- dette : `docs/SCALE-ARCHITECTURE.md §8.3` (tableau + décomposition d'estimation + jalon « G-bis ou vague dédiée, jamais en covert-change »).

---

## §7 — Dettes et écarts documentés (aucun silencieux)

| Écart | Décision |
|---|---|
| `geohash.ts` `PRECISION_LABELS` (« Bloc/Quartier/Ville/Province/Région/Pays/Précision {p} ») reste FR | module partagé utilisé par 3 vues + API — traduction différée (hors 2 jp du cœur G) ; visible dans le picker de précision et les libellés de canaux |
| Messages d'erreur SERVEUR (`describeApiError`) restent FR | mapping par code d'erreur différé — les wrappers statiques autour sont traduits |
| `admin/` (panneau) et `mobile/` restent FR | hors périmètre G (directive : 3 vues web + infra) — même architecture réutilisable |
| `<title>` SSR (`layout.tsx`) reste FR | metadata statique Next — la langue de la page elle-même (`<html lang>`) est pilotée côté client |
| lignes système MLS (« X a rejoint le groupe ») figées à la locale de génération | historique = contenu (comme les messages) — re-traduire falsifierait l'historique |
| harnais épinglés `fr` (38 contexts, 18 scripts) | la détection navigateur (CI Chromium = en-US) n'inverse plus la langue des preuves existantes ; la détection elle-même est prouvée par le harnais G (contexts `fr-FR`/`en-US`) |

## §8 — CI

- `tests.yml` : P4 simulé localement (247 pass / 231 skip / **0 fail**) — les F-16/F-17 tiennent ;
- `weekly-proof-run.yml` : **5ᵉ runner G** ajouté dans la file (D1·C2·C3·C4·G), même garde-fous Chromium (3 couches, leçon ed25110) ; glob d'artefacts passé en récursif (`docs/proofs/assets/**`) — les preuves par sous-dossiers (F/…, G/…) n'étaient pas remontées par l'ancien glob plat ;
- ⚠️ rappel push : le commit modifie `weekly-proof-run.yml` → le token fin-grained nécessaire doit porter **Workflows: Read and write** en plus de Contents (cf. protocole push G).

---

*Rapport conforme au protocole : chaque affirmation est adossée à un check du harnais (`results-g.json`), une capture (`docs/proofs/assets/G/`), un gate rejouable (`scripts/g-i18n-gate.ts`) ou un fichier de code cité. main intouché du début à la fin de la vague.*
