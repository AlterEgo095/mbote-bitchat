# RAPPORT DE PREUVE — A2 AUTHENTIFICATION DE CLÉS (recadrage, phase A2)

**Branche** : `feat/a2-key-auth` (construite SUR `feat/a1-anti-replay`) · **Statut** : en attente de validation
**Références** : crypto spec — lacunes **L-2** (pas d'authentification de clés) et **L-3** (substitution de clé par le serveur) — A2 ferme les deux · Algorithme : `docs/SAFETY-NUMBER-SPEC.md` (référence Signal, documenté AVANT implémentation).

---

## 1. Ce qui a été fait

**Menace fermée (L-3)** : le serveur pouvait servir n'importe quelle `ecdhPub` pour un pair → MITM des DM **sans détectabilité**. Maintenant : toute divergence entre la clé épinglée et la clé servie déclenche une **alerte rouge bloquante** (envoi E2EE suspendu jusqu'à re-vérification hors-bande du nouveau numéro).

**Composants livrés** :

| Composant | Fichier | Rôle |
|---|---|---|
| Numéro de sécurité 60 chiffres | `src/lib/mbote/safety-number.ts` (isomorphe) | SHA-512 itéré 5200× sur les **4 clés** (identité + ECDH des deux parties) — spec Signal documentée dans `docs/SAFETY-NUMBER-SPEC.md` |
| Épinglage LOCAL par appareil | `src/lib/mbote/trust-client.ts` | **Indépendant du serveur** : détecte toute rotation vue par cet appareil, même si le serveur est compromis et silencieux |
| Registre serveur (audit + inter-appareils) | `TrustedKey` (Prisma) + `src/lib/mbote/trust.ts` | état `unverified → verified → changed` persistant ; re-déclenchement automatique à chaque nouvelle divergence |
| Endpoints authentifiés | `GET /api/trust`, `POST /api/trust/verify` | preuve de possession signée obligatoire (`trust`/`trust-verify` dans `proof.ts`) ; le numéro confirmé est **lié à la signature** (audit : quel numéro, quand, par qui) |
| UI DM minimale | `MessagesView.tsx` | bannière jaune (premier contact, non bloquant) · dialogue du numéro (12×5 chiffres) · **bannière rouge + input bloqué** · flux « J'ai comparé en présentiel — Sceller » |

**Découpage des responsabilités (modèle Signal, assumé)** : l'épinglage local protège contre la rotation silencieuse vue par l'appareil ; le registre serveur assure l'audit et la détection inter-appareils ; contre un serveur pleinement malveillant qui servirait des clés différentes à chaque partie, seul le comparage hors-bande des 60 chiffres fait foi — c'est exactement le modèle de confiance Signal, documenté §5 de la spec.

## 2. Ce qui a été testé — PASS/FAIL par scénario

### Propriétés du fingerprint — `bun test tests/safety-number.test.ts` → 6/6 PASS

| # | Propriété | Résultat |
|---|---|---|
| 1 | Déterminisme (mêmes entrées → même numéro) | PASS |
| 2 | **Symétrie** (A,B) = (B,A) — les deux côtés affichent l'identique | PASS |
| 3 | **Avalanche** : 1 bit modifié → numéro différent ; substitution d'ecdhPub (attaque L-3) → > 9 groupes sur 12 changent | PASS |
| 4 | Format : 12 groupes de 5 chiffres = 60 chiffres | PASS |
| 5 | Performance : 5200 itérations SHA-512 < 2 s (usable UI) | PASS (≈ 0,16–0,4 s) |
| 6 | Clés malformées → erreur (jamais de numéro silencieusement faux) | PASS |

### Flux de confiance — `bun test tests/trust-flows.test.ts` → 4/4 PASS (Prisma + SQLite fichier temporaire)

| # | Scénario exigé | Résultat |
|---|---|---|
| T0 | Premier contact → `unverified`/jaune, épinglage initial, idempotent | PASS |
| T1 | **Substitution au premier contact** → deux numéros différents = détectable | PASS |
| T2 | **Substitution APRÈS établissement** → `changed` + niveau **rouge bloquant**, alerte persistante | PASS |
| T3 | **Nouvel appareil légitime** → publication de la nouvelle clé → re-vérification → `verified`/vert avec la nouvelle clé épinglée ; une nouvelle substitution re-déclenche le rouge | PASS |

### E2E API réel — `bun tests/trust-e2e.ts` → 7/7 PASS (serveur dev vivant)

