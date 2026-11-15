# BUNDLE incrémental — transfert feat/mbote-v1 vers l'opérateur

Transfert sans token, sans push direct, sans service tiers : bundle git
incrémental à récupérer par l'opérateur, qui pousse depuis son laptop.
Généré le 2026-11-15 07:05 UTC dans la session opérateur (sandbox), aucune
poussée effectuée — la seule écriture sur `origin` reste celle de l'opérateur.

## 1. Métriques du bundle

| Métrique | Valeur |
|---|---|
| Branche | `feat/mbote-v1` |
| SHA local (tip inclus dans le bundle) | `d4e7da315124c7537ae35ba031b964106b114e88` |
| SHA `origin/feat/mbote-v1` (prérequis) | `0d3309e72904a1fdbcec7f924a4fcb50e59ce7f7` |
| Commits transférés | **27** (`git rev-list --count origin/feat/mbote-v1..feat/mbote-v1`) |
| `git bundle verify` | OK (« bundle is okay », exit 0) — prérequis déclaré : `0d3309e` |
| Fichier compressé | `mbote-v1-20261115-0705.bundle.gz` |
| Taille compressée | **17 381 347 octets = 16,57 MB** (≈ 17,0 MB) |
| SHA-256 (bundle .gz) | `ea7a1d7da3a4a8da8f3a639074118fa6d32fc28bc10fc3007e47b7e3909ebcae` |
| Découpage | 4 chunks de 5 MB (binaire) → base64 |

Remarque honnête : `gzip -9` ne compresse presque rien (−10 octets) — un
packfile git est déjà compressé zlib en interne ; la taille du bundle ≈ la
taille du pack incrémental (les captures PNG committées dans la vague F
dominent le volume).

### Chunks (base64 — c'est ce qui est transféré, un par un, sur demande)

| Chunk | Binaire (octets) | Base64 (octets) | SHA-256 (binaire) |
|---|---|---|---|
| `chunk-mbote-v1-00.b64` | 5 242 880 | 6 990 508 | `7f4cb7a878725a2639418f6f79748054e7f2c38c82393547a4a4421de1d2ee83` |
| `chunk-mbote-v1-01.b64` | 5 242 880 | 6 990 508 | `7483581aa05037e2382b72db80b17fbafc3f068a32a472ac8f0f2827b5876f1d` |
| `chunk-mbote-v1-02.b64` | 5 242 880 | 6 990 508 | `1c9181584694b20e161f5dc452d8a651e4a610141f90a4ac14a87230bcc9e101` |
| `chunk-mbote-v1-03.b64` | 1 652 707 | 2 203 612 | `6e419cc6af22088867e2127dc8fb2521162279b7761d79e2cf2fe235832c07b9` |

Ordre de réassemblage : `00 → 01 → 02 → 03` (l'ordre lexicographique du glob
`chunk-mbote-v1-*.b64` est correct).

## 2. Instructions pour l'opérateur (laptop)

```bash
# 0. Sur ton laptop : avoir le repo cloné et à JOUR au minimum à 0d3309e
#    (le bundle est incrémental — il exige ce commit dans l'object store local)
git clone https://github.com/<owner>/<repo>.git mbote-laptop   # si pas déjà fait
cd mbote-laptop
git fetch origin                                               # si clone ancien
git log origin/feat/mbote-v1 --oneline -1                      # doit montrer 0d3309e

# 1. Télécharger les 4 chunks .b64 (méthode convenue — pas de service tiers),
#    puis vérifier CHAQUE chunk (les SHA-256 sont en section 1)
sha256sum chunk-mbote-v1-00 chunk-mbote-v1-01 chunk-mbote-v1-02 chunk-mbote-v1-03
#    (après décodage — voir 2a ; ou vérifier le .gz final directement, étape 2b)

# 2. Reconstituer le bundle
#    2a — décodage par chunk puis concaténation (équivalent, vérifiable chunk par chunk) :
for f in chunk-mbote-v1-*.b64; do base64 -d "$f" > "${f%.b64}"; done
cat chunk-mbote-v1-00 chunk-mbote-v1-01 chunk-mbote-v1-02 chunk-mbote-v1-03 > mbote-v1.bundle.gz
#    2b — ou la forme courte testée de bout en bout côté génération :
cat chunk-mbote-v1-*.b64 | base64 -d > mbote-v1.bundle.gz

# 3. Vérifier l'intégrité du .gz reconstitué
sha256sum mbote-v1.bundle.gz
#    attendu : ea7a1d7da3a4a8da8f3a639074118fa6d32fc28bc10fc3007e47b7e3909ebcae

# 4. Décompresser puis vérifier le bundle
gunzip mbote-v1.bundle.gz
git bundle verify mbote-v1.bundle
#    attendu : « contains this ref: d4e7da3… refs/heads/feat/mbote-v1 »
#              « requires this ref: 0d3309e… » + « is okay »

# 5. Fetch depuis le bundle (crée la branche temporaire mbote-temp)
git fetch mbote-v1.bundle feat/mbote-v1:mbote-temp

# 6. Pousser sur origin — fast-forward 0d3309e → d4e7da3, JAMAIS de force push
git push origin mbote-temp:feat/mbote-v1

# 7. Nettoyer
git branch -D mbote-temp
```

