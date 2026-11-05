# Plan de scalabilité Mbote — de 0 à 1 M+ utilisateurs

> Objectif : anticiper **dès aujourd'hui** les décisions qui coûtent cher à
> corriger plus tard. Chaque palier a un **déclencheur mesurable** (on migre
> quand le seuil est atteint, pas avant — pas de sur-ingénierie) et une
> **liste de changements concrets** sur notre code réel.

---

## 1. La vérité des chiffres : que signifie « 1 million d'utilisateurs » ?

| Métrique | Valeur (hypothèses standards réseaux sociaux) |
|---|---|
| Inscrits | 1 000 000 |
| DAU (~8 %) | 80 000 actifs/jour |
| Pics de connexions simultanées | ~8 000 (soirées, events, blackout internet) |
| Requêtes API | 20 / session → **~18 req/s moyenne, ~200 req/s en pic** |
| Publications | 0,5 post/DAU → 40 k posts/jour ≈ **0,5/s moyenne, 5-10/s en pic** |
| Socket.io simultanés | 8 000 → **1 à 2 nœuds** relay suffisent |
| Poids | Texte ≤ 500 o, pas de média lourd → bande passante triviale |

**Conclusion rassurante** : 200 req/s de lecture + 10 req/s d'écriture, c'est
**très en dessous** de ce que trois serveurs et un Postgres bien réglé encaissent.
Le mur n'est pas la puissance brute — il est dans **6 décisions structurelles**
prises maintenant (§3) et dans les pics **anormaux** de notre contexte :
blackout internet (tout le monde se reconnecte en même temps) et vagues de
sync des passerelles mesh le matin.

### Notre atout structurel que Twitter n'a pas

1. **Le mesh BLE est notre CDN** : toute interaction de proximité (marché,
   campus, quartier) ne touche **jamais** le serveur. Plus la densité locale est
   forte, moins le VPS travaille. Un réseau social classique dépense son CPU à
   servir des voisins de palier ; chez nous, c'est la radio qui le fait.
2. **Les canaux géohash sont un sharding naturel** : un canal = une ville. Le
   cache et (plus tard) les réplicas régionaux se mappent dessus sans logique
   métier supplémentaire.
3. **L'offline-first lisse les pics** : les outbox des clients et des passerelles
   absorbent la congestion (store-and-forward = tampon distribué).
4. **Pas de média lourd pour l'instant** : la plus grosse bombe à retardement des
   réseaux sociaux (images/vidéos) n'existe pas encore — on décide son cadre
   AVANT de la créer (§5, décision D3).

---

## 2. Audit du code actuel : les 8 murs identifiés

| # | Mur | Où dans le code | Quand il casse |
|---|---|---|---|
| 1 | **SQLite = 1 écrivain, pas réseau** | `prisma/schema.prisma` (`provider = "sqlite"`) | ~50-100 écritures/s → **premier mur**, vers 10-20 k DAU |
| 2 | **Compteurs calculés à chaque lecture** | `_count` sur likes/replies/posts/followers dans chaque requête feed | COUNT par ligne par requête → à 100 k posts, le feed rame |
| 3 | **Pagination sans curseur** | `orderBy: createdAt desc, take` dans `/api/posts` | infinite scroll instable (createdAt non unique), doublons/trous |
| 4 | **État en mémoire process** | `FragmentAssembler` (route mesh/bridge), dédup purgeée par `deleteMany` à CHAQUE requête | impossible de scaler en 2+ instances ; purge = écriture lourde par appel |
| 5 | **Relay socket.io mono-nœud + présence en RAM** | `onlineKeys: Map` dans relay-service | ~5-10 k sockets max/nœud ; 2 nœuds = présence incohérente |
| 6 | **Aucune limite de débit + signatures non vérifiées serveur** | routes API (pubkey déclarative, `signature` stockée mais JAMAIS vérifiée) | spam/impersonation dès l'ouverture publique ; à 1 M c'est mortel |
| 7 | **Zéro cache** | chaque GET feed/détail frappe la DB | 200 req/s = 200 hits DB/s sur des lectures identiques |
| 8 | **Déploiement mono-hôte** | docker-compose tout-sur-un-VPS | SPOF : le VPS redémarre = réseau entier hors ligne |

