# ADM Étape 9 — FOUR-EYES (ban définitif + purge) : preuves

**Statut** : LIVRÉ et PROUVÉ — intentions en attente, approbation par un
second super-admin DISTINCT (id ET session), exécution transactionnelle
auditée, expiration paresseuse 1 h, annulation par le demandeur seul.
Branche `feat/adm-mvp`, worktree externe `/home/z/wt-adm` (règle DEV-SETUP §2).

**Directive** : Étape 9 (~2–3 jp) — table `PendingAction` (id, actionType,
targetType, targetId, requestedBy, requestedAt, reason ≥ 20 chars, expiresAt
= requestedAt + 1 h, approvedBy, approvedAt, executedAt, status) ; endpoints
internes `POST/GET /api/internal/admin/pending-actions`, `POST [id]/approve`,
`POST [id]/cancel` ; « toute action execute déclenche la vraie mutation
(ban/purge) et écrit 2 lignes dans AdminAudit : une pour request, une pour
execute (avec requestedBy et approvedBy) » ; BFF `/api/pending-actions` ; UI
fiche (bouton Ban définitif actif super-admin → modale « justification ≥ 20
chars »), page `/pending-actions` (Approuver si ≠ demandeur / Annuler si =
demandeur), notification email (log en attendant SMTP) à chaque demande,
timeout visuel (ligne grise puis disparition) ; tests : création RBAC,
auto-approbation 403, approbation 2 admins → mutation + 2 lignes AdminAudit,
expiration → 410, annulation → aucune mutation, ban → bannedAt + posts
masqués (hiddenBy = exécutant), purge → post supprimé + beforeJson conservé,
notification log, RBAC support/auditor → 403.

