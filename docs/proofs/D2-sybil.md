# D2 — SYBIL PHASE 0 : preuve de travail + réputation + plafonds de débit

**Directive** : 2026-11-13 (vague D2+D3, worktree wt-adm sur feat/mbote-v1) · **Statut** : VERT
**Runner rejouable** : `bash scripts/d2-sybil-proof-run.sh` (exit 0) · **Port de preuve** : 3165
**Matrice de référence** : `docs/SYBIL-RESISTANCE-MATRIX.md` phase 0 (L3)

---

## 1. Livrables → implémentés

| Livrable (directive) | Implémentation | Fichier |
|---|---|---|
| PoW SHA-256 itéré, 20 bits, WebCrypto en Web Worker (non bloquant) | `POW_DIFFICULTY_BITS = 20`, worker autonome `public/pow-worker.js` (progression toutes les 4 096 itérations) | `src/lib/mbote/sybil.ts` · `src/lib/mbote/pow-client.ts` · `public/pow-worker.js` |
| Vérification serveur au POST /api/identity + anti-rejeu (nonce stocké) | `verifyPowServer` (node:crypto, difficulté décidée par le SERVEUR) + consommation **globale** `PowSpent` (PK challenge) DANS la transaction d'upsert — un échec réseau ne brûle pas le PoW (tolérance RDC) | `src/app/api/identity/route.ts` · `src/lib/mbote/sybil-server.ts` |
| Ne bloque pas T0 hors-ligne | PoW exigé UNIQUEMENT à la création serveur ; l'onboarding local reste instantané, le worker ne bloque jamais l'UI, la file courrier/outbox rejoue le payload tel quel (pas de fenêtre de fraîcheur) ; **le bridge mesh n'importe aucun module Sybil** (test M1 + grep) | grep §6 + `tests/d2-sybil.test.ts` M1 |
| Réputation : +1/post > 24 h sans report · +2/like reçu · +1/follow reçu · −5/report confirmé (hide/ban) | Sweep **paresseux** (pattern É6, pas de cron) aux points d'application ; like/follow crédités dans la transaction (FollowCredit = crédit UNIQUE par paire, l'aller-retour follow/unfollow ne farme pas) ; hide → −5 SI report(s) actionné(s) ; ban four-eyes → −5 | `sweepPostReputation` · `posts/like` · `follows` · `moderation/action` · `pending-action.ts` |
| Plafonds débit : <0 → 3/10 · 0-9 → 10/50 · 10-99 → 50/200 · ≥100 → 200/∞ | `dailyLimits` (pur, testé exhaustivement) + compteurs dénormalisés `postsToday/dmsToday/usageDay`, reset paresseux à minuit UTC, incrément dans la transaction du post/DM | `src/lib/mbote/sybil.ts` · `posts/route.ts` · `dms/route.ts` |
| Rate-limit durci /api/identity : 3 créations/h/IP | `identity-create-ip` 3/3 600 000 ms, incrémenté AVANT toute crypto (fail-closed, leçon V4) ; les mises à jour d'identité existante restent hors plafond horaire | `src/app/api/identity/route.ts` |
| UI onboarding : progression PoW visible | Bloc « Préparation du compte… X% » (barre + pourcentage + explication), le dialogue reste ouvert pendant le calcul | `OnboardingDialog.tsx` · `MboteApp.tsx` |
| UI profil : badge réputation + compteurs restants | Badge 4 tiers (à reconstruire/neutre/établie/exemplaire) + « 9/10 posts restants aujourd'hui · 50/50 DMs » | `ProfileView.tsx` · `dto.ts` (quota DTO) |
| Message clair si plafond atteint | Message serveur exact « Vous avez atteint votre limite de posts pour aujourd'hui. Le score de réputation augmente avec la participation de qualité. » — toasté tel quel par le Composer (bug historique : erreurs muettes) | `Composer.tsx` (toast serveur) |

## 2. Tests — `tests/d2-sybil.test.ts` (15/15 VERTS, serveur réel :3165)

```
 15 pass · 0 fail · 77 expect() calls — bun test tests/d2-sybil.test.ts (APP_URL=:3165)
```

- **P1** création valide (PoW 20 bits réel calculé en bun) → 200, quota exposé (posts.limit 10)
- **P2** création SANS nonce → 403 `pow_required`
- **P3** nonce invalide → 403 + compte jamais créé (vérifié en DB)
- **P4** nonce REJOUÉ (même challenge) → 409 `pow_replayed` (anti-rejeu global PowSpent, y compris sur le chemin update)
- **Q2** score −5 : plafond 3/j → 3 posts OK, 4ᵉ → 429 `quota_posts` (limit 3) ; GET identity → tier `negative`
- **Q1** score 0 : compte neuf → 10 posts OK, 11ᵉ → 429 (limit 10, used 10) + **message directive exact**
- **Q3** score 15 : GET identity → posts.limit 50 · dms.limit 200 · tier `established`
- **Q4** DMs score −5 : 10 OK (dm2 seq monotone), 11ᵉ → 429 `quota_dms` (limit 10)
- **R1** 4ᵉ création/heure/IP → 429 `identity_create_rate_limited` + **Retry-After ≥ 3590 s**
- **M1** **T0 mesh** : clé JAMAIS onboardée publie via la passerelle (paquets fragmentés > 452 o, réassemblés) → post visible dans le fil `origin:"mesh"`, sans PoW ni plafond
- **F1a-e** fonctions pures : matrice `dailyLimits` complète (5 paliers), reset jour UTC + Retry-After jusqu'à minuit (14 h exactes), `hashMeetsDifficultyHex` (cas limites + vérification croisée avec le solveur), `reputationTier`, `utcDay` borne UTC

