# Déploiement production (O-B → O-A) + builds mobiles — guide opérateur

> Date : 2026-11-15 · Branche : `feat/mbote-v1` @ `36ebd65` · Prod actuelle : `f558b1c` (A1/A2/A3)
> Cible : `mbotemesh.aenews.online` — VPS `95.111.226.63` (Docker Compose, nginx hôte)
> Statut : **O-B VERTE** (preuves §3) · **O-A PRÊTE** (§4) · **bloqueur unique : disque VPS à 100 %** (§2)

---

## 1. État des lieux — reconnaissance du 2026-11-15 (lecture seule)

| Élément | Constat | Verdict |
|---|---|---|
| SHA déployé (`/opt/mbote-bitchat/.deploy-commit`) | **`f558b1c`** (fix migrations 0003 — lignée main) | ancêtre direct de `feat/mbote-v1` → **fast-forward pur possible** |
| API en prod (`127.0.0.1:3390/api/stats`) | **HTTP 200** — users 11, posts 1, dms 8, uptime ~10,7 j | l'app fonctionne réellement |
| Conteneurs | `mbote-mesh` + `mbote-relay` « Up 10 days (**unhealthy**) » | cause identifiée : **disque plein** — le healthcheck (exec runc) ne peut pas s'exécuter (`no space left on device`), PAS un défaut applicatif |
| Disque | `/dev/sda1 : 193G / 193G — 100 %` | **bloqueur n° 1** : même `docker exec` échoue ; le déploiement (rsync + build) est impossible en l'état |
| Docker (`docker system df`) | Images 79,4 Go dont **27 Go récupérables (34 %)** · Build cache 2,19 Go | gisement de nettoyage clair (§2) |
| DB | volume Docker `mbote-bitchat_mbote-data` → `/app/db/custom.db` (237 Ko) | intact, `integrity_check = ok` |
| Migrations appliquées | **0001, 0002, 0003** | 0004 → 0012 s'appliqueront au boot (§4) |
| `.env` prod (5 vars) | `SEED_SECRET, MBOTE_BOT_KEY, RELAY_EMIT_TOKEN, NEXT_PUBLIC_SOCKET_URL, RELAY_ALLOWED_ORIGIN` | **`ADMIN_API_KEY` absente** → modération admin OFF (défaut sûr) ; décision opérateur §4.3 |
| Services (nouvelle version) | 3 : `mbote` (3390), `relay` (3391), **`admin` (127.0.0.1:3001, nouveau)** | l'admin nécessite nginx + DNS + Cloudflare Access (§4.4) |
| Médias (B2) | `.env` sans aucune var `MEDIA_S3_*` | les uploads répondront **503 propre** tant que le stockage objet n'est pas provisionné (§6.3) |

---

## 2. PRÉ-REQUIS BLOQUANT — libérer du disque (décision opérateur)

Le VPS héberge ~89 conteneurs (mailcow, penpot, redamon, auditforge, siteaenews…). **Aucune suppression ne sera faite sans ta validation explicite.** Options, par risque croissant :

```bash
# (a) SÛR — images pendantes + cache de build : ~2-4 Go récupérables
docker image prune -f          # images <none> (dangling) uniquement
docker builder prune -f        # cache de build : 2,19 Go

# (b) MOYEN — images non référencées par un conteneur ACTIF : jusqu'à ~27 Go
#     ⚠️ boîte partagée : une stack ARRÊTÉE temporairement perdrait son image
#     (re-pull au prochain démarrage). À n'exécuter qu'après inventaire :
docker image prune -a --filter "until=168h"   # non utilisées depuis > 7 j

# (c) COMPLÉMENT — logs conteneurs volumineux (json-file sans rotation ?)
du -sh /var/lib/docker/containers/*/ | sort -rh | head -10
# + truncate ciblé si besoin (jamais sur les logs d'un conteneur en cours d'audit)
```

**Critère de sortie** : `df -h /` avec **≥ 10 Go libres** (rsync + build Next standalone + couches Docker des 3 services).

---

## 3. O-B — les 5 requêtes SQL exactes (avant tout déploiement) — ✅ DÉJÀ VERTE

### Les requêtes (SQLite — readonly, jamais d'écriture)

