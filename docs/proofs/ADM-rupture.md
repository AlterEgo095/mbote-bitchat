# ADM ÉTAPE 0 — PREUVES DE LA RUPTURE `ADMIN_API_KEY`

**Date** : 2026-11-05 (Kinshasa WAT) · **Branche** : `feat/adm-mvp` · **Commits** : `e0d8a4b` (schéma+migration) · `04a5c4a` (code+tests)
**Prérequis de l'Étape 0** : rupture bloquante avant toute feature admin — **livrée seule, avant l'Étape 1** (validation demandée avant la suite).
**Audits de référence** : `docs/proofs/ADM-audit-2026-11-05.md` (risques R-1/R-2/R-8) · `docs/proofs/INCIDENTS-CLOSED-2026-11-05.md`.

---

## 0. VERDICT

**RUPTURE COMPLÈTE ET PROUVÉE.** Plus aucun endpoint HTTP ne lit `ADMIN_API_KEY` ; l'acteur des actions admin est `AdminUser.id` (identité nominative, FK réelle) ; le secret n'est stocké **nulle part** (DB entière greppée, binaire compris) ni renvoyé **nulle part** (tous les payloads HTTP greppés, serveur démarré avec le canari dans son env — pire cas). Append-only d'`AdminAudit` garanti au **niveau moteur SQLite** (UPDATE et DELETE refusés par triggers).

---

## 1. PRÉREQUIS VÉRIFIÉS (début de session)

```
$ git ls-remote origin main
75e9559c0e5bbcba873132819871094736c29a6d	refs/heads/main    ← clôture 7d4afb0 NON poussée

$ recherche du token (sans l'afficher) : .git/config · ~/.git-credentials (absent) ·
  ~/.netrc (absent) · $GITHUB_TOKEN/$GH_TOKEN (absents) · /home/z/audit/ (aucun)
→ AUCUN credential dans le sandbox : le premise « le token existant fonctionne »
  est FAUX côté build. Le PUSH = ACTION OPÉRATEUR (§8). Continuation locale
  (autor « sans bloquer »). main local = 6bcff08 (clôture + audit ADM committés).
```

**Découverte DB dev** : `db/custom.db` n'a **pas de table `_prisma_migrations`** (0/3 migrations) — DB créée par `db push` à l'ère pré-§4 = spécimen vivant de la cause racine I-2. Toute l'Étape 0 a donc été construite sur une **DB fraîche 100 % migrations** (`db/adm-rupture.db`) ; la DB drift est conservée telle quelle (preuve).

**Découverte pipeline** : `deploy-vps.yml` se déclenche sur push `main` (sauf `mobile/**`+`docs/**`) → quand l'opérateur poussera la clôture, le deploy durci partira seul (état sûr : secret absent → `::warning::` → .env à 5 vars).

---

## 2. MIGRATION `0004_admin` — GÉNÉRÉE, REVUE, VALIDÉE (jamais `db push`)

```
$ DATABASE_URL="file:$(pwd)/db/adm-rupture.db" bunx prisma migrate dev --name 0004_admin --create-only
Prisma Migrate created the following migration without applying it 20261105202309_0004_admin

REVUE MANUELLE du SQL (2 corrections sur le généré automatique) :
1. actorLabel NOT NULL : l'INSERT de copie ne fournissait pas la colonne
   (échec si lignes existantes) → constante 'legacy' injectée ;
   la VALEUR du secret (ancien adminKey) n'est JAMAIS copiée.
2. Seed pseudo-user system (id 1, role 'system', passwordHash NULL — jamais de
   login) + TRIGGERS append-only AdminAudit ajoutés au SQL de la migration.

$ DATABASE_URL="file:$(pwd)/db/adm-rupture.db" bunx prisma migrate dev        → appliquée + client généré
$ rm -f db/adm-verify.db && DATABASE_URL="file:$(pwd)/db/adm-verify.db" bunx prisma migrate deploy
All migrations have been successfully applied.          ← chaîne 0001→0004 rejouée proprement sur DB vierge
```

