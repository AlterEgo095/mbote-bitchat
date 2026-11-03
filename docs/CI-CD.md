# CI/CD — Mbote BitChat

> **Rôle de chacun** : GitHub Actions = usine de compilation et de livraison.
> VPS = serveur de production (web + API + relay Nostr). Téléphones = clients
> (mesh BLE offline + sync quand internet revient).

```
git push ──► GitHub Actions
              ├─ build-android.yml ──► APK signé ──► GitHub Release ──► 📲 sideload
              ├─ build-ios.yml ─────► IPA signée / simulateur ──► GitHub Release
              └─ deploy-vps.yml ────► rsync + docker compose ──► 🌐 VPS à jour
```

---

## 1. Les trois workflows

| Workflow | Fichier | Runner | Déclencheurs | Produit |
|---|---|---|---|---|
| **Android (APK)** | `.github/workflows/build-android.yml` | `ubuntu-latest` | push `main`, tag `v*.*.*`, PR, manuel | APK release signé |
| **iOS (IPA)** | `.github/workflows/build-ios.yml` | `macos-latest` | push `main`, tag `v*.*.*`, PR, manuel | IPA signée *ou* build simulateur |
| **Déploiement VPS** | `.github/workflows/deploy-vps.yml` | `ubuntu-latest` | push `main` (hors `mobile/`, `docs/`, `*.md`), manuel | web + relay à jour sur le VPS |

Chaque build publie ses fichiers dans l'onglet **Artifacts** (14 jours) ;
chaque **tag** `v*.*.*` crée une **GitHub Release** téléchargeable publiquement.

Lien permanent de distribution :
`https://github.com/AlterEgo095/mbote-bitchat/releases/latest`

