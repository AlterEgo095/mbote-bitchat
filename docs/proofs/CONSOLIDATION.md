# CONSOLIDATION — feat/mbote-v1 : branche unique (2026-11-12, Clarification 1, vague C3+C4)

## Contexte et décision

Trois vagues consécutives ont vu les deux branches `feat/adm-mvp` et
`feat/b1-media-foundation` devenir interdépendantes (MessagesView,
next.config, package.json, DEV-SETUP) et produire 4-5 conflits de merge à
chaque vague (5 en D1, 4 en C2). Direction : **arrêter le merge à
répétition** — une branche unique `feat/mbote-v1`, un worktree par piste de
travail (adm/média), pas par feature.

## Opérations exécutées (renommages purs — zéro conflit par construction)

1. `git worktree prune` (les répertoires wt-adm/wt-b1 avaient été emportés
   par un flip du superviseur — commits durables, prévue DEV-SETUP §2b) puis
   re-création de `wt-adm` sur `feat/adm-mvp`.
2. **Vérification préalable** : `git merge-base --is-ancestor
   feat/b1-media-foundation feat/adm-mvp` → OUI. Divergence
   `feat/adm-mvp...feat/b1-media-foundation` = `34 0` (34 commits d'avance
   côté adm, 0 côté b1) : **l'union D1+C2 (merge b912a4d) contenait déjà
   TOUT b1** — aucune fusion de contenu nécessaire.
3. `git branch -m feat/adm-mvp feat/mbote-v1` — renommage propre.
4. `git branch -m feat/b1-media-foundation archive/b1-media-foundation` —
   archivage (PAS de suppression, historique conservé).
5. Re-création de `wt-b1` en **HEAD détaché** sur `feat/mbote-v1` (git
   interdit deux worktrees sur la même branche) — les commits faits dans
   `wt-b1` avancent la branche par `git -C /home/z/wt-adm merge --ff-only
   <hash>`. Documenté DEV-SETUP §2.

## Preuve AVANT (captée avant tout renommage, 2026-11-12T10:58:44+00:00)

```
--- git branch -a (local) ---
  feat/a1-anti-replay
  feat/a2-key-auth
  feat/a3-moderation
* feat/adm-mvp
  feat/b1-media-foundation
+ main

--- git worktree list ---
/home/z/my-project  53f92cd ain]
/home/z/wt-adm      7dfe0db [feat/adm-mvp]

--- feat/b1-media-foundation ancêtre de feat/adm-mvp ? ---
OUI — b1 entièrement contenu dans adm (aucune fusion nécessaire, fast-forward trivial)

--- divergence adm...b1 (gauche=adm seul, droite=b1 seul) ---
34	0
```

## Preuve APRÈS (2026-11-12T10:58:56+00:00)

```
--- git branch -a (local) ---
  archive/b1-media-foundation
  feat/a1-anti-replay
  feat/a2-key-auth
  feat/a3-moderation
* feat/mbote-v1
+ main

--- git worktree list ---
/home/z/my-project  53f92cd ain]
/home/z/wt-adm      7dfe0db [feat/mbote-v1]
/home/z/wt-b1       7dfe0db (detached HEAD)

--- git log feat/mbote-v1 --oneline | head -20 ---
7dfe0db docs(d1): preuves finales sur l'union D1+C2 — 9/9 tests, benchmark 15.3 ms, navigateur OK, exit 0 …
b912a4d merge(b1→adm): résolution des 4 conflits C2 (règle §8.1) — union D1+C2
330f522 feat(c2): appels audio 1:1 WebRTC E2EE — signalisation hub signée, TURN éphémère, knock push, fallback notes vocales
02d94ed docs(d1): assets preuve D1 régénérés sur le CODEBASE FUSIONNÉ (b1+adm) — 9/9 tests, benchmark 15.3 ms, navigateur OK, exit 0 …
266f8e2 merge(b1→adm): résolution immédiate des 5 conflits (règle §8.1 — > 3 = maintenant)
ae6ed60 feat(d1): recherche — FTS5 fil public + index DM local IndexedDB (frontière E2EE structurelle)
902f3a0 feat(d1): Clarifications 1+2 — audit DB silencieux + check merge clean
42cb068 test(adm): rejeu preuve Étape 10 — runner exit 0 en replay (PIPESTATUS validé), assets régénérés (11:44) …
2a5a8fe docs(adm): étape 10 — preuves ADM-step10.md …
ec416ea feat(adm): étape 10 — runner de preuve rejouable exit 0 (scripts/adm-step10-proof-run.sh) …
a5a9a12 lint(adm): 2 défauts du commit précédent …
d41594d feat(adm): étape 10 — suite E2E intégrée 17/17 …
f68c1c4 docs(adm): point 3 Étape 10 — PRE-DEPLOY-CHECKLIST.md …
e97214e docs(c1): §non-testé FCM …
ff8d323 fix(adm): point 1 Étape 10 — audit exhaustif writeAdminAudit (14/14 sites) …
0db19ef docs(c1): grep de contrôle §6 100% propre …
ebc804b feat(c1): push notifications Web Push VAPID — knock SANS CONTENU …
c2c55f6 docs(adm): preuves ADM-step9 …
6e1617c feat(adm): etape 9 four-eyes …
128e6cc lint(adm): 3 défauts préexistants du panneau attrapés par la re-validation lint …
```

