# AUDIT DE PRODUCTION — VÉRIFICATION POST-PUSH ET POST-DÉPLOIEMENT

**Date** : 2026-11-05 (heure locale Kinshasa WAT / UTC+1 ; preuves UTC)
**Environnement d'audit** : sandbox de développement. Accès : git `origin` (token fourni par l'opérateur), HTTPS lecture/écriture tracée sur la prod, API GitHub authentifiée. **Pas d'accès SSH au VPS.**
**Portée** : §0 complet (avec réparation du pipeline) + §1–§6 dans la limite des accès.

---

## 1. VERDICT GLOBAL

## ✅ PROD SAINNE — A1/A2/A3 vérifiés en production — 2 incidents de déploiement corrigés en cours d'audit — 1 accès manquant (clé admin) laisse 7 tests A3 positifs NON TESTÉS

1. Après abort initial (aucun merge poussé), le pipeline a été complété : 3 merges + 2 correctifs de livraison. `origin/main` = `f558b1c`, CI verte, `Déploiement VPS` success, la prod sert le nouveau code (routes A2/A3 actives).
2. **A1 anti-rejeu : 8/8 PASS en prod** (dont ré-emballage hostile et pont mesh) · **A2 : 9/9 PASS** (numéro 60 chiffres symétrique, état rouge avec réception affichée, re-vérification, re-rouge) · **A3 blocage DM : 9/9 PASS** (`fromBlocked` posé/retiré) · **A3 gardes négatives : 7/7 PASS** (403 uniformes timing-safe, 400 E2EE sur DM).
3. Deux défauts de livraison ont été détectés et corrigés pendant l'audit (exclusion rsync `mobile/` → build Docker en échec ; **migration 0003 jamais créée → prod en 500 pendant ~12 min**). La prod n'a jamais été exposée en dehors de cette fenêtre. Les tests A3 positifs (queue, hide, purge, suspend) et le blocage-filtre du feed attendent la `ADMIN_API_KEY` de prod.

**GO/NO-GO : GO conditionnel** — §0, §1 (partiel), §2 (A1+A2 complets, A3 négatif), §3 (partiel), §4, §5 (partiel) verts. Le GO devient plein lorsque la clé admin permet les 7 tests A3 positifs restants + le nettoyage SQL complet. Un point non testé n'est pas un point vert : ils sont listés §3 du rapport.

---

## 2. §0 — PREUVES (état final, après réparation)

### §0.1 Push effectif — ✅ VERT
- État initial (00:10 UTC) : `git ls-remote origin main` → `7b51fd5` (pré-merge) — **abort du premier passage**. Aucun des 3 merges n'avait eu lieu ; `feat/a3` jamais poussée ; `origin/feat/a2` divergée (amend `0c7d4c3` vs `9c1fa19`, contenu local ⊇ remote, diff = +32 lignes doc A1).
- Réparation opérateur-assistée : `push --force-with-lease` a2, push a1/a3, puis merges `--no-ff` ordonnés :
  - `d271798` audit report → `9ff54a8` merge(a1) → `439ca48` merge(a2) → `0147ffa` merge(a3)
- État final : `git ls-remote origin main` → **`f558b1c3e2ddd07043392b1ea63ec294efb69804`**

