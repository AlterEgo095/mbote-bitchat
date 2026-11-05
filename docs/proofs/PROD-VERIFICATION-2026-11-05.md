# AUDIT DE PRODUCTION — VÉRIFICATION POST-PUSH ET POST-DÉPLOIEMENT

**Date** : 2026-11-05 (heure locale Kinshasa WAT / UTC+1 ; preuves UTC)
**Environnement d'audit** : sandbox de développement, lecture seule sur la prod, accès git à `origin`
**Portée exécutée** : §0 uniquement — **audit avorté au premier point, conformément au protocole**

---

## 1. VERDICT GLOBAL

## ⛔ AUDIT AVORTÉ — §0 ROUGE (bloqueur bloquant §0.1 : push effectif absent)

1. **`origin/main` est toujours à `7b51fd5`** — le SHA exact cité par le protocole comme critère d'abort immédiat. Aucun des merges `feat/a1-anti-replay`, `feat/a2-key-auth`, `feat/a3-moderation` n'a eu lieu. Pire : **`feat/a3-moderation` n'a jamais été poussée sur origin**, et a1/a2 ont des commits locaux non poussés (a2 est même divergée, cf. incident I-2).
2. **La production ne sert pas A1/A2/A3** : `/api/trust`, `/api/moderation/queue`, `/api/version` n'existent pas en prod (fallback HTML Next.js). La prod exécute le code de `7b51fd5`, c'est-à-dire le **dernier état validé**.
3. La prod n'est donc **ni cassée ni dégradée** — mais la prémisse de l'audit (« les branches viennent d'être poussées sur origin/main et déployées sur le VPS ») est **fausse**. Il n'y a rien à auditer : le pipeline merge → push → CI → deploy n'a jamais été déclenché.

**GO / NO-GO** : l'audit n'a pas lieu. La prod continue de servir le dernier état connu vert (`7b51fd5`) — aucune urgence opérationnelle. L'action requise est de **compléter le pipeline de livraison** (§5, actions manuelles A-1 à A-6), puis de relancer cet audit intégral.

---

## 2. §0 — PREUVES (4 points, commandes + sorties brutes)

### §0.1 Push effectif — 🔴 ROUGE (BLOQUEUR)

**Commande 1** — SHA de `origin/main` :

```
$ git ls-remote origin main
7b51fd5537f1939dabd2e68b194e8a95f5a2c6d0	refs/heads/main
```

→ C'est exactement `7b51fd5`, le SHA pré-merge. **Critère d'abort immédiat du protocole.**

**Commande 2** — État des branches vs `origin/main` (format `behind<TAB>ahead`) :

```
$ git rev-list --left-right --count origin/main...feat/a1-anti-replay
0	3        # a1 : 3 commits non mergés, pas de divergence
$ git rev-list --left-right --count origin/main...feat/a2-key-auth
0	6        # a2 : 6 commits non mergés, pas de divergence
$ git rev-list --left-right --count origin/main...feat/a3-moderation
0	8        # a3 : 8 commits non mergés, pas de divergence
```

→ Les trois branches sont fusionnables telles quelles (0 commit derrière `main`), mais **aucune n'a été mergée**.

**Commande 3** — État de push des branches elles-mêmes :

```
$ git rev-list --left-right --count origin/feat/a1-anti-replay...feat/a1-anti-replay
0	1        # dc26cca (trace d'incident superviseur) non poussée
$ git rev-list --left-right --count origin/feat/a2-key-auth...feat/a2-key-auth
1	4        # DIVERGENCE : cf. incident I-2
$ git ls-remote origin feat/a3-moderation
(vide, exit 0)     # feat/a3-moderation JAMAIS POUSSÉE sur origin
```

**Commande 4** — Dry-run de merge (local, `git merge-tree --write-tree`, sans écriture de refs) :

```
a1 + a2 : SANS conflit
a1 + a3 : SANS conflit
a2 + a3 : SANS conflit
```

→ Le merge lui-même est prêt et sans conflit ; c'est son **déclenchement** qui n'a jamais eu lieu.

### §0.2 CI verte — ⚪ NON VÉRIFIABLE (accès manquant)

- `gh` CLI absent de l'environnement d'audit : `gh: command not found`.
- API GitHub publique : rate-limitée depuis l'IP du sandbox (sortie brute) :

```
$ curl -s "https://api.github.com/repos/AlterEgo095/mbote-bitchat/actions/runs?branch=main&per_page=5"
{"message":"API rate limit exceeded for 47.57.242.119. (But here's the good news:
 Authenticated requests get a higher rate limit...)"}
```

- De toute façon **moot** : il n'existe pas de commit de merge sur `main` dont on puisse exiger que `tests.yml`, `security.yml`, `deploy-vps.yml` soient verts.

### §0.3 Déploiement effectif — 🔴 ROUGE (par construction) + accès VPS manquant

- `deploy-vps.yml` ne peut pas avoir tourné **après le merge** : il n'y a pas de merge.
- L'environnement d'audit n'a **aucun accès SSH au VPS** (`~/.ssh` inexistant, pas d'entrée pour `95.111.226.63`) : `docker ps`, `crontab -l`, `docker logs`, `PRAGMA integrity_check` etc. sont **des actions manuelles opérateur** (§5) même lorsque l'audit pourra tourner.

