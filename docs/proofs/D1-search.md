# D1 — Recherche : FTS5 fil public + index DM local (preuve)

Date : 2026-11-11 · Branche : `feat/adm-mvp` · Worktree : `wt-adm`
Runner : `bash scripts/d1-search-proof-run.sh` — **exit 0** (rejouable, DEV-SETUP §2b)

## 1. Livrables → tests → preuves

| Livrable | Test | Preuve (asset) |
|---|---|---|
| Migration FTS5 `0009_d1_post_fts` (table virtuelle + 3 triggers + backfill) | sonde prérequis + T4/T5 triggers | `d1-fts5-probe.txt`, `d1-migrate.txt`, `d1-test-output.txt` |
| `GET /api/search?q=&type=posts&limit=&offset=` (FTS5 MATCH, snippet≈60 car., rank bm25, authorPubkey/nickname, pagination offset, rate limit 30/min/IP, garde `type=dms`→400) | T1, T2, T3, T7, T8, T9 | `d1-test-output.txt` — **9 pass / 0 fail** |
| `GET /api/posts/[id]` (fetch isolé pour navigation, mêmes filtres de visibilité que le fil) | consommé par B3 (navigation hors page 1) | `d1-browser.json` `publicNavigation: true` |
| Index DM local IndexedDB `mbote-dm-search` (`dm-search-index.ts` : rebuild par conversation, prune boot, normalisation diacritiques, snippet 60, PANIC-WIPE branché) | preuve navigateur B5 + grep structure | `d1-browser.json` `dmHits: 1`, `d1-grep-frontiere-dm.txt` |
| UI GlobalSearch (Dialog, 2 sections « Fil public » / « Messages privés », debounce 250 ms, état vide) | B2, B5, B7 | `d1-search-public.png`, `d1-search-dm.png`, `d1-search-empty.png` |
| Navigation : clic post → feed + carte « Résultat de recherche » (fetch isolé) ; clic DM → conversation + message flashé (ring 2.5 s) | B3, B5 | `d1-search-open-post.png`, `d1-search-dm-focus.png` |

## 2. Résultats de test (extraits)

- **T1** hit `kinshasa` → payload complet (postId, snippet ≤ 65 car., rank bm25, authorPubkey, authorNickname). 
- **T2** diacritiques : requête `ecole` → post « L'école communautaire… » trouvé (`unicode61 remove_diacritics 2`).
- **T3** FRONTIÈRE DM : le DM piège au ciphertext contenant **littéralement** `secret` (seed) → `q=secret&type=posts` → **0 résultat** ; `type=dms` → **400** (« la recherche des messages privés est locale à l'appareil »). Un `LIKE` naïf sur la DB trouverait le piège (sanity check 1 ligne) — la frontière est structurelle : le serveur ne recherche jamais les DM.
- **T4/T5** triggers : `hiddenAt` posé → ligne **retirée de PostFTS** (SELECT count = 0) + introuvable via l'API ; post supprimé → idem. Un post masqué n'est pas recherchable même en contournant l'API.
- **T6** auteur suspendu : présent DANS l'index (suspension réversible — migration 0009 §modèle) mais **introuvable via l'API** (filtre lecture, même sémantique que le fil public).
- **T7** pagination : `limit=2` → `hasMore:true, nextOffset:2` ; page 2 **DISTINCTE** ; dernière page `hasMore:false`.
- **T9** rate limit : bucket 30/min/IP épuisé → requête suivante **429 + Retry-After**.

## 3. Benchmark (directive : 10k posts < 200 ms)

```
[benchmark FTS 10k] runs=15.3, 15.6, 14.7, 14.5, 14.4 ms — avg=14.9 ms max=15.6 ms
[benchmark HTTP]    round-trip=20.3 ms
```
10 010 posts indexés (`postFTS: 10010` — seed). Recherche complète (MATCH + JOIN + snippet + bm25 + tri) ≈ **15 ms** — 13× sous le budget.

## 4. Preuve navigateur (Chromium réel, build prod :3163)

`d1-browser.json` : `ok: true` — onboarding réel → recherche publique (1 hit) → clic → carte « Résultat de recherche » → DM E2EE réel envoyé à Bob (clé seedée) → recherche locale `secrete` (sans accent) → 1 hit DM → clic → **message flashé** (`[data-message-id].ring-2`) → état vide OK.

**Frontière réseau mesurée en direct** (`page.on('request')`) : 3 requêtes `/api/search` émises, **toutes `type=posts`, 0 violation** — la recherche DM n'émet RIEN vers le serveur.

## 5. Preuves grep (frontière DM)

`d1-grep-frontiere-dm.txt` : 0 occurrence de `fetch(`/`XMLHttpRequest`/`WebSocket`/`axios` dans `dm-search-index.ts` ; la section DM de `GlobalSearch.tsx` n'utilise QUE `searchLocalDm` ; garde serveur `type !== "posts"` → 400 (route.ts:68).

## 6. Bugs réels attrapés pendant la preuve

1. **« Nouvelle conversation » muet depuis l'état vide** (MessagesView) : l'état vide faisait un early-return SANS le Dialog « Choisir un contact » — le bouton posait le state mais rien ne s'ouvrait (premier contact impossible). FIX : Dialog hoisté en variable, rendu dans les DEUX branches. Constat : `MessagesView.tsx` §FIX (commentaire in situ) ; validé par B4 (le flow navigateur passe désormais).
2. **Placeholders « indéchiffrable » indexés** : le text du placeholder alimentait l'index DM (bruit de recherche). FIX : constante `UNDECRYPTABLE` exclue de l'index (`replaceDmConversation` ignore les textes vides).
3. **Anomalie d'environnement** (constat process, pas de code) : au recréage du worktree `wt-adm` (répertoire disparu, recréé via `git worktree add`), la working tree a été peuplée avec le contenu b1 (10 fichiers modifiés + résidus non suivis B1/B2/B3/B4/C1) au lieu de l'arbre propre de `feat/adm-mvp`. Nettoyage chirurgical (`git restore` des 13 fichiers + `git clean` exclusif) — état final vérifié : seuls les fichiers D1 diffèrent. MessagesView ré-appliqué sur la baseline adm (la version disque était la b1 : imports `media-client`/`VoiceNote`/`VideoBubble`).

## 7. check-merge-clean (fin de vague — Clarification 2)

Premier run (arbre propre, pré-commit D1) : **3 conflits** (`bun.lock`, `docker-compose.yml`, `docs/DEV-SETUP.md`) — ≤ 3, règle §8.1 NON déclenchée (résolution planifiée à la fusion, pas de blocage). Asset régénéré post-commit : `d1-merge-clean.txt`.

## 8. NON TESTÉ (explicite)

- **Recherche CJK / écritures non latines** : `unicode61` segmente mal le chinois/japonais/coréen (tokenizer trigram non livré) — Lingala/French/Swahili (script latin) couverts.
- **Recherche dans les pièces jointes** (texte d'images/notes vocales) : hors périmètre D1.
- **Recherche des groupes** : C4 (MLS) — les groupes n'existent pas encore.
- **QPS élevé / charge concurrente sur /api/search** : palier 1 (SQLite mono-conteneur) — le rate limit 30/min/IP borne la surface ; charge type Étape 10 non rejouée sur cette route.
- **Prefix search / fuzzy** (`kin*`, corrections) : non livré — termes exacts normalisés uniquement (documenté : `toFtsQuery` = ET implicite sur termes quotés).
- **Mobile Safari / Firefox IndexedDB** : preuve navigateur sur Chromium uniquement (classe dépendance externe).
