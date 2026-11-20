# AUDIT PLATEFORME — ADDENDUM 2026-11-20/21 — EXECUTION DU PLAN D'ACTION

> Suite directe de `AUDIT-PLATEFORME-GLOBALE-2026-11-19-SSH-VERIFICATION.md` (§4 :
> plan d'action validé). Ce document trace l'exécution des 11 lots + l'incident de
> fuite de secret découvert pendant l'exécution.

## 0. INCIDENT P0 — fuite de secret dans le repo PUBLIC (découvert 2026-11-21 ~23:15 UTC)

**Constat** : le commit `f0c8162` (« 489b4ca0-… », poussé le 2026-11-20 06:22 UTC) a
introduit `tools/sshvps.py` contenant le mot de passe SSH `aenews` **en clair** — et le
dépôt `AlterEgo095/mbote-bitchat` est **PUBLIC**. Le mot de passe était lisible par
tout internet pendant ~40 h. (Le commit UUID suggère une capture automatisée du
helper de la workstation par un `git add -A`.)

**Réponse (appliquée le jour même, ~30 min après découverte) :**

1. **Rotation du mot de passe** `aenews` (30 caractères aléatoires, remis au titulaire par canal privé). L'ancien mot de passe — celui publié — est mort.
2. **Durcissement SSH** : drop-in `/etc/ssh/sshd_config.d/00-hardening.conf` →
   `PasswordAuthentication no` + `KbdInteractiveAuthentication no` ; `sshd -t` puis
   reload ; **preuve** : connexion avec le BON mot de passe refusée. Auth par clé
   ed25519 installée et vérifiée (le déploiement CI utilisait déjà `VPS_SSH_KEY`).
   Note : le drop-in a d'abord été ignoré (premier match gagne) — `50-cloud-init.conf`
   et `99-aenews-hardened.conf` posaient `PasswordAuthentication yes` ; le nommage
   `00-` le place devant.
3. **Nettoyage repo** : `tools/sshvps.py` retiré de l'index (commit `7ee2d02`),
   `/tools/` ajouté au `.gitignore` (les helpers ops ne vivent que sur la
   workstation). Le stub local affiche un message d'incident.
4. **Historique git** : le secret demeure dans l'historique (`f0c8162`) mais la
   credential est **inutilisable** (auth mdp désactivée) → réécriture d'historique
   non justifiée (risque > bénéfice). Si le mot de passe SSH est réactivé un jour,
   il faut une NOUVELLE rotation d'abord.
5. Le password leak n'a pas de reproductibilité VPS depuis (clé seule) ; fail2ban
   reste en place (5091 tentatives/24 h bloquées au jour de l'audit — bruit devenu
   inoffensif pour l'auth mdp).

**Leçon** : tout credential VPS vit sur la workstation ou dans un gestionnaire de
secrets — jamais dans l'arbre versionné, même local. `git status` avant chaque push.

## 1. Lot 1 — Détente mémoire + mailcow (TERMINÉ)

- État trouvé (2026-11-21 23:06 UTC) : load **32**, swap **8/8 Go**, RAM 336 Mo
  libre, crash-loop PM2 `aenewsos-backend` à **1462** restarts.
- `swapoff` mathématiquement impossible (8 Go de swap pulvérisés sur des centaines
  de process vs 1,4 Go disponible) → **reboot** (prérequis vérifiés : PM2 enabled
  + dump rafraîchi par `pm2 save`, policies docker `unless-stopped`/`always`,
  nginx systemd).
- Post-reboot : **swap 0 B**, RAM 694 Mo utilisés, load normal après l'orage de
  démarrage (~100 conteneurs), PM2 resurrect 42/47 online.
- **Mailcow pleinement rétabli** : postfix running (queue vide), redis répond,
  ofelia/netfilter/clamd ok, 18/18 conteneurs UP. (Note : l'état « Exited 5 days »
  du `docker ps` était une vue stale du daemon sous charge — l'inspect et les logs
  SMTP ont tranché.)
- Comptes PM2 volontairement OFF : `aenewsos-backend` (app cassée côté code,
  crash-loop permanent — à corriger par son propriétaire AVANT réactivation) et
  `streamflix-be` (déjà stoppé, 145 934 restarts historiques).

## 2. Lot 2 — VAPID / Web Push (TERMINÉ)

- Paire générée (`bunx web-push generate-vapid-keys`), posée en secrets GitHub
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (API, sealed box libsodium).
- `deploy-vps.yml` : les 2 secrets sont injectés dans le `.env` du VPS (12 variables
  désormais) + warning explicite si absents.
- Activation effective au prochain deploy (déploiement de ce lot) → vérifier
  `/api/push/config` (attendu : `available: true`).

## 3. Lot 3 — Healthcheck post-deploy (TERMINÉ)

Étape « Vérification santé » remplacée par une vérification à 2 niveaux avec
retries : (1) healthchecks docker des 3 conteneurs (24 essais × 5 s) via
`docker inspect` ; (2) sonde HTTP `/api/stats` locale (12 essais × 5 s). Échec →
la run est ROUGE avec l'état `docker compose ps` (détection d'un deploy cassé au
lieu d'un vert mensonger).

## 4. Lot 4 — ClientIp durci (TERMINÉ, anti-bruteforce réel)

Chaîne login : CF → nginx (`$proxy_add_x_forwarded_for`, append — confirmé sur le
VPS, inchangé car le comportement append est ce que la preuve CF exige) → BFF
admin → mesh.

- **mesh** `src/lib/mbote/admin-internal.ts` : `clientIp` prend le DERNIER saut
  XFF (le premier était contrôlé par l'attaquant → bypass rate-limit). Fallback
  `x-real-ip`, puis `"unknown"` (bucket partagé — dégradation plus restrictive).
- **BFF** `admin/src/lib/client-ip.ts` : copie du module durci de l'app principale
  (preuve Cloudflare : dernier saut XFF ∈ plages CF + `cf-ray`, alors
  `cf-connecting-ip` retenu). Les 29 call sites `clientForwardedFor:` transmettent
  désormais une valeur UNIQUE résolue (écrasement du header) — plus aucun
  pass-through de la chaîne client.
- Tests existants compatibles (XFF à valeur unique → dernier saut = valeur testée).

## 5. Lot 5 — Rollback (TERMINÉ)

- `workflow_dispatch` accepte un input `ref` (SHA/branche/tag) ; le gate F-1
  reste enforce sur CE SHA (pas de contournement du harnais).
- `PRE-DEPLOY-CHECKLIST.md` §Rollback réécrit (l'ancien prescrivait `git checkout`
  sur le VPS — impossible : rsync exclut `.git`).

## 6. Lot 6 — Runbook restauration + custody clé (TERMINÉ)

- `docs/RUNBOOK-RESTAURATION-BACKUP.md` : procédure complète (déchiffrement
  AES-256-CBC/PBKDF2 300k, integrity_check, bascule du volume, fenêtre d'arrêt),
  état réel du système de backup (cron 03:17 WAT, test de restauration quotidien
  PASS, rotation 14 j, ~240 KB/archives).
- **`.backup-key` copié hors VPS** et remis au titulaire (2026-11-20) — la clé ne
  vivait QUE sur le VPS (SPOF destructeur : crash disque = données perdues à
  jamais). À re-faire après chaque rotation de clé.

## 7. Lot 7 — Second super-admin (DOCUMENTÉ — ACTION HUMAINE RESTANTE)

`ADMIN-OPERATIONS.md` §2.1 : procédure de création du second super-admin
(four-eyes exercable). À ce jour **1 seul super-admin réel** : les bans/purges
four-eyes sont inertés tant que le second titulaire n'est pas créé + enroled.
Le CLI est prêt ; la décision RH (qui détient le 2ᵉ compte) appartient au
titulaire du projet.

## 8. Lot 8 — SSH durci (TERMINÉ — accéléré par l'incident §0)

Voir §0 point 2. État final : `PermitRootLogin no` + `AllowUsers aenews` +
`PasswordAuthentication no` + clés uniquement + ciphers/MACs durcis (le socle
`99-aenews-hardened.conf` de 2026-03 conservé, complété par `00-hardening.conf`).

## 9. Lot 9 — Trivy bloquant + gates admin (TERMINÉ)

- Trivy passe `exit-code: 1` (BLOQUANT : HIGH/CRITICAL vuln + secrets + misconfig
  font échouer security.yml → le gate F-1 refuse le deploy). Pré-activation vérifiée
  par scan local : **0 finding** sur la surface racine.
- `effect@3.21.0` (ReDoS CVE-2026-121707, transitif via `@prisma/config`) corrigé
  par override `3.22.1` — `bun.lock` régénéré.
- `mobile/` exclu du scan (26 vulns de chaîne de build React Native : @xmldom/xmldom
  0.7.13, tar 6.2.1, postcss 8.4.49, image-size 1.2.1 — non déployé sur le VPS ;
  bumps transitifs à valider avec un build Android complet → follow-up tracé).
- Gates admin : `admin/` (package.json séparé) est désormais linté + typechecké par
  le deploy workflow (aucun gate avant — le build Docker seul).
- Note deps : `relay-service` n'a pas de lockfile (package.json seul) → rien à
  scanner ; envisager un lockfile dédié lors d'une prochaine passe.

## 10. Lot 10 — Patch apt + voisins cassés (PARTIEL — reboot fait)

- Reboot exécuté (effet immédiat : swap purgé, orage de crash-loops éteint).
- Patch apt (72 maj) : à jouer en fenêtre calme **après** la stabilisation
  post-reboot (`apt update && apt upgrade`) + reboot de clôture si noyau.
- Ne PAS réactiver `aenewsos-backend` tant que son crash n'est pas corrigé en amont.

## 11. Lot 11 — Runbook notes (TERMINÉ)

1. **Décalage git/réel sur le VPS** : `/opt/mbote-bitchat` sur le VPS ne contient
   PAS de `.git` (rsync exclut) — une copie git locale y avait été faite par le
   passé (`b993d98` dirty) : ne JAMAIS s'y fier pour connaître la version en prod.
   Sources de vérité : le SHA affiché par la run de deploy CI + `.deploy-commit` +
   le bundle servi. À l'époque de l'audit, prod = `94fec3b` (fix login).
2. **Nomenclature mbote/mboote** : DEUX projets distincts coexistent sur la VM —
   `mbote` (MBotE E2EE messagerie, ce repo, `/opt/mbote-bitchat`, conteneurs
   `mbote-*`) et `mboote` (AUTRE projet : `/opt/mboote`, PM2 `mboote-studio`,
   `mboote-agent`, daemon `/opt/mboote/scripts/agent/daemon.mjs`). Toute commande
   VPS doit viser le bon préfixe — confusion = action destructrice sur le mauvais
   projet.
3. Les vues `docker ps` du daemon peuvent être stale sous charge extrême (cf. §1) :
   trancher par `docker inspect` (State.StartedAt/FinishedAt) + logs applicatifs.

## 12. Suivi restant (post-exécution)

| Item | Statut | Responsable |
|---|---|---|
| Créer le 2ᵉ super-admin (§2.1 ADMIN-OPERATIONS) | TODO humain | titulaire |
| Patch apt 72 maj + reboot clôture si noyau | TODO VPS (fenêtre calme) | ops |
| Bumps transitifs mobile/ (26 vulns build) | TODO CI mobile | dev |
| Externalisation des .db.enc (S3/R2/2ᵉ machine) | P2 | ops |
| Corriger le crash au boot d'aenewsos-backend avant réactivation | hors périmètre MBotE | propriétaire |
| Vérifier `/api/push/config` = available:true après ce deploy | validation | ops/dev |
