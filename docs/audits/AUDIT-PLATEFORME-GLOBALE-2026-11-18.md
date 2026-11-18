# AUDIT PLATEFORME GLOBALE — MBotE Mesh (2026-11-18)

**Périmètre** : plateforme complète — topologie VPS (via docker-compose + Dockerfiles), chaîne
CI/CD (8 workflows), posture sécurité applicative (src/, admin/, relay), surface publique
(probes externes live), opérations (backups, preuves, runbooks).

**Méthode** : lecture exhaustive du code et des workflows, audits agents spécialisés
(CI/CD + sécurité, chaque constat adossé à un `fichier:ligne`), probes réseau réelles
(en-têtes, TLS, endpoints), analyse git (dependabot, conflits, merge-bases).

**Limite déclarée** : pas d'accès SSH disponible lors de l'audit — l'état *réel* du VPS
(conteneurs vivants, nginx, firewall, disque, logs) est inféré depuis le dépôt + les probes
publiques, pas observé directement. Section §7 liste ce qui reste à confirmer via SSH.

---

## 1. Synthèse exécutive

**Verdict : plateforme solide, nettement au-dessus de la moyenne pour un projet de cette
taille.** Les fondamentaux sécurité sont vérifiés conformes (fail-closed généralisé,
invariants E2EE respectés, back-office intégralement gardé, SQL paramétré, conteneurs
durcis, CI épinglée par SHA). Zéro constat P0.

Le point commun des vraies faiblesses résiduelles : **elles sont toutes silencieuses** —
CI verte alors que la prod est dégradée. Trois exemples concrets constatés pendant cet
audit même : le bug panneau d'hier est passé en deploy vert (healthcheck post-deploy ne
teste que l'app principale) ; les notifications push sont **actuellement désactivées en
prod** (`/api/push/config` → 503, cohérent avec le drift `.env` VAPID du workflow deploy) ;
7 des 20 derniers deploys sont en échec sans mécanisme de rollback utilisable.

| Priorité | Nombre | Résumé |
|---|---|---|
| P0 | 0 | — |
| P1 | 6 | Healthcheck post-deploy mono-service · push Web désactivé en prod (VAPID) · rate-limit admin contournable via XFF forgé · rollback inutilisable · Trivy non bloquant + deps non audités hors racine · pas de runbook de restauration backup |
| P2 | ~16 | Détail en §5 |

---

## 2. Topologie constatée (dépôt + probes)

| Service | Conteneur | Port hôte | Exposition | Durcissement |
|---|---|---|---|---|
| App principale | mbote-mesh | **0.0.0.0:3000** ⚠️ | nginx (Cloudflare-only) | read_only · cap_drop ALL · no-new-privileges · healthcheck migrations+API |
| Relay WebSocket | mbote-relay | 127.0.0.1:3030 (+3031 interne) | nginx → Cloudflare | idem, sans état |
| Admin BFF | mbote-admin | 127.0.0.1:3001 | chemin secret + basic auth nginx + login+TOTP | idem, zéro accès DB |

DB SQLite sur volume `mbote-data`. TURN direct `95.111.226.63:3478` (non proxifié CF — par
conception). Backups : `backups/` VPS (rotation 14) + branche git `backups` (chiffré AES-256,
clé `.backup-key` jamais hors VPS) + artefact CI 30 j.

---

## 3. Surface publique — probes réelles (2026-11-18)

| Sonde | Résultat | Verdict |
|---|---|---|
| En-têtes `/` | CSP stricte + HSTS preload + DENY + Permissions-Policy 20 directives | ✅ conforme |
| TLS | Let's Encrypt, valide jusqu'au 2027-02-06 | ✅ |
| APK `/downloads/mbote-latest.apk` | 200, 72 Mo, content-type correct | ✅ |
| `/admin` (chemin par défaut) | **404** — chemin secret actif | ✅ obscurcissement confirmé |
| `socket.io` polling | 200 (public par design) | ✅ |
| `/api/stats` | 200 public — compteurs globaux + perf (recon possible) | ⚠️ P2 |
| `/api/turn-credentials` | 401 (auth requise) | ✅ |
| `/api/push/config` | **503 — push DÉSACTIVÉ en prod** (VAPID absentes) | ❌ P1 |
| Historique deploys (20 derniers) | 13 succès / **7 échecs**, sans rollback ni notification dédiée | ⚠️ P1 |