### §0.4 Version servie — 🔴 ROUGE

La prod répond et est saine, mais elle sert l'**ancien code** :

```
$ curl -sI https://mbotemesh.aenews.online/
HTTP/2 200
server: cloudflare
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-frame-options: DENY
x-content-type-options: nosniff

$ curl -s -o /dev/null -w "HTTP %{http_code} en %{time_total}s\n" https://mbotemesh.aenews.online/api/posts
HTTP 200 en 0.643393s
```

Sondes lecture-seule sur les routes nouvelles de la livraison :

```
$ curl -s https://mbotemesh.aenews.online/api/version          → HTML (fallback Next.js) — route inexistante
$ curl -s https://mbotemesh.aenews.online/api/trust            → HTML (fallback Next.js) — route inexistante
$ curl -s https://mbotemesh.aenews.online/api/moderation/queue → HTML (fallback Next.js) — route inexistante
```

→ Aucun comportement nouveau unique à cette livraison n'est présent en prod. Cohérence croisée avec le code : dans `main` local (= `7b51fd5`), `src/app/api/trust` et `src/app/api/moderation` **n'existent pas** — ils n'apparaissent que dans les branches A2/A3. La prod correspond exactement au code de `7b51fd5`.

---

## 3. §1–§6 — NON EXÉCUTÉS

