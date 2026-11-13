# PUSH feat/mbote-v1 — RAPPORT DE VÉRIFICATION

Date : 2026-11-13 (session sandbox)
Mission : publier `feat/mbote-v1` sur origin avec un token fine-grained fourni par l'opérateur, vérifier la CI, retirer le token, rapporter.

## Verdict : ⚠️ PARTIEL

- Publication de la branche : ✅ (9fb798e sur origin, fast-forward strict depuis origin/main)
- `origin/main` inchangé : ✅ (75e9559 avant = 75e9559 après)
- Workflows prod (deploy-vps, schema-guard, build-android/ios) : ✅ absents
- `security.yml` : ✅ vert
- `tests.yml` : ❌ rouge — 3 échecs spécifiques environnement runner (détail §7)
- `weekly-proof-run.yml` : ❌ rouge — build D1 échoue sur le runner (détail §7)
- Hygiène token : ✅ (jamais committé, jamais en config, retiré de la session à la fin)

L'essentiel est atteint : les 20 phases (A1→E + durcissement) sont sauvegardées sur origin. La CI n'est pas intégralement verte ; les échecs sont des découvertes nouvelles à trier (§7), aucun fix appliqué conformément à la consigne « aucune modification sauf le rapport ».

---

## 1. Anomalies d'environnement rencontrées (et décisions)

### 1.1 Worktree /home/z/wt-adm disparu (prunable)
`/home/z/wt-adm` n'existait plus sur le disque (nettoyage sandbox entre sessions) ; git le marquait `prunable`, la branche et son historique étaient intacts dans `/home/z/my-project` (SHA 9fb798e, `373b215` vérifié ancêtre).
Décision : restauration fidèle de l'environnement documenté — `git worktree prune` (purge de l'enregistrement périmé uniquement, aucune ref/commit/fichier tracked modifié) puis `git worktree add /home/z/wt-adm feat/mbote-v1`. Toutes les vérifications Étape 1 ont ensuite été rejouées à la lettre dans ce worktree.
Inconnue résiduelle : l'état non-commité de l'ancien worktree est perdu avec le répertoire ; le commit E `9fb798e` contient les livrables E (UI-AUDIT.md, scripts, 25 captures, JSON par vue).