Portails qualité intégrés à chaque build mobile : **`tsc --noEmit` strict**
(un code qui ne compile pas ne produit jamais d'APK/IPA) et **`bun run lint`**
avant chaque déploiement VPS.

---

## 2. Android — détails

### Mode par défaut (zéro secret) ✅
Expo signe l'APK release avec la **clé debug** → l'APK reste **installable en
sideload** immédiatement. Parfait pour les tests et les premières distributions.

### Mode production (recommandé avant diffusion large)
1. Générer un keystore (une seule fois, à conserver précieusement) :
   ```bash
   keytool -genkeypair -v -keystore mbote-release.keystore \
     -alias mbote -keyalg RSA -keysize 2048 -validity 10000
   ```
2. L'encoder en base64 :
   ```bash
   base64 -w0 mbote-release.keystore   # -b0 sur macOS : base64 -i f | tr -d '\n'
   ```
3. Ajouter ces **GitHub Secrets** (Settings → Secrets and variables → Actions) :

   | Secret | Contenu |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | sortie base64 de l'étape 2 |
   | `ANDROID_KEYSTORE_PASSWORD` | mot de passe du keystore |
   | `ANDROID_KEY_ALIAS` | ex. `mbote` |
   | `ANDROID_KEY_PASSWORD` | mot de passe de la clé |

Le workflow décode le keystore, écrit `keystore.properties` et active
`mobile/scripts/mbote-signing.gradle` qui surcharge la signature Expo.
⚠️ **Un keystore perdu = mises à jour impossibles pour les utilisateurs.**
Sauvegarde-le hors du dépôt (jamais commité).

### Versioning
- `versionName` = tag `v1.2.3` → `1.2.3` (sinon version de `app.json`) ;
- `versionCode` = nombre de commits → strictement croissant, les mises à jour
  sideload s'installent toujours proprement.

---

## 3. iOS — détails

### Sans compte Apple Developer (par défaut)
Le workflow produit un **build simulateur** (`.app.zip`) — artefact de
développement. La distribution iPhone exige une signature Apple.

### Avec compte Apple Developer (99 $/an)
1. Exporter le certificat de distribution depuis Xcode (`Keychain Access` →
   exporter le certificat **Apple Distribution** en `.p12` avec mot de passe) ;
2. Créer un profil de provisionnement pour `org.mbote.bitchat`
   (Ad-hoc : jusqu'à 100 appareils · App Store : via TestFlight jusqu'à 10 000 testeurs) ;
3. Secrets à configurer :

   | Secret | Contenu |
   |---|---|
   | `APPLE_CERTIFICATE_BASE64` | le `.p12` en base64 |
   | `APPLE_CERTIFICATE_PASSWORD` | mot de passe du `.p12` |
   | `APPLE_PROVISIONING_PROFILE_BASE64` | le `.mobileprovision` en base64 |
   | `APPLE_TEAM_ID` | Team ID (appleid.apple.com → compte) |
   | `APPLE_EXPORT_METHOD` | `ad-hoc`, `app-store`, `development` (défaut : `ad-hoc`) |

Le workflow importe certificat + profil dans un trousseau éphémère, archive
(`xcodebuild archive`, signature manuelle) et exporte l'IPA via
`ExportOptions.plist` généré à la volée.

**Stratégie pragmatique tant que le compte n'existe pas** : les utilisateurs
iOS utilisent la **PWA web** (offline-capable via service worker) — Android
porte l'expérience native complète.

---

## 4. Déploiement VPS — détails

### Secrets requis

| Secret | Exemple | Notes |
|---|---|---|
| `VPS_HOST` | `203.0.113.10` ou `vps.mondomaine.tld` | |
| `VPS_USER` | `deploy` | utilisateur non-root recommandé, groupe `docker` |
| `VPS_SSH_KEY` | contenu de la clé **privée** | `ssh-keygen -t ed25519` dédiée CI |
| `VPS_PORT` | `22` | optionnel (défaut 22) |
| `VPS_DEPLOY_DIR` | `/opt/mbote-bitchat` | optionnel (défaut `/opt/mbote-bitchat`) |

### Variables de build temps réel (F-09)

`NEXT_PUBLIC_SOCKET_URL` est lue **à l'étape build** : elle est inlinée dans le
bundle client Next. Elle est donc transmise à toute la chaîne — secret GitHub →
`.env` sur le VPS (écrit par la CI via ssh + stdin, les secrets ne passent jamais
dans la ligne de commande distante) → `build.args` Docker → `ARG`/`ENV` du
Dockerfile.

Nouveaux **GitHub Secrets** à créer (Settings → Secrets and variables → Actions,
suite de l'environnement `VPS_HOST` / `VPS_USER` existant) :

| Secret | Exemple | Rôle |
|---|---|---|
| `NEXT_PUBLIC_SOCKET_URL` | `https://socket.mondomaine.tld` (ou l'URL du site si le hub est proxifié par Caddy) | URL publique du hub socket.io sur le VPS — sans elle, le bundle embarque le mode sandbox (`XTransformPort`) et le temps réel est hors service en prod |
| `RELAY_ALLOWED_ORIGIN` | `https://mbote.mondomaine.tld` | Origine autorisée par le relay (CORS), passée en `environment` au service `relay` |
| `SEED_SECRET` | chaîne aléatoire longue | Secret de l'endpoint de seed `/api/seed` |

> ⚠️ Modifier le secret ne suffit pas : il faut **rebuilder** l'image
> (`docker compose up -d --build`, ce que fait la CI à chaque push) pour que
> la nouvelle valeur soit inlinée dans le bundle.

### Préparation du VPS (une seule fois)
```bash
# sur le VPS
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy          # docker + compose v2 installés
sudo mkdir -p /opt/mbote-bitchat && sudo chown deploy /opt/mbote-bitchat
# clé publique CI :
echo "<clé publique>" >> ~/.ssh/authorized_keys
```
Caddy reste sur l'hôte (443 → 127.0.0.1:3000), cf. `Caddyfile` / `DEPLOY-VPS.md`.

### Ce que fait la CI à chaque push `main`
1. `bun run lint` — porte qualité ;
2. **rsync** du commit exact vers `$VPS_DIR` (`--delete`, exclusions :
   `node_modules`, `.next`, `mobile/`, `db/`, `.env`…) — un `.env` placé
   manuellement sur le VPS n'est **pas** écrasé ni supprimé ;
3. **écriture du `.env`** sur le VPS (variables de build temps réel, cf.
   « Variables de build temps réel (F-09) » ci-dessus) ;
4. `docker compose up -d --build` — si le build échoue, **les conteneurs
   précédents continuent de tourner** (zéro downtime accidentel) ;
5. Health check : `GET /api/stats` doit répondre 200, puis `docker compose ps`.

---

## 5. Versioning & distribution

```bash
git tag -a v1.0.0 -m "Première release mesh BLE"
git push origin v1.0.0        # → releases Android + iOS automatiques
```

- **Android** : l'utilisateur télécharge l'APK depuis la Release (ou un QR
  code pointant vers `…/releases/latest`), autorise les « sources inconnues »,
  installe. Aucun store, aucune dépendance Google.
- **iOS** : IPA via TestFlight/App Store (méthode `app-store`) ou Ad-hoc ;
  sinon PWA.

---

## 6. Dépannage rapide

| Symptôme | Cause / remède |
|---|---|
| `Gradle daemon… OOM` | déjà couvert : `-Xmx4g` dans le workflow ; sinon réduire la mémoire du runner |
| `expo prebuild` : conflit de plugin | `git clean -xfd mobile/android mobile/ios` (la CI utilise `--clean`) |
| APK non installable | vérifier la signature : `apksigner verify --print-certs app.apk` |
| IPA : `No signing certificate` | certificat expiré ou Team ID erroné |
| `security set-key-partition-list` échoue | trousseau verrouillé — le workflow le crée éphémère, relancer |
| SSH : `Permission denied (publickey)` | clé CI non autorisée sur le VPS, ou mauvais `VPS_PORT` |
| rsync supprime des fichiers VPS | normal (`--delete`) sauf exclusions ; ajouter les exclusions nécessaires dans le workflow |
| Déploiement bloqué sur build Docker | les anciens conteneurs tournent toujours ; corriger, puis `workflow_dispatch` |
