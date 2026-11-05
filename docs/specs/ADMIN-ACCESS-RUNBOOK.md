# RUNBOOK — ACCÈS & DÉPLOIEMENT DU PANNEAU ADMIN (ADM MVP)

**Version** : 1.0 · **Date** : 2026-11-05 (Kinshasa WAT) · **Applicable à partir de** : Étape 4 livrée (auth + RBAC)
**Décisions de référence** : `docs/proofs/ADM-audit-2026-11-05.md` §4.5 (CF Access requis, IP allowlist = fallback) · `docs/specs/ADMIN-RBAC.md`

---

## 1. CHAÎNE D'ACCÈS CIBLE

```
Opérateur (navigateur)
  → Cloudflare Access  (admin.mbotemesh.aenews.online — barrière primaire, décision §4.5)
  → nginx vhost TLS    (certbot LE dédié au sous-domaine)
  → 127.0.0.1:3001     (conteneur Docker `mbote-admin` — jamais publié au-delà de localhost)
  → réseau Docker      (mbote:3000 — endpoints /api/moderation/* et /api/internal/admin/*)
  → DB SQLite          (jamais touchée par l'app admin)
```

L'app principale (`mbotemesh.aenews.online`) reste inchangée et accessible au public. Le panneau vit sur un **sous-domaine dédié** avec cookie, CSP et vhost isolés.

---

## 2. PRÉREQUIS BLOQUANTS (dans l'ordre — ne pas inverser)

| # | Prérequis | Vérification | Référence |
|---|---|---|---|
| P1 | **O-B fait** : counts legacy prod = 0 (4 SELECT, en-tête migration 0004) | sortie opérateur collée en preuve | ADM-rupture.md §8 |
| P2 | **O-A fait** : `main` poussé (⚠️ déclenche `deploy-vps.yml` → migration 0004 en prod) | `git ls-remote origin main` | ADM-rupture.md §8 |
| P3 | **O-C fait** : `feat/adm-mvp` poussé + PR schema-guard verte (fermée sans merge) | CI verte | ADM-rupture.md §8 |
| P4 | **Étapes 3+4 livrées** (login+TOTP+sessions + RBAC + token interne) — *sans auth, l'admin n'existe pas fonctionnellement* | preuves ADM-step3-4 | recadrage §4 |
| P5 | DNS : `CNAME admin.mbotemesh.aenews.online → mbotemesh.aenews.online` (proxy CF **activé**, nuage orange) | `dig` | — |
| P6 | `.env` VPS : `ADMIN_INTERNAL_TOKEN=$(openssl rand -hex 32)` (jamais commité) | `grep -c ADMIN_INTERNAL_TOKEN .env` = 1 | RBAC §8 |

---

## 3. INSTALLATION VPS (commandes exactes)

```bash
# 1. Déployer la branche ADM (le pipeline CI fait le rsync + compose build)
#    Le compose démarre le 3e service `admin` (127.0.0.1:3001) — voir docker-compose.yml.

# 2. Vérifier le conteneur depuis l'intérieur du VPS
curl -s http://127.0.0.1:3001/api/health
#  → attendu : {"status":"ok","service":"mbote-admin","checks":{"backend":"up (200)"},...}

# 3. Certificat TLS du sous-domaine
certbot certonly --nginx -d admin.mbotemesh.aenews.online

# 4. Vhost nginx (template livré dans le repo)
cp deploy/nginx/admin.conf /etc/nginx/sites-available/mbote-admin.conf
sed -i 's/admin\.MBOTE_DOMAIN/admin.mbotemesh.aenews.online/' /etc/nginx/sites-available/mbote-admin.conf
ln -sf /etc/nginx/sites-available/mbote-admin.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 5. Cloudflare Access (dashboard CF) :
#    Applications → Self-hosted → domaine admin.mbotemesh.aenews.online
#    Policy : Include → Emails → <email opérateur> ; Login method : One-time PIN
#    (l'IP allowlist nginx du template reste COMMENTÉE = fallback uniquement)

# 6. Vérifications externes (depuis une machine hors VPS)
curl -sI https://admin.mbotemesh.aenews.online/api/health
#  → attendu SANS session Access : 302 vers <team>.cloudflareaccess.com (jamais 200 direct)
#  puis naviguer : login CF (One-time PIN) → page stub du panneau → badge backend vert.
```

