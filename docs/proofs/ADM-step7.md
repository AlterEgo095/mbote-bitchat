# ADM Étape 7 — Gestion utilisateurs (preuves)

**Statut** : LIVRÉ et PROUVÉ — annuaire + fiche + warn/suspend/unsuspend, ban
hors surface (four-eyes Étape 9). Branche `feat/adm-mvp`, worktree externe
`/home/z/wt-adm` (règle DEV-SETUP §2).

**Directive** : Étape 7 (~2–3 jp) — page `/users` protégée `requireAdmin('support')`,
fiche `/users/[id]` sans AUCUNE donnée privée, actions view/warn/suspend, ban
**bouton désactivé** (tooltip « approbation par 2 admins requise — Étape 9 »),
endpoints internes `/api/internal/admin/users` + BFF `/api/users`, preuves
navigateur + tests + runner rejouable.

---

## 1. Livrables → tests → preuves (chaque livrable a son témoignage)

| Livrable | Test (automatisé) | Preuve (fichier rejouable) |
|---|---|---|
| `GET /api/internal/admin/users` (liste cursor 20/page, recherche LIKE 20 max, tri inscription/reports, filtres statut+période) | harnais `tests/admin-users-e2e.test.ts` **42/42** (B, C) | `assets/adm-step7-users-page1.txt` (20 items, `mode:list`), `adm-step7-users-page2.txt` (0 chevauchement), `adm-step7-cursor-bad.txt` (400), `adm-step7-q-empty.txt` (400), `adm-step7-search-alice.txt` |
| `GET /api/internal/admin/users/[id]` (fiche publique + historique AdminAudit + reports ouverts) | harnais D (format, 404, anti-fuite) | `adm-step7-fiche-alice.txt` (bio publique servie, 0 email/IP/password — grep §3e) |
| `POST .../warn` (UserWarning + audit, 1 transaction) | harnais E + lecture du titulaire par preuve de possession (ECDSA P-256) | `adm-step7-warn-form.png`, `adm-step7-after-warn.png` (notice 2xx + refetch serveur), `adm-step7-audit-db.txt` (audit `SPAM: …` + warning) |
| `POST .../suspend` (24h/7d/30d, publication bloquée, **DM possible**) | harnais F (posts 403, dms 200, expiration backdatée, 400 durées invalides) | `adm-step7-suspend-200.txt` (suspendedUntil posé), `adm-step7-probe-before.txt` (200 témoin), `adm-step7-probe-during.txt` (**403** « compte suspendu » — post RÉEL signé ECDSA), `adm-step7-after-suspend.png` |
| `POST .../unsuspend` (levée — arbitrage §13.5) | harnais F (cleared en DB) | fiche `after-suspend.png` : bouton « Lever la suspension » offert |
| **Ban = AUCUNE route** (interne + BFF → 404) | harnais G (les DEUX surfaces) | `adm-step7-ban-404-internal.txt`, `adm-step7-ban-404-bff.txt` ; UI : bouton grisé + « four-eyes Étape 9 » sur la capture |
| RBAC (support lecture, moderator mutations, auditor 403) | harnais A + H | `adm-step7-support-warn-403.txt` (403), `adm-step7-auditor-403.txt` (403), `adm-step7-fiche-support.png` (fiche SANS boutons d'action en support) |
| BFF `/api/users/*` (502 ≠ 401 ≠ 403) | harnais H + Étape 6 (même chaîne) | `adm-step7-degradation-502.txt` (kill backend → 502 `backend-unreachable`) |
| UI non-optimiste (invariant §1.8) | captures | `after-warn.png` / `after-suspend.png` : notice « OK (2xx) — Fiche rejetée depuis le serveur », l'état affiché EST la réponse serveur |

## 2. Suites de tests exécutées (commandes exactes)

```bash
# harnais Étape 7 (42 tests) — deux serveurs RÉELS :3107+:3108
DATABASE_URL="file:$(pwd)/db/adm-users-e2e-test.db" bun test tests/admin-users-e2e.test.ts
# → 42 pass, 0 fail, 105 expect() (sortie intégrale dans le journal du commit)

# NON-RÉGRESSION du refactor user-moderation.ts — les suites des Étapes 3-6 :
DATABASE_URL="file:$(pwd)/db/adm-e2e-test.db"        bun test tests/admin-auth-e2e.test.ts      # → 83 pass, 0 fail
DATABASE_URL="file:$(pwd)/db/adm-queue-e2e-test.db"  bun test tests/admin-queue-e2e.test.ts     # → 30 pass, 0 fail
DATABASE_URL="file:$(pwd)/db/adm-dashboard-e2e-test.db" bun test tests/admin-dashboard-e2e.test.ts # → 22 pass, 0 fail
# Total : 177 tests verts sur serveurs réels (83+30+22+42), hors suites unitaires.
```

Le refactor Étape 7 (extraction `src/lib/mbote/user-moderation.ts` : la
transaction warn/suspend/unsuspend est UNIQUE — partagée par
`/api/moderation/action` legacy et les endpoints E7) est prouvé sans
régression par ces quatre suites. Un bug de refactor a été attrapé PAR LES
PREUVES pendant l'écriture : l'import `writeAdminAudit` retiré à tort du
legacy (branches post encore utilisatrices → hide 500 dans la matrice RBAC
55 cellules). Corrigé puis toutes les suites repassées vertes — la valeur
« preuves rejouables » illustrée une fois de plus.

## 3. Preuves navigateur (builds PRODUCTION, DEV-SETUP §2c)

Runner : `bash scripts/adm-step7-proof-run.sh` → exit 0 (journal en tête de
commit). Captures (1440×900, panneau standalone :3102 + app principale :3101) :

| Fichier | Ce qu'elle montre |
|---|---|
| `adm-step7-users-list.png` | annuaire page 1 : recherche, filtres (statut/période/tri), « 34 compte(s) au total », colonnes pseudo/inscription/posts/reports/statut, badges `actif` |
| `adm-step7-users-search.png` | recherche « alice » → « 1 résultat(s) » (LIKE serveur) |
| `adm-step7-fiche-support.png` | fiche alice en session **support** : données publiques uniquement, AUCUN bouton d'action (rôle lecture) |
| `adm-step7-warn-form.png` | formulaire de justification §6 (catégorie + texte ≥ 20) ouvert par moderator |
| `adm-step7-after-warn.png` | notice « Avertir — OK (2xx). Fiche rejetée depuis le serveur » + historique admin (1) |
| `adm-step7-suspend-form.png` | formulaire suspend avec dropdown Durée 24 h / 7 j / 30 j (directive) |
| `adm-step7-after-suspend.png` | fiche « suspendu — jusqu'au 07/11/2026 22:06 », **ban grisé** « four-eyes Étape 9 », « Lever la suspension » offert, historique (2) avec justifications |

Journal curl complet : fichiers `assets/adm-step7-*.txt` (tous produits par le
runner, aucuns chiffres saisis à la main). Secrets : DB de preuve jetable,
TOTP secrets affichés une fois dans le journal du seed (`/tmp/step7-seed.log`,
non commité).

## 4. Arbitrages

Tranchés et figés dans `docs/specs/ADMIN-RBAC.md` **§13.1–13.11** (matrice §4
re-tranchée : `users.view` = support, `user.warn` = moderator sur les
endpoints E7 / support sur le legacy — harmonisation Étape 8). Point clé :
l'identifiant d'URL est la **pubkey** (§13.2 — cible exacte des traces
d'audit existantes, zéro migration) ; les durées E7 sont 24h/7d/30d
(§13.3 — pas d'`indefinite` sur la fiche) ; `unsuspend` est exposé (§13.5) ;
le filtre `banni` accepte et rend 0 ligne (§13.7 — pas de champ avant É9).

## 5. NON TESTÉ (explicite, discipline)

- **ban + purge four-eyes** : Étape 9 — la route n'existe volontairement PAS
  (404 prouvé sur les deux surfaces, §13.9).
- **notifications email** : aucun SMTP dans le MVP — la notification warn est
  la UserWarning lue dans le profil (preuve de possession, testée).
- **charge réelle** : annuaire mesuré sur 34 comptes (fixtures) ; les
  sous-requêtes COUNT par ligne seront à relire au Palier 1 (compteurs
  dénormalisés si > 10 k DAU — cahier SCALE-ARCHITECTURE).
- **expiration suspend en navigateur** : le mock temporel (backdate DB) est
  prouvé au niveau API (harnais F) ; pas de capture navigateur dédiée (le
  statut affiché vient du même `mapItem` que l'API).
- **UI mobile du panneau** : captures desktop uniquement (outil d'astreinte
  bureau) — responsive Tailwind présent mais non photographié.

## 6. Rejouabilité

```bash
bash scripts/adm-step7-proof-run.sh
# seed idempotent → builds prod (cache) → serveurs :3101/:3102 → curl (RBAC,
# pagination, anti-fuite, ban 404) → probes ECDSA (200→403) → navigateur
# (3 logins TOTP fenêtres N/N+1) → preuve DB → 502 → nettoyage. Exit 0 attendu.
```
