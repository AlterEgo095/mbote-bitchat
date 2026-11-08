# PRE-DEPLOY-CHECKLIST — Clôture 16 phases → Production

**Version** : 1.0 · **Date** : 2026-11-08 (Kinshasa WAT) · **Statut** : à exécuter après validation de l'Étape 10
**Portée** : le pont entre les 16 phases de dev (A1-A3 · ADM 0-10 · B1-B4 · C1) et la production `mbotemesh.aenews.online`.
**Règle** : chaque case se coche AVEC sa preuve (sortie de commande collée dans le canal de validation). **Tout échec = STOP** — on corrige le déploiement avant tout nouveau code (décision stratégique post-Étape 10).
**Temps opérateur estimé** : 1 h 30 – 2 h (O-B 5 min · O-A 5 min · post-deploy 10 min · CF Access 30 min · bootstrap 10 min · tests manuels 30 min · marge).

**Références** : `docs/specs/ADMIN-ACCESS-RUNBOOK.md` (chaîne d'accès admin) · `docs/proofs/C1-push.md` §4 (procédure FCM device réel) · `docs/PROD-VERIFICATION-2026-11-05.md` (état prod au 05-11) · `docs/ADMIN-OPERATIONS.md` + `docs/ADMIN-TROUBLESHOOTING.md` (Étape 10).

---

## 0. Avant de toucher au VPS (10 min, local)

- [ ] **0.1 — Étape 10 validée** : `feat/adm-mvp` à `docs/proofs/ADM-step10.md` vert (runner exit 0) + validation opérateur dans le canal.
- [ ] **0.2 — CI verte sur les 3 branches** : `main`, `feat/b1-media-foundation`, `feat/adm-mvp` — GitHub Actions `tests.yml` + `schema-guard.yml` au vert sur le dernier commit de chacune.
- [ ] **0.3 — Ordre de fusion arrêté** (les deux branches touchent `prisma/` et `src/`) :
      ```
      git checkout main && git pull origin main
      git merge --no-ff feat/b1-media-foundation   # b1 d'abord (media + push C1)
      git merge --no-ff feat/adm-mvp               # puis adm (admin + Étape 10)
      # Résoudre les conflits éventuels — AUCUN conflit attendu sur prisma/migrations
      # (timestamps distincts, voir §2.4) ; conflits src/ probables sur
      # src/lib/mbote/justification.ts / state-store : relire, garder les DEUX apports.
      git push origin main                          # ← c'est LE commit de clôture (réf. opérateur : 7d4afb0)
      ```
- [ ] **0.4 — Vérifier l'union des migrations après merge** (preuve collée) :
      ```bash
      ls prisma/migrations/ | grep -v toml
      # Attendu (ordre lexicographique = ordre d'application) :
      #  0001_baseline · 0002_drop_avatar_seed · 0003_a1a2a3_replay_trust_moderation
      #  20261105202309_0004_admin
      #  20261105212940_0005_admin_auth
      #  20261106000000_0007_b2_media            ← label 0007, timestamp AVANT 0006 (cf. §2.4)
      #  20261106092200_0006_etape6_queue
      #  20261107090000_0007_etape9_four_eyes
      #  20261107094500_0008_c1_push
      #  20261107100000_0008_etape10_audit_stress
      ```

---

## 1. O-B — Pre-flight (5 min, sur le VPS)

> But : prouver que la prod est dans l'état attendu AVANT la clôture — colonnes legacy vides (rupture ADM Étape 0, `docs/proofs/ADM-rupture.md` §8), aucune session résiduelle.

- [ ] **1.1 — Backup DB AVANT tout** (rollback possible, 30 s) :
      ```bash
      docker exec mbote-mesh sh -c 'cp /app/db/custom.db /app/db/custom.db.pre-cloture-$(date +%Y%m%d-%H%M)'
      docker exec mbote-mesh ls -la /app/db/ | grep pre-cloture   # ← coller la sortie
      ```
- [ ] **1.2 — Les 6 requêtes legacy (attendu 0/6)** :
      ```bash
      docker exec -it mbote-mesh sh
      sqlite3 /app/db/custom.db
      ```
      ```sql
      SELECT COUNT(*) FROM Post WHERE hiddenBy IS NOT NULL;
      SELECT COUNT(*) FROM Report WHERE handledBy IS NOT NULL;
      SELECT COUNT(*) FROM User WHERE suspendedBy IS NOT NULL;
      SELECT COUNT(*) FROM User WHERE bannedById IS NOT NULL;
      SELECT COUNT(*) FROM AdminSession;
      SELECT COUNT(*) FROM ModerationAction WHERE adminKey IS NOT NULL;
      ```
      > ⚠️ **Correction vs brouillon opérateur** : « 5 requêtes attendu 0/5 » → **6 requêtes, attendu 0/6** (la liste en contenait déjà 6 : hiddenBy, handledBy, suspendedBy, bannedById, AdminSession, ModerationAction.adminKey).
      > Si AdminSession ≠ 0 : sessions d'un ancien test — `DELETE FROM AdminSession;` (append-only ne s'applique pas aux sessions) et re-vérifier.
      > Si une AUTRE colonne ≠ 0 : **STOP** — une écriture legacy a eu lieu, revoir ADM-rupture avant de continuer.
