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
