# CLÔTURE DES INCIDENTS — 5 ITEMS AVANT TOUTE NOUVELLE PHASE

**Date** : 2026-11-05 (Kinshasa WAT / preuves UTC)
**Précédé de** : `docs/proofs/PROD-VERIFICATION-2026-11-05.md` (GO conditionnel, incidents I-1/I-2)
**Portée de ce document** : les 5 fermetures exigées avant la phase suivante (B1) :
nettoyage prod · ADMIN_API_KEY · révocation token · défaut 1 (migrations) · défaut 2 (mobile/).
**Aucune phase de code (B1/A5/A4) n'est démarrée dans cette livraison.**

---

## 0. VERDICT D'ENSEMBLE

| # | Item | Statut |
|---|---|---|
| 1 | Nettoyage prod `audit-test-*` | 🟡 **DEFERRED (opérateur)** — outillage prêt + validé ; pas d'accès SSH côté audit ; l'audit n'est **pas clos** sans confirmation |
| 2 | `ADMIN_API_KEY` en prod | ✅ **CLOSED (implémentation)** — option **(a)** implémentée ; provisionnement = 1 commande opérateur (§3.2) |
| 3 | Révocation token GitHub | 🔴 **OUVERT — ACTION URGENTE** — token vérifié **ENCORE ACTIF** (HTTP 200) ; je ne l'ai plus utilisé du tout ; révocation = opérateur (§4) |
| 4 | Défaut 1 — migrations non versionnées | ✅ **CLOSED** — règle doc + `schema-guard.yml` (PR **et** push main) + healthcheck migration ; logique validée localement (5 cas) |
| 5 | Défaut 2 — `mobile/` exclu du rsync | ✅ **CLOSED** — choix explicite : **sync gardé + warning doc** (justifié §6) |

**Gate respecté** : B1 ne démarre pas tant que les items 1, 2 (provisionnement), 3 ne sont pas confirmés fermés.

---

## 1. ITEM 1 — Nettoyage final du résidu de test en prod

### Action prise
- Pas d'accès SSH au VPS (`~/.ssh` inexistant côté audit — inchangé aujourd'hui) → **exécution impossible depuis ici**, par conception du protocole (pas d'action irréversible à l'aveugle).
- Deux livrables prêts, **validés localement contre le schéma réel** (DB construite par `prisma migrate deploy` depuis les migrations 0001–0003, puis seed synthétique calqué sur le résidu prod exact : 3 réels + 8 `audit-test-20261105-*`, 8 DMs de test, paires TrustedKey/PeerBlock/ReplayCounter) :
  - **Chemin A (recommandé)** — `scripts/cleanup-audit-test.ts` : dry-run par défaut, preuves `SELECT COUNT(*)` AVANT/APRÈS en sortie brute, transaction unique, `PRAGMA integrity_check`, exit≠0 si résidu non nul.
  - **Chemin B** — `docs/proofs/cleanup-audit-test-20261105.sql` : SQL brut prêt-à-copier.
- **Décisions de sécurité SQL** (vs. l'ébauche du rapport d'audit §6.C) : la ligne `DELETE FROM ReplayGuard WHERE id NOT IN (SELECT DISTINCT guardId …)` est **retirée** — la colonne n'existe pas (ReplayGuard n'a aucun lien vers les identités, `id` = SHA-256 du tuple, auto-expiration < 24 h) ; `PeerBlock` purge les deux directions (`blockerKey` **et** `blockedKey`) ; `ModerationAction` n'est **jamais** supprimée (journal d'audit A3 — les traces subsistent même après purge ; 0 attendu, contrôle seul).

### Preuve re-jouable (locale, sortie brute)
DB test = migrations réelles 0001–0003 + seed synthétique. Script passé par **stdin** (`bun run -`) — exactement la commande opérateur, l'image `oven/bun` n'ayant ni `sqlite3` CLI ni `/app/scripts` :

