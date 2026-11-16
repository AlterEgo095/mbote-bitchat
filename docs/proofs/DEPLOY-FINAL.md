# DEPLOY-FINAL — Déploiement production O-A (2026-11-16)

**Verdict : GO — les 3 étapes sont réussies et prouvées.**

| Étape | Résultat | Preuve clé |
|---|---|---|
| 1. TURN câblé (coturn + app) | **PASS** | `/api/turn-credentials` → `available:true` ; allocation relay réelle UDP **et** TCP avec les credentials émis par l'application : 0 % de pertes |
| 2. Déploiement main | **PASS** | `origin/main = 6e98bb0…` (FF), workflow « Déploiement VPS » `completed/success`, 14/14 migrations, 3 conteneurs healthy, API 200 |
| 3. nginx 443 Cloudflare-only | **PASS** | bypass direct `curl --resolve` → **403** (externe et local) ; via Cloudflare → **200** ; hub socket.io intact (`sid` émis) |

Aucun secret (token GitHub, mot de passe SSH, `TURN_SHARED_SECRET`, credentials éphémères) n'est imprimé dans ce document ni dans les sorties d'exécution ; valeurs redactées `<…>`.

---

## Étape 1 — Câblage TURN (appels WebRTC, schéma REST coturn)

### 1.1 Secret généré