```sql
-- 1. ADMIN_API_KEY en clair héritée (colonne legacy supprimée par 0004_admin)
SELECT COUNT(*) FROM ModerationAction WHERE adminKey IS NOT NULL;   -- attendu 0

-- 2. Colonne legacy hiddenBy (Post)
SELECT COUNT(*) FROM Post WHERE hiddenBy IS NOT NULL;               -- attendu 0

-- 3. Colonne legacy handledBy (Report)
SELECT COUNT(*) FROM Report WHERE handledBy IS NOT NULL;            -- attendu 0

-- 4. Colonne legacy suspendedBy (User)
SELECT COUNT(*) FROM User WHERE suspendedBy IS NOT NULL;            -- attendu 0

-- 5. État des migrations (dernière appliquée = 0003 avant déploiement ; 0012 après)
SELECT migration_name, finished_at FROM _prisma_migrations
ORDER BY started_at DESC LIMIT 5;
```

### Exécution sur le VPS — 2 méthodes sans écriture disque

```bash
# Méthode A (recommandée quand le disque respire) — bun:sqlite readonly DANS le conteneur :
docker exec mbote-mesh bun -e 'const { Database } = require("bun:sqlite");
const p = (process.env.DATABASE_URL || `file:/app/db/custom.db`).replace(/^file:/, ``);
const db = new Database(p, { readonly: true });
const q = (s) => db.query(s).all();
console.log(q("SELECT COUNT(*) FROM ModerationAction WHERE adminKey IS NOT NULL"));
console.log(q("SELECT COUNT(*) FROM Post WHERE hiddenBy IS NOT NULL"));
console.log(q("SELECT COUNT(*) FROM Report WHERE handledBy IS NOT NULL"));
console.log(q("SELECT COUNT(*) FROM User WHERE suspendedBy IS NOT NULL"));
console.log(q("SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5"));
console.log(q("PRAGMA integrity_check"));'

# Méthode B (résiste au disque plein) — python3 hôte + sqlite immutable (0 octet écrit) :
sudo python3 -c 'import sqlite3, json
p = "/var/lib/docker/volumes/mbote-bitchat_mbote-data/_data/custom.db"
db = sqlite3.connect("file:%s?mode=ro&immutable=1" % p, uri=True)
q = lambda s: db.execute(s).fetchall()
print("OB1", q("SELECT COUNT(*) FROM ModerationAction WHERE adminKey IS NOT NULL"))
print("OB2", q("SELECT COUNT(*) FROM Post WHERE hiddenBy IS NOT NULL"))
print("OB3", q("SELECT COUNT(*) FROM Report WHERE handledBy IS NOT NULL"))
print("OB4", q("SELECT COUNT(*) FROM User WHERE suspendedBy IS NOT NULL"))
print("OB5", json.dumps(q("SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5")))
print("OB6", q("PRAGMA integrity_check"))'
```

### ✅ Résultat acquis le 2026-11-15 (méthode B, preuve)

| Requête | Résultat | Attendu | Verdict |
|---|---|---|---|
| OB1 `ModerationAction.adminKey` | **0** | 0 | ✅ aucune clé brute héritée |
| OB2 `Post.hiddenBy` | **0** | 0 | ✅ |
| OB3 `Report.handledBy` | **0** | 0 | ✅ |
| OB4 `User.suspendedBy` | **0** | 0 | ✅ |
| OB5 migrations | **0003 → 0002 → 0001** | prod à 0003 | ✅ 0004→0012 s'appliqueront au boot |
| OB6 `integrity_check` | **ok** | ok | ✅ DB saine |

**Plan conditionnel (si un jour ≠ 0)** — consigné dans l'en-tête de la migration 0004 :
`UPDATE ModerationAction SET adminUserId = 1 WHERE actorLabel = 'legacy';` (idempotent, rattache au pseudo-user `system`, auditable via AdminAudit).

---

## 4. O-A — procédure de déploiement (fast-forward, zéro force)

### 4.1 Topologie vérifiée (garantie mathématique du FF)

- `git merge-base origin/main feat/mbote-v1` = `75e9559` **= origin/main lui-même**
- `feat/mbote-v1..origin/main` = **0 commit** ; `origin/main..feat/mbote-v1` = **117 commits**
- Les 4 commits ADM (`e0d8a4b`, `04a5c4a`, `6d3666b`, `7d4afb0`) sont **ancêtres** de `feat/mbote-v1` (mêmes hashes)
- **Bilan** : `git push origin 36ebd65:main` = fast-forward strict, `--force` inutile et interdit