- [ ] **1.3 — État des migrations actuelles en prod** (preuve de départ, cf. §2.4) :
      ```sql
      SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;
      .quit
      ```
      > Origin/main ne porte que 0001-0003 : le delta attendu au boot est TOUT ce qui manque de la liste §0.4 (0004_admin et au-delà). Coller la sortie — c'est la référence « avant ».

---

## 2. O-A — Push clôture + migrations (5 min)

- [ ] **2.1 — Push + déclenchement** :
      ```bash
      git pull origin main        # récupérer la clôture (7d4afb0 ou étiquette du jour)
      git push origin main        # déclenche deploy-vps.yml
      ```
- [ ] **2.2 — Run GitHub Actions `deploy-vps.yml` → success** (rsync du commit exact → `docker compose up -d --build`). Vérifier dans l'onglet Actions : job vert de bout en bout (build, rsync, health check `/api/stats`). Coller le lien du run.
- [ ] **2.3 — Migrations appliquées au démarrage** (le `Dockerfile` CMD exécute `bunx prisma migrate deploy && exec bun server.js` — F-36) :
      ```bash
      docker logs mbote-mesh --since 10m 2>&1 | grep -i migrat
      docker exec mbote-mesh sh -c "sqlite3 /app/db/custom.db \"SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;\""
      ```
      Attendu : les 7 entrées §0.4 non encore appliquées (0004_admin → 0008_etape10_audit_stress) listées dans `_prisma_migrations`, **zéro `failed`**.