**Comptes legacy (la question « les 4 colonnes sont-elles vides ? »)** :
- **Prod** : 0 par construction vérifiable — la seule voie d'écriture de ces colonnes était l'endpoint gardé par `ADMIN_API_KEY`, qui n'a **jamais pu atteindre le conteneur** (compose à `75e9559` ne la déclare pas — ADM-audit §0.3) ; les 7 tests A3 positifs n'ont jamais pu tourner (clé absente). → `SELECT` de confirmation opérateur en §8 (à coller en preuve).
- **Locale (rupture DB)** : 0 lignes (DB fraîche). **Plan conditionnel si ≠ 0 en prod** (consigné dans l'en-tête de la migration) : `UPDATE ModerationAction SET adminUserId = 1 WHERE actorLabel = 'legacy';` (idempotent, rattache au system user, auditable).

---

## 3. TESTS UNITAIRES — 6/6 (nouveau contrat acteur)

```
$ bun test tests/moderation.test.ts
(pass) U1a · ADMIN_API_KEY absente → aucun accès (le CLI refuse)
(pass) U1b · mauvaise clé → refusé · bonne clé → accepté            ← garde CLI uniquement
(pass) U2 · contenu court inchangé · contenu long tronqué ≤ 280
(pass) U3 · purge transactionnelle : cascade, trace, reports clôturés, compteur parent
(pass) U3b · purge d'un post déjà purgé → POST_NOT_FOUND (pas de double trace)
(pass) U4 · idempotence du signalement (P2002)
6 pass · 0 fail · 39 expect() calls

U3 vérifie la rupture : trace.adminUserId = moderator.id · trace.actorLabel =
"admin-<id>" · (trace).adminKey === undefined · AdminAudit{actorId, actorRole,
justification, beforeJson.content} écrit dans la MÊME transaction.
Les tests créent leur DB par `prisma migrate deploy` (éphémère) — `db push`
banni des tests aussi (discipline §4, exception éphémère versionnée).
```

---

## 4. TESTS E2E — 43/43 SUR LE SERVEUR RÉEL **SANS ADMIN_API_KEY**

Serveur démarré : `DATABASE_URL="file:$(pwd)/db/adm-rupture.db" bun run dev` — **la variable `ADMIN_API_KEY` n'est PAS dans son environnement** (preuve n°1 : l'app tourne sans la clé).

```
$ DATABASE_URL=… MBOTE_BASE_URL=http://127.0.0.1:3000 bun tests/moderation-e2e.ts
session e2e : adminUser id=2 (super-admin)
── S1–S2  ✅ 3 identités · P1/P2/C1 publiés
── S3–S4  ✅ report 201 · file AVEC contexte · idempotence · poids = 2
── S5     ✅ targetKind "dm" → 400 (E2EE par conception)
── S6     ✅ sans preuve → 401 · cible inconnue → 404
── S7     ✅ file SANS session → 401 · cookie INCONNU → 401
── S8–S9  ✅ blocage : fil filtré · DM REÇU mais MARQUÉ (fromBlocked/blocked)
── S10    ✅ hide → absent du fil, RESTE en DB avec hiddenAt + hiddenById = admin
── S11    ✅ purge → SUPPRIMÉ en DB, trace conservée
── S12    ✅ intégration : report clôturé (status=actioned, handledById=admin)
── S13    ✅ SANS session → 401 · session INCONNUE → 401 · pubkey comme cookie → 401
          ✅ session valide SANS jeton CSRF → 403 · CSRF FAUX → 403
── S14    ✅ suspend → 200 · publication suspendue → 403 · unsuspend/warn → 200
── S15    ✅ unblock → retour à la normale
✅ E2E A3 : tous les scénarios PASS
```

Changement de sémantique assumé (rupture) : l'ancien « 403 uniforme par clé » d'A3 devient **401 (session absente/invalide) / 403 (rôle insuffisant ou CSRF invalide)** — plus expressif, exigé par le RBAC à venir.