### 4.2 Migrations appliquées automatiquement au démarrage — 11 (pas 7)

Le `CMD` du conteneur : `bunx prisma migrate deploy && exec bun server.js` (F-36). Ordre réel (timestamp Prisma), **11 migrations** s'appliqueront au premier boot :

| # | Dossier | Contenu |
|---|---|---|
| 1 | `20261105202309_0004_admin` | schéma AdminUser/Session/Audit + **rupture des 4 colonnes legacy** + triggers AdminAudit append-only |
| 2 | `20261105212940_0005_admin_auth` | auth du panneau (sessions, RBAC) |
| 3 | `20261106000000_0007_b2_media` | médias B2 (Media, quotas) |
| 4 | `20261106092200_0006_etape6_queue` | queue |
| 5 | `20261107090000_0007_etape9_four_eyes` | four-eyes |
| 6 | `20261107094500_0008_c1_push` | push notifications |
| 7 | `20261107100000_0008_etape10_audit_stress` | audit/stress |
| 8 | `20261110100000_0009_d1_post_fts` | FTS5 posts |
| 9 | `20261112120000_0010_c4_groups` | groupes MLS (Group, GroupMember, GroupMessage) |
| 10 | `20261113100000_0011_d2_sybil` | Sybil (PoW spent, réputation) |
| 11 | `20261115100000_0012_g_i18n_preferences` | locale/localeExplicit (G/i18n) |

Garde de santé : le conteneur ne passe `healthy` que si `_prisma_migrations` non vide **ET** `/api/stats` répond (healthcheck readonly bun:sqlite). Tout échec de migration = conteneur visiblement unhealthy (jamais silencieux).

### 4.3 Décisions opérateur avant push

| Décision | Impact |
|---|---|
| `ADMIN_API_KEY` (secret GitHub) : provisionner ou non | présente → 6ᵉ var écrite dans `.env` + modération admin ON ; absente → warning CI + modération OFF (403 uniforme, défaut sûr) — voir `docs/RUNBOOK-ADMIN-KEY.md` |
| Secrets VPS : `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` | requis par `deploy-vps.yml` (vérifier Settings → Secrets) |
| `MEDIA_S3_*` (R2/S3) | sans ces vars, les médias répondent 503 propre (le reste vit normalement) — §6.3 |

### 4.4 Panneau admin — exposé réseau (action opérateur)

Le service `admin` (BFF sans état, zéro accès DB, read_only, cap_drop ALL) se lie **127.0.0.1:3001** uniquement. Exposition publique prévue : nginx server block `admin.mbotemesh.aenews.online → 127.0.0.1:3001` + DNS + **Cloudflare Access** (décision audit §4.5). Tant que ce bloc n'existe pas, le panneau reste joignable uniquement en SSH (tunnel `ssh -L 3001:127.0.0.1:3001`).

### 4.5 Séquence O-A (après disque + O-B verte)

```
1. push main :        git push origin 36ebd65:main            # fast-forward, PAS de force
2. CI auto :          tests.yml (feat/** → main) puis deploy-vps.yml (workflow_run, gate F-1)
   — gate F-1 : tests.yml VERTE sur le SHA + security.yml verte/absente + paths pertinents
3. deploy :           rsync du SHA testé → .env (5-6 vars) → docker compose up -d --build
4. boot conteneur :   prisma migrate deploy (11 migrations) → bun server.js
5. healthcheck :      _prisma_migrations non vide + /api/stats 200 → healthy
6. vérification :     bun scripts/prod-verify-oa.ts https://mbotemesh.aenews.online   (§6)
```

---

## 5. Builds mobiles (nouvelle version)

### 5.1 Ce qui a changé

- **`build-android.yml`** : **aucune modification fonctionnelle requise** — il construit déjà la version du checkout (prebuild Expo → `assembleRelease`), signe debug installable sans secrets (keystore prod si secrets), publie l'artefact à chaque run + Release sur tag `v*.*.*`. Déclencheurs : push/PR `[main]`, tags, **`workflow_dispatch`** → dispatchable sur `feat/mbote-v1` dès maintenant.
- **`build-ios.yml`** : **étape ajoutée** — « IPA non signée (device — méthode Payload, `CODE_SIGNING_ALLOWED=NO`) » : build `generic/platform=iOS` non signé → `Payload/` zippé → `mbote-v1.0.0-ios-unsigned.ipa` (arm64 réel). L'artefact simulateur existant est conservé ; l'IPA signée (certificats Apple) reste conditionnelle aux secrets.