- [ ] **2.4 — Note sur les labels dupliqués (ne pas s'affoler)** : les labels `0006/0007/0008` se répètent entre branches (b2_media vs etape6_queue ; c1_push vs etape10_audit_stress) — **Prisma applique par NOM DE RÉPERTOIRE** (timestamp), l'ordre chronologique des timestamps est correct et les dépendances respectées :
      `0004_admin` (tables admin) → `0005_admin_auth` → `0007_b2_media` (média) → `0006_etape6_queue` (queue + UserWarning) → `0007_etape9_four_eyes` (**crée PendingAction**) → `0008_c1_push` (PushSubscription) → `0008_etape10_audit_stress` (**index sur PendingAction** — DOIT venir après four_eyes ✅ 10:00 > 09:00).

---

## 3. Vérifications post-deploy (10 min)

- [ ] **3.1 — En-têtes de sécurité** :
      ```bash
      curl -sI https://mbotemesh.aenews.online/ | head -5
      # Attendu : HSTS + CSP stricts (déjà en prod — cf. PROD-VERIFICATION-2026-11-05)
      ```
- [ ] **3.2 — API principale** :
      ```bash
      curl -s https://mbotemesh.aenews.online/api/stats
      # Attendu : 200 avec les compteurs (users, posts, messages…)
      ```
- [ ] **3.3 — Push config (C1)** :
      ```bash
      curl -s -o /dev/null -w "%{http_code}" https://mbotemesh.aenews.online/api/push/config
      # Attendu : 503 SI les clés VAPID ne sont pas encore dans le .env VPS (fail-closed documenté)
      #       OU 200 si §3.4 fait AVANT ce check.
      ```
- [ ] **3.4 — Variables d'env NOUVELLES requises par cette clôture** (dans le `.env` VPS, jamais commité) :
      ```bash
      docker exec mbote-admin printenv | grep -E "ADMIN_INTERNAL_TOKEN" | wc -l   # attendu 1
      # C1 — push (OPTIONNEL au premier boot : fail-closed sans clés ; ajouter pour activer) :
      #   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   (bunx web-push generate-vapid-keys)
      #   VAPID_SUBJECT="mailto:admin@mbotemesh.aenews.online"
      # Si ajout/modif .env → docker compose up -d --force-recreate
      ```
- [ ] **3.5 — Logs conteneurs propres** :
      ```bash
      docker logs mbote-mesh --since 10m 2>&1 | grep -iE "(error|fail|exception)" ; docker logs mbote-relay --since 10m 2>&1 | grep -iE "(error|fail|exception)" ; docker logs mbote-admin --since 10m 2>&1 | grep -iE "(error|fail|exception)"
      # Attendu : 0 ligne critique (les warnings [pending-action:notify] / [ADMIN-ALERT] sont NORMAUX)
      ```
- [ ] **3.6 — Santé interne admin (depuis le VPS)** :
      ```bash
      curl -s http://127.0.0.1:3001/api/health
      # Attendu : {"status":"ok","service":"mbote-admin","checks":{"backend":"up (200)"}}
      ```
- [ ] **3.7 — Panneau NON exposé publiquement sans CF Access** (ordre : ce check AVANT §4 ; en attendant CF, le vhost n'est pas encore posé → connexion refusée = état sûr) :
      ```bash
      curl -sI https://admin.mbotemesh.aenews.online/ 2>&1 | head -3
      # Attendu AVANT vhost+CF : erreur DNS/TLS (le sous-domaine n'existe pas encore)
      # Jamais 200 direct sans session Access.
      ```

---

## 4. Cloudflare Access (30 min, configuré par l'opérateur)

> Référence complète : `docs/specs/ADMIN-ACCESS-RUNBOOK.md` §3 (vhost, certbot, template nginx). Invariant RBAC §1.5 : **le panneau n'est jamais exposé sans CF Access**.

- [ ] **4.1 — DNS** : enregistrement `admin.mbotemesh.aenews.online` → IP VPS (ou CNAME → mbotemesh…), proxy Cloudflare **activé** (nuage orange). Vérif : `dig +short admin.mbotemesh.aenews.online` → IPs Cloudflare.
- [ ] **4.2 — TLS + vhost** (runbook §3, commandes 3-4) : certbot sur le sous-domaine, template `deploy/nginx/admin.conf`, `nginx -t && systemctl reload nginx`.
- [ ] **4.3 — Application CF Access** (dashboard CF) : Applications → Self-hosted → `admin.mbotemesh.aenews.online` ; Policy : Include → Emails → `<email opérateur>` ; Login method : One-time PIN (email SSO + OTP).
- [ ] **4.4 — Preuve d'accès** (depuis une machine HORS VPS) :
      ```bash
      curl -sI https://admin.mbotemesh.aenews.online/ | head -5
      # Attendu : 302 vers <team>.cloudflareaccess.com — JAMAIS 200 direct
      ```
- [ ] **4.5 — Login CF réel** : naviguer → login CF (OTP par email) → page de login du panneau (stub Mbote Admin).

---

## 5. Bootstrap admin — UNE SEULE FOIS après déploiement (10 min)

> ⚠️ **Deux corrections vs brouillon opérateur** (justifiées par le code, pas par goût) :
> (a) le conteneur est **`mbote-mesh`** (l'app principale, qui détient la DB) — PAS `mbote-admin` : l'invariant RBAC §1.1 interdit à l'app admin d'accéder à la DB, le conteneur panneau n'a donc ni `scripts/` ni Prisma ;
> (b) en production (`NODE_ENV=production`) le script **exige `--allow-prod`** (garde anti-accident, testé dans `tests/admin-bootstrap.test.ts`) et la syntaxe `bun run` demande `--` avant les flags.

- [ ] **5.1 — Bootstrap** :
      ```bash
      docker exec -it mbote-mesh bun run admin:bootstrap -- --email=<ton-email> --allow-prod
      # → QR TOTP ASCII + secret base32 + mot de passe + 2 codes de secours, affichés UNE FOIS
      ```
- [ ] **5.2 — Capturer HORS LIGNE** : QR/secret TOTP scanné dans l'app auth (Aegis/Google Authenticator…), mot de passe + 2 codes de secours stockés offline (gestionnaire de secrets local / papier dans un lieu sûr). **Ne pas partager, ne pas coller dans le canal.**
- [ ] **5.3 — Premier login** : `https://admin.mbotemesh.aenews.online/` (session CF Access) → email + mot de passe + code TOTP → enrôlement confirmé → dashboard 4 métriques visibles.
- [ ] **5.4 — Preuves DB (à coller, sans secret)** :
      ```bash
      docker exec mbote-mesh sh -c "sqlite3 /app/db/custom.db \"SELECT id, email, role, totpEnrolled, disabledAt FROM AdminUser; SELECT COUNT(*) AS sessions FROM AdminSession; SELECT action, actorId, targetType FROM AdminAudit WHERE action='bootstrap';\""
      # Attendu : 1 super-admin (hors system), totpEnrolled=1 après login, 1 ligne audit 'bootstrap'
      ```

---

## 6. Tests manuels post-deploy (30 min)

> Chaque case = une preuve (capture ou sortie). Interface : deux comptes réels (2 navigateurs ou device + navigateur).

- [ ] **6.1 — Login admin** : TOTP → dashboard → 4 métriques visibles (actifs 24h/7j, reports ouverts, uptime, backup).
- [ ] **6.2 — Image** : envoi image compte A → réception + affichage compte B.
- [ ] **6.3 — Voice note** : envoi compte A → réception + lecture compte B.
- [ ] **6.4 — Vidéo ~30 s** : envoi compte A → réception + lecture compte B.
- [ ] **6.5 — Push notifications PWA Android réelle** : **procédure rejouable §4 de `docs/proofs/C1-push.md`** (installer PWA → permission → DM depuis autre compte → notification reçue SANS contenu → tap → open). ⚠️ Requiert §3.4 (clés VAPID). Toute étape en échec = bloquant ouverture publique.
- [ ] **6.6 — Queue de modération** : user A publie un post → user B le signale → login admin (moderator+) → /queue → hide post → le post est masqué dans le feed public (vérifier depuis une session déconnectée).
- [ ] **6.7 — Four-eyes** : super-admin #1 crée une intention ban sur user B → 2ᵉ super-admin (AUTRE compte) approuve → user B banni : publication 403, posts masqués, 2 lignes AdminAudit (`pendingaction_created` + `ban`) — vérifier dans /audit.
- [ ] **6.8 — Audit viewer** : /audit → filtres (acteur, since 24h) → export CSV téléchargé.
- [ ] **6.9 — Gestion user** : /users → recherche pubkey B → warn (justification « CATÉGORIE: texte ≥ 20 chars ») → warning visible sur le profil de B.

---

## 7. Critères GO / NO-GO

**GO** (ouverture du planning D1/C2/C3/MLS) : §0-§6 tous verts + zéro ligne critique dans les logs + CF Access 302 + les 6 requêtes O-B à 0 AVANT et les métriques dashboard cohérentes APRÈS.

**NO-GO / STOP** : échec migrations au boot · counts legacy ≠ 0 · panel accessible sans CF Access (200 direct) · push device réel en échec (§6.5) · toute erreur 5xx non expliquée dans les logs 30 min après deploy.

**Rollback** (si NO-GO bloquant) :
```bash
# Sur le VPS — revenir à l'image précédente (le rsync ne pousse pas un rollback : redéployer le commit précédent via Actions, ou manuellement) :
docker exec mbote-mesh sh -c 'cp /app/db/custom.db.pre-cloture-<ts> /app/db/custom.db'
cd <VPS_DIR> && git checkout <commit-precedent> && docker compose up -d --build
# Les migrations sont ADDITIVES (aucune suppression de colonne 0004→0008) : une DB restaurée
# pré-clôture redémarre proprement sur l'ancien code ; les tables admin restantes sont inertes.
```

---

## 8. NON TESTÉ (limites assumées, tracées)

- **Charge massive** (100 admins simultanés) : le stress Étape 10 couvre 4-way par paires et 10 admins × 5 actions (light). Pas de benchmark massif — SQLite le justifie (palier 1).
- **Pentest / attaques ciblées** : rate limits + CSRF + CF Access posés ; AUCUN pentest réalisé. À faire AVANT ouverture publique.
- **Localisation UI admin (i18n)** : panneau en français uniquement.
- **FCM subscribe device réel** : procédure §6.5 (réf. C1-push §4) — obligatoire, pas encore exécutée.
- **SMTP notifications admin** : log structuré uniquement (`[pending-action:notify]`, `[ADMIN-ALERT]`) — aucune email réelle.

---

*Checklist rejouable : en cas de re-déploiement, repartir de §0 (l'ordre fusion/migrations/push est idempotent ; O-B attendra alors des counts ≠ 0 légitimes — adapter l'attendu au diff des migrations restantes).*