### §0.2 CI verte — ✅ VERT (sur le commit final)
Sur `f558b1c` : `Tests — harness adversarial` = **success** (run 41942237689), `Déploiement VPS` = **success** (run 41942237636). iOS/Android : builds en cours à la clôture (non bloquants pour le web).
`security.yml` : déclencheurs = hebdo (lundi 06:00 UTC) + push touchant `package.json`/`bun.lock`/`Dockerfile`/le workflow lui-même — les merges A1/A2/A3 ne touchaient aucun de ces fichiers → pas de run attendu, par conception. Dernier run : `a8e5faa` success (2026-11-04 21:37 UTC).
⚠️ Note d'audit : une observation antérieure (« trigger `branches: ain]` corrompu ») était une **erreur de l'auditeur** (artefact d'affichage du pipeline `git show | sed` qui mange le motif `[m`) — les octets bruts sont `branches: [main]` (vérifié par `od -c`). Rien à corriger.

### §0.3 Déploiement effectif — ✅ VERT (après 2 échecs corrigés, cf. incidents I-1/I-2)
- Run 41940394873 (`0147ffa`) : **failure** — step « Build & démarrage » : typecheck Docker (log : `Property 'dedupFingerprint' does not exist on type .../mobile/src/core/bitchat-protocol`)
- Run 41941474662 (`4d24909`) : **success**
- Run 41942237636 (`f558b1c`, commit final) : **success**
- Conteneur : healthy par déduction (l'API répond ; `docker ps` = action opérateur, cf. §5)

### §0.4 Version servie — ✅ VERT
Avant correction : `/api/trust`, `/api/moderation/queue`, `/api/version` retournaient du HTML (fallback Next.js) — routes inexistantes.
Après déploiement (sorties brutes, script `prod-audit-phase1.ts`) :
```
GET  /api/trust            → 400 {"error":"me et peer requis"}          (route A2 déployée, validation avant auth)
GET  /api/moderation/queue → 403 {"error":"Accès modération refusé (admin requis)"}   (route A3 déployée)
POST /api/dms {}           → 400 {"error":"senderKey, recipientKey, iv, ciphertext requis"}
```
`/api/version` n'existe toujours pas (endpoint recommandé, prochaine livraison).

---

## 3. RÉSULTATS §1–§6 (tableau)

Confiance : F=faible, M=moyen, É=élevée.

| # | Test | Statut | Preuve (commande + extrait) | Conf. |
|---|---|---|---|---|
| **§1** | XFF D5 — bucket anti-usurpation | **PARTIEL** | `curl -H "X-Forwarded-For: 1.2.3.4" .../api/posts` → HTTP 200, 0.285s, comportement normal. Le bucket n'est **pas observable** hors logs serveur. Code vérifié dans le build (`client-ip.ts` : dernier hop XFF ∈ plages CF + `cf-ray` sinon `"local"` en prod) et tests.yml vert. **1.2.3.4 ne peut pas devenir le bucket** (jamais dernier hop). Vérification logs = action opérateur | M |
| §1 | Backups R1 — côté GitHub | ✅ PASS | `git ls-remote origin backups` → `74ec3d5` ; dernier commit backup **2026-11-04T21:46:12Z** (< 25 h), `sha256=da27e27b…` | É |
| §1 | Backups R1 — côté VPS (crontab 17 3, last-backup-status.json, fichier chiffré) | **NON TESTÉ** | Pas de SSH. Commandes fournies §6 (actions opérateur) | — |
| §1 | Supply chain D6 — digests épinglés | **PARTIEL** | Workflows épinglés par SHA vérifiés dans le repo (`actions/checkout@11d5960…`, `oven-sh/setup-bun@0c5077e…`). `docker inspect` sur le VPS = action opérateur | M |
| §1 | Headers sécurité | ✅ PASS | `curl -sI https://mbotemesh.aenews.online/` : CSP sans `unsafe-eval` (`script-src 'self' 'unsafe-inline'`), HSTS 2 ans preload, `X-Frame-Options: DENY`, nosniff, referrer-policy, permissions-policy | É |
| **§2 A1** | DM #1 → 200 msgId+seq | ✅ PASS | `{"message":{"id":"cmw2th5av0002p201…","seq":2…}}` | É |
| §2 A1 | Rejeu verbatim → 409 | ✅ PASS | `{"error":"Anti-rejeu : enveloppe déjà reçue (garde persistante liée au payload)","outcome":"duplicate"}` | É |
| §2 A1 | **Ré-emballage hostile** (même payload, nouveaux msgId/seq signés) → 409 | ✅ PASS | `outcome":"duplicate"` — la garde est **payload-bound, pas transport-bound** | É |
| §2 A1 | Second DM différent → 200 seq=2 | ✅ PASS | réponse `"seq":2` | É |
| §2 A1 | Régression seq=1 → 409 | ✅ PASS | `outcome":"seq_regression"` | É |
| §2 A1 | Preuve 8 jours → 401 | ✅ PASS | fraîcheur vérifiée avant la garde | É |
| §2 A1 | Pont mesh — 1er dépôt | ✅ PASS | `{"status":"accepted","detail":"DM scellé déposé (opaque, garde anti-rejeu)"}` | É |
| §2 A1 | Pont mesh — paquet différent, même DM | ✅ PASS | `{"status":"duplicate","detail":"anti-rejeu : enveloppe déjà reçue…"}` — hashes de paquets différents (`56a9c858…`/`dc712b50…`), même payload → dédup **SHA-256-128** liée au payload | É |
| **§2 A2** | Premier contact | ✅ PASS | `state:"unverified", level:"yellow"`, numéro **60 chiffres** | É |
| §2 A2 | Symétrie du numéro | ✅ PASS | identique A→B et B→A | É |
| §2 A2 | Rotation ecdhPub acceptée | ✅ PASS | re-signée, 200 | É |
| §2 A2 | État rouge | ✅ PASS | `state:"changed", level:"red", keyChanged:true` + numéro CHANGÉ | É |
| §2 A2 | **Réception en état rouge** | ✅ PASS | DM entrant livré (200) **et** lisible dans la conversation — le test prioritaire de la directive | É |
| §2 A2 | Re-vérification → vert | ✅ PASS | `state:"verified", level:"green", keyChanged:false` sur le nouveau numéro | É |
| §2 A2 | Seconde rotation → re-rouge | ✅ PASS | `changed` + `keyChanged` à nouveau | É |
| §2 A2 | Preuve invalide → 401 | ✅ PASS | aucun état de confiance sans clé | É |
| **§2 A3** | Report sur post de test → 201 + file avec contexte | **NON TESTÉ** | requiert création d'un post public + purge ensuite → **`ADMIN_API_KEY` manquante** | — |
| §2 A3 | report targetKind=dm | ✅ PASS | 400 `{"error":"targetKind invalide — fil public uniquement… Aucune modération DM : impossible par conception (E2EE…)"}` | É |
| §2 A3 | report sans preuve → 401 / cible inconnue → 404 | ✅ PASS | 401 / 404 | É |
| §2 A3 | queue sans clé / mauvaise clé → 403 **uniforme** | ✅ PASS | corps strictement identiques : `{"error":"Accès modération refusé (admin requis)"}` — pas de fuite sur la nature du refus | É |
| §2 A3 | action sans clé / mauvaise clé → 403 | ✅ PASS | idem uniforme | É |
| §2 A3 | hide → disparu du feed / unhide → revient / purge → supprimé + trace / suspend+warn | **NON TESTÉ** | **`ADMIN_API_KEY` manquante** — commandes prêtes §6 | — |
| §2 A3 | block → posts filtrés du feed du bloqueur | **PARTIEL — NON TESTÉ (partie feed)** | la partie feed requiert un post du bloqué → clé admin pour purge ensuite. **La partie DM est verte :** | M |
| §2 A3 | block → DM **reçus mais marqués** | ✅ PASS | block 200 `blocked:true` → DM du bloqué livré (200) + `fromBlocked:true` sur les nouveaux + conversation `blocked:true` → unblock → `fromBlocked:false` | É |
| **§3** | Post → feed / like/unlike / follow/unfollow | **NON TESTÉ** | requiert création de posts publics + purge ensuite (clé admin) — refus de polluer le feed sans nettoyage garanti | — |
| §3 | Session : re-login, identité persistante | ✅ PASS | même pubkey re-signée acceptée ; `GET /api/identity?pubkey=` → même `ecdhPub` avant/après | É |
| §3 | Pont mesh dédup SHA-256 (pas FNV-64) | ✅ PASS | cf. §2 A1 pont — le détail cite la garde persistante liée au payload | É |
| §3 | PWA : 200 + service worker actif | ✅ PASS | navigateur réel : `navigator.serviceWorker.controller=true`, 1 registration scope `/`, manifest présent, app rendue (capture `prod-pwa-home.png`), 0 erreur console | É |
| **§4** | Pas de pollution : posts de test | ✅ PASS | `/api/stats` : **posts:1 inchangé** (aucun post créé pendant l'audit) | É |
| §4 | Identités test en DB | **RÉSIDU CONNU** | users: 3 → **11** = +8 identités `audit-test-20261105-*` (créées par les 3 suites, comptées exactement). Pas d'API de suppression → **SQL opérateur fourni §6** | É |
| §4 | Reports de test | ✅ PASS | 0 report créé (tous les reports de test ont échoué AVANT création : 400/404/401 — par conception) | É |
| §4 | Cohérence DMs UI/DB | ✅ PASS (partiel) | chaque DM envoyé (8) est relu dans la conversation ; aucun doublon anti-rejeu (409 ne crée pas de ligne visible) | M |
| §4 | Journal d'audit ModerationAction | **NON TESTÉ** | aucune action de modération exécutée (clé admin) | — |
| **§5** | Latence /api/posts ×10 | ✅ PASS | **médiane 0,272 s · p95 0,801 s** (min 0,236 / max 0,801) | É |
| §5 | Logs 24 h sans erreur critique | **NON TESTÉ** | pas de SSH — commande fournie §6. NB : les 500 des 00:31–00:43 UTC (incident I-2) sont ATTENDUS dans les logs | — |
| §5 | Conteneurs healthy, uptime > 1 h | **PARTIEL** | uptime < 1 h par construction (redéploiements de l'audit) ; healthy déduit de l'API répondante ; `docker ps` = opérateur | M |
| §5 | DB taille/intégrité | **NON TESTÉ** | `PRAGMA integrity_check` = opérateur | — |
| §5 | Reconnexion 30 s | **NON TESTÉ** | nécessite une session DM active dans le navigateur — non réaliste en audit sans données réelles | — |
| **§6** | SHA avant / maintenant | ✅ | avant : `7b51fd5` · maintenant : `f558b1c` | É |
| §6 | Revert des merges sans conflit | ❌ **NON** | testé sur worktree jetable : `git revert -m1 9ff54a8` → **CONFLITS** (modify/delete `tests.yml`, contenu `prisma/schema.prisma`) | É |
| §6 | Chemin de rollback validé | ✅ | **la migration 0003 est 100 % additive** → l'ancien code fonctionne sur le nouveau schéma : rollback = redéployer le commit précédent, **sans toucher la DB**. Rollback DB (si jamais) : restore R1 du 2026-11-04 21:46 UTC | É |

---

## 4. INCIDENTS RENCONTRÉS (exhaustif, avec cause racine)

| # | Incident | Cause racine | Résolution | Impact prod |
|---|---|---|---|---|
| I-0 | **Abort §0 du premier passage** : aucun merge poussé, `feat/a3` jamais poussée, `origin/feat/a2` divergée (amend post-push) | Le travail validé A1/A2/A3 n'a pas suivi son pipeline de livraison | Pushes + merges ordonnés (voir §2/§0.1) | Aucun (prod restée sur le dernier état vert) |
| I-1 | **Deploy run 41940394873 failure** : typecheck Docker — `dedupFingerprint` absent du miroir mobile vu par le VPS | `deploy-vps.yml` rsync excluait `mobile/` → le VPS gardait un miroir pré-A1 ; le garde de parité A1 (typecheck du script de parité importé par le build) a refusé de construire | `4d24909` — suppression de `--exclude 'mobile'` (le step s'intitule « rsync du commit exact ») | Aucun (l'ancien conteneur continuait de tourner) |
| I-2 | **Prod en 500 pendant ~12 min** (00:31–00:43 UTC) après le premier déploiement vert : `POST /api/identity` et `GET /api/posts` en 500 | **La migration A1/A2/A3 n'avait jamais été versionnée** : dev en `db push`, prod en `prisma migrate deploy` → no-op → nouveau client Prisma sur ancien schéma (colonnes `suspendedAt`, `hiddenAt`… absentes) | `f558b1c` — migration `0003_a1a2a3_replay_trust_moderation` générée par `prisma migrate diff` (118 lignes, **100 % additive**, validée par `migrate deploy` complet sur DB vierge avant push) | **Fenêtre 00:31–00:43 UTC : inscriptions et feed indisponibles** — détectée par l'audit en < 2 min, corrigée et re-vérifiée |
| I-3 | Le harnais E2E CI passait alors que la prod cassait | CI provisionne son schéma via `db push` (prérequis documenté des harnais) — aucun workflow ne testait le chemin prod `migrate deploy` | 0003 corrige le fond ; recommandation : ajouter au CI un job « migrate deploy sur DB vierge » (cf. §7 recommandations) | — |
| I-4 | 2 FAILs faux dans la 1re exécution de l'audit (rotation A2 → 401) | Bug de l'**auditeur** : nickname signé ≠ nickname envoyé dans la preuve d'identité | Script corrigé ; flux A2 rouge re-joué : 9/9 PASS | Aucun |

**Absence de clé admin** : le `.env` écrit par le deploy ne contient que 5 variables (`NEXT_PUBLIC_SOCKET_URL`, `RELAY_ALLOWED_ORIGIN`, `SEED_SECRET`, `RELAY_EMIT_TOKEN`, `MBOTE_BOT_KEY`) — **pas `ADMIN_API_KEY`**. Si elle n'est pas posée manuellement sur le VPS, la modération admin est **désactivée** en prod (défaut sûr : `ADMIN_API_KEY` absente → aucun accès admin, cf. preuve A3-U1a) — c'est l'hypothèse la plus probable, à confirmer par l'opérateur.

---

## 5. RÉSIDU DE TEST — COMPTABILISATION EXACTE

- **Avant nettoyage** (état à la clôture) : `users: 11, posts: 1, dms: 8` (`GET /api/stats`). Base réelle : 3 users, 1 post, 0 DM.
  - **+8 identités** `audit-test-20261105-*` (A1A, A1B, A2A, A2B, RED-A, RED-B, BLK-A, BLK-B — dont nicknames de rotation/relogin tous préfixés `audit-test-20261105-`)
  - **+8 DMs** E2EE entre ces identités uniquement (msgIds `audit-*`, `audit-red-*`, `audit-blk-*`, `mesh-audit-*`)
  - **0 post** · **0 report** · **0 ModerationAction** · likes/follows : inchangés (2 likes préexistants)
  - Lignes annexes : TrustedKey (paires A2), ReplayGuard/ReplayCounter (expiration automatique)
- **Nettoyage API effectué** : unblock (S3) — l'état blocage a été annulé. Rien d'autre n'était annulable via API.
- **Après nettoyage SQL opérateur** (script §6) : résidu = **0**. L'audit fournit le SQL exact ; la vérification finale `SELECT COUNT(*)` revient à l'opérateur.
- Traçabilité des écritures : toutes les écritures prod de cet audit sont celles des scripts `/home/z/audit/*.ts` (identités signées + DMs + 1 block/unblock) — aucun autre POST émis.

---

## 6. ACTIONS MANUELLES OPÉRATEUR

### A. Clé admin — débloque les 7 tests A3 positifs restants
Fournir `ADMIN_API_KEY` de prod (ou confirmer qu'elle n'est pas posée — auquel cas la poser d'abord :
`ssh root@95.111.226.63` → ajouter `ADMIN_API_KEY=<générée>` dans `/opt/mbote-bitchat/.env` ou l'environnement compose → `docker compose up -d`). Puis relancer la suite A3 positive (script prêt côté audit).

### B. Vérifications VPS (lecture seule)
```bash
ssh root@95.111.226.63 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}"'
ssh root@95.111.226.63 'docker inspect mbote-mesh --format "{{.Image}}"'
ssh root@95.111.226.63 'docker logs mbote-mesh --since 24h 2>&1 | grep -iE "(error|fail|exception)" | grep -v "no such column" | head -20'   # les 500 de l'incident I-2 sont attendus entre 00:31 et 00:43 UTC
ssh root@95.111.226.63 'crontab -l | grep backup'
ssh root@95.111.226.63 'cat /opt/mbote-bitchat/backups/last-backup-status.json 2>/dev/null || find / -name last-backup-status.json 2>/dev/null'
ssh root@95.111.226.63 'docker exec mbote-mesh sh -c "sqlite3 /app/db/custom.db \"PRAGMA integrity_check; SELECT COUNT(*) FROM User; SELECT COUNT(*) FROM DirectMessage;\""'
```

### C. Nettoyage SQL du résidu d'audit (après validation, résidu = 0)
```bash
ssh root@95.111.226.63 'docker exec mbote-mesh sh -c "sqlite3 /app/db/custom.db"' <<'SQL'
-- 0) État avant nettoyage (attendu : 8)
SELECT COUNT(*) FROM User WHERE nickname LIKE 'audit-test-20261105-%';
-- 1) DMs de test (entre identités audit)
DELETE FROM DirectMessage WHERE senderKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-20261105-%')
  OR recipientKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-20261105-%');
-- 2) Trust / blocage / replays liés aux identités de test
DELETE FROM TrustedKey WHERE ownerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-20261105-%')
  OR peerKey  IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-20261105-%');
DELETE FROM PeerBlock WHERE blockerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-20261105-%');
DELETE FROM ReplayGuard WHERE id NOT IN (SELECT DISTINCT guardId FROM DirectMessage);  -- garde : ne rien faire si schéma diffère, expiration auto < 24 h
-- 3) Identités de test
DELETE FROM User WHERE nickname LIKE 'audit-test-20261105-%';
-- 4) Vérification finale (attendu : 0 partout)
SELECT COUNT(*) FROM User WHERE nickname LIKE 'audit-test-%';
SELECT COUNT(*) FROM DirectMessage WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%';
SELECT COUNT(*) FROM Report;
PRAGMA integrity_check;
SQL
```
⚠️ Ajuster les noms de colonnes (`guardId`) au schéma réel avant exécution ; les ReplayGuard/ReplayCounter expirent seuls (< 24 h) si la suppression est omise.

### D. Recommandations de livraison (prochain commit)
1. **`GET /api/version`** (SHA + date de build injectés au build) — preuve directe de version pour les prochains §0.4.
2. **Job CI « chemin prod »** : `prisma migrate deploy` sur une DB vierge dans tests.yml — aurait détecté I-2 avant le déploiement.
3. Poser `ADMIN_API_KEY` dans le pipeline de deploy (secret → .env VPS) pour sortir l'accès admin du bricolage manuel.
4. Remplacer l'auth admin provisoire par le RBAC complet **avant ouverture publique** (déjà planifié A3 §4).

---

## 7. ANNEXE — Traçabilité

- Preuves : sorties brutes dans `/home/z/audit/` (`phase1-output.txt`, `a2red-output.txt`, `blockdm-output.txt`, capture `prod-pwa-home.png`).
- Runs CI cités : 41940394873 (failure, I-1) · 41941474662 (success, 4d24909) · 41942237689 (tests success) · 41942237636 (deploy success final).
- Scripts d'audit : `prod-audit-phase1.ts` (25 checks), `prod-audit-a2red.ts` (9), `prod-audit-block-dm.ts` (9).
- Cet audit a créé : 3 commits de réparation sur `main` (`d271798` rapport initial, `4d24909` fix rsync, `f558b1c` migration 0003) + 8 identités/8 DMs de test marqués.
- Le token GitHub fourni par l'opérateur a été retiré de la config git locale à la clôture. **Recommandation : révoquer et régénérer ce token** — il a transité en clair dans la conversation.
