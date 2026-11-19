# AUDIT PLATEFORME GLOBALE — Vérification SSH live (2026-11-19)

**Complément de** : `AUDIT-PLATEFORME-GLOBALE-2026-11-18.md` — cet addendum ferme la
§7 de l'audit doc (« non vérifiable sans accès SSH ») en observant **directement le
VPS** `95.111.226.63` (host `vmi3058261`, Ubuntu 6.8.0-147, uptime 31 j).

**Méthode** : SSH interactif (`docker ps/inspect/stats/logs exec`, `ss`, `ufw`,
`fail2ban-client`, `sshd -T`, lecture `/etc/nginx/sites-enabled/*`, crontab, PM2,
inspection SQLite live readonly via `bun:sqlite`, probes externes depuis l'extérieur
via Cloudflare : codes HTTP, headers, handshake socket.io, STUN 3478/udp, TCP connect
sur ports sensibles).

**Périmètre déclaré** : observation + probes passives. **Aucune modification** n'a été
effectuée sur le VPS (aucun prune, aucun restart, aucune écriture) — les actions
proposées sont en §4, à valider avant exécution.

---

## 1. Synthèse exécutive

**MBotE (la plateforme elle-même) est saine et conforme à l'audit doc :** 3 conteneurs
healthy, DB SQLite intègre (34 tables, `integrity_check: ok`, WAL), backups quotidiens
chiffrés **PASS** avec test de restauration à chaque cycle, chaîne nginx→CF verrouillée
(bypass origine = 403 confirmé), basic-auth admin actif (401 externe), fail2ban 14 jails,
UFW deny par défaut, conteneurs MBotE légers (< 1 % CPU, 230 Mo RAM cumulés).

**La vraie menace est l'hôte, pas MBotE.** La VM est **saturée** : load ~9.5 sur 6 vCPU,
RAM 9,7/11 Go, **swap 8 Go utilisé à 100 %** (2,1 Mo libres), **disque 95 %** (11 Go
libres / 193 Go). ~100 conteneurs Docker + 23 apps PM2 cohabitent. Conséquences déjà
réelles : mailcow redis **OOM-killed (exit 137)**, postfix arrêté 3 jours, ofelia et
netfilter en boucle de restart ; `aenewsos-backend` (PM2) en crash-loop (989 restarts) ;
`aenews-mongo` bloqué sur « health: starting » depuis 3 jours ; `aenewsb-api` unhealthy.
Le killer OOM peut frapper n'importe quel conteneur, **y compris mbote-mesh**.

| Priorité | Nombre | Résumé |
|---|---|---|
| P0 (hôte) | 1 | Saturation hôte (swap 100 %, load 9.5, disque 95 %) — risque OOM direct sur MBotE |
| P1 | 6 | Confirmés live : VAPID vides (push 503) · rate-limit admin bypassable (XFF) · healthcheck post-deploy mono-service · rollback inutilisable · Trivy non bloquant · runbook restauration + custody `.backup-key` |
| P2 (hôte) | 5 | Mailcow dégradé 3 j · SSH password-auth sous bruteforce · 72 maj apt en attente · voisins dégradés (mongo/PM2) · `x-powered-by` exposé |
| P2 (app) | ~16 | Identiques à l'audit doc §5 (non re-vérifiés un à un) |

---

## 2. Clôture de la §7 de l'audit doc — confirmé / infirmé