---

## 4. Constats P1 (avec preuves)

1. **Healthcheck post-deploy mono-service** — `deploy-vps.yml:253-258` : un seul `curl
   /api/stats` local, sans retry. L'admin (`/api/health` basePath-aware existe !
   `admin/src/app/api/health/route.ts`) et le relay ne sont jamais vérifiés par la CI ;
   la couche TLS publique non plus. Conséquence démontrée : le bug panneau du 17-11 est
   parti en prod en vert. *Fix : boucle retry 12×5 s + `docker compose ps` + curl admin
   + socket.io + URL publique.*
2. **Push Web désactivé en prod (drift `.env`)** — `deploy-vps.yml:216-227` n'écrit que
   10 variables ; `docker-compose.yml:35-37` attend `VAPID_*`. Chaque deploy écrase le
   `.env` et efface silencieusement les clés si elles étaient posées à la main — ou elles
   n'ont jamais été provisionnées (état actuel : 503). *Fix : provisionner les clés VAPID
   + les ajouter aux secrets GitHub et au step `.env`.*
3. **Rate-limit admin contournable** — `admin-internal.ts:53-60` fait confiance au
   **premier** hop `x-forwarded-for` (forgé par l'attaquant) alors que l'app publique a un
   client-IP durci (`client-ip.ts:149-167`, dernier hop prouvé Cloudflare). Le BFF relaye
   la chaîne XFF verbatim (`admin-backend.ts:47`). *Fix : réutiliser le clientIp durci ou
   faire écraser XFF par nginx sur le vhost admin + bucket secondaire par email.*
4. **Rollback inutilisable** — `docs/PRE-DEPLOY-CHECKLIST.md:224` documente `git checkout`
   sur le VPS : impossible (rsync exclut `.git`, `deploy-vps.yml:163`) et le dispatch ne
   déploie que le HEAD. *Fix : input `ref` sur le `workflow_dispatch` (derrière le gate) +
   doc corrigée.*
5. **Scanning non bloquant et incomplet** — Trivy `exit-code: "0"` (`security.yml:119`,
   HIGH/CRITICAL jamais rouges) ; `npm audit` racine seule — `admin/`, `relay/`,
   `mobile/` partent en prod sans aucun audit de deps ; aucun gate qualité (lint/tsc) sur
   `admin/**` avant le build Docker (`tsconfig.json:43,47`, `eslint.config.mjs:126`).
6. **Restauration backup non documentée** — le backup est excellent (AES-256, integrity
   check, VACUUM, **test de restauration à chaque cycle** `backup-mbote.sh:136-154`) mais
   la procédure manuelle n'existe nulle part : perte du VPS + perte de `.backup-key` =
   données irrécupérables sans runbook ni double garde de la clé.

## 5. Constats P2 (résumé)

**CI/CD** : gate pass-through si erreur API (`deploy-vps.yml:89-94`) · paths-ignore
évalué sur le dernier commit seul (`:98-107`) · weekly-proof skip = vert
(`weekly-proof-run.yml:99,132-145`) · timeouts/concurrency absents de la plupart des jobs
(seul weekly-proof a un timeout) · `contents: write` sur builds y compris PR (F-5) ·
Xcode non épinglé · 5 PR dependabot obsolètes dont checkout-7.0.1 **en conflit réel** avec
main (versions mixtes post-merge) · docs CI-CD.md / CI-AUDIT.md obsolètes (déclencheurs,
table secrets, exclusions rsync).

**Sécurité applicative** : relay sans rate limit sur `hello`/`subscribe` + preuve hello
rejouable 15 min (`hub.ts:51,165-208`) · proxy média bufferise jusqu'à 100 Mo anonymement
(`proxy/[...path]/route.ts:42,132-139`) · binding `0.0.0.0:3000` incohérent avec les deux
autres services (`docker-compose.yml:12`) · fallback bot-key dérivable en prod
(`bot-key.ts:44`) · `/api/stats` public trop bavard · pas de purge automatique des médias
pending > 24 h · pas de middleware défensif `/api/internal/*` · CSP `unsafe-inline`
(arbitrage Next à formaliser ou passer aux nonces) · cookie sans préfixe `__Host-` ·
comparaison non timing-safe sur `x-seed-secret` (`seed/route.ts:139-148`) · artefacts de
secrets de test dans docs/proofs (dev, non exploitables, à purger).

## 6. Points forts vérifiés conformes (audit honnête)

- **Fail-closed généralisé** : ADMIN_INTERNAL_TOKEN absent → tout refusé ; SEED_SECRET,
  TURN, VAPID, S3 — tous dégradés proprement, jamais ouverts.
- **Back-office intégralement gardé** : vérification programmatique — 0 route
  `/api/internal/admin/*` sans garde sur ~30 routes ; timing-safe ; RBAC à rôles ;
  cross-check acteur ; CSRF mutations ; auth par headers custom (immunisée CSRF navigateur).
- **Invariants E2EE respectés partout**, y compris les 6 nouveaux annuaires admin :
  métadonnées uniquement, `LENGTH(ciphertext)` jamais le contenu, badge `e2ee:true`.
- **SQL irréprochable** : FTS5 paramétré + quoté, `$queryRawUnsafe` en placeholders,
  fragments depuis whitelist, LIKE échappé.
- **Sessions admin durcies** : Argon2id + TOTP anti-rejeu par compteur persisté, token
  hashé en DB, TTL 8 h + idle 30 min, révocation tracée, 401 uniforme anti-énumération.
- **Rate limiting public dense** : PoW 20 bits + 3 comptes/h/IP, DMs 30/min/clé +
  anti-replay transactionnel, uploads 20/h + quota 500 Mo, search 30/min/IP.
- **Conteneurs durcis** : read_only, cap_drop ALL, no-new-privileges, healthchecks réels
  (dont garde migrations).
- **CI épinglée 26/26 par SHA**, images Docker par digest, gate de déploiement en code,
  schema-guard, backups auto-testés.

## 7. Non vérifiable sans accès SSH (à confirmer en séance)

1. État réel des 3 conteneurs (`docker compose ps`), logs d'erreurs récurrents.
2. nginx : allowlist Cloudflare-only active sur 443, vhost admin (basic auth + chemin),
   écrasement ou non de XFF ; exposition réelle du port 3000/3001/3030/3478 depuis
   l'extérieur ; ufw/iptables.
3. Charge système (load ~8-10 constaté en session précédente — seuil CPU de la VM ?),
   mémoire, disque (croissance du volume DB), swap.
4. Custody de `.backup-key` (double ? coffre ?) + une restauration manuelle conduite une fois.
5. Fail2ban / durcissement SSH (port dédié `VPS_PORT`, interdiction root, clés).
6. Taille réelle de la DB + fréquence VACUUM vs croissance.

## 8. Plan d'action priorisé

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | Healthcheck post-deploy complet (3 services + retry + URL publique) dans deploy-vps.yml | S | évite « CI verte, prod morte » — aurait attrapé le bug d'hier |
| 2 | Provisionner VAPID_* (bunx web-push generate-vapid-keys) → secrets GitHub + step .env → push réactivé | S | fonctionnalité push remise en service, drift supprimé |
| 3 | Unifier clientIp durci côté admin-internal (+ nginx XFF overwrite si SSH) | S | anti-bruteforce admin réellement efficace |
| 4 | Rollback : input `ref` au workflow_dispatch + doc corrigée | S | capacité de réagir en incident |
| 5 | Trivy bloquant + audit deps admin/relay/mobile + gates lint/tsc sur admin/** | M | chaîne d'approvisionnement couverte |
| 6 | Runbook de restauration backup + double de `.backup-key` hors VPS | S | continuité réelle |
| 7 | Dependabot : fermer les 5 PR, regénérer (checkout v7 en conflit) | S | hygiène supply chain |
| 8 | Binding `127.0.0.1:3000:3000` + vérif allowlist CF via SSH | S | cohérence réseau |
| 9 | Rate limit relay hello/subscribe + streaming proxy média | M | surfaces DoS fermées |
| 10 | Notifications d'échec (webhook) sur deploy + backup ; timeouts partout | M | incidents visibles |

*Légende effort : S ≤ 1 h, M ≤ 1 jour.*
