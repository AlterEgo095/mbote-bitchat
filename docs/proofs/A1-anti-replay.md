# RAPPORT DE PREUVE — A1 ANTI-REJEU DM (recadrage, phase A1)

**Branche** : `feat/a1-anti-replay` · **Statut** : en attente de validation · **Base** : `main` = `7b51fd5`
**Références** : crypto spec `docs/CRYPTO-SPEC-v1.md` (lacunes L-4, L-5, OD-6) · mapping de numérotation : A1 (recadrage, étiqueté « crypto ③ ») = **lacune L-4 de la crypto spec** ; l'essentiel est le contenu, pas le numéro.

---

## 1. Ce qui a été fait

**Menace fermée** : la preuve de possession DM est tolérée 7 j (tolérance offline). Une enveloppe capturée était rejouable pendant 7 jours — via `/api/dms` verbatim, ou via le pont mesh en **ré-emballant** le même DM dans un nouveau paquet (la dédup par octets de paquet ne voit que le transport).

**Trois barrières indépendantes** (`src/lib/mbote/anti-replay.ts`) :
1. **Garde persistante** `ReplayGuard` : SHA-256 du tuple canonique `sender|recipient|iv|ciphertext` — **liée au PAYLOAD**, pas aux octets de transport. TTL 7 j (= fenêtre maximale de validité d'une preuve). Un ré-emballage (nouveau paquet, msgId/seq forgés) reste un doublon.
2. **Compteurs monotones** `ReplayCounter` : séquence strictement croissante par (conversation, époque) — mais seulement quand la `seq` est **couverte par la signature `dm2`** (`sender|dm2|recipient|msgId|seq|iv|ciphertext|ts`). Sur le pont (événements non signés), la seq n'est PAS opposable — l'imposer permettrait à un tiers d'empoisonner le compteur (DoS) ; décision de conception documentée dans le code.
3. **Époques de 6 h** : rotation naturelle des compteurs ; `ts` hors fenêtre (> 7 j ancien, > 60 s futur) → rejet avant toute écriture.

**Propriété transactionnelle** : `/api/dms` écrit la garde + le message dans UNE transaction — un rejeu ne double-livre jamais, un message accepté ne se perd jamais (le refus annule tout par rollback). Le flush d'outbox (rejeu légitime) devient **idempotent** : 409 `duplicate` = succès côté client (`MboteApp.tsx`).

**Remplacement FNV-64 (L-5, partiel assumé)** : `dedupFingerprint()` = SHA-256 tronquée 128 bits via WebCrypto, livrée dans les DEUX miroirs (`src/lib/mbote/bitchat-protocol.ts` + `mobile/src/core/bitchat-protocol.ts`), parité étendue (égalité + avalanche). Le FNV-64 subsiste pour les usages NON-sécurité (fragId, affichage) et comme repli documenté hôtes sans WebCrypto ; la migration des appelants mobiles synchrones (MeshTransport/Hermes) reste à la vague mobile.

**Schéma** : `ReplayGuard` (+ index expiresAt), `ReplayCounter` (+ index epoch), `DirectMessage.msgId/seq` (nullable — legacy préservé), commentaire `MeshIngest` corrigé (il décrivait encore FNV-64 alors que F-30 a livré SHA-256).

**Client** : `dm-sequence.ts` (seq monotone persistée par conversation, msgId uuid) ; `MessagesView.tsx` signe `dm2` ; le même payload sert en ligne ET dans l'outbox.

## 2. Ce qui a été testé — PASS/FAIL par scénario

### Harness unitaire + persistance — `bun test tests/anti-replay.test.ts` → **13 pass / 0 fail**

| # | Scénario adversarial | Résultat |
|---|---|---|
| 1 | Rejeu à 1 s | PASS → `duplicate` |
| 2 | Rejeu à 1 h | PASS → `duplicate` |
| 3 | Rejeu à 24 h | PASS → `duplicate` |
| 4 | **Rejeu après redémarrage** (disconnect → nouveau client → même fichier SQLite) | PASS → `duplicate` |
| 4b | Atomicité : refus en transaction → rollback intégral (garde absente en DB) | PASS |
| 5 | Compteur manipulé : seq égale / inférieure | PASS → `seq_regression` ; seq croissante acceptée (trous légitimes) |
| 6 | **Ré-emballage hostile** : même payload, msgId/seq forgés | PASS → `duplicate` |
| 7 | Nouvelle époque (+7 h) : compteur neuf | PASS |
| 8 | Fenêtres : > 7 j / futur > 60 s / ts invalide | PASS → `stale` |
| 9 | Purge : gardes expirées partent, vivantes restent | PASS |
| 10 | Enveloppe legacy (sans msgId) : acceptée, rejeu → `duplicate` | PASS |
| + | Déterminisme garde/compteur (directions et époques séparées) | PASS |
| + | Contrat commun Memory/Prisma (mêmes verdicts) | PASS |

### E2E sur API réelle — `bun tests/anti-replay-e2e.ts` → **10/10 PASS**

| # | Scénario (serveur dev vivant) | Résultat |
|---|---|---|
| S1 | 2 identités ECDSA réelles enregistrées | PASS |
| S2 | DM v2 accepté (200) | PASS |
| S3 | Rejeu verbatim +1 s → **409 duplicate** | PASS |
| S4 | **Ré-emballage hostile** : même (iv, ciphertext), NOUVEAU msgId+seq **re-signés avec la vraie clé** → 409 duplicate | PASS |
| S5 | seq=2 accepté ; régression seq=1 → **409 seq_regression** | PASS |
| S6 | Enveloppe legacy acceptée ; rejeu → 409 duplicate | PASS |
| S7 | Preuve de 8 jours → 401 (fraîcheur preuve avant la garde) | PASS |
| S8 | Pont mesh : ré-emballage en 2 paquets D'OCTETS DIFFÉRENTS → 1er `accepted`, 2e `duplicate` (« anti-rejeu ») | PASS |

### Portefeuille qualité
- `bunx tsc --noEmit` → **OK** · `bun run lint` → **OK** · `bun scripts/check-protocol-parity.ts` → **OK** (13 assertions, dont 2 nouvelles pour l'empreinte cryptographique).

## 3. Commandes exactes de reproduction

```bash
# 1. harness adversarial (unitaire + persistance SQLite fichier temporaire)
bun test tests/anti-replay.test.ts

# 2. E2E contre l'API réelle (serveur dev sur :3000 requis)
bun tests/anti-replay-e2e.ts

# 3. portefeuille qualité
bunx tsc --noEmit && bun run lint && bun scripts/check-protocol-parity.ts
```

## 4. Ce qui n'a PAS été testé — et pourquoi

- **Rejeu depuis un second process VRAIMENT concurrent** (2 processes Next sur la même DB) : le test simule le redémarrage par déconnexion/reconnexion du client sur le même fichier SQLite — l'atomicité repose sur l'unicité SQLite (P2002), vérifiée ; un test multi-process apporterait peu et coûterait cher en flakiness CI.
- **Client mobile natif** : la migration des appelants `MeshTransport` vers `dedupFingerprint` (contrainte Hermes : WebCrypto asynchrone) est reportée à la vague mobile, documentée dans la crypto spec (OD-6). Le miroir du protocole est déjà à jour + parité verrouillée.
- **Charge** : le coût de la garde = 2 requêtes indexées par DM ; un benchmark type `tests/load-bridge.ts` dédié DM viendra avec A5 (tests systématiques), pas en A1.
- **Navigation manuelle du chat** : la phase A1 est backend pur ; la non-régression du flux DM existant est couverte par l'E2E API + tsc. Une vérification visuelle suivra avec A2 (qui ajoute une surface UI minimale).

## 5. Décision de conception à noter pour la validation

- **Seq non opposable sur le pont** (événements dm non signés) : imposer la monotonie sur une seq forgable = DoS sur la conversation. La garde payload-bound reste la barrière du pont ; le compteur ne s'applique qu'au canal signé `dm2`. Si vous préférez la dureté maximale (compteur appliqué partout, au prix du DoS documenté), c'est un changement d'une ligne + 1 test — à trancher à la validation.
- **Fenêtre `stale` = 7 j** alignée sur `ACTION_MAX_AGE_MS` : une garde ne survit jamais à la validité de sa preuve (pas de limbo « garde vivante / preuve morte »).

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
git log --oneline main..feat/a1-anti-replay   # 2 commits : A1 + fix CI
git diff 652c5b0 0c7d4c3 --stat         # uniquement les 2 correctifs cwd des tests
git reflog show origin/main             # aucun rewind : fast-forwards + push recadrage seulement
```

**Portée de l'incident** : strictement LOCAL. `origin/main` n'a **jamais** été réécrit (le reflog de la ref distante ne montre que des fast-forwards et le push du recadrage `7b51fd5`) ; aucun historique public n'a été altéré. Note : `feat/a2-key-auth` a, elle, nécessité deux poussées non fast-forward (rebases internes à la branche : `652c5b0` → `eb7995e` → … → `0c7d4c3`) — visibles dans son reflog, sans impact sur `main`.

**Mesure corrective durable** : le travail de phase se fait désormais dans des **worktrees git externes** (`git worktree add`), hors de portée du reset du superviseur — pattern documenté dans `docs/DEV-SETUP.md`.