| # | Question §7 | Réponse SSH (mesurée) |
|---|---|---|
| 1 | État des 3 conteneurs + logs | ✅ `mbote-mesh` (healthy, 112 Mo, 0,1 % CPU), `mbote-admin` (healthy, 62 Mo, 0 erreurs 48 h), `mbote-relay` (healthy, 18 Mo, startup propre). Logs mesh : bruit `prisma:query` verbeux + 1 erreur bénigne Next server-action ID (client obsolète). **Aucune erreur récurrente.** |
| 2 | nginx allowlist CF / vhost admin / XFF / exposition | ✅ geo `$mbote_not_cf` actif — `curl --resolve 127.0.0.1` depuis l'hôte → **403**. Vhost admin : basic-auth `/console-16bd6307` → 401 externe, 200 interne. ⚠️ **XFF confirmé append-only** (`$proxy_add_x_forwarded_for`) : le premier hop reste forgé → P1#3 confirmé. Exposition réelle : 3000/3001/3030 → `127.0.0.1` (override VPS, l'inquiétude compose `0.0.0.0:3000` de l'audit doc est **neutralisée en prod**) ; 3478 public (par conception, TURN). |
| 3 | Charge / RAM / disque / swap | ❌ **Pire que prévu** : load 9,4-9,7/6 vCPU ; RAM 9,7/11 Go ; **swap 8/8 Go (100 %)** ; disque 183/193 Go (**95 %**, 11 Go libres) ; docker : 78 Go d'images dont **25,7 Go récupérables** + 1,25 Go build cache. MBotE innocent (0,1 % CPU, 230 Mo). Coupables : clamd 1 Go RAM, ~100 conteneurs, 23 apps PM2. |
| 4 | Custody `.backup-key` + restauration manuelle | ⚠️ Partiellement résolu : backups quotidiens 02:17 UTC **PASS** (cron aenews ligne 34), AES-256-CBC/PBKDF2, integrity_check + comparaison comptages à chaque cycle, rotation 14 j, statut JSON. **Custody = copie unique sur le VPS** : VPS mort = backups illisibles. Runbook de restauration manuelle : toujours absent. |
| 5 | Fail2ban / durcissement SSH | ✅ fail2ban actif, 14 jails (sshd, recidive, nginx-admin-bruteforce, nginx-http-auth…), **896 bans cumulés**. sshd : root interdit, pubkey on, MaxAuthTries 5. ⚠️ **PasswordAuthentication yes** sous 5 091 échecs/24 h — tenable avec fail2ban, mais clés + `PasswordAuthentication no` recommandés (P2). |
| 6 | Taille DB / VACUUM | ✅ `custom.db` 516 Ko + WAL 128 Ko, 34 tables, `integrity_check: ok`, journal WAL, VACUUM INTO à chaque backup. Contenu : 19 users, 3 posts, 10 DMs, 2 comptes admin (dont 1 system sans mot de passe), 11 entrées AdminAudit (uniquement des `login_success`), **PendingAction 0, ModerationAction 0** → four-eyes jamais exercé, **un seul super-admin réel** (gap confirmé au niveau DB). |

## 3. Constats nouveaux (SSH uniquement)

1. **[P0 hôte] Saturation ressource** — swap plein à 100 % est le signal le plus grave :
   la machine thrash, le killer OOM est armé. Mailcow redis (exit 137) et postfix
   (exited, 3 jours) en sont déjà victimes. MBotE ne survit à cette situation que par
   sa faible empreinte — pas par une garantie quelconque. **Actions proposées** (à
   valider) : nettoyage docker (≈ 26 Go récupérables : images pendantes + build cache),
   recadrage des stacks voisines (mailcow restart, limiter clamd), surveillance swap
   (alerte à 70 %), à terme : séparer mailcow ou migrer sur un 2e hôte.
2. **[P2 hôte] Mailcow dégradé** — postfix exited, redis OOM, ofelia + netfilter en
   boucle depuis 3 jours : la messagerie du domaine est probablement hors service depuis
   le 16/11 (à confirmer côté mail, hors périmètre MBotE).
3. **[P2 hôte] Voisins dégradés** — `aenews-mongo` « health: starting » depuis 3 j,
   `aenewsb-api` unhealthy, PM2 `aenewsos-backend` crash-loop (↺ 989). Hygiène host à
   reprendre (chaque crash-loop consomme CPU/swap).
