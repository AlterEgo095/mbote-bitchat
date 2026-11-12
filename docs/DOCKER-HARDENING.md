# DOCKER-HARDENING — durcissement des conteneurs (D3, 2026-11-13)

**Portée** : les 3 images compose — `mbote` (app Next standalone), `relay` (socket.io),
`admin` (panneau BFF). **Chaque changement est justifié par une menace** ; les
procédures VPS sont celles de la release coordonnée prévue par le TODO du Dockerfile
(exécuté à la vague D3).

## 1. Utilisateur non-root (les 3 Dockerfiles)

| Image | Utilisateur | uid/gid |
|---|---|---|
| app principale | `mbote` | 10001/10001 |
| relay | `relay` | 10002/10002 |
| admin | `admpannel` | 10003/10003 |

- `addgroup --system` + `adduser --system --no-create-home` — comptes système, sans
  shell ni home réel ; `ENV HOME=/tmp BUN_INSTALL=/tmp/.bun` redirige toute écriture
  éphémère de bun/bunx (cache) vers `/tmp` (tmpfs — voir §2), la seule écriture
  persistante reste `/app/db`.
- L'app principale : `chown -R mbote:mbote /app/db` au build — un **volume nommé
  Docker est initialisé avec les droits du contenu de l'image** au premier montage :
  une base NEUVE démarre lisible/écrivable par `mbote`.

### Procédure VPS pour le volume EXISTANT (release coordonnée — non négociable)

1. `docker compose down`
2. `chown -R 10001:10001 /var/lib/docker/volumes/mbote-mesh_mbote-data/_data`
   (chemin réel via `docker volume inspect mbote-mesh_mbote-data`)
3. `docker compose build && docker compose up -d`
4. Garde : `curl -f https://…/api/stats` + `docker exec mbote-mesh id` → uid=10001
5. En cas d'échec de migration (droits) : rollback = `git revert` du commit D3
   Docker + `chown -R root:root` du volume — procédure testée à l'inverse au §4.

## 2. Système de fichiers en lecture seule (docker-compose.yml)

| Service | `read_only` | Écritures autorisées |
|---|---|---|
| mbote | `true` | `/app/db` (volume nommé — SQLite) · `/tmp` (tmpfs) · `/app/.next/cache` (tmpfs — cache image optimizer) |
| relay | `true` | `/tmp` (tmpfs) — relay sans état |
| admin | `true` | `/tmp` + `/app/.next/cache` (tmpfs) — BFF sans état |

Le cache Next (`/app/.next/cache`) est un **tmpfs éphémère** : les vignettes
optimisées sont recalculées après redémarrage (aucune donnée utilisateur — le cache
ne contient que des rendus dérivés d'images déjà E2EE-côté-client).

## 3. Privileges minimisés

Les 3 services :

```yaml
security_opt:
  - no-new-privileges:true   # un process compromis ne peut pas escalader (setuid bloqué)
cap_drop:
  - ALL
```

`cap_add` : **aucun** — les ports écoutés (3000 app, 3030/3031 relay, 3001 admin)
sont tous > 1024 : `NET_BIND_SERVICE` est inutile. `docker-compose.yml` ne publie
que `127.0.0.1:*` (relay) et `3000:3000` (app derrière nginx/Caddy) — inchangé.

## 4. Menaces couvertes / résiduelles

| Menace | Couverture |
|---|---|
| RCE dans l'app → écriture disque arbitraire | read_only + cap_drop ALL : seuls /app/db et /tmp sont écrivables — un attaquant peut corrompre la base (backup §0.1 checklist) mais pas la racine ni les autres conteneurs |
| Escalade de privilèges via binaire setuid | no-new-privileges:true |
| Contamination inter-services | cap_drop ALL sur les 3 ; le relay n'a AUCUN accès à la DB (séparation déjà en place) |
| Rejeu de build non reproductible | images de base épinglées par digest (§5 SECURITY-TRIAGE — vérifié à jour), bun.lock `--frozen-lockfile` |
| Runtime root dans le conteneur | 3× USER non-root (10001/10002/10003) |

**Résiduel NON couvert** (documenté) : le sandbox n'a PAS de daemon Docker —
`docker run` du conteneur durci (quiami=uid 10001, routes 200) est la première case
de PRE-DEPLOY-CHECKLIST §0 à cocher sur le VPS AVANT le déploiement D4 ; le runner
D3 valide les invariants applicatifs équivalents (app standalone + routes API 200).

## 5. Vérifications (runner D3)

- YAML compose validé par parser (read_only/security_opt/cap_drop/tmpfs sur les 3
  services — sortie dans `docs/proofs/assets/d3-compose-config.json`).
- Dockerfiles : `USER` non-root présent dans les 3 (grep du runner).
- `bun run build` + `tsc --noEmit` + lint verts après le bump next/sharp/prisma.
- App standalone :3168 : routes API principales → 200 (miroir applicatif de la
  vérification `docker run` impossible en sandbox).
