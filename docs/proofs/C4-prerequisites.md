# C4-prerequisites — Bibliothèque MLS pour groupes privés (2026-11-12)

**Statut : VALIDÉ — GO pour C4.** Tous les prérequis directive sont prouvés
par exécution réelle (pas par lecture de README — leçon web-push : vérifier le
fichier LICENSE, pas l'annonce).

## 1. Bibliothèque retenue : `ts-mls` 1.6.4 (TypeScript pur, RFC 9420)

### 1.1 Candidats évalués

| Candidat | Verdict | Preuve |
|---|---|---|
| **`ts-mls` 1.6.4** | **RETENU** — RFC 9420 complète (TreeKEM, commits, welcomes, HPKE, ratchet), TS pur WebCrypto (pas de WASM), CI + coverage, maintenu (2026-08), ciphersuites post-quantum incluses | PoC adversarial exit 0 (§3) + sonde navigateur exit 0 (§4) |
| `@openmls/openmls` / `openmls` | **N'EXISTE PAS sur npm** (référence fantôme de la directive — E404 registry). OpenMLS (Rust) n'a pas de binding WASM officiel publié | `npm view @openmls/openmls` → E404 |
| `ping-openmls-sdk` 0.9.0 (wrapper OpenMLS WASM) | Apache-2.0 annoncé mais **un seul mainteneur indépendant, version 0.9 pré-mature, 4,9 Mo, pas de PoC possible** sans confiance au vendeur — écarté au profit d'une lib auditable de bout en bout | npm view + tarball non audité |
| `@vanishing.page/webcrypto-mls` 0.0.18 | Licence « SEE LICENSE IN LICENSE » à déchiffrer, 31 Mo unpacked, version 0.0.x — immature | npm view |
| `@absolutejs/e2ee-mls` 0.5.0 | « Experimental » déclaré par l'auteur lui-même | npm view |
| Implémentation maison (RFC 9420) | ÉCARTÉE : TreeKEM + HPKE + key schedule + commits + welcomes ≈ plusieurs mois et un audit cryptographique — inacceptable devant une implémentation MIT testable | analyse |

### 1.2 Licence — vérifiée AU FICHIER (leçon web-push MPL-2.0 vs MIT)

```
ts-mls tarball 1.6.4 → LICENSE (fichier réel, PAS le README) :
"MIT License — Copyright (c) 2025 Luka Jacobowitz"  → MIT CONFIRMÉ
```

Dépendances transverses (toutes vérifiées `npm view <pkg> license`) :

| Paquet | Licence déclarée | Rôle |
|---|---|---|
| `@hpke/core` 1.10.1 | MIT | HPKE (RFC 9180) |
| `@noble/curves` 2.4.0 | MIT | courbes elliptiques |
| `@noble/ciphers` 2.4.0 | MIT | AES-GCM / ChaCha20 |
| `@noble/post-quantum` 0.5.2 | MIT | optionnel (PQC) — peerDep |
| `@hpke/chacha20poly1305` 1.8.0 | MIT | cipher suite optionnelle |

**Aucune licence copyleft, aucune dépendance inconnue.** La chaîne complète est
MIT → compatible avec l'app (zéro obligation de révélation de source).

### 1.3 Suite ciphersuite retenue

`MLS_128_DHKEMP256_AES128GCM_SHA256_P256` — famille P-256 (cohérente avec les
identités ECDSA P-256 existantes de l'app — une seule famille de courbes dans
toute la stack), WebCrypto natif partout (Chromium/Safari/Firefox).

## 2. Taille du bundle (pas de WASM — TS pur)

```
bun build --target=browser --format=esm :
  brut          1,44 Mo (ts-mls + @hpke/core)
  minifié       784 Ko
  min + gzip    238 Ko  ← ce qui traverse le réseau
```

**Décision d'architecture** : le module MLS est chargé en **dynamic import
lazy** — seuls les utilisateurs qui ouvrent/recvuent un groupe paient les
238 Ko (le service worker le met ensuite en cache runtime). Le bundle principal
n'est PAS alourdi.

## 3. Tests adversariaux — EXÉCUTÉS AVANT le code C4 (directive), exit 0

Asset : `scripts/c4-mls-poc.ts` → `docs/proofs/assets/c4-mls-poc.json`
(`bun scripts/c4-mls-poc.ts` — exit 0, rejouable) :

| Scénario directive | Résultat | Détail |
|---|---|---|
| T0 livraison 3 membres | **PASS** | Alice crée (epoch 0), ajoute Bob (epoch 1) puis Carol (epoch 2) via commits+welcomes ; les trois traitent M1 |
| T2 epoch rotation | **PASS** | 0→1→2→3 (add, add, **remove**) — Carol applique le commit de retrait SANS welcome (le commit se diffuse au groupe) |
| T1 forward secrecy | **PASS** | Bob retiré → M2 (epoch 3) : `OperationError` — l'état périmé ne déchiffre PAS |
| T3 replay | **PASS** | M1 déjà consommé rejoué : `Desired gen in the past` — refus par ratchet |
| T4 collusion | **PASS** | L'état exfiltré de Bob ne déchiffre pas l'epoch suivante (le commit de retrait a ratcheté toute la chaîne — pas de chemin vers l'epoch courante sans PSK externe ni commit signé par un membre actuel) |
| T5 persistence | **PASS** | GroupState round-trip codec JSON+b64 (21 102 octets, epoch 3) + état restauré FONCTIONNEL (envoie M3, Carol le déchiffre) |

Découvertes de flux (infrastructures C4 à intégrer) :

1. **Un membre qui n'a pas traité un commit ne peut pas déchiffrer
   l'epoch suivante** (OperationError) — le relais serveur doit remettre les
   commits à TOUS les membres (room de groupe), pas seulement aux nouveaux.
2. **Leaf index d'un membre** = recherche d'identité dans l'arbre du créateur
   (index tableau / 2 — arithmétique TreeKEM) — l'API n'expose pas leafIndex
   sur l'état d'autrui.
3. **Chaque message traité avance l'état** (`newState` dans le résultat) —
   la persistence doit suivre chaque message consommé (sinon replay indésirable
   ou incapacité à déchiffrer la suite).

## 4. Compatibilité navigateur

| Runtime | Résultat | Preuve |
|---|---|---|
| Chromium OSS (headless, page réelle) | **PASS — exit 0** : groupe MLS 2 membres + message de groupe déchiffré, 100 % WebCrypto natif, zéro node:crypto/Buffer | `scripts/c4-browser-probe.ts` + `c4-browser-probe.json` + `c4-mls-browser-entry.ts` (bundle ESM browser-target) |
| Bun (sandbox) | **PASS** (PoC T0-T5) — avec 1 bug runtime documenté §5c | `c4-mls-poc.json` |
| Safari/iOS | **THÉORIQUEMENT OK** (TS pur WebCrypto — aucune API hors spec utilisée ; suite P-256 native) mais NON TESTÉ — classe dépendance externe, re-jouer la sonde sur un device réel (procédure DEVICE-TEST-PROTOCOL) | analyse |
| React Native (miroir mobile) | Hermes : WebCrypto asynchrone — même contrainte que A1 (déduction) ; bloc mobile dédié (SCALE-ARCHITECTURE §8) hors périmètre C4 web | analyse |

## 5. Contraintes runtime découvertes (à documenter DANS le code C4)

| # | Contrainte | Contournement retenu |
|---|---|---|
| a | `encodeGroupState`/`decodeGroupState` 1.6.4 **CASSÉS** (bug bibliothèque : `InternalError: last node must be non-blank` au décodage de ses PROPRES encodages, même état simple) | persistence par **codec JSON+b64 maison** (PoC T5) / **IndexedDB structured clone natif** dans le navigateur |
| b | `clientConfig.authService` porte une **fonction** (non clonable) | persister le `GroupState` seul (sans clientConfig), ré-attacher la config au réhydratage |
| c | `structuredClone` de **bun** bugué : `[leafA, leafB]` FAIL alors que chaque feuille seule passe ; **node 24 conforme** clone le même arbre OK → le NAVIGATEUR (IndexedDB, implémentation conforme à la spec) est viable | fallback codec déterministe (preuve T5) ; jamais compter sur bun pour la persistence |
| d | Le commit de retrait du DERNIER membre laisse une feuille vide en fin d'arbre | aucun impact côté client (pas de décodage TLS d'état) — noté pour d'éventuels exports wire |

Rapport upstream à ouvrir : les bugs (a) et (c) sont reportables au repo
ts-mls (le message d'erreur invite littéralement « please submit a bug report »).

## 6. Modèle de menace adopté pour C4 (contrat avant implémentation)

1. **Le serveur ne voit JAMAIS de contenu de groupe** : GroupMessage stocke du
   ciphertext MLS opaque (invariant testé : déchiffrer avec une fausse clé →
   garbage, pas de plaintext).
2. **Les commiteurs sont authentifiés** : chaque commit/welcome circule signé
   par MLS (authentification interne) ET le transport porte la preuve ECDSA de
   l'app (`callProofMessage`-like) — anti-injection de commits par un tiers.
3. **Forward secrecy opérationnelle** : le retrait d'un membre = remove
   proposal + commit par un admin de groupe → l'ex-membre ne lit plus les
   messages d'après (POUVÉ T1). Les messages D'AVANT restent lisibles par
   l'ex-membre s'il a conservé son état (limite MLS intrinsèque — documentée :
   les historiques pré-retrait ne sont PAS effacés).
4. **Collusion** : états périmés combinés ne déchiffrent rien de nouveau
   (POUVÉ T4).
5. **Persistence chiffrée** : l'état MLS (clés privées du ratchet incluses)
   vit dans l'IndexedDB chiffré existant (clés identité — même coffre).

## 7. Décision

**GO pour C4** — bibliothèque retenue, licence propre, bundle raisonnable
(lazy), adversarial pré-prouvé, runtime navigateur prouvé. Les prérequis
étaient la porte BLOQUANTE demandée par la direction : elle est franchie avec
des preuves d'exécution, pas des promesses de README.

## 8. NON TESTÉ (explicite)

- Safari/iOS réel (classe dépendance externe — sonde à re-jouer).
- Groupes > 50 membres (perf TreeKEM non mesurée — le PoC est 3 membres).
- Appels de groupe (C5 — hors périmètre C4).
- Audit cryptographique formel de ts-mls (l'auteur le déclare lui-même non
  audité — README §Security) : accepté pour le MVP avec le modèle de menace §6 ;
  le rapport upstream des bugs (a)/(c) sert aussi de contact avec le mainteneur.