4. **[P2 hôte] Maintenance OS** — 72 paquets apt upgradables, incl. le watcher
   release-upgrader actif. Prévoir fenêtre de patch.
5. **[Info app] VAPID confirmé vide en prod** — `VAPID_PRIVATE_KEY=`/`VAPID_PUBLIC_KEY=`
   vides dans l'env du conteneur (table `PushSubscription` : 0 lignes, cohérent) →
   P1#2 de l'audit doc confirmé live, fix = provisionner les clés + secrets GitHub.
6. **[Info CI/CD] Sync réelle** — GitHub main = 8acdde7 = local ; le run « Déploiement
   VPS » du 18/11 est vert mais docs-only (paths-ignore → aucun deploy, par design).
   **La prod tourne bien sur 94fec3b** (fix login du 17/11 : `csrfToken` présent dans
   les chunks servis — vérifié dans le bundle + images construites 08:13-08:16 UTC).
   ⚠️ Cosmétique : `/opt/mbote-bitchat` sur le VPS est un checkout b993d98 sale (rsync
   exclut `.git`) — le déploiement ne passe pas par git, mais ce décalage piège toute
   personne qui inspecte le repo à la main ; le noter au runbook.
7. **[Info] Nom confusionnel** — `mboote-postgres`/`mboote-*` (PM2, nginx penpot.mboote.com)
   sont **un autre projet** ; MBotE mesh n'utilise pas PostgreSQL mais SQLite. Risque
   d'erreur opérationnelle (backup au mauvais endroit, "db push" sur la mauvaise base).
8. **[Info] Headers** — CSP/HSTS preload/DENY/Permissions-Policy confirmés sur `/` via
   CF ; `x-powered-by: Next.js` exposé (P2 mineur, `poweredByHeader: false`).

## 4. Plan d'action révisé (à valider avant exécution)

| # | Action | Effort | Impact | Garde-fou |
|---|---|---|---|---|
| 1 | **Detente hôte** : `docker image prune -a` filtré + `builder prune` (≈26 Go, disque 95 %→~82 %), restart mailcow stack, clear swap après baisse pression | M | ferme le P0 OOM | lister les images avant suppression ; jamais pendant un deploy ; fenêtre calme |
| 2 | VAPID : `bunx web-push generate-vapid-keys` → secrets GitHub `VAPID_*` + step `.env` deploy → push réactivé | S | P1 | test `/api/push/config` post-deploy |
| 3 | Healthcheck post-deploy 3 services + retry + URL publique (deploy-vps.yml) | S | P1 | n/a |
| 4 | ClientIp durci côté `admin-internal.ts` (+ nginx XFF overwrite vhost admin) | S | P1 | tests login/rate-limit |
| 5 | Rollback : input `ref` workflow_dispatch + doc PRE-DEPLOY corrigée | S | P1 | gate F-1 conservé |
| 6 | Runbook restauration backup + copie `.backup-key` hors VPS (coffre utilisateur) | S | P1 | restaurer 1 backup en dossier de test pour preuve |
| 7 | Second super-admin (four-eyes exercable) + rotation codes de récupération | S | gouvernance | procédure ADMIN-OPERATIONS |
| 8 | SSH : poser une clé, basculer `PasswordAuthentication no` (ou au minimum port dédié) | S | P2 | **ne jamais** couper avant confirmation de la clé par l'utilisateur |
| 9 | Trivy bloquant + audit deps admin/relay/mobile + gates lint/tsc admin | M | P1 | fenêtre CI |
| 10 | Patch apt + redémarrage voisins cassés (mailcow, mongo, aenewsos-backend) | M | P2 hôte | coordonner avec propriétaires des stacks |
| 11 | Notifier push au runbook : décalage git/réel sur VPS, nomenclature mbote/mboote | XS | doc | — |

**Non déclenché volontairement** : aucun `prune`, aucun restart, aucune écriture DB,
aucune modification nginx/sshd — tout ce qui touche l'hôte partagé exige votre validation
explicite (§4).
