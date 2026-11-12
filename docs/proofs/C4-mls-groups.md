# C4 — Groupes privés MLS (RFC 9420) — preuve

Date : 2026-11-12 · Branche : `feat/mbote-v1` (via wt-b1, piste média) · Prérequis : `C4-prerequisites.md` VALIDÉ (GO)
Runner : `bash scripts/c4-mls-groups-proof-run.sh` — **exit 0** (rejouable, DEV-SETUP §2b)

La porte bloquante demandée par la direction (Clarification 4) a été franchie
AVANT le code : bibliothèque retenue, licence vérifiée au fichier, PoC
adversarial `ts-mls` exit 0, sonde navigateur exit 0 — voir
`C4-prerequisites.md`. Cette preuve couvre l'implémentation.

## 1. Livrables → tests → preuves

| Livrable | Test | Preuve |
|---|---|---|
| **Schéma** : Group, GroupMember (leftAt = exclusion), GroupMessage (ciphertext opaque, epoch BigInt), GroupEnvelope (commit broadcast / welcome ciblé), MlsKeyPackage (single-use) | migration additive `20261112120000_0010_c4_groups` (DEV-SETUP §4) + smoke test tables | `c4-migrate.txt` |
| **Client MLS** (`src/lib/mbote/mls/`) : ts-mls importé PARESSEUSEMENT (238 Ko gz hors bundle principal), état scellé AES-GCM (ECDH-soi, clé non-extractible) dans le coffre IDB « mbote-secure » v2, commits traités DANS L'ORDRE, dédoublonnage enveloppes/messages par id persisté | harnais W1-W7 (3 clients réels) + navigateur N1-N7 | `c4-test-output.txt`, `c4-browser.json` |
| **Création de groupe** : UN commit multi-adds + UN welcome, l'arbre voyage DANS le welcome (`ratchetTreeExtension`) — le serveur ne voit que du binaire MLS | W1 + N3 | captures `c4-create-dialog.png`, `c4-group-created-a.png` |
| **Jointure** : `joinFromWelcome` essaie les key packages privés en cache (match HPKE par référence), consomme le bon (single-use) | W1 + N5 | capture `c4-joined-b.png` |
| **Messages de groupe E2EE** : ciphertext MLS opaque, le serveur stocke sans lire | W6 (opacité) + greps DB : **8 messages, 0 fuite plaintext** | `c4-greps.txt` |
| **Forward secrecy** : retrait → remove-commit (ratchet complet de la chaîne) → l'ex-membre ne déchiffre PAS l'epoch suivante | W2 (système) + N7 (UI : M2 lu par C, INVISIBLE chez B) | capture `c4-m2-b-excluded.png` |
| **Epoch rotation** : 0→1 (add) → 2 (remove) ; Carol applique le commit de retrait SANS welcome | W3 | `c4-test-output.txt` |
| **Replay** : message consommé rejoué → REFUS | W4 (refus ratchet) | idem |
| **Collusion** : l'état exfiltré pré-retrait ne déchiffre pas M3 | W5 | idem |
| **Invariants serveur** : 401 sans preuve · 403 non-créateur · 400 ciphertext > 16 Ko · ciphertext opaque · invite/remove réservés au créateur · auto-retrait créateur refusé | W6 | idem |
| **Key package single-use** : la 2ᵉ consommation → 404 (HPKE init key à usage unique) | W7 | idem |
| **UI** : vue Groupes (nav + PWA allowlist), création multi-contacts, conversation (auteur, badge « MLS actif », messages système ajout/retrait par diff d'annuaire), gestion membres (couronne créateur, invitation, retrait avec confirmation), composer MLS | N1-N7 navigateur | captures `c4-*.png` |
| **Temps réel** : relay-notify `group-envelope` → rooms dm:<userKey> (aucun contenu, fire-and-forget), polling de secours, sync des welcomes HORS vue sélectionnée | N5 (B rejoint sans cliquer au préalable) | `c4-browser.json` |

## 2. Golden path navigateur (TROIS navigateurs réels, build prod)

`c4-browser.json` : **ok: true** — 11 vérins verts :

```
N1 onboarding A (« Nav-Alice ») + B (« Nav-Bob ») + C (« Nav-Carol »)
N2 vue Groupes ×3 → key packages publiés (bouton actif) — scellés dans le coffre IDB
N3 A crée « Nav-Groupe-MLS » avec B et C → UN commit multi-adds MLS (POST capté : 2 membres)
N4 A envoie « Bonjour groupe MLS » → badge « MLS actif » visible
N5 B ouvre la conversation → welcome consommé → M1 DÉCHIFFRÉ localement ;
   B répond « Salut de Bob » → lu par A ET C (capture c4-joined-c.png)
N6 A RETIRE B (confirmation) → message système « a été retiré » + B disparaît des badges
N7 A envoie « M2-apres-retrait » → C le déchiffre ; B NE LE VOIT PAS
   (forward secrecy à l'écran — captures c4-m2-c.png / c4-m2-b-excluded.png)
```

## 3. Benchmark (directive : établissement groupe < 2 s, envoi < 500 ms)

```
[BENCH] établissement groupe (création + 2 jointures MLS complètes) = 94 ms  (budget 2 000 ms)
[BENCH] envoi message de groupe                                     = 10 ms  (budget 500 ms)
```

Mesuré SystÈME : 3 états MLS réels (TreeKEM complet, HPKE, welcome + commits)
via les VRAIS endpoints HTTP — pas des mocks. Les epochs avancent de 0 à 1.

## 4. Invariant serveur — preuve en base (greps)

```
messages stockés : 8
fuites plaintext : 0 (attendu 0 — MLS est E2EE)
```

Le grep inspecte le ciphertext DÉCODÉ de chaque GroupMessage : aucun plaintext
(M1/M2/M3/messages navigateur) n'y apparaît — le serveur ne peut pas lire ce
qu'il relaie, par construction ET par vérification.

## 5. Bugs réels attrapés pendant la preuve (tous corrigés)

1. **authPost signait SANS le timestamp** (le serveur vérifie `${msg}|${ts}`) →
   401 sur la publication de key packages. **Classe §7** : le harnais système
   réimplémentait le protocole (vert), le CLIENT portait le bug — la preuve
   navigateur l'a attrapé.
2. **authPost envoyait l'OBJET identité entier** dans `body.me` (la route exige
   une string) — même classe, même capture.