---

## 5. CLI — SEUL DÉTENTEUR RESTANT DE LA CLÉ

```
$ ADMIN_API_KEY="$CANARY" bun scripts/moderation-purge.ts --purge adm-cli-target --admin-key "mauvaise-cle" --execute
Clé admin invalide (ADMIN_API_KEY) — purge refusée.        exit=1 ✅
$ bun scripts/moderation-purge.ts --purge adm-cli-target --execute        (sans --admin-key)
Post adm-cli-target introuvable → refus                     exit=1 ✅ (et sans --execute : dry-run)
$ ADMIN_API_KEY="$CANARY" bun scripts/moderation-purge.ts --purge adm-cli-target --reason "preuve rupture ADM Etape 0" --admin-key "$CANARY" --execute
PURGÉ adm-cli-target — auteur=A3-Bob-73323, réponses purgées=0, likes=0, signalements clôturés=0
Traces : ModerationAction(action=purge, targetId=adm-cli-target, actorLabel="cli") + AdminAudit(actorId=1, actorRole="system")

Traces DB de la purge CLI :
ModerationAction: [{"action":"purge","adminUserId":1,"actorLabel":"cli","targetId":"adm-cli-target"}]
AdminAudit: [{"id":7,"actorId":1,"actorRole":"system","action":"purge","targetType":"post",
              "targetId":"adm-cli-target","justification":"preuve rupture ADM Etape 0",
              "userAgent":"cli:moderation-purge"}]
```

---

## 6. NON-RÉTENTION & NON-ÉCHO DU SECRET (méthode canari)

```
CANARY  = adm-rupture-canari-1793910720   (clé CLI du test §5)
CANARY2 = http-echo-canari-1793910749     (ADMIN_API_KEY de l'ENV DU SERVEUR — pire cas)

$ rg -a -c "$CANARY" db/adm-rupture.db          → 0 occurrence
✅ 0 occurrence du secret dans la DB ENTIÈRE (binaire compris)
$ rg -a -c "a3-e2e@mbote.test" db/adm-rupture.db → hits     ✅ contrôle positif (méthode validée)

Serveur relancé AVEC ADMIN_API_KEY=$CANARY2 dans son env, e2e COMPLET exécuté
(report/block/queue/action — toutes les réponses capturées dans /tmp/adm-e2e-out.txt) :
$ rg -c "$CANARY2" /tmp/adm-e2e-out.txt         → 0 occurrence
✅ 0 occurrence du secret dans TOUTES les réponses HTTP (endpoints admin-adjacents compris)
$ rg -c "super-admin" /tmp/adm-e2e-out.txt      → hits     ✅ contrôle positif
```

---

## 7. APPEND-ONLY AU NIVEAU MOTEUR + SCHÉMA FINAL

```
$ sqlite_master (triggers AdminAudit) : admin_audit_no_update · admin_audit_no_delete

Colonnes ModerationAction (adminKey SUPPRIMÉE) :
id, adminUserId, actorLabel, action, targetKind, targetId, reason, reportIds, meta, createdAt

Seed AdminUser :
[{"id":1,"email":"system@mbote.internal","role":"system","passwordHash":null,"totpEnrolled":0},
 {"id":2,"email":"a3-e2e@mbote.test","role":"super-admin","passwordHash":null,"totpEnrolled":0}]

$ UPDATE AdminAudit SET action='falsifié' WHERE id=1  → ✅ REFUSÉ : AdminAudit is append-only (UPDATE forbidden)
$ DELETE FROM AdminAudit WHERE id=1                   → ✅ REFUSÉ : AdminAudit is append-only (DELETE forbidden)
Ligne 1 intacte après tentatives : {"id":1,"action":"hide","actorRole":"super-admin"} · total=7 lignes
```

**Garde résiduelle documentée** (le seul contournement = une migration future qui dropperait les triggers) : `schema-guard.yml` (PR **et** push main) + check CI `sqlite_master` à ajouter aux tests (Étape 10) + relecture super-admin obligatoire de toute migration touchant `AdminAudit` (commenté dans le schéma et la migration).