### 1.2 main LOCAL de /home/z/my-project = 12487ab « ahead 9 »
Le `main` local du dépôt principal contient 9 commits absents d'origin/main : 7d4afb0 (clôture d'incidents), 3 commits ADM (e0d8a4b, 04a5c4a, 6d3666b) et 4-5 commits-UUID de sandbox (12487ab, 53f92cd, 77c9752, 6bcff08, ee02373 — contenus : composants shadcn, artefacts admin/.next, preuve ADM-audit, fichiers .github à diff vide).
Décision : RIEN touché — ni push, ni reset, ni nettoyage (consigne : ne pas « nettoyer »). `origin/main` reste à 75e9559, inchangé avant/après mission.
Note : 3 de ces commits-UUID (77c9752, 6bcff08, ee02373) sont AUSSI dans l'historique de feat/mbote-v1 (fusionnés) et sont donc publiés par ce push. 77c9752 embarque ~58 Mo d'artefacts admin/.next (dé-trackés ensuite par 5c51a6d mais présents dans l'historique — bloat à connaître pour les clones).

### 1.3 Topologie vérifiée
`merge-base(origin/main, feat/mbote-v1) = 75e9559` → la branche est strictement en avance sur origin/main ; publication en fast-forward, zéro divergence, zéro force push.

### 1.4 Token : format annoncé vs réel
Annonce : fine-grained `github_pat_…` (contents:write, 24h). Fourni : PAT classique `ghp_…` (11 caractères visibles identiques au fragment déjà documenté, cf. §6). Le token a fonctionné pour l'API REST et l'endpoint git.

### 1.5 Fragment de token redacté déjà dans l'historique (pré-existant)
Le commit `7d4afb0` (clôture d'incidents, session précédente validée) contient la forme redactée `ghp_3k0z…WBg` (8 premiers + 3 derniers caractères) dans sa documentation. Le token COMPLET n'apparaît nulle part : pickaxe `git log -S` sur `ghp_`, `github_pat_` et `3k0zPxe0` sur origin/main..feat/mbote-v1 → 0 hit pour la valeur complète (2 hits = formes redactées/patterns de scanner). Ce fragment est publié par ce push (déjà validé en son temps) ; l'opérateur jugera s'il faut le purger avant O-A (rewrite interdit sans instruction).

### 1.6 Difficultés de transfert git (diagnostic documenté pour DEV-SETUP)
Trois causes combinées ont fait échouer les premières tentatives de push :
1. **Variable d'environnement perdue entre les appels shell du sandbox** → le credential helper envoyait un mot de passe VIDE → `remote: Invalid username or token` (401). Correction : token ré-exporté DANS CHAQUE appel de push.
2. **Chunked transfer-encoding bloqué** par le chemin egress avec le `http.postBuffer` par défaut (1 MiB) → upload suspendu (timeout 600 s). Correction : `-c http.postBuffer=536870912` (corps unique avec Content-Length).
3. `-c http.version=HTTP/1.1` ajouté par prudence.
Recette validée (2,9 Mo en 2 s ; 58 Mo en 9 s ; ~52 Mo en 5 s) :
```
git -c http.version=HTTP/1.1 -c http.postBuffer=536870912 \
    -c credential.helper= \
    -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$TOKEN_ENV"; }; f' \
    push origin <sha>:refs/...
```
Technique transitoire : les objets ont été staged via deux refs éphémères `refs/tmp/mbote-staging` (lignée ADM) et `refs/tmp/mbote-staging-b` (lignée b1 — nécessaire car la lignée b1 diverge depuis 6d3666b et n'est pas un descendant de la lignée ADM), PUIS la ref réelle `refs/heads/feat/mbote-v1` créée en un dernier push minimal. **La CI n'a donc été déclenchée qu'UNE SEULE fois, sur le SHA final 9fb798e** (les refs hors `refs/heads/` ne déclenchent aucun workflow). Les deux refs tmp ont été supprimées immédiatement après (vérifié : `ls-remote refs/tmp/*` vide).
Aucun `--force`, aucune réécriture, chaque mise à jour = fast-forward.

---

## 2. Étape 1 — Vérification pré-push (sorties brutes)

```
$ git -C /home/z/wt-adm status            (après restauration §1.1)
On branch feat/mbote-v1
nothing to commit, working tree clean

$ git -C /home/z/wt-adm branch --show-current
feat/mbote-v1

$ git -C /home/z/wt-adm rev-parse feat/mbote-v1
9fb798e29f08f018274191538772868e30413a51

$ git -C /home/z/wt-adm rev-list --count origin/main..feat/mbote-v1
83

$ git -C /home/z/wt-adm log --oneline origin/main..feat/mbote-v1 | grep -iE "A1|A2|A3|ADM|B1|B2|B3|B4|C1|C2|C3|C4|D1|D2|D3|F-1|break-glass|mesh|hardening" | head -30
9fb798e audit(ui): vague E — UI-AUDIT.md 78 problèmes (6 C / 42 M / 30 m)…
77ec1b1 docs(ci): F-15 — même pattern sur main tracé…
611c7af proof(hardening): runner 7/7 vert + HARDENING.md…
5c51a6d chore(gitignore): admin/.next jamais tracké (455 artefacts dé-trackés)…
343ec17 docs(hardening): CI-AUDIT — F-1 corrigé en code…, F-15 nouveau (31 fails CI)…
16fe0c4 fix(sqlite): mesh/bridge ATOMIQUE par paquet…
3a7c073 fix(sqlite): totp-enroll ATOMIQUE…
a492c44 fix(ci): harness guards skip PROPRE… simulation CI : 225 pass / 231 skip / 0 fail…
640893a fix(sqlite): break-glass ATOMIQUE… harnais R1/R2/R3 : 3/3
b4f6b97 fix(f1): deploy-vps gâté par la CI — workflow_run sur tests.yml + gate SHA…
893428f docs(db): invariant §4d…
373b215 docs(ci): audit statique 8 workflows — 14 constats F-1..F-14…
25aaa56 feat(d3): supply chain — triage 98 vulns (prod 11 → 0)… scan secrets 127 commits (0 réel)…
0ad0a40 feat(d2): Sybil phase 0 — PoW 20 bits… tests 15/15 serveur réel…
30f3155 chore(ci+git): Clarifications 1-4 vague D2+D3…
489a7fd docs(c4): preuve C4-mls-groups.md…
ba24030 test+proof(c4): preuve complète groupes MLS — harnais 8/8…
51c1563 feat(c4): UI groupes privés MLS…
3113450 feat(c4): client MLS + endpoints serveur groupes…
17a8940 feat(c4): schéma groupes MLS — migration 0010
a2f5c21 docs(c4-prereq): C4-prerequisites.md VALIDÉ…
eba0221 test(c4-prereq): PoC MLS adversarial ts-mls 1.6.4 — exit 0 (T0-T5)…
4933bb4 docs+proof(c3): preuve navigateur C3 complète… benchmarks 767 ms / 5 ms
ed59653 feat(c3): appels vidéo 1:1 WebRTC E2EE…
6f84277 chore(git): consolidation branches — feat/adm-mvp → feat/mbote-v1, b1 archivée…
7dfe0db docs(d1): preuves finales sur l'union D1+C2 — 9/9 tests… exit 0…
b912a4d merge(b1→adm): résolution des 4 conflits C2 (règle §8.1)…
330f522 feat(c2): appels audio 1:1 WebRTC E2EE…
02d94ed docs(d1): assets preuve D1 régénérés… 9/9 tests… exit 0…
266f8e2 merge(b1→adm): résolution immédiate des 5 conflits…

$ git ls-remote origin main
75e9559c0e5bbcba873132819871094736c29a6d	refs/heads/main

$ git ls-remote origin feat/mbote-v1
(vide — première publication)

$ git config --local --list | grep -iE 'credential|token'
OK: clean (pas de credential/token dans la config locale)
```

Contrôles supplémentaires :
- Jalons par phase (comptage conventionnel sur origin/main..feat/mbote-v1) : adm 29, c1 3, c2+, c3 2, c4 5, b1 2, b2 3, b3 2, b4 2, d1 4, d2 1, d3 1 + durcissement complet (F-1, break-glass, mesh, totp-enroll, hardening) + vague E. A1/A2/A3 : commits ancêtres de la branche (déjà aussi sur origin/main) — vérifiés par `merge-base --is-ancestor` : dc26cca, 88c3599, 6edb720 = DANS feat/mbote-v1.
- Scan secrets pré-push : pickaxe `ghp_`/`github_pat_`/`3k0zPxe0` sur les 83 commits → token complet absent (§1.5).

## 3. Étape 3 — Push (sorties clés)

Tentatives initiales : 2 timeouts 600 s + 1 échec auth instantané (mot de passe vide, cf. §1.6). Push final après correction :

```
# Micro-push de re-test (2,9 Mo) vers refs/tmp/mbote-staging
MICRO2_EXIT=0 DUREE=2s
To https://github.com/AlterEgo095/mbote-bitchat.git
 * [new reference]   7d4afb061746cf63f62b8d5ac7e2e5ffab2425a3 -> refs/tmp/mbote-staging

# Staging lignée ADM (18 Mo puis ~1-2 Mo)
CHUNK c1 EXIT=0   → 7d4afb0..6e1617c  refs/tmp/mbote-staging
ADM ae6ed604 EXIT=0 DUREE=3s

# Staging lignée b1 (58 Mo d'artefacts admin/.next du commit UUID 77c9752)
B1 77c9752 (58Mo) EXIT=0 DUREE=9s

# Push FINAL (branche réelle, ~52 Mo restants)
PUSH_FINAL EXIT=0 DUREE=5s
To https://github.com/AlterEgo095/mbote-bitchat.git
 * [new branch]      9fb798e29f08f018274191538772868e30413a51 -> feat/mbote-v1
remote: Create a pull request for 'feat/mbote-v1' on GitHub by visiting:
remote:      https://github.com/AlterEgo095/mbote-bitchat/pull/new/feat/mbote-v1

# Purge des refs de staging
 - [deleted]         refs/tmp/mbote-staging
 - [deleted]         refs/tmp/mbote-staging-b
```

## 4. Étape 3/4 — Checks de sécurité token

```
$ git config --local --get-regexp 'credential|token'
OK: no credential in config

$ ls -la ~/.git-credentials
OK: no ~/.git-credentials

$ git -C /home/z/wt-adm config --list | grep -iE 'credential|token'
(équivalent --local : propre ; global ne contient que safe.directory/user.name/user.email)

$ cat ~/.gitconfig | grep -iE 'credential|token'
OK: clean
```
Le token n'a jamais été écrit dans un fichier du dépôt, ni dans la config git (helper inline éphémère alimenté par variable d'environnement, jamais par URL). Il apparaît uniquement en mémoire de session et dans le canal de conversation.

## 5. Étape 4 — SHAs post-push

```
$ git ls-remote origin feat/mbote-v1
9fb798e29f08f018274191538772868e30413a51	refs/heads/feat/mbote-v1

$ git rev-parse feat/mbote-v1
9fb798e29f08f018274191538772868e30413a51
→ IDENTIQUES

$ git ls-remote origin main
75e9559c0e5bbcba873132819871094736c29a6d	refs/heads/main
→ INCHANGÉ (75e9559 avant = après ; ni push, ni merge, ni force vers main)

$ git ls-remote origin "refs/tmp/*"
(vide — staging purgé)
```

## 6. Étape 5 — Runs CI sur 9fb798e (branche feat/mbote-v1)

| Workflow | Attendu | Réel | Conclusion |
|---|---|---|---|
| Tests — harness adversarial (tests.yml) | ✅ vert | ❌ **failure** | 223 pass / 229 skip / **3 fail** / 1658 expect() / 455 tests, 28 fichiers, 19,29 s (détail §7.1) |
| Sécurité — analyse des vulnérabilités (security.yml) | ✅ vert | ✅ **success** | — |
| Preuves navigateur — hebdomadaires (weekly-proof-run.yml) | ✅ vert OU skip documenté | ❌ **failure** | Garde-fous prérequis = success ; D1 échoue à « 2. build standalone » exit 1 ; C2/C3/C4 skippés ; artefact proof-assets.zip publié (9,6 Mo) (détail §7.2) |
| deploy-vps.yml | NE DOIT PAS apparaître | ✅ absent | Confirmé |
| schema-guard.yml | NE DOIT PAS apparaître | ✅ absent | Confirmé |
| build-android.yml / build-ios.yml | NE DOIT PAS apparaître | ✅ absent | Confirmé |

IDs : tests 43413459579, weekly 43413459843, security 43413459645. Événement : `push` (un seul run par workflow — la technique de staging §1.6 a évité tout run sur SHA intermédiaire).

## 7. Échecs CI — analyse (AUCUN fix appliqué, consigne session)

### 7.1 tests.yml — 3 fail (localement P4 : 225 pass / 231 skip / 0 fail)
```
(fail) db boot pragmas (Clarification 1) > S2 — happy path : DB fraîche → WAL posé et persistant [4.39ms]
(fail) db boot pragmas (Clarification 1) > S3 — DB verrouillée EXCLUSIVE par un PROCESS TIERS → verifyBootPragmas REJETE (fail-fast) [0.52ms]
(fail) B1 · G — intégration MinIO locale (upload → check → delete) > (unnamed) [1599.69ms]
```
Hypothèses de triage (à instruire hors session) :
- **S2/S3** : dépendances au filesystem/sémantique SQLite du runner (WAL persistant, verrou EXCLUSIVE par process tiers) — l'environnement runner diffère du sandbox où la simulation P4 passait. Pistes : skip documenté si env non-reproductible, ou service/fixture dédié, ou détection d'environnement.
- **MinIO** : le runner n'a pas de service MinIO/S3 local ; le test d'intégration B1-G tente une vraie connexion (timeout ~1,6 s) et échoue au lieu de skipper. Pistes : service container dans tests.yml, ou garde skipIf (comme a492c44 l'a fait pour les harness admin), ou faux S3 local.
Candidats registre DEV-SETUP §4d / CI-AUDIT : à numéroter (ex. F-16 tests.yml env-dépendant, F-17 weekly build D1) par l'opérateur.

### 7.2 weekly-proof-run.yml — D1 « build standalone » exit 1
```
[d1-proof] 11:00:58 — 1. sonde FTS5 (prérequis bloquant)   ← passée
[d1-proof] 11:00:58 — 2. build standalone
##[error]Process completed with exit code 1.               ← sans message du build
```
La sonde FTS5 passe ; le build standalone échoue silencieusement sur le runner (aucune sortie d'erreur dans le log). Localement ce runner est vert (historique « runner exit 0 »). Piste : sortie d'erreur avalée par le script → à rendre verbeux, puis cause racine (env, DATABASE_URL, next build standalone ?).

## 8. NON TESTÉ (limites de session)

- CI « live » sur d'autres plateformes que le runner ubuntu GitHub Actions ; les 3 fails §7.1 n'ont PAS été reproduits localement (simulation P4 : 0 fail).
- Le comportement de deploy-vps.yml (gate workflow_run) n'est PAS exercé : aucun run main, aucun merge — par conception de mission.
- Safari/Firefox, lecteurs d'écran réels, périphériques physiques : hors périmètre (déjà documentés côté vague E).
- Le fragment §1.5 : aucune action de purge/rewrite tentée (interdite sans instruction).

## 9. Second push (publication du présent rapport)

Commit : `docs: push verification report feat/mbote-v1` (fichier unique docs/proofs/PUSH-feat-mbote-v1.md).
Conséquence : la CI re-déclenche sur ce commit docs-only — les issues §7 (code/environnement) resteront identiques ; ne pas les ré-interpréter comme régression. Résultat du second push : voir le SHA en tête de section si présent, sinon « rapport resté local » (consigne : ce cas n'est pas grave, l'essentiel étant la sauvegarde des 20 phases, déjà acquise).

## 10. Rappel opérateur

**Révoquer le token GitHub dès que ce rapport est lu** (Settings → Developer settings → Tokens). Le token a servi : validation API, 6 pushes (staging ×4, branche réelle ×1, purge refs ×1, + le push du rapport). Aucune autre utilisation.