Chemin testé côté génération (simulation laptop complète, avant livraison) :
clone depuis `origin` (= `0d3309e`) → `git fetch <bundle>` → tip =
`d4e7da315124c7537ae35ba031b964106b114e88`, 27 commits ajoutés
(`0d3309e..d4e7da3`). Le réassemblage `cat chunk-*.b64 | base64 -d` a été
exécuté et le SHA-256 du `.gz` obtenu est identique à celui ci-dessus.

## 3. Vérifications post-push (laptop)

```bash
# 1. feat/mbote-v1 à jour sur origin
git ls-remote origin feat/mbote-v1
#    attendu : d4e7da315124c7537ae35ba031b964106b114e88  refs/heads/feat/mbote-v1

# 2. main INCHANGÉ (aucun push main, règle absolue)
git ls-remote origin main
#    attendu : 75e9559c0e5bbcba873132819871094736c29a6d  refs/heads/main

# 3. Sanity GitHub : github.com/<owner>/<repo>/branches → feat/mbote-v1 à jour,
#    "27 commits ahead of main" (nombre indicatif).
```

## 4. Vérifications CI (post-push, sur github.com → Actions)

- `tests.yml` ✅ vert
- `security.yml` ✅ vert
- `weekly-proof-run.yml` ✅ vert ou skipped documenté
- `deploy-vps.yml`, `schema-guard.yml`, `build-android.yml`, `build-ios.yml`
  **absents** (non déclenchés par ce push de branche)

Si CI rouge : diagnostic AVANT tout prompt G (séquence obligatoire
Clarification 2 post-F). La branche porte 24 commits jamais vus par la CI au
moment du diagnostic — tout échec nouveau est d'abord attribué avant correction.

## 5. Notes

1. **Bundle incrémental** : il exige `0d3309e72904a1fdbcec7f924a4fcb50e59ce7f7`
   dans l'object store de la machine cible. Si le laptop n'a pas ce commit
   (`git cat-file -t 0d3309e…` échoue), `git fetch origin` d'abord — `origin`
   l'a toujours (`git ls-remote origin feat/mbote-v1` confirmé au moment de la
   génération).
2. **Si le fetch échoue** avec `error: Could not read from bundle` :
   vérifier le SHA-256 du `.gz` reconstitué (étape 3 de la section 2) — un
   écart = chunk manquant ou corrompu, re-télécharger le chunk fautif (SHA par
   chunk en section 1).
3. **Commit de métadonnées** : le commit qui ajoute ce fichier
   (`docs: bundle transfer metadata for feat/mbote-v1 (27 commits)`) est posé
   APRÈS la création du bundle — il n'est donc PAS dans ce bundle et reste
   local au sandbox. Après le push opérateur, le sandbox sera 1 commit devant
   `origin/feat/mbote-v1` ; il sera inclus dans le prochain bundle si
   nécessaire.
4. **Le push opérateur est un fast-forward** (`0d3309e` → `d4e7da3`) :
   aucune option `--force`, conformément aux règles de branche.
5. Contenu des 27 commits (aperçu log `0d3309e..d4e7da3`) : F-16a/F-16b/F-17
   (fixes CI), Clarification 1 (gate tsc ×13 runners), Clarification 2 (dette
   B1 MinIO tracée ×2), diagnostic #47, harnais F complet, corrections
   Critiques #1 #2 #15 #39 #47 #72 + Majeurs (erreurs honnêtes, a11y 44px,
   axe/contraste), rapport F-ui-fixes.md, Clarification 1 harnais (IDB probe,
   contextes jetables, EXPECTED_AXE_VIEWS), Ajout 1 (garde SYBIL_BYPASS
   production + §7b + gate runner 1b), Ajout 2 (preuve visuelle des 5 vues
   axe, §8b, 6ᵉ occurrence corrigée comme messages-offline).