## 3. Preuve navigateur (réelle, `scripts/d2-browser-proof.ts`)

| Vérin | Résultat |
|---|---|
| E1 PoW VISIBLE pendant le calcul | « Préparation du compte… **4%** » capturé en plein calcul (`d2-pow-onboarding.png`) — barre + explication utilisateur |
| E2 bench PoW réel (worker, WebCrypto) | **2 973 ms / 400 535 itérations / ~134 700 hash/s** — `d2-pow-bench.json` |
| E3 profil | badge « Réputation neutre » + « **9/10 posts restants aujourd'hui · 50/50 DMs** » (`d2-profile-reputation.png`) |
| E4 publication UI | post publié, compteur décrémenté (10 → 9 restants) |
| E5 plafond atteint | compteur seedé à 10/10 → 429 → toast « Vous avez atteint votre limite de posts pour aujourd'hui… » affiché, le texte reste dans le composer (`d2-quota-reached.png`) — au premier plan on voit aussi le post **mesh-only sans PoW** du test M1 |
| E6 DTO | `GET /api/identity` → quota complet (score, tier, posts, dms) |

## 4. Benchmarks et prérequis (`d2-prereq-probe.json`)

- Sonde WebCrypto/Worker : **pass=true** (SHA-256 itéré + Worker en contexte sécurisé).
- PoW 20 bits sur le sandbox : **649 ms – 7 874 ms selon la charge de l'hôte** (fourchette observée entre exécutions) — compatible budget directive (~2-5 s mobile bas de gamme) ; la mesure navigateur la plus représentative est **2 973 ms** (§3).
- **Limitation documentée** : `CDP Emulation.setCPUThrottlingRate` ne s'applique PAS aux threads de Web Worker — la mesure « ×4 » ci-dessous est donc non représentative (649 ms, machine libre). Le bench réel sur device Android bas de gamme reste à faire.
- **NON TESTÉ** (directive) : adversaires distribuant le PoW sur 1 000 machines (coût économique — à mesurer en prod), PoW GPU/SIMD (adversaire optimisé), retry automatique si plafond atteint.

## 5. Bugs réels découverts pendant la preuve (leçon §7 : le harnais ne suffit pas)

1. **P2028 « Transaction already closed » (500)** — `commitUsageIncrement` était appelé SANS le client `tx` dans la transaction posts : l'écriture globale concurrente à `BEGIN IMMEDIATE` (SQLite, un seul écrivain) bloquait jusqu'au timeout 5 s. Fix : passer `tx` partout (le DM le faisait déjà). **Invisible aux tests de fonctions pures — attrapé par le harnais serveur réel.**
2. **Rejeu PoW invisible sur le chemin update** — rejouer une création sur un utilisateur existant passait par la branche update et réussissait ; ajout du pré-check `PowSpent` pour tout payload portant un PoW (directive : « nonce rejoué → refusé »).
3. **dm2 seq non monotone (409)** — le harnais envoyait `seq:0` à chaque DM : le compteur de séquence A1 refuse la répétition ; le test envoie désormais une séquence croissante.
4. **Rate-limit 12/min/clé masquait le plafond** — cumuler les tests de plafond sur le même compte déclenchait le 429 minute au lieu du 429 quota (messages différents) ; tests réordonnés + compte dédié, sous la fenêtre minute.
5. **CDP throttling × worker** (§4) — limitation d'outil documentée au lieu d'un chiffre trompeur.

## 6. Invariants greps (`d2-greps.txt`)

- PoW exigé à la création : `verifyPowServer` + `pow_required` présents dans `identity/route.ts`
- Anti-rejeu global : table `PowSpent` (schéma + route)
- Plafonds branchés : `quotaVerdict` + messages directive dans `posts/route.ts` et `dms/route.ts`
- **T0 préservé : 0 référence Sybil dans `mesh/bridge/route.ts`** — la passerelle mesh ne subit ni PoW ni plafond
- Migration `20261113100000_0011_d2_sybil` : 6 colonnes User + `Post.reputationRewarded` + `PowSpent` + `FollowCredit`

## 7. Consolidation (fin de vague)

Sortie RÉELLE de `bash scripts/check-merge-clean.sh` après commit (arbre propre, exit 0) :

```
── check-merge-clean ──────────────────────────────────────────────
branche courante : feat/mbote-v1
INVARIANT OK : archive/b1-media-foundation ⊆ feat/mbote-v1 (commits b1 hors mbote-v1 : 0)
branches de travail actives : 1 (feat/mbote-v1 )
RÉSULTAT : branche unique — 0 conflit PAR CONSTRUCTION (plus de merge à répétition).
main a 2 commit(s) exclusif(s) — vérification des 732 fichiers de main...
fichiers partagés main ↔ feat/mbote-v1 (hors artefacts générés) : 244
INVARIANT OK : main ⊆ feat/mbote-v1 — 0 divergence sur les fichiers partagés.
CHECK_EXIT=0
```

Runner final : `RUNNER_EXIT=0` (`bash scripts/d2-sybil-proof-run.sh` rejoué après commit —
tests 15/15, preuve navigateur, greps, tsc+lint ; assets régénérés figés par amend).

## 8. Discipline

- Commit propre sur feat/mbote-v1 (wt-adm), aucune poussée main.
- Runner rejouable exit 0 : `bash scripts/d2-sybil-proof-run.sh`.
- `bunx tsc --noEmit` + `bun run lint` verts (étape 8 du runner).