`TURN_SHARED_SECRET = openssl rand -hex 32` (64 hex), conservé dans un fichier 0600 temporaire, **jamais imprimé**, injecté côté VPS via SFTP (0600, supprimé après application — confirmation d'absence en §1.2) et côté GitHub via chiffrement libsodium sealed box.

### 1.2 Configuration coturn sur le VPS (95.111.226.63)

Commandes appliquées (extraites du script root, secret lu depuis un fichier temporaire 0600, backup conservé) :

```bash
# /etc/turnserver.conf — généré puis :
cp -a /etc/turnserver.conf /etc/turnserver.conf.bak-oa-20261116   # backup de la conf d'origine (fichier par défaut entièrement commenté)
mv /etc/turnserver.conf.new /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf && chmod 640 /etc/turnserver.conf
systemctl restart coturn
```

Contenu posé (secret redacté) :

```conf
listening-port=3478            # TCP+UDP — 443 est occupé par nginx (décision O-A)
external-ip=95.111.226.63
realm=mbotemesh.aenews.online
server-name=mbotemesh.aenews.online
use-auth-secret
static-auth-secret=<TURN_SHARED_SECRET>
rest-api-separator=:           # contrat /api/turn-credentials : username = "<expiry>:<pubkey>"
fingerprint
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
min-port=49152
max-port=65535
simple-log
```

Preuves collectées immédiatement après :

```
conf posée: -rw-r----- root:turnserver | backup: /etc/turnserver.conf.bak-oa-20261116
coturn: active
== écoutes 3478 sur IP publique ==
udp UNCONN 95.111.226.63:3478   (×6)
tcp LISTEN 95.111.226.63:3478   (×6)
== test auth REST + allocation TURN réelle ==
--- allocation UDP --- Total lost packets 0 (0.000000%), total send dropped 0 (0.000000%)
--- allocation TCP --- Total lost packets 0 (0.000000%), total send dropped 0 (0.000000%)
== cleanup temporaires == secret temp SUPPRIMÉ
```

Le test d'allocation est fait avec `turnutils_uclient -y -u "<expiry>:probe-oa" -w "<HMAC>" -p 3478` (UDP) puis `-T` (TCP) : credentials dérivés du secret par HMAC-SHA1 — auth REST coturn validée **sur le serveur**.

### 1.3 Secret GitHub

`PUT /repos/AlterEgo095/mbote-bitchat/actions/secrets/TURN_SHARED_SECRET` → **HTTP 201 (créé)**, vérifié par `GET` (HTTP 200, `updated_at=2026-11-16T16:38:58Z`, valeur jamais exposée). Chiffrement : sealed box avec la clé publique du repo (`key_id=3380204578043523366`).

Le workflow `deploy-vps.yml` l'écrit dans le `.env` du VPS à chaque déploiement (7 variables désormais).

### 1.4 Câblage application — commit `a1da4a8` (2 fichiers, +21/−4)

- `docker-compose.yml` (service `mbote`) :
  - `TURN_URLS=turn:95.111.226.63:3478?transport=udp,turn:95.111.226.63:3478?transport=tcp` (codé en dur : URLs non sensibles ; le domaine est proxifié Cloudflare et ne route pas 3478 → IP publique directe, conformément à la décision « port 3478 TCP/UDP, 443 occupé par nginx »)
  - `TURN_SHARED_SECRET=${TURN_SHARED_SECRET:-}` (via `.env` — le secret ne vit jamais dans le repo)
- `.github/workflows/deploy-vps.yml` : secret `TURN_SHARED_SECRET` ajouté au bloc `.env` (6 → **7 variables**), au mapping `env`, header de documentation, + `::warning::` explicite si le secret est absent (dégradation propre).

Preuve que le conteneur reçoit les variables (noms de vars du `.env`, empreinte conteneur) :

```
== .env (noms seulement) ==
ADMIN_API_KEY, MBOTE_BOT_KEY, NEXT_PUBLIC_SOCKET_URL, RELAY_ALLOWED_ORIGIN,
RELAY_EMIT_TOKEN, SEED_SECRET, TURN_SHARED_SECRET
== vars TURN visibles du conteneur ==
TURN_SHARED_SECRET,TURN_URLS
TURN_URLS: turn:95.111.226.63:3478?transport=udp,turn:95.111.226.63:3478?transport=tcp
```

### 1.5 Preuve bout-en-bout : TURN joignable PAR L'APPLICATION

Sonde `turn-probe.ts` (paire ECDSA P-256 jetable, pré-vol `subtle.verify`, aucune identité persistée) → production via Cloudflare :

```
GET /api/turn-credentials?me=…&ts=…&signature=…  → HTTP 200
available: true
urls: ["turn:95.111.226.63:3478?transport=udp","turn:95.111.226.63:3478?transport=tcp"]
username: <expiry-unix>:<pubkey b64url>  (TTL 600 s)
credential: 28 caractères HMAC-SHA1 base64 (valeur NON imprimée)
```

Puis **allocation relay réelle sur coturn avec ces credentials exactement ceux émis par l'application** (boucle complète app → CF → API → coturn) :

```
--- allocation TURN UDP (credentials émis par l'application) ---
Total lost packets 0 (0.000000%), total send dropped 0 (0.000000%)   → UDP PASS
--- allocation TURN TCP (credentials émis par l'application) ---
Total lost packets 0 (0.000000%), total send dropped 0 (0.000000%)   → TCP PASS
```

Gate fail-closed maintenu : sans preuve de possession de clé → `GET /api/turn-credentials` sans signature → **401** (re-vérifié après déploiement).

---

## Étape 2 — Déploiement (push main, CI, prod)

### 2.1 Manipulation main — fast-forward strict, zéro perte

Constat pré-push : `main` local était `ahead 13` de `origin/main` avec 6 commits d'artefacts cron (`…-cron`) au-dessus du merge-base `77c9752` partagé avec `feat/mbote-v1` (les 7 premiers des 13 étaient déjà des ancêtres de la branche feat). FF strict depuis le `main` local divergé était donc **impossible** ; traitement :

1. Sauvegarde : branche `archive/local-main-cron-pre-oa` = `d0395ff` (les 6 commits cron restent récupérables) ;
2. Vérification que les fichiers re-commités par les artefacts cron (sidebar/use-toast/tailwind.config…) sont absents de `feat/mbote-v1` validée en prod → aucune perte pour Mbote ;
3. `git reset --hard feat/mbote-v1` sur `main` local ;
4. Preuve FF remote : `git merge-base --is-ancestor origin/main main` → **OK** (aucun force push nécessaire).

### 2.2 Push et chaîne CI

```
75e9559..a1da4a8  main -> main   (124 commits ; vérification ls-remote ANONYME = a1da4a8)
```

**Incident #1 (signalé, corrigé)** : le premier `git push` a été un no-op (syntaxe `git push -c …` au lieu de `git -c … push` → usage git-push) — `ls-remote` a prouvé l'absence d'effet avant correction.

**Incident #2 (signalé, corrigé)** — run de déploiement `43910340114` : **failure à la step « Portail qualité — lint + typecheck »** :

```
scripts/verify-mls.ts
  52:10  error  'ab' is defined but never used  @typescript-eslint/no-unused-vars
✖ 1 problem (1 error, 0 warnings)
```

Cause racine : le portail lint+tsc n'appartient qu'au workflow de déploiement (main-only, `workflow_run`) — il n'avait jamais tourné sur `feat/mbote-v1` avant ce premier push main ; la fonction utilitaire `ab()` y était devenue inutilisée. Aucun rsync n'a été effectué pour ce run (step suivante skipped) — **la prod est restée inchangée** pendant l'incident. Fix `6e98bb0` (suppression de 7 lignes de code mort), poussé sur `feat/mbote-v1` puis main :

```
a1da4a8..6e98bb0  main -> main  (vérification ls-remote ANONYME = 6e98bb0)
```

### 2.3 Run de déploiement final — `43911255752` (SHA `6e98bb0`)

Gate F-1 : `Tests — harness adversarial = success` ; `Sécurité — analyse des vulnérabilités = success` ; Schema guard = success.

Steps (extrait) :

```
Gate F-1 ……………………………………………………… completed/success
Bun (portail qualité) ………………………………… completed/success
Portail qualité — lint + typecheck ……………… completed/success
Empreinte du déploiement …………………………… completed/success
Synchroniser le code (rsync du SHA testé) …… completed/success
Environnement de build (.env — 7 variables) …… completed/success
Build & démarrage ……………………………………… completed/success
Vérification santé …………………………………… completed/success
→ Déploiement VPS: completed/success
```

### 2.4 Vérification post-déploiement (SSH, lecture seule)

```
== conteneurs mbote ==
mbote-mesh | Up 3 minutes (healthy)      ← recréé par ce déploiement
mbote-admin| Up 23 hours (healthy)       ← image/config inchangées (compose idempotent)
mbote-relay| Up 23 hours (healthy)       ← image/config inchangées
== migrations Prisma ==
migrations enregistrées: 14 | non terminées: 0 | dernière: 20261115100000_0012_g_i18n_preferences
== empreinte déployée ==
6e98bb00ec68446577a4d4f549555e7a891090d6
== API locale ==
GET /api/stats 127.0.0.1:3390 → HTTP 200
```

**14/14 migrations appliquées, 0 en cours ; 3/3 conteneurs healthy ; le SHA déployé = le SHA poussé.**

### 2.5 API en production (via Cloudflare)

```
GET /api/posts?scope=global&limit=5 → HTTP 200          (texte)
GET /api/stats                      → HTTP 200
GET /api/media/download-url         → HTTP 503 {"error":"Stockage média non configuré (MEDIA_S3_* absent) — lecture indisponible"}
GET /api/turn-credentials (sans preuve) → HTTP 401
```

### 2.6 Note S3 — mode dégradé conforme

`.env` prod ne contient aucune variable `MEDIA_S3_*` (noms listés en §1.4) : l'application démarre **healthy** et les médias échouent **proprement** en 503 contrôlé (message explicite, pas de crash) ; texte, appels (TURN opérationnel, §1.5) et admin fonctionnent. Exactement le comportement demandé.

---

## Étape 3 — Sécurisation nginx (bypass direct-origine bloqué)

### 3.1 Correction d'implémentation importante (constat d'audit appliqué correctement)

Le vhost mbote hérite de `conf.d/02-cloudflare-realip.conf` (`real_ip_header CF-Connecting-IP`, `real_ip_recursive on`) : **`$remote_addr` est réécrit en IP client réelle**, donc un bloc naïf `allow <plages CF>; deny all;` aurait bloqué **100 % du trafic légitime** (évalué après restauration realip). La forme correcte sous realip est le module `geo` sur `$realip_remote_addr` (IP TCP d'origine, non réécrite) — c'est l'équivalent exact du `allow …; deny all;` demandé :

```nginx
# top du vhost (contexte http)
geo $realip_remote_addr $mbote_not_cf {
    default 1;
    # plages Cloudflare officielles (www.cloudflare.com/ips-v4 + ips-v6)
    173.245.48.0/20 0;  103.21.244.0/22 0;  103.22.200.0/22 0;  103.31.4.0/22 0;
    141.101.64.0/18 0;  108.162.192.0/18 0; 190.93.240.0/20 0;  188.114.96.0/20 0;
    197.234.240.0/22 0; 198.41.128.0/17 0;  162.158.0.0/15 0;   104.16.0.0/13 0;
    104.24.0.0/14 0;    172.64.0.0/13 0;    131.0.72.0/22 0;
    2400:cb00::/32 0;   2606:4700::/32 0;   2803:f800::/32 0;   2405:b500::/32 0;
    2405:8100::/32 0;   2a06:98c0::/29 0;   2c0f:f248::/32 0;
}

# dans server { listen 443 ssl http2; … }
if ($mbote_not_cf = 1) { return 403; }
```

### 3.2 Application et validation

```bash
cp -a /etc/nginx/sites-enabled/mbotemesh.aenews.online.conf \
      /etc/nginx/sites-enabled/.mbotemesh.conf.bak-oa-20261116     # backup
# vhost patché posé, puis :
nginx -t          # → "syntax is ok / test is successful"
systemctl reload nginx
```

Rollback automatique prévu (si `nginx -t` échouait, restaurer le backup + reload) — non déclenché.

### 3.3 Preuves

```
== depuis un réseau externe (le test décisif) ==
curl --resolve mbotemesh.aenews.online:443:95.111.226.63 https://…/api/stats → HTTP 403   (bypass direct BLOQUÉ)
https://mbotemesh.aenews.online/api/stats                                    → HTTP 200   (via Cloudflare, trafic légitime intact)

== depuis le VPS, après transition du reload (voir §3.4) ==
curl --resolve via 127.0.0.1       → HTTP 403
curl --resolve via 95.111.226.63   → HTTP 403
socket.io polling direct local     → HTTP 403

== trafic légitime via CF ==
GET /socket.io/?EIO=4&transport=polling → HTTP 200 + {"sid":"A7fBa-MizJ-…","upgrades":["websocket"],…}
```

Le hub temps réel reste pleinement joignable par les clients via Cloudflare.

### 3.4 Écart transitoire observé puis résolu (transparence)

Les deux premiers `curl` locaux lancés dans la même seconde que le `reload` ont renvoyé 200 : workers de l'ancienne génération en **graceful shutdown** ont encore servi ces requêtes. Re-test immédiat après la transition : **403 partout** (§3.3). Aucun défaut de configuration — la preuve externe (403) était déjà acquise au moment du constat.

Remarque : le test `curl` d'upgrade WebSocket brut renvoie 400 (émulation incomplète du handshake engine.io par curl — artefact connu, non lié au bloc CF qui est IP-based) ; le WS réel via nginx+CF avait été validé bout-en-bout dans l'audit précédent (upgrade + handshake + close 1000) et le polling 200+sid confirme la route.

---

## Hygiène des secrets

- Token GitHub et mot de passe SSH : fichiers 0600 temporaires uniquement, jamais en clair dans les sorties/preuves/URLs ; **shred final en fin d'opération** (confirmation d'absence en fin de session).
- `TURN_SHARED_SECRET` : généré, injecté VPS + GitHub sealed box, jamais imprimé ; fichier temporaire du VPS supprimé (vérifié) ; `.secret` local shred final.
- Credentials TURN éphémères : jamais imprimés (longueur seule) ; fichier d'interpolation local shred final.
- `/etc/turnserver.conf` (640 root:turnserver) et `.env` (600) sur le VPS contiennent le secret, comme prévu par l'architecture.

## État final de production

| Élément | État |
|---|---|
| `origin/main` | `6e98bb0…` (= `feat/mbote-v1`, FF, vérifié anonymement) |
| Déployé sur le VPS | `6e98bb0…` (empreinte `.deploy-commit`) |
| Conteneurs | mbote-mesh / mbote-relay / mbote-admin — 3/3 healthy |
| Migrations Prisma | 14/14 appliquées, 0 non terminée (`0012_g_i18n_preferences`) |
| API | `/api/stats` 200, `/api/posts` 200 (via Cloudflare) |
| Médias (S3 absent) | 503 propre, mode dégradé conforme |
| TURN | coturn actif 3478 TCP+UDP publics ; `/api/turn-credentials` `available:true` ; allocation relay UDP+TCP réelle 0 % pertes |
| nginx 443 | réservé aux plages Cloudflare ; bypass direct → 403 ; hub socket.io intact |
| Backups | `/etc/turnserver.conf.bak-oa-20261116`, `/etc/nginx/sites-enabled/.mbotemesh.conf.bak-oa-20261116` |
| Archive | `archive/local-main-cron-pre-oa` (commits cron pré-push, aucun travail Mbote perdu) |

**Reste à l'opérateur (hors périmètre de cette session)** : provisionner `MEDIA_S3_*` (S3 réel) et `ADMIN_API_KEY` (modération admin — actuellement OFF par défaut sûr, `::warning::` CI) ; renouveler/révoquer le token GitHub utilisé (scopé `repo, workflow, write:packages`) selon la procédure de révocation documentée.