**Bonnes surprises déjà en place** (à préserver) :
- Index DM `@@index([recipientKey, createdAt])` ✅ correct pour la boîte de réception
- `MeshIngest` avec dédup par hash + fenêtre 6 h ✅ (le modèle est bon, la purge doit devenir un job)
- API de passerelle générique (`GatewayNode`) ✅ accueillera LoRa/Nostr sans refonte
- Chiffrement E2E des DM (le serveur ne stocke que de l'opaque) ✅ pas de coût de conformité sur le contenu privé

---

## 3. Les 6 décisions structurelles à prendre MAINTENANT

> Ce sont les décisions dont le coût de retard est **quadratique** : à faire
> avant 10 k utilisateurs, sinon refactorisation douloureuse sous charge.

- **D1. Postgres dès 10 k DAU** — le schéma Prisma actuel est portable (aucun
  type SQLite-spécifique, cuid OK). Migration = swap provider + `db push` +
  dump/restore. À 1 M utilisateurs ce serait une opération risquée ; à 10 k
  c'est une formalité.
- **D2. API 100 % sans état** — tout ce qui vit en RAM (FragmentAssembler,
  compteurs, rate limits) doit avoir une interface **pluggable** :
  `MemoryStore` aujourd'hui, `RedisStore` demain, sans toucher aux routes.
- **D3. Politique média AVANT la première image** — avatars = SVG générés
  (déjà le cas, zéro stockage) ; toute image utilisateur → stockage objet
  S3-compatible + CDN dès le premier jour de cette feature. Jamais d'image
  dans la base, jamais de disque local.
- **D4. Vérification de signature serveur** — le client signe déjà (ECDSA
  P-256, champ `signature` dans le protocole) ; le serveur doit **vérifier**
  avant d'insérer. ~1 ms/vérif, tue l'usurpation d'identité et le spam
  d'identités jetables (avec rate limit par pubkey).
- **D5. Compteurs dénormalisés** — `likeCount`/`replyCount` en colonnes sur
  `Post`, incrémentés atomiquement à l'écriture. Les COUNT à chaud disparaissent.
- **D6. Pagination par curseur** — `?before=<createdAt|id>` partout, avant que
  des clients tiers ne se branchent sur l'API.

---

## 4. La feuille de route par paliers

### Palier 0 — « Scale-ready » (maintenant, ≤ 10 k DAU) — **1 VPS actuel**
Infrastructure : inchangée (Docker Compose actuel).

Travail code (checklist exécutable dès le prochain « suite ») :
- [x] **D5** : `likeCount`/`replyCount` en colonnes + migration backfill + updates atomiques dans `/api/posts/like` et création de replies ✅ *implémenté*
- [x] **D6** : curseur `before` sur `/api/posts` (tous les scopes) + `nextCursor` renvoyé dans la réponse ✅ *implémenté*
- [x] **D4** : vérification ECDSA serveur quand `signature` est présente (`src/lib/mbote/verify.ts`, chaîne canonique `${pubkey}|${content}|${ts}`) ; rate limit fenêtre fixe par pubkey+IP sur posts/likes/DMs/bridge ; **idempotence par signature** (`@@unique(signature)`) — le même événement arrivé par le web ET par le mesh = un seul post ✅ *implémenté*
- [x] **D2** : `FragmentAssembler`, rate store et purges derrière `src/lib/mbote/state-store.ts` (MemoryStore → Redis sans toucher aux routes) ✅ *implémenté*
- [x] Purge `MeshIngest` déplacée en tâche périodique via `src/instrumentation.ts` (une fois par process, plus jamais par requête) ✅ *implémenté*
- [x] Index audit : `Post(createdAt)`, `Post(parentId, createdAt)`, `Follow(followingId)` ajoutés ; `Like` déjà couvert par `@@unique` ✅ *implémenté*
- [x] `GET /api/stats` enrichi : req/s, latence p95, par route, clés du rate store, passerelles, uptime ✅ *implémenté*

### Palier 1 — « Split vertical » (déclencheur : 10 k DAU ou 50 écritures/s) — 2-3 VPS
- **Postgres 16** : managé (Neon/Supabase, ~0-25 $/mois) ou VPS dédié (~12 $/mois) — D1 exécutée
- **Redis** : cache lectures chaudes (feed global anonyme 15 s, canaux 60 s, profils 5 min — invalidation par les événements socket.io déjà émis), rate limits distribués, presence relay
- **relay-service** sur son propre conteneur/hôte, sticky sessions à l'LB
- **CDN gratuit** (Cloudflare) : statiques + GET cacheables anonymes (`s-maxage`, SWR)
- **Backups** : PITR Postgres, test de restauration mensuel
- **Coût** : ~30-60 $/mois. Charge supportée : ~100 k DAU.

### Palier 2 — « Horizontal » (déclencheur : 100 k DAU ou 1 nœud API saturé) — 4-8 VPS
- **API ×3-5** derrière LB (l'état sans état de D2 le permet désormais)
- **File d'attente d'ingestion mesh** : BullMQ sur Redis — les bursts de passerelles matinales sont absorbés par des workers, l'API reste fluide ; dédup via `SET NX EX` Redis (fini le deleteMany)
- **Fan-out de feed hybride** : canaux géohash = pull + cache par canal ; abonnements = push dans des timelines Redis (bornées à 800 entrées, trim) — classique Twitter, appliqué à notre géométrie
- **Postgres** : 1 réplica de lecture pour les feeds ; `MeshIngest` et `DirectMessage` **partitions temporelles** ; PgBouncer
- **Socket.io ×2-3** avec `@socket.io/redis-adapter` + presence Redis
- **Observabilité** : Prometheus + Grafana (métriques), Sentry (erreurs), Loki (logs) — on ne pilote pas 1 M d'utilisateurs à l'aveugle
- **Coût** : ~150-400 $/mois. Charge supportée : ~1 M inscrits / 100-150 k DAU.

### Palier 3 — « Régions + fédération » (déclencheur : 1 M+ inscrits multi-pays)
- **Lecture multi-région** : réplicas Postgres par région + caches CDN régionaux ; les canaux géohash routent naturellement vers la région proche (DRC → Afrique centrale, etc.)
- **Option fédération Nostr** : nos `MeshEvent` ↔ NIP — les relais publics absorbent la diffusion globale, l'écosystème Nostr devient une **gratuite de capacité**, pas seulement un canal d'acquisition
- **Sharding si necessaire** : Citus ou sharding applicatif par région géohash
- **Écriture multi-maître** : à éviter le plus longtemps possible ; notre modèle offline-first (events signés, réconciliation) s'y prête bien le jour venu
- **Coût** : 1 000+ $/mois — atteint seulement si la monétisation existe déjà (à cadrer séparément).

---

## 5. Le plan d'infrastructure cible (Palier 2, en un schéma)

```
                       ┌─────────────┐
        Internet ──────►│   CDN/WAF   │  Cloudflare (statique, cache GET, anti-DDoS)
                       └──────┬──────┘
                       ┌──────▼──────┐
                       │ Load Balancer│  Caddy/HAProxy (TLS, sticky /relay/*)
                       └──┬────┬───┬─┘
              ┌───────────┘    │   └───────────┐
        ┌─────▼─────┐   ┌──────▼─────┐   ┌─────▼─────┐
        │  API #1   │   │  API #2…N  │   │ Relay ×2-3│  socket.io + redis-adapter
        │ Next.js   │   │ Next.js    │   │ (sticky)  │
        └──┬───┬────┘   └──┬───┬─────┘   └─────┬─────┘
           │   │           │   │               │
     ┌─────▼┐ ┌▼───────────▼┐ ┌▼──────────┐ ┌──▼───────────┐
     │Redis │ │  Workers    │ │  Postgres │ │  S3-compatible│
     │cache │ │ (ingest mesh│ │ primary + │ │  (médias futurs│
     │queue │ │  rollups,   │ │  réplica  │ │   + CDN)      │
     │presence│ TTL, emails)│ │  lecture  │ └───────────────┘
     └──────┘ └─────────────┘ └───────────┘
                                   ▲
                        ┌──────────┴──────────┐
                        │ Passerelles mesh ×N │  (mobiles, RPi, LoRa, Nostr)
                        └─────────────────────┘
```

## 6. Tableau de bord de décision (quand faire quoi)

| Signal | Seuil | Action |
|---|---|---|
| DAU | > 10 000 | Palier 1 (Postgres + Redis + CDN) |
| Écritures DB | > 50/s soutenues | Palier 1 immédiat |
| Latence p95 feed | > 300 ms | Cache Redis + compteurs (D5) |
| Sockets simultanés | > 5 000 | Relay multi-nœuds + adapter |
| Burst ingest mesh | files > 10 k paquets | Queue + workers (Palier 2) |
| CPU API | > 70 % soutenu | API ×N (Palier 2) |
| DAU multi-pays | > 3 régions | Palier 3 (réplicas régionaux) |

---

## 7. Ce que ce plan N'EST pas

- **Pas une migration immédiate** : le Palier 0 est du code, pas de l'infra —
  le VPS actuel reste suffisant jusqu'à ~10 k DAU.
- **Pas de microservices** : Next.js modulaire + 1 relay + workers suffisent ;
  on découpe seulement si un composant devient un vrai goulot.
- **Pas de Kubernetes au début** : Docker Compose multi-hôtes + LB tiennent
  largement le Palier 1 ; K8s se justifie au Palier 2-3 seulement.
- **Pas de prématurité** : chaque palier a un déclencheur mesuré (§6), pas une date.

---

## 8. Jalons techniques reportés — dates cibles explicites

Un élément reporté sans jalon devient permanent par oubli. Cette section
fige les reports en cours avec leur borne de rattrapage. Un jalon ne peut être
déplacé que par une décision explicite de validation — jamais supprimé
silencieusement.

| Élément reporté | État actuel | Jalon cible (borne dure) | Pourquoi cette borne |
|---|---|---|---|
| **FNV-64 mobile → SHA-256-128** (crypto spec OD-6, lacune L-5) | Empreinte SHA-256-128 (`dedupFingerprint`) livrée côté web + miroirs mobiles + parité verrouillée (A1) ; les appelants **synchrones** de `mobile/src/transport/MeshTransport.ts` (contrainte Hermes : WebCrypto asynchrone) utilisent encore FNV-1a 64 pour la dédup mémoire | **Bloc 2-F « UI médias » au plus tard — et dans tous les cas AVANT toute ouverture publique** | la dédup mémoire porte les chunks des médias E2EE ; le verrou médias (R4) ne doit pas reposer sur une empreinte forgeable. Si la vague mobile glisse, le jalon glisse AVEC elle mais reste antérieur à l'ouverture publique |

---

*Mbote Mesh — la scalabilité par la géométrie : la proximité est servie par la
radio, la ville par le cache, le monde par la fédération.*