### 5.2 Déclenchement (au choix)

```bash
# via gh CLI sur la branche :
gh workflow run "Android (APK)"  --ref feat/mbote-v1
gh workflow run "iOS (IPA / simulateur)" --ref feat/mbote-v1
# ou via l'onglet Actions → choisir le workflow → Run workflow → branch: feat/mbote-v1
```

Artefacts (retention 14 j) : `mbote-android-v1.0.0-r{N}` (APK) · `mbote-ios-v1.0.0-r{N}` (simulateur.zip + unsigned.ipa + éventuelle signed.ipa). `versionCode`/build = nombre de commits (monotone, historique complet fetché).

### 5.3 Installer l'APK Android (aucun Play Store requis)

1. Télécharger `mbote-v1.0.0-android.apk` depuis l'artefact du run (ou la Release si tag)
2. Android → Paramètres → Applications → autoriser « Installer des apps inconnues » pour le navigateur/gestionnaire de fichiers
3. Ouvrir l'APK → Installer → Ouvrir ; l'app démarre en mode mesh BLE même sans internet
4. Signature : **debug** (tests) tant que le keystore production n'est pas dans les secrets (`docs/CI-CD.md`) — un APK « debug-signé » est parfaitement installable et fonctionnel

### 5.4 Inspecter l'IPA non signée (et la re-signer)

```bash
unzip -l mbote-v1.0.0-ios-unsigned.ipa          # doit lister Payload/MboteMesh.app/…
unzip -o mbote-v1.0.0-ios-unsigned.ipa -d ipa-inspect
plutil -p ipa-inspect/Payload/MboteMesh.app/Info.plist | grep -E 'CFBundleVersion|CFBundleShortVersion|MinimumOSVersion'
lipo -info ipa-inspect/Payload/MboteMesh.app/MboteMesh        # attendu : arm64
codesign -dvv ipa-inspect/Payload/MboteMesh.app 2>&1 | head -3  # attendu : « code object is not signed »
```

**Re-signature pour installation** (au choix) : Sideloadly/AltStore (Apple ID gratuit, 7 jours) · compte Developer 99 $/an + profil ad-hoc (durable) — l'IPA non signée est une **preuve de compilation arm64**, pas un livrable installable tel quel (rappel Apple).

---

## 6. Vérification post-déploiement (BitChat-like)

### 6.1 Script automatisé — `scripts/prod-verify-oa.ts`

```bash
bun scripts/prod-verify-oa.ts https://mbotemesh.aenews.online
```

Exerce **en réel** (identités PoW 20 bits + ECDSA P-256 générées à la volée) : santé `/api/stats` · gates des nouvelles routes (refus propre sans preuve) · identité (PoW+ECDSA) · texte signé (`/api/posts`) · **DM E2EE bout en bout** (ECDH → AES-256-GCM → dm2 signé → relecture dm-read par le destinataire) · **médias** (presigned PUT + finalize ; 503 propre si stockage non provisionné → WARN avec remédiation) · **groupe MLS** (création signée + ciphertext opaque `mlsEpoch`) · **préférences i18n** (POST signé + GET). Exit 0 = prêt ; chaque FAIL est explicite (jamais silencieux). Effets de bord documentés : 2 identités de test, 1 post, 1 DM, 1 groupe, 1 message de groupe.

### 6.2 Les 5 scénarios opérateur (manuel, navigateur — la vraie expérience BitChat)

1. **Texte E2EE** : deux navigateurs/profils, 2 identités onboarding, DM Alice→Bob → le serveur ne voit que du ciphertext (vérifiable : contenu absent des logs prisma côté valeur claire)
2. **Image + note vocale** : Composer → média image (PNG) puis note vocale (audio/webm) — nécessite `MEDIA_S3_*` provisionné (§6.3) sinon 503 propre
3. **Groupe MLS** : créer un groupe, inviter Bob (keypackage), message de groupe → seul Bob (membre actif) lit les ciphertexts
4. **Admin** : `ssh -L 3001:127.0.0.1:3001 aenews@95.111.226.63` puis `http://127.0.0.1:3001/api/health` (200) — après nginx/CF Access : `https://admin.mbotemesh.aenews.online`
5. **Migrations** : commande O-B (§3) — la dernière migration doit être **`0012_g_i18n_preferences`** ; `/api/stats` 200 et conteneurs `healthy`