Conformément au protocole (« Si §0 n'est pas entièrement vert : STOP. Ne passe pas à §1 »), **aucun test fonctionnel n'a été lancé, aucune écriture effectuée, aucun compte de test créé**.

| Section | Statut | Raison |
|---|---|---|
| §1 Sécurité de prod (XFF, backups, supply chain, headers) | **NON TESTÉ** | Bloqué par §0 ; checks VPS de toute effet nécessitent un accès SSH absent |
| §2 A1 anti-rejeu en prod | **NON TESTÉ** | Les routes A1 ne sont pas déployées |
| §2 A2 auth clés en prod | **NON TESTÉ** | `/api/trust` inexistant en prod (prouvé §0.4) |
| §2 A3 modération en prod | **NON TESTÉ** | `/api/moderation/*` inexistant en prod (prouvé §0.4) |
| §3 Non-régression | **NON TESTÉ** | Audit avorté |
| §4 Intégrité des données | **NON TESTÉ** | Nécessite accès DB VPS (absent) |
| §5 État opérationnel | **NON TESTÉ** | Nécessite accès VPS (absent) ; seule sonde passable : latence HTTPS publique |
| §6 Rollback ready | **PARTIEL, local uniquement** | Cf. ci-dessous |

**§6 éléments rassemblables localement** (lecture seule, sans accès VPS) :
- SHA `origin/main` **avant** le push (dernier commit connu vert) : `7b51fd5` — c'est aussi le SHA **actuel**, puisqu'aucun push n'a eu lieu.
- Réversibilité : sans merge, il n'y a rien à revert. Un `git revert` n'est applicable à rien en prod.
- Backup pré-déploiement : non vérifiable depuis cet environnement (action opérateur).

**Rappel** : un point non testé n'est pas un point vert.

---

## 4. INCIDENTS RENCONTRÉS

| # | Incident | Cause racine | Confiance |
|---|---|---|---|
| I-1 | **Prémisse d'audit fausse** : rien n'a été mergé ni déployé. Le flux merge → push → CI → deploy n'a jamais été déclenché ; les 3 branches sont restées locales (a3 jamais poussée du tout). | Le travail A1/A2/A3 validé en local n'a pas suivi son pipeline de livraison. | Élevée (preuves git directes, §0.1) |
| I-2 | **Divergence `origin/feat/a2`** : le remote porte `0c7d4c3` (poussé 2026-11-04 23:20 UTC), le local porte `9c1fa19` — même message, amend après push. Diff contenu : local = remote **+ 32 lignes** dans `docs/proofs/A1-anti-replay.md` (trace d'incident superviseur). Le local est un surensemble : un `push --force-with-lease` (après relecture du diff) est le chemin propre. | Amend d'un commit déjà poussé sans re-push. | Élevée |
| I-3 | **Pas de `/api/version`** : l'audit §0.4 a dû s'appuyer sur l'absence de routes A2/A3 comme discriminant de version. | Endpoint jamais créé. À ajouter dans la prochaine livraison (commit normal sur `main`, pas de modif manuelle de prod). | Élevée |
| I-4 | **Accès d'audit manquants** : pas de `gh` CLI, quota API GitHub non authentifiée épuisé depuis l'IP du sandbox, pas de SSH VPS. CI et état VPS invérifiables depuis cet environnement. | Environnement d'audit sans identifiants. | Élevée |

---

## 5. ACTIONS MANUELLES RESTANTES (opérateur — commandes exactes)

**A-1. Relecture du diff de divergence a2, puis force-push avec lease** (aucun consommateur de la branche, aucun merge fait) :
```bash
cd /home/z/my-project && git diff 0c7d4c3 9c1fa19   # attendu : uniquement docs/proofs/A1-anti-replay.md (+32 lignes)
cd /home/z/wt-a2 && git push --force-with-lease=feat/a2-key-auth:0c7d4c3 origin feat/a2-key-auth
```

**A-2. Pousser a1 et a3 à jour :**
```bash
cd /home/z/wt-a1 && git push origin feat/a1-anti-replay
cd /home/z/wt-a3 && git push origin feat/a3-moderation
```

**A-3. Merge ordonné et poussé sur `main`** (dry-runs locaux sans conflit prouvés §0.1) :
```bash
cd /home/z/my-project
git checkout main
git merge --no-ff feat/a1-anti-replay && git push origin main
git merge --no-ff feat/a2-key-auth   && git push origin main
git merge --no-ff feat/a3-moderation && git push origin main
```

**A-4. Vérifier CI verte sur le merge final** (`tests.yml`, `security.yml`, `deploy-vps.yml` = `success`) — via l'interface GitHub Actions ou un `gh auth login` + `gh run list --branch main`.

**A-5. Vérifier le déploiement sur le VPS** :
```bash
ssh root@95.111.226.63 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}"'
```
→ statut `Up ... (healthy)`, `CREATED` postérieur au merge.

**A-6. (Recommandé, prochaine livraison)** Ajouter un endpoint `GET /api/version` (SHA + date de build via variable d'environnement injectée au build) pour que le futur §0.4 ait une preuve directe. À faire via commit normal, jamais en modifiant la prod à la main.

**A-7. Relancer cet audit intégral** (§0 → §6) une fois A-1…A-5 verts.

**Commit du présent rapport** (au choix de l'opérateur, avec le lot A-3) :
```bash
cd /home/z/my-project && git add docs/proofs/PROD-VERIFICATION-2026-11-05.md && git commit -m "audit: prod verification 2026-11-05 — avorté à §0 (aucun merge/déploiement effectif)"
```

---

## 6. RÉSIDU DE TEST

- **Tests fonctionnels exécutés** : 0. **Écritures en prod** : 0. **Comptes/contenus de test créés** : 0.
- Comptes `audit-test-*` / `A3-Bob-*` / `CLI-B-*` : **0 par construction** (aucun POST émis vers la prod).
- Signalements de test dans `Report` : 0 (aucun appel à `/api/report`).
- Toutes les commandes exécutées durant cet audit : `git ls-remote`, `git rev-list`, `git log`, `git diff`, `git merge-tree` (dry-run, sans écriture de refs), `git worktree list`, `git show`, `curl` GET lecture-seule (HEAD `/`, GET `/api/posts`, GET `/api/trust`, GET `/api/moderation/queue`, GET `/api/version`, GET api.github.com). **Aucune autre action.**
- Résidu final : **0**.

---

## ANNEXE — Traçabilité

- Preuves collectées le 2026-11-05 ~00:10 UTC (01:10 WAT).
- Repo : `https://github.com/AlterEgo095/mbote-bitchat.git`
- Prod : `https://mbotemesh.aenews.online` (Cloudflare en front, VPS 95.111.226.63 supposé en origine — non vérifiable depuis cet environnement).
- Ce rapport est un livrable d'audit **avorté à §0** ; il ne présume rien sur §1–§6.