**Arbitrages** : ADMIN-RBAC.md §15.1–7 (tranchés 2026-11-06/07) —
1. **Rôle = super-admin** pour créer ET approuver (directive É9 explicite ;
   matrice §4 #9–11 v1.0 `moderator` réalignée) — la file est VISIBLE dès
   `moderator` (observation), agir = super-admin seul.
2. **Statuts `pending | executed | cancelled | expired`** — le `rejected` de
   la v1.0 §5 fusionne dans `cancelled` (la directive ne décrit aucun bouton
   « Rejeter » côté approbateur : un refus = ne pas agir, l'intention expire).
3. **« user disabledAt » (directive) = `User.bannedAt` + `bannedById`** —
   sémantique identique, nom aligné sur le schéma §5 (pas de unban UI).
4. **Ban = publication 403 + posts masqués** (`hiddenById` = exécutant) +
   double barrière feed (`author.bannedAt: null`).
5. **Expiration = évaluation PARESSEUSE** (pas de cron, tranché à la
   directive) : approbation → 410 Gone ; GET liste marque `expired` + audit
   par ligne ; UI grise `expiresAt < now` puis l'historique prend le relais.
6. **Doublon → 409** (une intention OUVERTE par actionType+cible) ; cible
   déjà bannie → 409 ; post purgé entre-temps → 404 à la demande.
7. **Notification = log structuré** `[pending-action:notify]` (SMTP absent —
   NON TESTÉ, assumé).

---

## 1. Livrables → tests → preuves (chaque livrable a son témoignage)

| Livrable | Test | Preuve |
|---|---|---|
| `PendingAction` (migration `20261107090000_0007_etape9_four_eyes`, 100 % additive) | harnais 29/29 (DB dédiée, migrate deploy) | `assets/adm-step9-create-201.txt` (201 pending + expiresAt ≈ +1 h) |
| Endpoints internes `POST/GET pending-actions` + `[id]/approve` + `[id]/cancel` (create/approve = super-admin, file = moderator min) | harnais A/B/I/K (403 moderator/support/auditor, 201, 200) | `assets/adm-step9-create-mod-403.txt` (403 uniforme) · `adm-step9-mod-list-200.txt` (200 moderator) |
| Auto-approbation impossible (garde double id ET session) | harnais C (2ᵉ session du même admin → 403, message id puis garde session active) | `assets/adm-step9-auto-403.txt` (403 uniforme BFF) |
| Exécution TRANSACTIONNELLE du ban (reports clos + bannedAt + posts masqués + ModerationAction + AdminAudit) | harnais D (200 + DB assertions) | `assets/adm-step9-approve-200.txt` (requestedBy/approvedBy) · **`adm-step9-ban-executed-db.json`** (bannedById=exécutant, 2/2 posts masqués par sa2, EXACTEMENT 2 lignes `[pendingaction_created, ban]`, fourEyes.requestedBy=super@…/approvedBy=super2@…) |
| Publication du banni refusée (garde distincte de la suspension) | harnais D (`403 « banni définitivement »`) | `assets/adm-step9-banned-403.txt` (403 + message, VRAIE clé bannie + signature valide) |
| Feed sans le banni + annuaire `status=banni` + fiche « banni » | harnais D (0 post du banni dans le feed ; 1 ligne ; status=banni) | capture `adm-step9-fiche-banni.png` |
| Expiration 1 h paresseuse → 410 Gone | harnais E (backdate → 410, statut expired audité) | `assets/adm-step9-expire-410.txt` · capture `adm-step9-pending-expired.png` (historique `expired`) |
| Annulation par le demandeur SEUL → aucune mutation | harnais F (403 autre admin, 200 cancelled, bannedAt NULL, audit `_cancelled`, re-approve → 409) | `assets/adm-step9-cancel-403.txt` · `adm-step9-cancel-200.txt` |
| Purge par four-eyes → post SUPPRIMÉ, beforeJson conservé | harnais G (2 lignes `[pendingaction_created, purge]`, content dans beforeJson, fourEyes en afterJson) | **`assets/adm-step9-purge-db.json`** |
| Notification log à chaque création | harnais H (poll du fichier stdout serveur) | `[pending-action:notify] … destinataires: sa-fe2@…` (harnais 29/29) |
| Zéro route ban directe (scénario G É7 toujours vrai) | harnais J (interne → 404, BFF → 404) | runner exit 0 |
| BFF `/api/pending-actions*` (502≠401≠403, CSRF) | harnais K (200/201/200/403) | captures navigateur ci-dessous |
| UI fiche (bouton ACTIF super-admin → modale) | navigateur (runner §9) | `adm-step9-fiche-bouton-actif.png` · `adm-step9-modale-intention.png` · `adm-step9-intention-201.png` |
| UI `/pending-actions` (Approuver si ≠ demandeur / Annuler si = demandeur, timeout visuel) | navigateur (runner §9b/§10/§11) | `adm-step9-pending-sa1.png` (demandeur : Annuler seul) · `adm-step9-pending-sa2.png` (2ᵉ admin : Approuver + historique executed/cancelled/expired) |
| Support refusé sur la file | navigateur (runner §12) | `adm-step9-support-refusal.png` |

## 2. Suites de tests exécutées (totaux exacts)

```
DATABASE_URL="file:$(pwd)/db/adm-four-eyes-e2e-test.db" bun test tests/admin-four-eyes-e2e.test.ts
  → 29 pass · 0 fail (112 expect)
# non-régression (DBs officielles de chaque harnais) :
admin-auth-e2e      → 83 pass · 0 fail
admin-queue-e2e     → 30 pass · 0 fail
admin-dashboard-e2e → 22 pass · 0 fail
admin-users-e2e     → 42 pass · 0 fail
admin-audit-e2e     → 30 pass · 0 fail
TOTAL NON-RÉGRESSION : 207 verts + 29 four-eyes = 236 verts
```

**3 bugs réels attrapés par le harnais AVANT toute preuve navigateur** (la
classe « preuves > harnais » fonctionne aussi en sens inverse) :
1. `super-admin-2` seedé comme RÔLE (inexistant → 403 partout) — fix : 2
   comptes au rôle `super-admin`, clés de session distinctes.
2. **DEADLOCK SQLite** : `writeAdminAudit` appelé SANS `tx` DANS la
   transaction de cancel → file lock → pool bloqué 5 s par annulation →
   cascade de timeouts. Fix : `tx` obligatoire (commentaire in situ).
3. `expired` répondait 409 au cancel — la directive veut 410 Gone (fix :
   `loadPendingAction` différencie `expired` des autres statuts).

## 3. Preuves navigateur (runner REJOUABLE, builds standalone TOUJOURS)

```
bash scripts/adm-step9-proof-run.sh   → EXIT 0
```
- Builds `next build` racine + panneau à CHAQUE exécution (leçon É8 — un
  build périmé prouverait une autre étape).
- Captures 1440×900 (build prod standalone :3101/:3102) : modale d'intention
  (`adm-step9-modale-intention.png`), notice 201 invariant §1.8
  (`adm-step9-intention-201.png`), file du demandeur sans bouton Approuver
  (`adm-step9-pending-sa1.png`), file du 2ᵉ admin avec « Approuver (exécute
  l'action) » + historique 4 statuts (`adm-step9-pending-sa2.png`), fiche
  « banni définitivement · four-eyes » avec bouton re-grisé
  (`adm-step9-fiche-banni.png`), historique expiré
  (`adm-step9-pending-expired.png`), refus support
  (`adm-step9-support-refusal.png`).
- Preuves DB : `adm-step9-ban-executed-db.json` + `adm-step9-purge-db.json`
  (cycle = 2 lignes EXACTES, requestedBy/approvedBy conservés).
- `5b` : publication du banni avec la VRAIE clé (JWK exportée par le seed) et
  une signature valide → 403 « banni définitivement » (`adm-step9-banned-403.txt`).

## 4. NON TESTÉ (explicite)

- **Notification email réelle** : SMTP absent — le log structuré est la
  preuve du déclencheur ; le transport est un fallback assumé (directive).
- **Job de cleanup automatique des intentions expirées** : tranché paresseux
  (§15.5) — les lignes expired sont conservées (audit), aucune purge SQL.
- **Charge réelle** (file > 200 intentions simultanées) : `take ≤ 200` et
  index `status` posés ; comportement au-delà non mesuré.
- **Deux approbations simultanées** (course) : re-prise TX en place (un seul
  gagne, l'autre 409) — non testé sous charge parallèle réelle.
- **UI mobile du panneau** (viewport < 768) : captures 1440×900 uniquement.
- **Merge/push** : aucun — branche `feat/adm-mvp` locale, `main` intouché.