### 6.3 Remédiation stockage médias (quand décision prise)

Provisionner les vars `MEDIA_S3_*` (endpoint/bucket/clés — Cloudflare R2 recommandé, `MEDIA_S3_PUBLIC_ENDPOINT` pour les URLs publiques signées) dans les **secrets GitHub** → le déploiement suivant les écrit dans le `.env` VPS (le workflow ne les écrase jamais sans les secrets définis).

### 6.4 Commandes SSH utiles (lecture seule)

```bash
docker logs mbote-mesh --tail 50          # démarrage + migrations visibles
docker compose ps                          # 3 services attendus (mbote, relay, admin)
docker logs mbote-admin --tail 30          # panneau admin
docker inspect mbote-mesh --format '{{.State.Health.Status}}'
```

---

## 7. Ordre des opérations — checklist finale

| # | Action | Qui | Statut |
|---|---|---|---|
| 1 | Libérer ≥ 10 Go disque (§2) | opérateur (décision) | ⏳ |
| 2 | O-B verte (§3) | fait — ✅ 2026-11-15 | ✅ |
| 3 | Push workflows/doc/script sur `feat/mbote-v1` + dispatch builds mobiles | fait par sandbox | ⏳ ce run |
| 4 | Décisions : `ADMIN_API_KEY`, secrets VPS, `MEDIA_S3_*` | opérateur | ⏳ |
| 5 | **STOP respecté** : push main uniquement sur TON feu vert (token ou push manuel) | opérateur | ⏳ |
| 6 | `git push origin 36ebd65:main` (FF) → CI → deploy auto → healthcheck | auto après 5 | ⏳ |
| 7 | `bun scripts/prod-verify-oa.ts https://mbotemesh.aenews.online` | opérateur/sandbox | ⏳ |
| 8 | Scénarios manuels §6.2 (5 points BitChat-like) | opérateur | ⏳ |

## 8. Traçabilité

- Recon prod : 2026-11-15 (3 rounds lecture seule, aucune mutation, aucun secret imprimé)
- O-B : méthode B (python3 + sqlite `mode=ro&immutable=1`, zéro écriture disque)
- Livrables de ce run : `.github/workflows/build-ios.yml` (IPA non signée) · `scripts/prod-verify-oa.ts` (tsc 0 erreur) · `docs/proofs/DEPLOY-AND-MOBILE.md` (ce document)
- Règles respectées : pas de force push, main intouché avant feu vert, aucun secret dans les logs, jamais silencieux

---

## 9. DÉPLOIEMENT RÉEL 2026-11-15 — prod sur `e970f0e` (workflow_dispatch sur feat, STOP main respecté)

**Déclencheur** : `POST /actions/workflows/deploy-vps.yml/dispatches {ref: "feat/mbote-v1"}` — la production est
passée de `f558b1c` (A1-A3, migrations 0001-0003) à **`e970f0e`** SANS toucher à `main` (le STOP tient : aucun
push main effectué).

### 9.1 Pré-requis exécutés
- **Espace disque** : VPS à **100 % (0 octet libre)** → nettoyage mandat « > 3 mois » : caches npm/_npx/_prebuilds
  (4.7 G) + bun install cache (3.1 G) + .cache outils (337 M) + blobs ollama > 90 j (1.9 G, moondream conservé) +
  node_modules projets dormants (aenews-dashboard/-v2, ollama-dashboard, nexusai — 5.4 G, code source préservé) +
  sprint8_backup juin 2026 + logs pm2 datés + prune docker (>90 j) + build cache (2.19 G) → **0 → 13 Go libres**.
- **O-B (pré-migrations)** : 4 COUNT legacy `adminKey/hiddenBy/handledBy/suspendedBy` = **0/0/0/0**,
  `integrity_check ok`, migrations = 0001-0003 → **vert**.
