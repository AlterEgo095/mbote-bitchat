# Déployer Mbote Mesh sur un VPS

L'application tourne en **deux conteneurs** : `mbote` (Next.js standalone + SQLite via
Prisma, push du schéma automatique au démarrage) et `relay` (hub temps réel socket.io).
Aucun service externe requis.

## 1. Architecture : deux conteneurs

```
navigateurs ⇄ Caddy/nginx :443 ─┬─► mbote:3000  (HTTP — pages + API)
                                └─► relay:3030  (WebSocket socket.io)

mbote ── POST /emit ──► relay:3031   (interne, réseau Docker, fire-and-forget)
```

- **mbote** (`mbote-mesh`, port 3000) : pages, API REST (`/api/posts`, `/api/dms`…),
  SQLite dans le volume `mbote-data`.
- **relay** (`mbote-relay`) : hub socket.io du temps réel.
  - Port **3030** : connexions navigateurs (WebSocket/polling). Publié sur
    `127.0.0.1` uniquement — seul le reverse proxy de l'hôte a besoin d'y accéder.
  - Port **3031** : endpoint HTTP **interne** (`POST /emit` pour diffuser un
    événement, `GET /health`). Jamais publié : il n'est joignable que sur le réseau
    Docker interne, via `RELAY_EMIT_URL=http://relay:3031`.
- Les routes API Next.js notifient le relay en fire-and-forget (voir
  `src/lib/mbote/relay-notify.ts`) : si le relay est éteint, l'application reste
  100 % fonctionnelle — le frontend retombe sur le polling.

## 2. Prérequis

- Un VPS (Ubuntu/Debian, 1 vCPU / 1 Go suffisent pour démarrer)
- Docker Engine + plugin compose :

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Transférer le projet

```bash
# depuis votre machine (ou git clone si le repo est distant)
rsync -avz --exclude node_modules --exclude .next --exclude db ./ monvps:/opt/mbote/
```

## 4. Lancer

```bash
cd /opt/mbote
docker compose up -d --build
docker compose logs -f        # « prisma db push … » côté mbote,
                              # « [relay] … » côté mbote-relay
```

Deux conteneurs doivent être `healthy` :

```bash
docker compose ps
# mbote-mesh   … (healthy)   mbote-relay   … (healthy)
```

L'app répond sur `http://VOTRE_IP:3000`. Les données vivent dans le volume
`mbote-data` (`/app/db/custom.db`). Le port 3030 n'est publié que sur
`127.0.0.1` (pour le reverse proxy), le 3031 n'est pas publié du tout.

## 5. Reverse proxy (HTTPS) — exemple Caddy

Le WebSocket socket.io doit être routé vers `127.0.0.1:3030`. **Option
recommandée** : servir socket.io sous le même domaine, sur le préfixe
`/socket.io/*` (le client socket.io utilise justement ce chemin par défaut) :

```caddyfile
mbote.mondomaine.net {
    # App Next.js (pages + API) — tout sauf /socket.io/*
    reverse_proxy 127.0.0.1:3000

    # Hub temps réel socket.io. handle_path retire le préfixe
    # /socket.io : le relay, lui, écoute à la racine (path "/").
    handle_path /socket.io/* {
        reverse_proxy 127.0.0.1:3030
    }
}
```

Caddy gère l'upgrade WebSocket automatiquement (aucun en-tête à ajouter).
Variante **sous-domaine dédié** :

```caddyfile
socket.mondomaine.net {
    reverse_proxy 127.0.0.1:3030
}
```

(Nginx + certbot fonctionne aussi : `proxy_pass http://127.0.0.1:3000;` pour
l'app, et pour le socket.io un `location /socket.io/` vers `127.0.0.1:3030`
avec `proxy_http_version 1.1;` et les en-têtes `Upgrade`/`Connection "upgrade"`.)

```bash
docker run -d --name caddy --network host \
  -v /etc/caddy:/etc/caddy -v /etc/ssl/caddy:/etc/ssl/caddy \
  caddy:2 caddy run --config /etc/Caddyfile
```