### 3.1 Seed du premier AdminUser (après Étape 3)
```bash
docker exec mbote-mesh bun scripts/admin-create.ts --email operateur@<domaine> --role super-admin
#  → mot de passe temporaire + secret TOTP (QR otpauth) affichés UNE FOIS — noter hors ligne.
#  Premier login panneau : mot de passe temporaire → enrôlement TOTP forcé (RBAC §7.2)
#  → 2 codes break-glass affichés UNE FOIS — les conserver hors ligne (RBAC §7.3).
```

---

## 4. HEALTH CHECK — LES 2 ÉTATS (prouvés dans `docs/proofs/ADM-step1-2.md`)

| État | Condition | Réponse | Effet compose |
|---|---|---|---|
| **UP** | `mbote:3000` répond (ping `/api/stats`) | `200 {"status":"ok","checks":{"backend":"up (200)"}}` | conteneur `healthy` |
| **DEGRADED** | backend injoignable (timeout 3 s / non-2xx) | `503 {"status":"degraded","checks":{"backend":"unreachable"}}` | conteneur `unhealthy` après 3 retries |

Le healthcheck du conteneur admin interroge son propre `/api/health` : un backend mort rend le conteneur visiblement `unhealthy` (`docker ps`), sans jamais toucher la DB (readonly par construction — l'app admin n'a pas de client DB).

---

## 5. EXPLOITATION COURANTE

| Besoin | Procédure |
|---|---|
| Lister les sessions actives | `docker exec mbote-mesh bun scripts/admin-session.ts list` |
| Révoquer toutes les sessions (suspicion de fuite) | `docker exec mbote-mesh bun scripts/admin-session.ts revoke-all` |
| Désactiver un compte admin | CLI `--disable` (jamais de DELETE — FK + audit) |
| TOTP perdu + break-glass brûlé | CLI `admin-reset-totp` + justification (audit) ; la session compromise est révoquée |
| Urgence modération sans panneau | CLI `moderation-purge.ts` (Étape 0 — seul détenteur restant d'`ADMIN_API_KEY`) |
| Diagnostic panneau | `docker logs mbote-admin` · `curl http://127.0.0.1:3001/api/health` · access.log nginx du vhost admin |
| Rotation du token interne | nouveau `openssl rand -hex 32` dans `.env` → `docker compose up -d admin mbote` (les 2 services redémarrent ; sessions utilisateur inchangées) |

---

## 6. ROLLBACK

```bash
docker compose stop admin                # le panneau tombe
rm /etc/nginx/sites-enabled/mbote-admin.conf && nginx -t && systemctl reload nginx
# (option) Cloudflare Access → pause/suppression de l'application
```
L'app principale et le relay **ne sont pas touchés** (service isolé dans le compose). Aucun rollback DB n'est nécessaire tant qu'aucune action admin n'a été exécutée — et après coup, l'audit append-only conserve la trace de tout ce qui a été fait.

---

## 7. CHECKLIST GO DÉPLOIEMENT ADM (à cocher dans le rapport de preuve de déploiement)

- [ ] P1→P6 du §2 toutes vertes (dans l'ordre)
- [ ] `docker ps` : `mbote-admin` **healthy**, `mbote-mesh` **healthy**, `mbote-relay` **healthy**
- [ ] `curl http://127.0.0.1:3001/api/health` → 200 `status:"ok"`
- [ ] Dehors, sans session Access : **302** CF (pas de 200 direct) — capture en preuve
- [ ] Dehors, avec session Access : page stub + badge backend vert
- [ ] En-têtes présents sur le vhost : CSP (`frame-ancestors 'none'`), X-Frame-Options DENY, nosniff
- [ ] Premier login opérateur + TOTP enroll + 2 codes break-glass archivés hors ligne
- [ ] `ADMIN_API_KEY` toujours absente du `.env` (gel O-4 maintenu jusqu'à preuve de rupture déployée)