| # | Scénario | Résultat |
|---|---|---|
| S1 | 2 identités ECDSA réelles | PASS |
| S2 | Premier contact : `unverified`/yellow + numéro 60 chiffres | PASS |
| S3 | Rotation d'`ecdhPub` **re-signée par le pair** (nouvel appareil ou attaque — le protocole ne les distingue pas, la vérification hors-bande tranche) → `changed` + `keyChanged` | PASS |
| S4 | Re-vérification avec le NOUVEAU numéro → `verified`/green ; nouvelle rotation → rouge re-déclenché | PASS |
| S5 | Preuve invalide → **401** (aucun état de confiance sans clé) | PASS |

### Preuve UI (capture d'écran, agent-browser — `docs/proofs/assets/`)

| Étape | Preuve | Vérification programmatique |
|---|---|---|
| Premier contact | `a2-yellow-first-contact.png` — bannière jaune « numéro non vérifié » | bannière présente |
| Numéro de sécurité | `a2-dialog-safety-number.png` — 60 chiffres en 12 groupes | format vérifié |
| **Substitution** | `a2-red-key-change.png` — bannière rouge « Clé de chiffrement changée — envoi bloqué » | `ALERTE ROUGE PRÉSENTE` + `INPUT BLOQUÉ` |
| **Re-vérification** | `a2-green-after-reverify.png` — retour au vert après « Sceller » | `INPUT DÉBLOQUÉ` |

Méthode : identité réelle créée dans l'app (onboarding), conversation avec le bot de démo, rotation de l'`ecdhPub` du bot directement en DB (simulation de substitution), rechargement → alerte rouge ; re-vérification via le dialogue → déblocage.

### Portefeuille qualité (l'ensemble des tests du repo)
- `bun test tests/` → **23 pass / 0 fail** (13 A1 + 10 A2) · `bunx tsc --noEmit` **OK** · `bun run lint` **OK** · parité protocole **OK**.

## 3. Commandes exactes de reproduction

```bash
# 1. propriétés du numéro de sécurité
bun test tests/safety-number.test.ts

# 2. flux de confiance (premier contact / substitution / re-vérification)
bun test tests/trust-flows.test.ts

# 3. E2E API réel (serveur dev sur :3000 requis)
bun tests/trust-e2e.ts

# 4. portefeuille complet
bun test tests/ && bunx tsc --noEmit && bun run lint && bun scripts/check-protocol-parity.ts
```

## 4. Ce qui n'a PAS été testé — et pourquoi

- **QR scan caméra** (vérification en présentiel par scan mutuel) : exige une lib QR + caméra → Bloc 2 phase F. Le canal numérique hors-bande (60 chiffres de vive voix, cas d'usage mesh/terrain prioritaire) est livré et testé.
- **Test adversarial avec un FAUX serveur** qui servirait deux `ecdhPub` différentes à Alice et Bob : le scénario est couvert *au niveau du design* (les numéros diffèrent → détecté par comparaison hors-bande ; testé T1 par la divergence des numéros). Le test bout-en-bout avec un serveur réellement malveillant viendra avec le protocole de tests adversariaux globaux (A5).
- **Multi-appareils** : la synchronisation de l'épinglage entre appareils d'un même compte est explicitement hors périmètre A2 (modèle Signal : chaque appareil épingle localement) — traitée au Bloc 2 phase G (portage de clés).
- **Safire de 5200 itérations sur appareils très bas de gamme** : mesuré < 0,4 s sous Bun ; mesure sur mobile bas de gamme à faire à la vague mobile (critère < 2 s maintenu).

## 5. Points à noter pour la validation

1. **Le verrou demandé est en place** : « bloquant pour tout média E2EE » — le niveau rouge bloque l'envoi de TOUT message DM (plus fort que les seuls médias), et A1/A2 sont les deux prérequis déclarés du verrou médias.
2. **Numérotation** : A2 (recadrage, « crypto ④ ») = lacunes **L-2 + L-3** de la crypto spec.
3. **Le pseudo du pair change à la rotation d'identité** (upsert identity) — sans impact sur la confiance (l'identité stable = la clé publique, pas le pseudo).

---

## 6. Trace d'incident — « superviseur » (exigée pour la validation A1/A2)