```
$ DATABASE_URL="file:/tmp/cleanup-test.db" bun run - < scripts/cleanup-audit-test.ts     # DRY-RUN
   users_test                 = 8      trusted_keys               = 2
   dms_test                   = 8      peer_blocks                = 1
   replay_counters            = 1      reports_test               = 0
── DRY-RUN : relancer avec CLEANUP_APPLY=1 …        exit=1 (résidu non nul → alerte)

$ DATABASE_URL="file:/tmp/cleanup-test.db" CLEANUP_APPLY=1 bun run - < scripts/cleanup-audit-test.ts
── Transaction COMMITée (6 DELETE) ✅
   users_test = 0 · dms_test = 0 · trusted_keys = 0 · peer_blocks = 0 · replay_counters = 0 · reports_test = 0
── PRAGMA integrity_check : ok                        exit=0  ✅ RÉSIDU = 0

$ survie des données réelles : users = utilisateur-1…3 ; dms restants = dm-real   ✅
$ 2e APPLY : « résidu déjà à 0 », exit=0   (idempotent)                            ✅
$ chemin B (SQL brut via stdin, db.exec multi-statements) : users=3 · dms=1 (réel)  ✅
```

### Preuve « avant » côté prod (API, lecture seule)
```
$ curl -s https://mbotemesh.aenews.online/api/stats          # 2026-11-05T06:04Z
{"users":11,"posts":1,"dms":8,"channels":0,"likes":2,"gateways":1,"meshIngest24h":2,…,"uptimeSec":20075}
```
`users:11` = 3 réels + **8** `audit-test-20261105-*` · `dms:8` = les DMs de test · `posts:1` inchangé (0 post d'audit) — conforme à la comptabilité §5 du rapport d'audit.

### Commandes opérateur (exécution + preuve)
```bash
# 1) AVANT — dry-run, aucune écriture (sortie = preuve « avant », attendu 8/8/…)
ssh root@95.111.226.63 'docker exec -i mbote-mesh bun run -' < scripts/cleanup-audit-test.ts
# 2) APPLICATION — sortie = preuve « après » (attendu 0 partout + integrity ok + exit 0)
ssh root@95.111.226.63 'docker exec -i -e CLEANUP_APPLY=1 mbote-mesh bun run -' < scripts/cleanup-audit-test.ts
# 3) Contrôle indépendant via API (attendu : users:3, dms:0)
curl -s https://mbotemesh.aenews.online/api/stats
```

### Statut : 🟡 DEFERRED (opérateur) — justification
Le protocole l'exige : « si pas d'accès SSH direct, fournir le SQL prêt à copier et signaler l'action comme opérateur — ne pas clore l'audit sans confirmation ». L'outillage est prêt et validé ; la clôture de cet item attend la **sortie brute APPLY + le contrôle API** collés en confirmation.

---

## 2. ITEM 2 — `ADMIN_API_KEY` en prod : tranche maintenant

### Choix explicite : **option (a)** — GitHub Secret + injection au déploiement
Recommandée par la directive ; reproductible et auditable ; seule source qui **survit aux déploiements** (l'étape .env du deploy réécrit `/opt/mbote-bitchat/.env` à chaque run — une clé posée à la main est perdue au deploy suivant).

### Actions prises (code + docs)
1. **`deploy-vps.yml`** — l'étape « Environnement de build » passe à **6 variables** : `ADMIN_API_KEY` (secret) est écrite dans le `.env` VPS ; `::warning::` visible sur **chaque run** tant que le secret est absent (« modération admin DÉSACTIVÉE… Provisionner : gh secret set… ») ; message final explicite (6 variables vs 5).
2. **`docker-compose.yml`** — découverte connexe corrigée : `SEED_SECRET`, `MBOTE_BOT_KEY`, `ADMIN_API_KEY` existaient dans le `.env` mais n'étaient **déclarées nulle part** dans l'`environment` du service `mbote` (aucun `env_file` dans le repo — elles ne pouvaient atteindre le conteneur que via un override VPS invisible). Elles sont désormais déclarées explicitement (interpolation `${VAR:-}` — le même mécanisme que `RELAY_EMIT_TOKEN` déjà en place). **À vérifier par l'opérateur** : si aucun override n'existait, F-02/F-29 étaient silencieusement dégradés en prod ; après le prochain deploy, contrôler `docker exec mbote-mesh env` (RUNBOOK §3).
3. **`docs/RUNBOOK-ADMIN-KEY.md`** (nouveau) — décision, justification, provisionnement (`gh secret set` interactif, jamais dans un chat/ticket), vérification re-jouable (`.env` → env conteneur → API 200/403), rotation, dépannage, périmètre A3 (jamais les DM ; RBAC avant ouverture publique).
4. **`docs/CI-CD.md`** — table des secrets complétée (`MBOTE_BOT_KEY`, `ADMIN_API_KEY`).

Comportement sûr inchangé d'ici provisionnement : clé absente/vide → **403 uniforme timing-safe** (vérifié dans `src/lib/mbote/moderation.ts` — `isAdminKey` : `!expected → false`), jamais de 500.

### Preuve re-jouable
- YAML validé : `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-vps.yml'))"` → OK (les 3 fichiers YAML modifiés).
- Chaîne secrète : secret GitHub → `${{ secrets.ADMIN_API_KEY }}` (env du step) → stdin ssh → `.env` (chmod 600) → interpolation compose → `environment` conteneur → `process.env.ADMIN_API_KEY` → 403/200. Le code applicatif est déjà testé (A3-U1a : absence → 403).

### Ce qui reste (1 commande opérateur)
```bash
openssl rand -hex 24 && gh secret set ADMIN_API_KEY --repo AlterEgo095/mbote-bitchat   # coller la valeur à l'invite
# puis : Actions → « Déploiement VPS » → Run workflow
# puis : RUNBOOK §3 (3 vérifications) + relance des 7 tests A3 positifs + nettoyage item 1
```

### Statut : ✅ CLOSED (implémentation) — provisionnement en attente d'opérateur (1 commande, RUNBOOK §2)

---

## 3. ITEM 3 — Révocation du token GitHub

### Vérification (2026-11-05T06:07Z, sortie brute)
```
$ curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token ghp_…WBg" https://api.github.com/user
200        ← TOKEN ENCORE ACTIF
```

### Constat honnête
Le rapport d'audit (§7) disait : « retiré de la config git locale à la clôture » — c'était vrai, mais la **révocation côté GitHub n'a jamais eu lieu**. Trois mentions sans fait : ce point était ouvert et le reste.

### Actions prises (cette session)
- **Le token n'a plus été utilisé du tout** — zéro push, zéro appel API authentifié, zéro secret GitHub posé avec (aucune action privilégiée avec un credential connu comme compromis).
- Tous les livrables de cette session sont **commités localement** (pas de push) — voir §8 pour les commandes.
- Procédure de révocation fournie ci-dessous.

### Action opérateur (URGENTE — la seule qui « ne peut pas attendre »)
```text
1. Ouvrir https://github.com/settings/tokens
2. Repérer le token (le nom donné à sa création ; le suffixe correspondant est …WBg)
3. Delete / Revoke
4. Confirmation re-jouable (attendu : 401) :
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token ghp_3k0z…WBg" https://api.github.com/user
```
(PAT classique : la révocation n'est **pas** exposée à l'API par GitHub — d'où l'action web UI. Après révocation, tout push/dépôt de secret passera par un nouveau credential — idéalement fine-grained, durée courte, scope `contents:write` + `secrets:write` seulement.)

### Statut : 🔴 OUVERT — action opérateur immédiate ; CLOSED dès le curl 401 collé en confirmation

---

## 4. DÉFAUT 1 — Divergence migration (`db push` vs `migrate deploy`) : durcissement systémique

### Actions prises
1. **`docs/DEV-SETUP.md` §4 (nouveau)** — interdiction stricte de `prisma db push` pour **toute modification de schéma** ; obligatoire : `bunx prisma migrate dev --name <phase>` + commit du dossier `prisma/migrations/<n>_<phase>/` dans la PR de la phase ; seule exception explicite : provisioning de DB **éphémère** sur schéma déjà versionné (CI `db/ci-test.db`, worktrees §2a — annoté sur place). Incident I-2 cité comme cause racine.
2. **`.github/workflows/schema-guard.yml` (nouveau)** — déclenché sur **PR vers main ET push main** (le pipeline réel de ce projet merge en local puis pousse — un garde PR-seul n'aurait jamais servi) : si `prisma/schema.prisma` diffère de la base et qu'aucun fichier `prisma/migrations/**` n'est ajouté → **échec avec message clair** (cite I-2, l'interdit, l'obligatoire, DEV-SETUP §4). Actions épinglées par SHA (supply chain, condition 6). `permissions: contents: read`.
3. **Healthcheck post-migration (`docker-compose.yml`)** — le healthcheck du service `mbote` exécute maintenant `SELECT 1 FROM _prisma_migrations WHERE finished_at IS NOT NULL LIMIT 1` **et** le check HTTP `/api/stats` : le conteneur ne passe `healthy` que si une migration est réellement appliquée. Implémentation `bun:sqlite` (builtin — l'image `oven/bun` n'a pas de CLI `sqlite3`), ouverture `readonly` (le healthcheck n'écrit jamais). `start_period` 20 s → 30 s (couvre le `migrate deploy` du CMD).

### Preuves re-jouables (locales, sorties brutes)
**Healthcheck** — snippet exact du compose, 3 cas :
```
A) DB avec migrations 0001–0003 appliquées : exit=0  (healthy — barrière migration passée + API 200)
B) DB avec _prisma_migrations VIDE (0 migr. terminée) : exit=1
   → « migrations non appliquees (_prisma_migrations vide) »
C) DB sans la table (legacy db push) : exit=1 → « SQLiteError: no such table: _prisma_migrations »
```

**Schema guard** — logique exacte du workflow rejouée dans un clone jetable (5 cas) :
```
CAS 1 : schema.prisma modifié, 0 migration ajoutée      → schema=1 migrations=0 → ROUGE ✅
CAS 2 : migration versionnée ajoutée                    → schema=0 migrations=1 → VERT  ✅
CAS 3 : aucun changement                                → schema=0 migrations=0 → VERT (skip) ✅
CAS 4 : merge --no-ff (schema+migration ensemble)       → schema=1 migrations=1 → VERT  ✅  ← forme réelle du pipeline
CAS 5 : merge d'un commit rogue (schema sans migration) → schema=1 migrations=0 → ROUGE ✅
```

**Qualité** : `bun run lint` 0 erreur · `bunx tsc --noEmit` OK · YAML des 3 fichiers validé (`yaml.safe_load`).

### Ce qui reste (test CI réel)
Le test « PR factice → CI rouge » sur GitHub nécessite un credential valide — **volontairement non fait** avec le token compromis. Deux chemins : (i) l'opérateur crée la PR factice (commandes ci-dessous), ou (ii) le garde fera ses preuves sur le premier vrai PR/push touchant le schéma (B1 modifie `schema.prisma` → le garde s'exécutera réellement).
```bash
git checkout -b test/guard-rouge && printf '\n// test\n' >> prisma/schema.prisma && git commit -am "test: schema sans migration" && git push -u origin test/guard-rouge
# → Schema guard ROUGE attendu sur la PR vers main (et Tests vert) → fermer la PR sans merger
```

### Statut : ✅ CLOSED (code + doc + filet prod + preuves locales) — run CI de démonstration reporté sur PR factice/next-phase (justification ci-dessus)

---

## 5. DÉFAUT 2 — `mobile/` exclu du rsync : choix tranché

### Choix explicite : **garder le sync `mobile/` + warning documenté** (pas l'option « parité hors build prod »)
Justification : (1) la garde de parité **a joué son rôle** dans I-1 — elle a refusé de construire un miroir divergent ; la déplacer hors du build prod recréerait le risque d'une divergence silencieuse ; (2) sortir `mobile/` du typecheck du build exigerait de retoucher `tsconfig`/Dockerfile **sans possibilité de tester le build VPS** depuis le sandbox (pas de docker, pas de push) — exactement le type de changement structurel non vérifiable que la discipline du projet interdit ; (3) la parité est **déjà** vérifiée en CI indépendamment (`tests.yml` → `bun scripts/check-protocol-parity.ts`) — l'option « workflow dédié » est donc partiellement en place, et le coût du sync restant est nul (un dossier de ~quelques fichiers source).

### Action prise
`docs/DEV-SETUP.md` **§5 (nouveau)**, avec le libellé exigé :
> **`mobile/src/core/` est sync vers le VPS car le build Docker typecheck le miroir pour la parité protocole. Ne pas ré-exclure sans mettre à jour le script de parité.**

+ historique de l'incident I-1 (run 41940394873) et rappel de la double garde (typecheck build + CI parité).

### Statut : ✅ CLOSED (une des deux options, implémentée et documentée)

---

## 6. DÉCOUVERTES ANNEXES (honnêteté d'audit)

1. **Token jamais révoqué** (cf. §3 ci-dessus) — la mention du rapport d'audit §7 était ambiguë ; désormais explicite : révocation NON faite, à faire MAINTENANT.
2. **`SEED_SECRET`/`MBOTE_BOT_KEY` possiblement jamais arrivés au conteneur de prod** : déclarés nulle part dans le compose du repo (aucun `env_file`), donc dépendaient d'un `docker-compose.override.yml` VPS invisible. Corrigé par déclaration explicite (`docker-compose.yml`) ; contrôle opérateur après prochain deploy : `docker exec mbote-mesh sh -c 'test -n "$SEED_SECRET" && echo PRESENT'` (idem `MBOTE_BOT_KEY`). Si ABSENT avant ce fix : F-02 (garde du seed) et F-29 (chiffrement au repos du bot) étaient silencieusement dégradés — à vérifier et, le cas échéant, re-migrer le bot (`bot-key.ts` migre au boot).
3. **Piège §2a attrapé en live** : pendant les tests locaux, le `DATABASE_URL` global du sandbox a écrasé ma cible `/tmp/*.db` (dry-run exécuté sur la mauvaise DB — sans écriture). Le pattern « surcharge explicite sur CHAQUE commande » a de nouveau prouvé sa nécessité ; corrigé en appliquant le pattern, comme documenté.

---

## 7. ACTIONS OPÉRATEUR — DANS L'ORDRE (chemin vers la clôture complète)

| # | Action | Commande / lien | Débloque |
|---|---|---|---|
| O-1 | **Révoquer le token** (URGENT) | https://github.com/settings/tokens → Delete (token …WBg) ; preuve : `curl` → **401** | Item 3 ; tout le reste |
| O-2 | **Pousser les commits locaux** (nouveau credential) | `cd /home/z/my-project && git push origin main` | CI/deploys des fixes |
| O-3 | **Nettoyage prod** (item 1) | dry-run puis `CLEANUP_APPLY=1` (§1) ; coller les sorties brutes + `curl /api/stats` (attendu users:3, dms:0) | Clôture de l'audit (GO plein possible) |
| O-4 | **Provisionner `ADMIN_API_KEY`** (item 2) | RUNBOOK §2 (2 min) puis Run workflow « Déploiement VPS » ; vérifs RUNBOOK §3 | 7 tests A3 positifs |
| O-5 | **Relancer les 7 tests A3 positifs** + re-vérif des vars conteneur (`SEED_SECRET`, `MBOTE_BOT_KEY`) | script d'audit prêt (`/home/z/audit/`) ; RUNBOOK §3 | GO conditionnel → **GO plein** |
| O-6 | (optionnel) PR factice schema-guard | commandes §4 | Démonstration CI du garde avant B1 |
| O-7 | Si SSH donné un jour : `docker ps`, `crontab -l`, `integrity_check` (§6 du rapport d'audit) | commandes déjà fournies | §1/§4/§5 du rapport d'audit |

---

## 8. TRAÇABILITÉ DE CETTE LIVRAISON

**Fichiers créés** : `.github/workflows/schema-guard.yml` · `docs/RUNBOOK-ADMIN-KEY.md` · `scripts/cleanup-audit-test.ts` · `docs/proofs/cleanup-audit-test-20261105.sql` · `docs/proofs/INCIDENTS-CLOSED-2026-11-05.md` (ce fichier).
**Fichiers modifiés** : `.github/workflows/deploy-vps.yml` (6 vars + warning) · `docker-compose.yml` (3 vars d'environment + healthcheck migration) · `docs/DEV-SETUP.md` (§2a annoté, §4 migrations, §5 mobile) · `docs/CI-CD.md` (table secrets).

**Git** : commits **locaux** sur `main` — **aucun push cette session** (token compromis actif, interdit d'usage). Poussée = O-2.
**Lint/typecheck** : `bun run lint` 0 erreur · `bunx tsc --noEmit` OK.
**Impact prod de cette livraison** : aucun tant que pas poussée ; au prochain deploy : healthcheck durci (conteneur healthy seulement si migration appliquée — la prod actuelle a 0003 appliquée, donc healthy), `.env` à 6 variables (warning si ADMIN_API_KEY absent), `SEED_SECRET`/`MBOTE_BOT_KEY`/`ADMIN_API_KEY` déclarées dans l'environment du conteneur.

**Gate B1** : pas démarré. Il ne démarrera qu'après confirmation de O-1 (token révoqué, curl 401), O-3 (résidu = 0 prouvé) et O-4 (clé provisionnée + 7 tests A3 verts, O-5). Une base polluée produirait des preuves média indiscernables du bruit de test — c'est exactement ce que la directive interdit.
