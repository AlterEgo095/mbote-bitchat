# Mbote BitChat 📡

**Réseau social offline-first** : un fil social, des canaux géolocalisés et des
messages privés qui circulent **de proche en proche via Bluetooth (BLE mesh)**,
sans internet — avec un pont VPS optionnel pour synchroniser le monde connecté.

> Inspiré du protocole **BitChat** (domaine public,
> permissionlesstech/bitchat, whitepaper v2.0) : flood contrôlé TTL 7, dédup
> LRU, gigue de retransmission 10–220 ms, paquets binaires ≤ 469 octets,
> clés = identités.

## Les trois composants

```
┌─────────────────┐   BLE mesh    ┌─────────────────┐
│  App mobile     │◄─────────────►│  App mobile     │
│  (Kotlin/Swift) │   hors-ligne  │  (Kotlin/Swift) │
└────────┬────────┘               └────────┬────────┘
         │        ┌─────────────────┐      │
         └───────►│  App mobile #3  │◄─────┘   … relais multi-sauts (TTL)
                  └────────┬────────┘
                           │ HTTPS (quand internet existe)
                  ┌────────▼────────┐
                  │   PONT VPS      │  /api/mesh/bridge (store-and-forward)
                  │  Next.js 16     │  relay Nostr (docker-compose) + Caddy
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │  Client web PWA │  feed, canaux géohash, DM, temps réel
                  └─────────────────┘
```

| Dossier | Rôle |
|---|---|
| `src/` | **Client web PWA** : feed social, canaux géohash, DM chiffrés, simulation mesh |
| `src/lib/mbote/bitchat-protocol.ts` | **Cœur du protocole** (TS pur, isomorphe, partagé partout) |
| `src/app/api/mesh/bridge/` | **Pont VPS** : dépôt de paquets mesh (dédup 6 h, création des entités) |
| `mobile/` | **App native Expo** + modules BLE natifs Android (Kotlin) / iOS (Swift) — voir [`mobile/README.md`](mobile/README.md) |
| `mini-services/relay-service/` | Service WebSocket temps réel |
| `Dockerfile` · `docker-compose.yml` · `Caddyfile` · `DEPLOY-VPS.md` | Déploiement VPS (app + relay Nostr + HTTPS) |
| `docs/NATIVE-APP-SPEC.md` | Spec détaillée de l'app native |

## Fonctionnement du mesh

1. **Identité locale** : paire ECDSA P-256 générée sur l'appareil — pas de
   numéro, pas d'e-mail. La clé publique *est* le compte.
2. **Annonce** : diffusion périodique (30 s) de présence + clés publiques.
3. **Publication** : événement social JSON signé, encapsulé dans un paquet
   binaire BitChat, envoyé aux voisins BLE.
4. **Retransmission** : chaque pair déduplique (LRU 1000), décrémente le TTL
   (7, clampé à 5 en zone dense ≥ 6 voisins) et retransmet après une gigue
   aléatoire de 10–220 ms — flood contrôlé, sans tempête.
5. **Pont VPS** : dès qu'un appareil trouve internet, il remonte ses paquets
   accumulés (`/api/mesh/bridge`) ; le serveur déduplique, crée les entités
   sociales et les expose au fil web. Les DM restent scellés de bout en bout.

## Démarrage rapide (web)

```bash
bun install
bun run db:push
bun run dev        # http://localhost:3000
```

## Démarrage rapide (mobile)

```bash
cd mobile && npm install
npx expo run:android   # ou run:ios (appareil réel requis pour le BLE)
```

## Déploiement VPS

Voir [`DEPLOY-VPS.md`](DEPLOY-VPS.md) : `docker compose up -d` monte l'app,
le relay Nostr et Caddy (HTTPS auto).

## Statut

- ✅ Cœur protocole TS (paquets, dédup, fragmentation, geohash)
- ✅ Client web PWA complet (feed, canaux, DM, réseau, PWA offline)
- ✅ Pont mesh↔VPS + tests E2E (`tests/mesh-bridge-e2e.ts`)
- ✅ Modules BLE natifs Android (Kotlin) + iOS (Swift) + app Expo
- 🔜 DM mobile (crypto prête), canaux géohash mobile, courriers DTN