## 6. Adapter le client socket.io (VPS)

Le client (`src/lib/mbote/socket.ts`) est **déjà configurable** :

- **Sandbox Z.ai (défaut)** : chaque requête engine.io porte la query
  `XTransformPort=3030`, routée par la passerelle interne.
- **VPS** : définissez `NEXT_PUBLIC_SOCKET_URL` à la construction pour pointer
  vers le hub public, et la query interne est automatiquement désactivée :

```ts
const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;
socket = io(socketUrl, {
  query: socketUrl ? undefined : { XTransformPort: "3030" },
  transports: ["websocket", "polling"],
  // …
});
```

Valeurs de `NEXT_PUBLIC_SOCKET_URL` selon l'option Caddy choisie :

- `handle_path /socket.io/*` (recommandé) : `https://mbote.mondomaine.net`
- sous-domaine dédié : `https://socket.mondomaine.net`

Le relay écoute socket.io sur le chemin racine (`path: "/"`) et accepte toute
requête arrivant sur le port 3030 avec les paramètres engine.io — c'est ce qui
permet au `handle_path` (préfixe retiré) comme au sous-domaine de fonctionner
sans toucher au serveur.

⚠️ Les variables `NEXT_PUBLIC_*` sont inlinées dans le bundle **à la
construction**, pas à l'exécution : passez-les au build (un
`ARG NEXT_PUBLIC_SOCKET_URL` + `build.args` dans le compose) ou mettez l'URL en
dur dans la constante avant de construire.

## 7. Vérifier le temps réel

```bash
# hors Docker (dev local, RELAY_EMIT_URL par défaut http://127.0.0.1:3031)
curl http://127.0.0.1:3031/health
# → {"ok":true,"clients":0,"identitiesOnline":0}

# en Docker, le 3031 n'est pas publié : passez par le réseau interne
docker compose exec mbote bun -e \
  "fetch('http://relay:3031/health').then(r => r.text()).then(console.log)"
```

Puis, côté navigateur : ouvrir le site dans **deux onglets**, poster dans
l'un → l'autre affiche la publication instantanément (likes et DM aussi, et le
compteur de présence doit monter à 2).

## 8. Sauvegardes

SQLite = un fichier. Une ligne de cron suffit :

```cron
0 4 * * * docker exec mbote-mesh sh -c 'cat /app/db/custom.db' > /opt/mbote-backups/custom-$(date +\%F).db
```

## 9. Mise à jour

```bash
cd /opt/mbote
rsync -avz --exclude node_modules --exclude .next --exclude db ./ monvps:/opt/mbote/
docker compose up -d --build     # reconstruit et relance les 2 conteneurs,
                                 # schéma repushé, données conservées
```

## 10. Variables d'environnement

Modèle complet et commenté : **`.env.example`** (à copier en `.env` sur le VPS).

| Variable                | Défaut                                      | Rôle                                                            |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`          | `file:/app/db/custom.db`                    | emplacement SQLite (volume)                                     |
| `PORT`                  | `3000`                                      | port d'écoute du serveur                                        |
| `NODE_ENV`              | `production`                                | mode de Next.js (désactive le hub embarqué, CSP durcie)         |
| `RELAY_EMIT_URL`        | `http://127.0.0.1:3031` (compose : `http://relay:3031`) | endpoint interne d'émission du relay (`POST /emit`) |
| `NEXT_PUBLIC_SOCKET_URL` | (défaut : vide → mode sandbox `XTransformPort=3030`) | URL publique du hub socket.io vue par le navigateur (voir §6) |
| `RELAY_EMIT_TOKEN`      | vide                                        | **F-51** : token exigé sur `/emit` (header `x-emit-token`) — défini des deux côtés |
| `RELAY_ALLOWED_ORIGIN`  | vide                                        | **F-08** : origines croisées autorisées par le hub (vide = aucune) |
| `RELAY_PORT` / `EMIT_PORT` | `3030` / `3031`                          | ports du hub (public / interne)                                 |
| `RELAY_EMIT_HOST`       | `0.0.0.0`                                   | **F-51** : bind de `/emit` — `127.0.0.1` sur un hôte unique      |
| `SEED_SECRET`           | vide                                        | **F-02** : protège `POST /api/seed` en production (`x-seed-secret`) |
| `MBOTE_BOT_KEY`         | vide                                        | **F-29** : chiffre au repos (AES-GCM) le secret du bot          |