**Garde locale du cas réel** : `schema_changed=1` + `migrations_added≥1` (dossier 0004) → logique du guard = **VERT** (le cas « schéma sans migration » est ROUGE — déjà prouvé 5 cas à la clôture). Test CI réel du guard : action opérateur (§8 — push requis).

---

## 8. ACTIONS OPÉRATEUR (dans l'ordre)

| # | Action | Commande | Débloque |
|---|---|---|---|
| O-A | **Pousser la clôture + l'audit ADM sur main** (token à réintégrer UNE fois, puis retirer du sandbox à nouveau) | `cd /home/z/my-project && git push origin main` | CI/déploiement durci ; ⚠️ le push déclenche `deploy-vps.yml` (état sûr : clé absente → warning) |
| O-B | **Confirmer les counts legacy prod** (avant tout deploy de la branche ADM) | `ssh root@95.111.226.63 'docker exec mbote-mesh sh -c "bun -e \"…4 COUNT…\""'` — les 4 SELECT sont dans l'en-tête de la migration 0004 | preuve « 0 attendu » ; si ≠ 0 → plan conditionnel (§2) |
| O-C | **Pousser `feat/adm-mvp` + PR de test du schema-guard** | `git push -u origin feat/adm-mvp` puis ouvrir la PR vers main → le guard doit être **VERT** (schéma+migration ensemble) → fermer la PR SANS merger | démonstration CI du garde sur le cas réel 0004 |
| O-D | Rappel risque résiduel assumé (token non révoqué — décision opérateur) | — | — |

**Gel confirmé** : `ADMIN_API_KEY` n'est PAS ajoutée au `.env` de déploiement ni au compose (O-4 gelé) ; le panneau n'en dépend pas.

---

## 9. « NON TESTÉ À DOCUMENTER » (Étape 0)

- **Migration prod réelle** : la rupture part en prod via `migrate deploy` au prochain deploy de la branche — le `SELECT` opérateur (O-B) doit précéder.
- **Cloudflare Access** : action opérateur au déploiement (non vérifiable sans auth CF).
- **DB dev du sandbox (`db/custom.db`)** : reste en drift (0/3 migrations) — à re-provisionner par migrations un jour (hors périmètre Étape 0 ; ne casse rien, elle n'est plus utilisée par les tests).
- **Login/TOTP/rotation** : Étape 3 — le bootstrap de session est refusé en production d'ici là (fail-safe : surface admin API fermée aux humains en prod, CLI seulement).

---

## 10. TRAÇABILITÉ

- **Commits** : `e0d8a4b` (schéma + migration 0004_admin + triggers + seed) · `04a5c4a` (admin-auth, routes, CLI, bootstrap, tests, @types/bun) · ce document.
- **Fichiers créés** : `src/lib/mbote/admin-auth.ts` · `scripts/admin-session.ts` · `prisma/migrations/20261105202309_0004_admin/` · ce document.
- **Fichiers rompus** : `prisma/schema.prisma` · `src/lib/mbote/moderation.ts` (adminGuard/adminKeyFromRequest SUPPRIMÉS) · `src/app/api/moderation/{action,queue}/route.ts` · `scripts/moderation-purge.ts` · `tests/moderation.test.ts` · `tests/moderation-e2e.ts`.
- **Qualité** : `bunx tsc --noEmit` OK · `bun run lint` 0 erreur · `bun test` 6/6 · e2e 43/43.
- **Serveur actuel du sandbox** : tournant sur `db/adm-rupture.db` (migrations-based), `/api/stats` 200.
- **Séquencement confirmé** : Étape 1 (specs RBAC/runbook/breakdown) n'est PAS démarrée — validation de la rupture demandée avant, conformément à la directive. B1 reste en parallèle sur sa branche ; **déploiement prod ordonné ADM → B1** (sera confirmé dans `ADM-mvp.md` §séquencement à l'Étape 10).
