# GOTOMARKET — Transformation en plateforme professionnelle

**Date** : 2026-11-16 (Kinshasa WAT) · **main** : `cb9f880` (déploiements `72fe773` puis `cb9f880`) · **Verdict** : **GO — 3/3 volets livrés en production**

---

## 1. Synthèse

| Volet | Livrable | État |
|---|---|---|
| 1 — Landing page | Vitrine pro sur `https://mbotemesh.aenews.online/`, app déplacée sur `/chat` | ✅ en ligne, 200, ~0.9 s |
| 2 — Distribution APK | `https://mbotemesh.aenews.online/downloads/mbote-latest.apk` | ✅ 200 · 72 405 979 octets |
| 3 — Admin activé + obscurci | Chemin secret + Basic Auth + `ADMIN_API_KEY` + super-admin | ✅ opérationnel |

Chaîne CI complète au vert pour les deux déploiements : `tests.yml` #42/#43 ✅, `security.yml` #10/#11 ✅, `deploy-vps.yml` #41/#42 ✅, `build-android.yml` #59/#60 ✅ (cette dernière valide aussi la nouvelle publication « latest »).

Production finale : `mbote-mesh` / `mbote-admin` / `mbote-relay` **3/3 healthy**, **14/14 migrations** appliquées, `.env` = **10 variables** (les 7 historiques + `ADMIN_INTERNAL_TOKEN`, `ADMIN_BASE_PATH`, `NEXT_PUBLIC_ADMIN_BASE_PATH`).

---

## 2. Volet 1 — Landing page professionnelle

### 2.1 Ce qui a été livré

- **Route `/`** : vitrine publique (Signal-like : sombre, typographie forte, accent unique émeraude — la couleur `--primary` existante, **aucun indigo/bleu**).
  - Hero : titre **« La messagerie qui survit aux coupures. »**, sous-titre E2EE + mesh BLE, CTA principal `Ouvrir Mbote → /chat`, CTA secondaire ancre `#telecharger`.
  - Bande de confiance : Chiffrement de bout en bout · Open Source · Sans publicité · Sans numéro ni compte.
  - Grille 4 features : Appels chiffrés (WebRTC + TURN), Groupes MLS, Médias protégés (voix/images/vidéos), Gouvernance (double validation + audit append-only).
  - Section téléchargement avec **détection d'OS** : Android → CTA APK mis en évidence (ring émeraude + badge « Recommandé pour vous ») ; iOS → carte TestFlight + lien liste d'attente (mailto) ; aria-live pour lecteurs d'écran.
  - Strip « 3 étapes » + footer sticky (`min-h-screen flex flex-col` + `footer mt-auto`), safe-area iOS respectée.
- **Route `/chat`** : l'application chat (ex-`/`), metadata dédiée, i18n inchangée.
- **i18n** : +49 clés `landing.*` dans `locales/fr.json` ET `en.json` (parité vérifiée par script) — zéro dépendance ajoutée.
- **Accessibilité** : header/main/section/footer sémantiques, cibles ≥ 44 px, `prefers-reduced-motion`, focus-visible shadcn.
- **Performance** : `hero.webp` 139 KB (1280 w, ffmpeg, remplace un JPEG masqué `.png` de 180 KB) + `logo.webp` 19 KB ; `next/image` avec `priority` sur le hero seul ; HTML `/` = **34.7 KB**, TTFB+render **≈ 0.90 s** via Cloudflare (objectif < 3 s : 3× marge).

### 2.2 PWA (mise à jour cohérente)

- `sw.js` **v8** : shell pré-caché = `/` **et** `/chat` ; repli hors-ligne privilégie **`/chat`** (le mode courrier doit ouvrir l'app, pas la vitrine) ; cache des navigations **par URL** (l'ancien code écrasait tout à la clé `/`).
- `manifest.webmanifest` : `start_url` `/chat`, `share_target.action` `/chat`, raccourcis `/chat?view=feed` et `/chat?view=network`.