Le compose livré positionne déjà `RELAY_EMIT_URL=http://relay:3031` sur le
service `mbote` ; en dev local (relay lancé à la main), le défaut
`http://127.0.0.1:3031` convient.

## 10 bis. Checklist de mise en production (Vague 6)

Après le premier déploiement (ou après chaque mise à jour), exécuter :

```bash
# depuis le conteneur applicatif (accède à la DB et aux env réelles) :
docker exec mbote-mesh bun scripts/prod-verify.ts https://TON-DOMAINE
# ou depuis l'hôte (vérifications HTTP seulement) :
bun scripts/prod-verify.ts https://TON-DOMAINE
```

Le script contrôle : CSP **sans `unsafe-eval`** + HSTS + nosniff + X-Frame-Options +
Referrer/Permissions-Policy (F-35) · `/api/stats` 200 · garde du seed 403 (F-02) ·
présence des variables critiques (F-09/F-51/F-29/F-02) · migrations Prisma
appliquées (`_prisma_migrations`) · secret du bot chiffré `enc:v1:` (F-29).

**Checklist opérateur avant ouverture publique :**

- [ ] `.env` écrit sur le VPS : `NEXT_PUBLIC_SOCKET_URL=https://…`,
      `SEED_SECRET`, `MBOTE_BOT_KEY`, `RELAY_EMIT_TOKEN` (tous `openssl rand -hex 32`)
- [ ] `docker compose build --build-arg NEXT_PUBLIC_SOCKET_URL=…` (F-09 : présent au BUILD)
- [ ] `docker compose up -d` puis `migrate deploy` exécuté par le CMD avant le boot
- [ ] reverse proxy HTTPS : routes explicites (jamais de proxy par query sur un VPS — F-51),
      WebSocket forwardé vers `127.0.0.1:3030`
- [ ] `prod-verify` : 0 FAIL
- [ ] golden path navigateur : identité → post signé → like → DM bot → temps réel (§7)
- [ ] rotation des secrets si jamais passés en clair dans un canal de discussion

## 11. Architecture de déploiement (et suite mesh)

```
VPS (deux conteneurs)                   Appareils sur le terrain
┌───────────────────────────┐           ┌──────────────┐
│ Next.js standalone :3000  │◄── HTTPS ─│ navigateurs  │
│ SQLite (volume Docker)    │           └──────┬───────┘
│ API : posts, DM E2E,       │                 │ WSS (socket.io)
│ canaux géohash, bot       │           ┌──────┴───────┐
│                           │           │ relay :3030  │
│                           │◄── /emit ─│ temps réel   │
└───────────────────────────┘  interne  └──────────────┘
              ▲
              │ (roadmap : passerelle BitChat ↔ Nostr ↔ web)
┌─────────────┴─────────────┐
│ nœud passerelle Android/  │  relais BLE mesh ⇄ internet
│ Raspberry Pi sur place    │  (fork bitchat-android + WebSocket)
└───────────────────────────┘
```

Le VPS joue le rôle des **relays Nostr** de BitChat : il transporte du ciphertext pour
les DM (il ne peut pas les lire) et sert d'agrégateur signé pour les publications
publiques. Le conteneur `relay` ajoute la diffusion en direct de ces événements aux
navigateurs connectés. Pour brancher le vrai mesh Bluetooth, une passerelle locale
(Android ou Raspberry Pi avec BT) relaierait les paquets mesh vers `/api/posts` et les
DM scellés vers `/api/dms` — le schéma de données est déjà au format « enveloppes
opaques ».