*Section ajoutée à la validation (demande explicite : « un auditeur externe doit pouvoir trouver cette trace sans fouiller l'historique »). Faits issus des reflogs locaux, re-jouables.*

**Que s'est-il passé** : pendant la livraison A1/A2, l'environnement d'exécution (le « superviseur » — le driver de sandbox qui héberge l'agent) **rétablit de force le checkout sur `main` entre deux tours d'outils de l'agent**. Les commits de phase ont donc atterri directement sur `main` au lieu des branches de phase : `main` a été déplacé hors de `7b51fd5` à deux reprises (« main forcé 2× »), plus un correctif CI dans la même manœuvre.

**SHAs concernés** (reflog local `main`, transitoires) :

| Reflog | SHA | Contenu |
|---|---|---|
| `main@{3}` | `2994060` | commit A1 anti-replay — posé sur main par erreur |
| `main@{2}` | `652c5b0` | commit A2 key-auth — posé sur main par erreur |
| `main@{1}` | `05b06bc` | fix a2-ci (cwd trust-flows) — posé sur main par erreur |
| `main@{0}` | `7b51fd5` | **restauration** : main réinitialisé à l'état validé |

**Remédiation** : `main` réinitialisé à `7b51fd5` ; le travail recréé sur les branches de phase — `feat/a1-anti-replay` = `2994060` + fix CI `441c927` ; `feat/a2-key-auth` = `0c7d4c3` (rebasé sur `441c927`, équivalent de `652c5b0` + fix cwd `05b06bc`).

**Vérification finale — re-jouable** :

```bash
git rev-parse main origin/main          # → 7b51fd5… = 7b51fd5… (identiques)
git log --oneline main..feat/a2-key-auth      # 3 commits : A1 + fix CI A1 + A2
git diff 652c5b0 0c7d4c3 --stat         # uniquement les 2 correctifs cwd des tests
git reflog show origin/main             # aucun rewind : fast-forwards + push recadrage seulement
```

**Portée de l'incident** : strictement LOCAL. `origin/main` n'a **jamais** été réécrit (le reflog de la ref distante ne montre que des fast-forwards et le push du recadrage `7b51fd5`) ; aucun historique public n'a été altéré. Note : `feat/a2-key-auth` a, elle, nécessité des poussées non fast-forward (rebases internes à la branche : `652c5b0` → `eb7995e` → … → `0c7d4c3`) — visibles dans son reflog, sans impact sur `main`.

**Mesure corrective durable** : le travail de phase se fait désormais dans des **worktrees git externes** (`git worktree add`), hors de portée du reset du superviseur — pattern documenté dans `docs/DEV-SETUP.md`.

---

## 7. Clarification — comportement exact en état rouge (exigée avant A3)

*Clarification DEMANDÉE à la validation (« sans re-tester ») — consolidée du code livré et des preuves UI existantes de ce rapport.*

| Action en état rouge | Comportement exact | Source de preuve |
|---|---|---|
| Message **SORTANT** | **Bloqué** — input + bouton d'envoi désactivés (`trustBlocked = trust?.level === "red"`, appliqué aux deux) ; l'outbox n'est pas alimentée en état rouge | capture `a2-red-key-change.png` (`INPUT BLOQUÉ` vérifié programmatiquement) — reconfirmé à la validation |
| Message **ENTRANT** | **Affiché** — la liste DM ne filtre rien selon la confiance : côté client, `MessagesView.tsx` rend tous les messages et les déchiffre sans condition de niveau ; côté serveur, `GET /api/dms` ne consulte pas l'état de confiance. **L'utilisateur voit le trafic suspect** et peut réagir | revue de code à la validation (`MessagesView.tsx` : rendu de liste + effet de déchiffrement ; `src/app/api/dms/route.ts` : aucun filtre de confiance) |
| **Bannière rouge** | Permanente (`role="alert"`) en tête de conversation, avec bouton **« Re-vérifier le numéro de sécurité »** → dialogue de scellement : le flux de re-vérification est disponible **à tout moment**, sans quitter la conversation | capture `a2-red-key-change.png` (`ALERTE ROUGE PRÉSENTE`) |
| Déchiffrement en état rouge | Le déchiffrement utilise la clé **courante** servie : un message chiffré avec la NOUVELLE clé s'affiche en clair ; une enveloppe chiffrée avec l'ANCIENNE clé épinglée s'affiche « 🔒 Enveloppe indéchiffrable » — **visible elle aussi** (jamais masquée) | `MessagesView.tsx` (fallback `catch` du déchiffrement) |

**Conclusion** : la réception n'est **pas** bloquée en état rouge — l'exigence (« l'utilisateur doit voir qu'il reçoit quelque chose de suspect pour déclencher la re-vérification ») est satisfaite par le comportement livré. **Aucun correctif requis avant A3.**