### 2.3 Preuves

| Contrôle | Résultat |
|---|---|
| `curl https://mbotemesh.aenews.online/` | **200** · 0.90 s · 34 710 octets · contient « La messagerie qui survit aux coupures » |
| `curl https://mbotemesh.aenews.online/chat` | **200** |
| Capture desktop 1280 (prod) | `tool-results/gtm-landing-prod-desktop.png` |
| Capture mobile 375 (prod) | `tool-results/gtm-landing-prod-mobile.png` |
| Vérifications navigateur locales (dev) | `tool-results/landing-desktop.png`, `landing-mid.png`, `landing-download.png`, `landing-footer.png`, `landing-mobile.png`, `chat-mobile.png` |

---

## 3. Volet 2 — Distribution directe de l'APK

### 3.1 Chaîne mise en place

```
build-android.yml (push main / tag v* / dispatch)
  → artefact classique + release GitHub « latest » avec asset NOM STABLE mbote-latest.apk
      URL permanente : https://github.com/AlterEgo095/mbote-bitchat/releases/download/latest/mbote-latest.apk
deploy-vps.yml (après gate F-1)
  → télécharge l'APK SUR LE VPS vers public/downloads/mbote-latest.apk
     (dossier exclu du rsync : la version précédente survit à un échec de téléchargement)
  → docker compose build (l'APK entre dans l'image) + nginx `location ^~ /downloads/`
     (service direct depuis le disque hôte, content-type APK)
Landing page
  → bouton « Télécharger pour Android » → /downloads/mbote-latest.apk
```

