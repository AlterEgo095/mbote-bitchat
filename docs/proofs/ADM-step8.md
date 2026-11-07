# ADM Étape 8 — Audit viewer (preuves)

**Statut** : LIVRÉ et PROUVÉ — journal `/audit` + fiche `/audit/[id]` + export
CSV, lecture seule par construction, porte EXACTE auditor + super-admin.
Branche `feat/adm-mvp`, worktree externe `/home/z/wt-adm` (règle DEV-SETUP §2).

**Directive** : Étape 8 (~1–1,5 jp, « court, ciblé ») — page `/audit`
(protégée `requireAdmin('auditor')`), liste paginée cursor tri
createdAt décroissant, filtres acteur/action/targetType/période
(24h/7j/30j/custom) + recherche par cible (`type:id`), détail avec
beforeJson/afterJson en accordéons repliés, export CSV (Content-Disposition
attachment, ≤ 10 000 lignes, sans before/after), endpoints internes
`/api/internal/admin/audit{,/[id],/export.csv}` + BFF `/api/audit*`, lecture
seule — aucune route de mutation, append-only re-confirmé.

**Arbitrages** : ADMIN-RBAC.md §14 (10 points tranchés) — dont §14.1 porte
EXACTE (support/moderator → 403 TESTÉS, super-admin admis), §14.4 CSV RFC 4180
sans BOM + chiffrement CSV reporté-tranché, §14.7 export = fetch JS (le 422
doit être affichable).

---

## 1. Livrables → tests → preuves (chaque livrable a son témoignage)

