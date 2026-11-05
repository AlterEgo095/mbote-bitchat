# RUNBOOK — `ADMIN_API_KEY` (modération admin A3)

**Décision tranchée (clôture d'incidents 2026-11-05) : option (a)** —
provisionnement via **GitHub Secret** + injection dans le `.env` VPS par
`deploy-vps.yml` (reproductible, auditable, survit aux déploiements).

État tant que le secret n'est pas provisionné : la modération admin est
**DÉSACTIVÉE** en prod — `/api/moderation/queue` et `/api/moderation/action`
répondent **403 uniforme** (défaut sûr, testé : preuve A3-U1a ; aucun accès
admin, aucune fuite sur la nature du refus). Les 7 tests A3 positifs restent
NON TESTÉS jusqu'à provisionnement (cf. PROD-VERIFICATION-2026-11-05.md §3).

---

## 1. Pourquoi le secret GitHub et pas une pose manuelle VPS

L'étape « Environnement de build » du deploy **réécrit** `/opt/mbote-bitchat/.env`
à chaque déploiement (stdin ssh — les secrets ne passent jamais en ligne de
commande). Une clé posée manuellement sur le VPS est donc **perdue au
déploiement suivant**. Le secret GitHub est la seule source durable.

Depuis le 2026-11-05, deux filets rendent l'absence **visible** au lieu de
silencieuse :

1. le run « Déploiement VPS » affiche `::warning::Secret ADMIN_API_KEY absent…`
   tant que le secret n'existe pas ;
2. le `docker-compose.yml` déclare `ADMIN_API_KEY` dans l'`environment` du
   service `mbote` (interpolation depuis le `.env`) — la variable atteint
   désormais le conteneur par le chemin déclaré dans le repo, sans dépendre
   d'un `docker-compose.override.yml` invisible.

## 2. Provisionnement (opérateur, ~2 min)

```bash
# 1. Générer la clé — NE JAMAIS la coller dans un ticket / chat / rapport
openssl rand -hex 24

# 2. Provisionner le secret GitHub (invite interactive — rien dans l'historique shell)
gh secret set ADMIN_API_KEY --repo AlterEgo095/mbote-bitchat
#    Alternative web UI :
#    https://github.com/AlterEgo095/mbote-bitchat/settings/secrets/actions
#    → New repository secret → Name: ADMIN_API_KEY → valeur → Add secret
#    (gh nécessite une auth : gh auth login, ou un token frais — PAS celui
#    de l'audit, à révoquer : voir INCIDENTS-CLOSED-2026-11-05.md)

# 3. Injecter : relancer le déploiement
#    GitHub → Actions → « Déploiement VPS » → Run workflow (workflow_dispatch)
#    (ou tout prochain push main hors docs/ — cf. paths-ignore)
```

## 3. Vérification post-déploiement (preuve re-jouable)

```bash
# a) le .env VPS contient une ligne ADMIN_API_KEY non vide (présence — jamais afficher la valeur)
ssh root@95.111.226.63 "grep -c '^ADMIN_API_KEY=..*' /opt/mbote-bitchat/.env"        # attendu : 1

# b) le conteneur reçoit la variable
ssh root@95.111.226.63 'docker exec mbote-mesh sh -c "test -n \"\$ADMIN_API_KEY\" && echo PRESENT || echo ABSENT"'   # attendu : PRESENT

# c) l'API répond correctement (avec clé / sans clé)
curl -s -o /dev/null -w '%{http_code}\n' -H "x-admin-key: <LA_CLÉ>" https://mbotemesh.aenews.online/api/moderation/queue   # attendu : 200
curl -s -o /dev/null -w '%{http_code}\n' https://mbotemesh.aenews.online/api/moderation/queue                              # attendu : 403
```

Puis **relancer la suite A3 positive** (7 tests : report sur post, queue avec
contexte, hide/unhide, purge + trace, suspend+warn, filtre du feed) — script
d'audit prêt (`/home/z/audit/`), et terminer par le nettoyage du résidu
(`scripts/cleanup-audit-test.ts` + `docs/proofs/cleanup-audit-test-20261105.sql`).

## 4. Rotation

```bash
openssl rand -hex 24                                            # nouvelle valeur
gh secret set ADMIN_API_KEY --repo AlterEgo095/mbote-bitchat    # remplacer
# → Run workflow « Déploiement VPS » — l'ancienne clé meurt avec l'ancien conteneur
```

À faire immédiatement si la clé a transité en clair (chat, ticket, log).

## 5. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `::warning::Secret ADMIN_API_KEY absent` dans le run | secret non créé (ou casse du nom fautive — `ADMIN_API_KEY` exact) | §2 |
| `.env` OK (`grep` = 1) mais conteneur ABSENT (§3b) | conteneur pas recréé après le nouveau `.env` | `docker compose up -d --build` (le fait déjà la CI) ; vérifier qu'aucun override VPS n'écrase `environment` |
| 403 persistant malgré §3a/b | valeur copiée avec whitespace/EOL ; ou ancienne image | re-faire §2 proprement ; vérifier la date du conteneur (`docker ps`) |
| Perte de la clé | elle n'est jamais lisible après coup | §4 : rotation |

## 6. Non-goût (rappel du périmètre A3)

- `ADMIN_API_KEY` est une auth **provisoire** — à remplacer par un RBAC
  complet **avant ouverture publique** (docs/proofs/A3-moderation.md §4).
- La modération admin ne touche **jamais les DM** : E2EE par conception.
- Clé vide ou absente = modération OFF (403 uniforme) — jamais de 500.