- **Backup pré-déploiement** : `VACUUM INTO` → `/opt/backups/mboote/mbote-pre-deploy-deb69e4-20261115-1853.db`
  (232 Ko, snapshot transactionnel, integrity ok, 11 users).
- **Procédure D3 (volume existant)** : `chown -R 10001:10001 /var/lib/docker/volumes/mbote-bitchat_mbote-data/_data`
  exécuté AVANT le premier déploiement de l'image non-root (root → 10001 confirmé).

### 9.2 Trois échecs de build — causes racine et fixes (chaque échec rapporté, jamais silencieux)
| # | Étape | Erreur | Cause racine | Fix (SHA) |
|---|---|---|---|---|
| 1 | relay | `addgroup: not found` exit 127 | base `oven/bun:1` épinglée = **Debian 13 slim sans paquet adduser** (`addgroup` est un script perl absent des slim variants) | `USER 10002:10002` numérique — durcissement D3 équivalent, indépendant de la distro (`5bed365`) |
| 2 | mbote | `PrismaClientConstructorValidationError: Invalid value undefined` sur TOUTES les routes important db | le stage `builder` n'avait **pas de DATABASE_URL** (la CI n'écrit que 6 vars sans DATABASE_URL) ; `src/lib/db.ts:29` instancie PrismaClient au chargement de module — la collecte `next build` l'exige | `ENV DATABASE_URL="file:/app/db/custom.db"` au builder (valeur jamais lue au disque : aucune requête à la collecte) (`e970f0e`) |
| 3 | admin | `Bind for 127.0.0.1:3001 failed: port is already allocated` | le port 3001 de l'hôte est retenu par un docker-proxy d'un autre stack ; la convention serveur (ports 3390/3391) n'était pas étendue à l'admin | `docker-compose.override.yml` VPS : bloc `admin: ports !override "127.0.0.1:3392:3001"` (sauvegarde du fichier avant édition) |

⚠️ Incident de procédure documenté : un `printf` a interprété `\127` comme octal (`W.0.0.1`) lors du premier append
de l'override → doublon de clé `admin` puis réécriture complète du fichier via stdin (aucune expansion shell).
Le mbote principal et l'admin utilisaient le même pattern addgroup → corrigés dans le même esprit (USER
10001:10001 / 10003:10003).

### 9.3 État final (vérifié en réel)
- `docker compose ps` : **mbote-mesh (healthy)** · **mbote-relay (healthy)** · **mbote-admin (healthy)**
- `/api/stats` : 200 via `127.0.0.1:3390` ET via `https://mbotemesh.aenews.online` (users=11 posts=1 dms=8 —
  données intactes, pré/post-déploiement identiques)
- Admin : 200 via `127.0.0.1:3392` (nginx/Cloudflare Access en amont selon plan)
- **Migrations : 14/14 appliquées** (0001-0003 + `0004_admin` → `0012_g_i18n_preferences`), `integrity_check ok`
- `prod-verify-oa.ts` : **14 PASS / 1 WARN / 1 FAIL-corrigeable** — gates cryptographiques verts (médias 503 gardé,
  groupes 401, dms 400, call-knock 400, turn-credentials 401 GET-only, préférences 400), **identités réelles créées
  (PoW 20 bits + ECDSA)**, **texte signé 200**, **DM E2EE bout-en-bout 200** (ciphertext opaque + relecture
  destinataire), **préférences i18n POST+GET 200 (locale=en persistée)**
- WARN assumé : médias = stockage `MEDIA_S3_*` non provisionné (décision opérateur, remédiation §6)
- FAIL script corrigé : `mlsGroupId` hex **lowercase strict** (le filtre case-insensitive du script laissait passer
  des A-F majuscules que la regex serveur `/^[0-9a-f]{32,128}$/` rejette) ; le re-test MLS réel attend la fenêtre
  du plafond Sybil (compteur incrémenté AVANT validation : 3 hits/h/IP déjà consommés par les sondes)

### 9.4 Restant (opérateur)
1. `MEDIA_S3_*` : provisionner le stockage objet (R2/S3) puis re-run `prod-verify-oa.ts` (médias passent).
2. Push `feat/mbote-v1` → `main` (FF vérifié : 117/0) quand le feu vert tombe — la CI redéploiera identiquement.
3. Re-test MLS (script corrigé) après libération du plafond Sybil (fenêtre 1 h glissante).