| Livrable | Test (automatisé) | Preuve (fichier rejouable) |
|---|---|---|
| `GET /api/internal/admin/audit` (cursor keyset DESC 20/page, tri createdAt DESC + id DESC) | harnais `tests/admin-audit-e2e.test.ts` **30/30** (B1-B3) | `adm-step8-audit-page1.txt` (20 items + facets), `adm-step8-audit-page2.txt` (0 chevauchement), `adm-step8-cursor-bad.txt` (400) |
| Filtres : action, targetType, acteur, `since=24h\|7d\|30d`, `from/to` custom (prime, exclusifs → 400) | harnais C1-C5 | `adm-step8-filter-warn.txt` (uniquement des warn), `adm-step8-filter-period.txt` (48 h exclue), `adm-step8-search-target.txt` |
| Recherche cible : `type:id` (égalité double) + sous-chaîne cuid | harnais D1-D2 | `adm-step8-search-target.txt` (`target=user:<pubkey>` → l'entrée warn) |
| `GET /api/internal/admin/audit/[id]` (TOUS champs : before/after, ip, userAgent, justification) | harnais E1-E2 | `adm-step8-detail.txt` (beforeJson/afterJson/ip/userAgent/justification §6), 404 prouvée |
| Export CSV : `Content-Disposition: attachment` + `text/csv`, RFC 4180, 7 colonnes SANS before/after | harnais F1-F2 (+ parser RFC 4180 du harnais : guillemets doublés) | `adm-step8-export-headers.txt`, `adm-step8-export-walk.csv` (25 lignes parsées), `adm-step8-export-head.txt` |
| Limite export 10 000 → 422 avec message (jamais de troncature silencieuse) | harnais F3 (DB seedée à 10 031 lignes) + F4 (même DB, filtré → 200, `X-Export-Rows: 2`) | `adm-step8-export-422.txt` (« Export trop volumineux … affine les filtres ») |
| **RBAC porte EXACTE** : auditor → 200, support → 403, moderator → 403, super-admin → 200, anonymous/token-seul/session-sans-token → 401 | harnais A1-A5 | `adm-step8-support-403.txt` (liste), `adm-step8-support-403-export.txt` (export), `adm-step8-super-200.txt`, `adm-step8-support-refusal.png` (carte SSR) |
| **Append-only re-confirmé AVEC routes exposées** : UPDATE/DELETE via Prisma → erreur trigger SQLite ; POST HTTP → 405 | harnais G1-G3 | `adm-step8-appendonly-db.txt` (les DEUX erreurs + action inchangée `warn`) |
| BFF `/api/audit`, `/api/audit/[id]`, `/api/audit/export.csv` (502 ≠ 401 ≠ 403, CSV relayé octet pour octet) | harnais H1-H4 | `adm-step8-export-headers.txt` (headers d'attachment PRESERVÉS à travers le BFF) |
| FACETS (acteurs email+rôle, actions, targetTypes de l'ensemble filtré) | harnais I1 | `adm-step8-audit-page1.txt` (`"facets"`), dropdowns remplis sur `adm-step8-audit-list.png` |
| Lien cible : `user` → `/users/<pubkey>` ; autres types → texte brut (§14.5) | UI | `adm-step8-audit-detail-expanded.png` : cible `user : step8-warn-target-pubkey…` LIÉE |

## 2. Suites de tests exécutées (commandes exactes)

```bash
# harnais Étape 8 (30 tests) — deux serveurs RÉELS :3117+:3118
DATABASE_URL="file:$(pwd)/db/adm-audit-e2e-test.db" bun test tests/admin-audit-e2e.test.ts
# → 30 pass, 0 fail, 107 expect() (10 001 lignes seedées pour la limite export)

# NON-RÉGRESSION — l'option exactRoles est ADDITIVE, minRole inchangé :
DATABASE_URL="file:$(pwd)/db/adm-e2e-test.db"           bun test tests/admin-auth-e2e.test.ts      # → 83 pass, 0 fail (matrice RBAC 55 incluse)
DATABASE_URL="file:$(pwd)/db/adm-queue-e2e-test.db"     bun test tests/admin-queue-e2e.test.ts     # → 30 pass, 0 fail
DATABASE_URL="file:$(pwd)/db/adm-dashboard-e2e-test.db" bun test tests/admin-dashboard-e2e.test.ts # → 22 pass, 0 fail
DATABASE_URL="file:$(pwd)/db/adm-users-e2e-test.db"     bun test tests/admin-users-e2e.test.ts     # → 42 pass, 0 fail
# Total : 207 tests verts sur serveurs réels (83+30+22+42+30), hors suites unitaires.
```

## 3. Preuves navigateur (builds PRODUCTION, DEV-SETUP §2c)

Runner : `bash scripts/adm-step8-proof-run.sh` → exit 0 (`TERMINÉ`). Le
runner REBUILD les deux standalone à chaque exécution (un build périmé
prouverait une autre étape — leçon du premier passage : le build É7 sans
routes /audit servait 404, corrigé par rebuild systématique). Captures
(1440×900, panneau standalone :3102 + app principale :3101) :

| Fichier | Ce qu'elle montre |
|---|---|
| `adm-step8-audit-list.png` | journal rempli : 6 filtres (acteur/action/type/période/plage custom/cible), bouton « Exporter CSV », compteur « 20 lignes affichées · pages suivantes disponibles », colonnes directive — entrées `login_success` du run VIVANT tracées (l'audit capture ses propres preuves) |
| `adm-step8-audit-filter-actor.png` | dropdown acteur (facettes) sélectionné → journal filtré |
| `adm-step8-audit-detail-collapsed.png` | fiche `/audit/1` : tous champs + accordéons beforeJson/afterJson **REPLIÉS** (directive) |
| `adm-step8-audit-detail-expanded.png` | JSON pretty-print DÉPLIÉ : `warnings: 0 → 1`, `suspendedAt: null`, IP 10.91.7.42, userAgent figé, cible `user` LIÉE à la fiche |
| `adm-step8-audit-export.png` | clic « Exporter CSV » (vue filtrée action=walk) → notice aria-live « Export téléchargé (audit-….csv) » |
| `adm-step8-support-refusal.png` | session **support** → carte de refus SSR (« la porte est auditor exacte (+ super-admin) — arbitrage §14.1 ») |

## 4. Bugs réels attrapés par les preuves pendant l'écriture

1. **Build standalone périmé** (premier passage du runner) : le garde
   « build si absent » réutilisait le standalone É7 — l'app principale
   répondait SANS les routes /audit. Correction : le runner É8 rebuild
   TOUJOURS. Leçon enregistrée : un runner de preuve qui réutilise un
   artefact prouve le passé, pas le code.
2. **Backdatage du seed faux** (harnais C3) : `o.back` (ms) multiplié par
   1000 → l'entrée « 48 h » datait de 5 ans, la plage from/to l'excluait.
   Attrapé par l'assertion (l'entrée attendue absente de la plage).
3. **Export UI 422 sur vue non filtrée** (runner 7d) : le journal de preuve
   dépasse 10 000 lignes — le clic export SANS filtre renvoyait correctement
   422 ; le runner filtre maintenant (action=walk) pour démontrer le
   téléchargement, la 422 étant prouvée en 3g.
4. **Headers de requête renvoyés au lieu de la réponse** (harnais F1/H3) :
   `headers.get` absent — le helper HTTP retournait l'objet d'en-têtes de la
   REQUÊTE. Corrigé (`res.headers`).

## 5. NON TESTÉ (explicite)

- **Rétention long-terme (illimitée)** : arbitrage §4.3 d'ADMIN-RBAC — le
  volume réel sur des années n'est pas mesuré (charge réelle NON TESTÉE).
- **Chiffrement du CSV à l'export** : reporté-TRANCHÉ (arbitrage §14.4) —
  le panneau est derrière Cloudflare Access + HTTPS ; ré-évaluer avec le rôle
  compliance (§2.3) si certification. Aucune capture de fuite possible tant
  que CF Access couvre le panneau.
- **Charge réelle** : le harnais seede 10 031 lignes ; la pagination/facets
  sur des millions d'entrées (rétention illimitée) n'est pas benchée.
- **502 BFF en conditions réelles** : couvert par la chaîne É5-É7 (même
  code `verifyPanelSession`/`denied`) — le harnais H4 vérifie le health
  DEGRADED mais ne tue pas MAIN pendant le run (le pattern 502 est déjà
  prouvé par les étapes précédentes sur le même code partagé).