3. **Le script de preuve cliquait `getByLabel('Inviter C4-Bob')`** (noms du
   harnais copiés au lieu des contacts Nav-*) : trois itérations de mauvaises
   pistes (théories « animation du dialog », « race React ») avant la
   relecture du FICHIER RÉEL du script. **Leçon d'outillage** : jamais de
   `replace` python sans anchor asserté — deux éditions silencieuses ont
   « corrigé » des lignes inexistantes.
4. **Le clic d'envoi bouillonnait jusqu'à la Card** et désélectionnait le
   groupe (bug UX réel) — fix `stopPropagation` sur le conteneur conversation.
5. **Les welcomes n'étaient traités que si le groupe était sélectionné** —
   fix : sync des handshakes à chaque événement socket, même hors vue.

## 6. NON TESTÉ (explicite)

- **Groupes > 50 membres** (borne serveur GROUP_MEMBERS_MAX=50) : perf TreeKEM
  non mesurée au-delà de 3 membres — le PoC prérequis était 3 membres ; un
  bench 50 membres reste à faire avant montée en charge.
- **Appels de groupe** : C5 (hors périmètre C4 — la signalisation d'appel est
  1:1).
- **Safari/iOS réel** : TS pur WebCrypto (théoriquement compatible, sonde
  navigateur Chromium OK) — re-jouer la sonde sur device réel (classe
  dépendance externe).
- **Migration RN du module MLS** : le bloc mobile dédié (SCALE-ARCHITECTURE §8)
  couvrira la persistance Hermes (WebCrypto asynchrone, contrainte A1).
- **Rotation des key packages à long terme** : le client republie à l'ouverture
  de session (prune ≤ 3) ; le comportement après des dizaines de consommations
  sans republication (404 → UX « contact absent ») est documenté mais non testé
  en endurance.
- **Audit cryptographique formel de ts-mls** : l'auteur déclare la lib non
  auditée (README §Security) — accepté MVP avec le modèle de menace
  C4-prerequisites §6 ; rapport upstream ouvert pour les bugs §5 du document
  de prérequis.
- **FCM device réel** pour les knocks de groupe : les groupes ne déclenchent
  pas encore de push (reprise C1 pour les DM uniquement) — le réveil passe par
  le socket (membres en ligne) ou le polling (4 s).