**Tout y est** : D1 (ae6ed60) + C2 (330f522) + C1 (ebc804b) + les vagues B
(b2/b3/b4) + ADM (étapes 0-10) + les merges d'union — la branche unique est
l'union complète, sans perte.

## check-merge-clean — 0 conflit (plus qu'une branche)

Script réécrit pour le monde à branche unique : vérifie (1) arbre propre sur
`feat/mbote-v1`, (2) INVARIANT `archive/b1-media-foundation ⊆
feat/mbote-v1`, (3) unicité de la branche de travail ; supporte un dry-merge
optionnel (`bash scripts/check-merge-clean.sh <branche>`) pour un futur
reopen. Règle §8.1 (>3 conflits = résoudre maintenant) conservée.

Sortie réelle (exécutée APRÈS commit des modifications, arbre propre, exit 0) :

```
$ bash scripts/check-merge-clean.sh
── check-merge-clean ──────────────────────────────────────────────
branche courante : feat/mbote-v1
INVARIANT OK : archive/b1-media-foundation ⊆ feat/mbote-v1 (commits b1 hors mbote-v1 : 0)
branches de travail actives : 1 (feat/mbote-v1 )
RÉSULTAT : branche unique — 0 conflit PAR CONSTRUCTION (plus de merge à répétition).
# exit 0

$ bash scripts/check-merge-clean.sh archive/b1-media-foundation   # dry-merge optionnel
── check-merge-clean ──────────────────────────────────────────────
branche courante : feat/mbote-v1
INVARIANT OK : archive/b1-media-foundation ⊆ feat/mbote-v1 (commits b1 hors mbote-v1 : 0)
branches de travail actives : 1 (feat/mbote-v1 )
RÉSULTAT : branche unique — 0 conflit PAR CONSTRUCTION (plus de merge à répétition).
dry-merge : feat/mbote-v1 ← archive/b1-media-foundation (merge-base 330f522)
commits cible non fusionnés : 0
RÉSULTAT : merge PROPRE — 0 conflit (merge annulé, aucun état modifié).
# exit 0
```

Incident de harnais corrigé en cours de preuve (classe §7 DEV-SETUP) :
1re exécution → le glob `refs/heads/*` de `for-each-ref` ne matche pas les
branches multi-niveaux (`feat/mbote-v1`) → « branches actives : 0 » faux
positif ERREUR, et exit 0 malgré tout (`$?` après pipe = exit de tee).
Corrigé : `refs/heads/` + exit réel via `PIPESTATUS` (pattern déjà érigé en
règle par ADM-step10). La preuve ci-dessus est la sortie du script corrigé.

## Docs mis à jour (références vivantes ; les preuves historiques datées ne sont PAS réécrites)

- `docs/DEV-SETUP.md` §2 — procédures worktree + consolidation + wt-b1
  détaché ; §2a-c inchangés (toujours valides).
- `docs/SCALE-ARCHITECTURE.md` §8.1 — règle de merge remplacée par
  l'invariant de branche unique.
- `docs/PRE-DEPLOY-CHECKLIST.md` §0.1-0.3 — un seul merge au déploiement
  (`main ← feat/mbote-v1`).
- `docs/specs/ADMIN-ACCESS-RUNBOOK.md` P3 — note de renommage (entrée
  historique, toucher minimal).
- `scripts/check-merge-clean.sh` — réécrit (invariant + dry-merge générique).

## NON TESTÉ

- Le push `origin/feat/mbote-v1` (aucune poussée sur main ni sur origin dans
  cette vague — la poussée du renommage est une opération de déploiement,
  pas une étape de développement local).
- Comportement des workflows GitHub Actions sur le nouveau nom de branche
  (déclenchement vérifié au premier push réel).