- `build-android.yml` : triggers `push` (main + tags) / `pull_request` (paths-limité `mobile/**`) / `dispatch` ; **step « Publier mbote-latest.apk »** (release `latest`, upload `--clobber`, non-PR uniquement).
- `deploy-vps.yml` : step **« APK Android — téléchargement sur le VPS »** — succès → remplacement ; échec + fichier existant → conservation + `::warning::` ; échec + aucun fichier → `::warning::` explicite (jamais silencieux).
- `.gitignore` : `/public/downloads/` — l'APK (69 MB) n'est **jamais** versionné.
- Releases GitHub : `v1.0.0` (release versionnée d'origine) + **`latest`** (créée avec `make_latest=false` pour ne pas masquer `v1.0.0`, asset `mbote-latest.apk` 69.1 MB). Les runs #59/#60 du workflow Android ont ensuite ré-uplodé l'asset automatiquement — **boucle CI validée de bout en bout**.

### 3.2 Preuve (curl, exécutée depuis l'extérieur via Cloudflare)

```
$ curl -s -o /dev/null -w "%{http_code} · %{size_download} bytes · %{content_type}" \
    https://mbotemesh.aenews.online/downloads/mbote-latest.apk
200 · 72405979 bytes · application/vnd.android.package-archive
```

Téléchargement complet 72.4 MB en ≈ 6.3 s (≈ 11 MB/s). URL publique anonyme de la release : HTTP 200 également.

---

## 4. Volet 3 — Panneau d'administration : activation et obscurcissement

### 4.1 Activation (secrets & compte)

| Élément | État |
|---|---|
| `ADMIN_API_KEY` | **Actif** — généré (`openssl rand -hex 32`), provisionné en **secret GitHub** (API, valeur chiffrée sealed-box, jamais imprimée), écrit dans le `.env` VPS par `deploy-vps.yml` (preuve : clé présente dans le `.env`, valeur non divulguée) |
| `ADMIN_INTERNAL_TOKEN` | **Actif** — idem (nécessaire au BFF admin pour `/api/internal/admin/*`, RBAC §8 ; était **absent** avant cette session — le panneau n'aurait jamais pu s'authentifier) |
| `.env` VPS | 10 variables confirmées : `ADMIN_API_KEY`, `ADMIN_BASE_PATH`, `ADMIN_INTERNAL_TOKEN`, `MBOTE_BOT_KEY`, `NEXT_PUBLIC_ADMIN_BASE_PATH`, `NEXT_PUBLIC_SOCKET_URL`, `RELAY_ALLOWED_ORIGIN`, `RELAY_EMIT_TOKEN`, `SEED_SECRET`, `TURN_SHARED_SECRET` |
| Super-admin | **Créé en prod** via `scripts/admin-bootstrap.ts` dans le conteneur `mbote-mesh` (`--allow-prod`) : rôle `super-admin`, `totpEnrolled=false` → **enrôlement TOTP forcé au premier login** ; 2 codes de secours générés (stockés hashés) ; `AdminAudit{action:'bootstrap'}` écrit dans la même transaction |
| Credentials opérateur | **`/opt/mbote-bitchat/ADMIN-CREDENTIALS.txt` (0600, sur le VPS)** — contient l'UNIQUE sortie du bootstrap : email, mot de passe temporaire, secret TOTP (otpauth), 2 codes break-glass. **Aucun secret dans ce rapport ni dans le chat.** |

DB vérifiée : `AdminUser total=2` (pseudo-user `system@mbote.internal` de la migration + le compte opérateur `super-admin`) ; `AdminAudit` = `bootstrap:1, login_failed:1` (ce dernier = la sonde volontaire à mauvais identifiants, §4.3).

### 4.2 Obscurcissement & défense en profondeur

**Décision documentée — chemin secret plutôt que sous-domaine** : la création du sous-domaine (`console-*.mbotemesh.aenews.online`) exige une entrée DNS Cloudflare ; **aucun token d'API Cloudflare n'est disponible** sur le VPS ni dans le dépôt (chasse documentée §6). Le fallback implémenté (à défaut de CF Access ET d'IP-allowlist opérateur inconnue) :

```
Cloudflare (TLS + proxy)
  → nginx vhost mbotemesh.aenews.online
      · geo $realip_remote_addr → 403 hors plages Cloudflare (O-A, maintenu)
      · location ~ ^/console-16bd6307(/|$)   ← COUCHE 1 : URL imprévisible
          auth_basic /etc/nginx/.htpasswd-mbote-admin   ← COUCHE 2 : Basic Auth (root:www-data 640)
          proxy_pass 127.0.0.1:3392 (override compose, basePath Next)
  → app admin (basePath Next figé au build : ADMIN_BASE_PATH/NEXT_PUBLIC_ADMIN_BASE_PATH)
      cookie de session SCOPÉ au chemin (cookieFlags — plus émis vers les routes publiques)
  → login panneau : Argon2id + TOTP + RBAC   ← COUCHE 3
  → backend /api/internal/admin/* : token interne ADMIN_INTERNAL_TOKEN   ← COUCHE 4
```

Implémentation technique :
- `admin/next.config.ts` : `basePath: process.env.ADMIN_BASE_PATH || undefined` (vide = racine, rétrocompatible dev/sous-domaine).
- `admin/src/lib/api-base.ts` (nouveau) : wrapper **`apiFetch`** (signature = `fetch`) préfixant les 20 appels clients absolus `/api/…` — refactor mécanique des 8 composants ; `tsc` 0 erreur.
- `admin/src/lib/admin-backend.ts` : `cookieFlags()` scope le cookie de session au chemin secret.
- `admin/Dockerfile` : `ARG/ENV ADMIN_BASE_PATH` + `NEXT_PUBLIC_ADMIN_BASE_PATH` (basePath figé à la build — validé : `routes-manifest.json.basePath = /console-testgtm` sur un build local de contrôle).
- `docker-compose.yml` : `build.args` + `environment` admin ; **healthcheck basePath-aware** (cf. incident §5.1).
- `deploy/nginx/admin.conf` : template corrigé — port hôte **3392** (override compose ; ⚠️ `127.0.0.1:3001` est occupé par `siteaenews-frontend` sur ce serveur partagé) et mode sous-domaine documenté pour évolution (MODE B).

### 4.3 Preuves (curl via Cloudflare)

```
$ curl -o /dev/null -w "%{http_code}" https://mbotemesh.aenews.online/console-16bd6307
401                                    ← sans Basic Auth : refusé (Basic Auth actif)

$ curl -L -u mbote:*** -o /dev/null -w "%{http_code}" …/console-16bd6307
200                                    ← avec Basic Auth : page de login
                                       (title "Mbote Admin", capture gtm-admin-login-prod.png)

$ curl -u mbote:*** -X POST -H 'Content-Type: application/json' \
     -d '{"email":"x@y.z","password":"n","totp":"000000"}' \
     …/console-16bd6307/api/admin/auth/login
401 {"error":"invalid credentials"}    ← API vivante, 401 uniforme (audit login_failed tracé)

$ curl -sk --resolve mbotemesh.aenews.online:443:95.111.226.63 -o /dev/null -w "%{http_code}" https://mbotemesh.aenews.online/
403                                    ← bypass direct-origine toujours bloqué (O-A maintenu)
```

---

## 5. Incidents & écarts (jamais silencieux)

1. **`mbote-admin` unhealthy après le 1ᵉʳ déploiement (72fe773)** — cause : la sonde du compose frappait `/api/health` absolu alors que la route vit sous le basePath (`/console-16bd6307/api/health` → 200 vérifié depuis le VPS : **l'app était saine, c'est le moniteur qui était trompé**). Correctif `cb9f880` (sonde basePath-aware) → re-déploiement #42 → **3/3 healthy**.
2. **Permissions htpasswd** — créé `root:root 0600` : les workers nginx (`www-data`) ne pouvaient pas le lire → 500. Corrigé `root:www-data 640` (pattern nginx standard), `nginx -t` + reload, re-test 401/200/401 verts.
3. **`docker cp` et tmpfs** — le conteneur est `read_only` et `docker cp` ne voit pas le mount tmpfs `/tmp` : transfert des 2 fichiers du bootstrap refait via `docker exec -i sh -c 'cat > …'`. Nettoyage `/tmp/gtm` effectué.
4. **Fausse alerte « branches: ain] »** — un artefact d'affichage (séquence `[m` avalée par le canal de sortie) faisait croire à un YAML cassé ; inspection des octets réels (`5b 6d 61 69 6e 5d` = `[main]`) : **le trigger était correct**. Correction non appliquée (uniquement paths-limitation des PR + step « latest »).
5. **Runbook `admin:create`** — `docs/specs/ADMIN-ACCESS-RUNBOOK.md §3.1` référence `bun run admin:create` : ce script npm n'existe pas dans `package.json` et `scripts/` n'est pas copié dans l'image (standalone). Bootstrap exécuté via `admin-bootstrap.ts` injecté dans `/tmp` du conteneur (symlink `node_modules`). **Écart code↔docs à combler** (script npm + copie scripts/ ou runbook corrigé).
6. **2 déploiements au lieu d'un** — `72fe773` (GTM) puis `cb9f880` (fix healthcheck). Chacun passé par le gate F-1 complet (tests + security vertes sur son SHA).
7. **Détection locale vs prod** — le catalogue de locale du navigateur headless (EN) active l'anglais par défaut : comportement correct de l'i18n ; captures FR obtenues via `localStorage mbote_locale=fr`.

---

## 6. Enquêtes & découvertes (contexte)

- **Aucun token d'API Cloudflare** accessible (hunt ciblé : `~`, `/opt` racines, `/etc/environment`, crontab, `/opt/configs`, `/opt/scripts`, `/opt/aenews-ai-creds.txt`) → choix du chemin secret ; la procédure sous-domaine reste documentée dans `deploy/nginx/admin.conf` (MODE B) si l'opérateur crée le CNAME proxifié + `certbot certonly --nginx`.
- **Port 3001 hôte = `siteaenews-frontend`** (autre app du serveur partagé) — le template historique `admin.conf` qui pointait 3001 aurait proxifié vers la MAUVAISE application ; corrigé vers 3392.
- **Bootstrap admin** : le seul AdminUser préexistant était le pseudo-user `system@mbote.internal` (migration 0004) — aucun vrai compte n'existait en prod, le bootstrap était donc bien requis.

---

## 7. État final de la production

| Contrôle | Résultat |
|---|---|
| `docker ps` (mbote) | `mbote-admin healthy` · `mbote-mesh healthy` · `mbote-relay healthy` — **3/3** |
| Migrations | **14/14** appliquées (`_prisma_migrations` finished) |
| Landing `/` | 200 · 0.90 s · titre FR ✓ |
| App `/chat` | 200 ✓ |
| APK `/downloads/mbote-latest.apk` | 200 · 72 405 979 octets · `application/vnd.android.package-archive` ✓ |
| Bypass direct (curl --resolve) | **403** (verrou Cloudflare O-A maintenu) ✓ |
| Admin chemin secret sans auth | **401** ✓ |
| Admin avec Basic Auth | **200** (« Mbote Admin », backend health 200 · 245 ms) ✓ |
| POST login (mauvais creds) | **401 uniforme** ✓ (audit tracé) |
| TURN (rappel O-A) | inchangé — `/api/turn-credentials` actif (protégé par preuve) |

**Déploiements** : `deploy-vps.yml` run #41 (SHA `72fe773`) et run #42 (SHA `cb9f880`) — tous deux `success` ; logs : `https://github.com/AlterEgo095/mbote-bitchat/actions/runs/43932422969` et `…/43935461945`.

---

## 8. Prochaines étapes opérateur (hors périmètre session)

1. **Premier login admin** : lire `/opt/mbote-bitchat/ADMIN-CREDENTIALS.txt` sur le VPS (`cat` en SSH) → ouvrir `https://mbotemesh.aenews.online/console-16bd6307` (Basic Auth `mbote` / mot de passe stocké dans ce même fichier — voir §4.1) → saisir email + mot de passe temporaire → **enrôlement TOTP forcé** (scanner le secret otpauth depuis un authentificateur) → noter les 2 codes break-glass hors ligne.
2. **Rotation recommandée** : mot de passe Basic Auth (`htpasswd` sur le VPS) après première connexion ; éventuellement renouveler le token GitHub utilisé (scopes repo/workflows).
3. **Optionnel — sous-domaine dédié** : créer le CNAME proxifié chez Cloudflare (zone aenews.online) → `certbot certonly --nginx -d <sous-domaine>` → activer le MODE B dans `deploy/nginx/admin.conf` (vhost prêt) → retirer le bloc chemin secret du vhost principal.
4. **Optionnel — Cloudflare Access (Zero Trust)** : barrière primaire idéale sur ce chemin (décision audit §4.5) — l'activer depuis le dashboard CF quand l'accès API/dashboard est disponible.
5. **Comblement d'écart docs** : wire `admin:create` (script npm) ou corriger le RUNBOOK §3.1 (cf. §5.5).
6. **iOS** : TestFlight — préparer un compte développeur Apple (l'IPA non signée n'est pas installable ; la carte iOS de la landing porte déjà la liste d'attente mailto).

---

## 9. Hygiène des secrets (fin de session)

- Protocole push respecté 2× : `umask 077` → cred 0600 → précheck API → push → `git ls-remote` anonyme → `shred -u` (fichiers présents vérifiés disparus).
- Secrets GitHub provisionnés via API (sealed box libsodium) : valeurs **jamais imprimées** dans les sorties.
- Fichiers temporaires locaux shred en fin de session : `.gtm.env`, `.gtm-secrets.json`, `.htmphash`, `.gh.tok` (les valeurs vivent uniquement : secrets GitHub / `.env` VPS 0600 / `ADMIN-CREDENTIALS.txt` VPS 0600 / htpasswd hashé).
- Aucun secret en clair dans ce rapport (les valeurs sensibles sont masquées `***` ou remplacées par leur empreinte de longueur).
