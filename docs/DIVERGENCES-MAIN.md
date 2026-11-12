# DIVERGENCES-MAIN — fichiers partagés main ↔ feat/mbote-v1

**Rôle** : registre obligatoire des divergences détectées par
`scripts/check-merge-clean.sh` (invariant **main ⊆ feat/mbote-v1**, Clarification 2
vague D2+D3). Le script compare, pour chaque fichier présent **à la fois** dans
`main` et `feat/mbote-v1`, le contenu des deux branches :

- **OK** si les contenus sont identiques ;
- **OK** si `main` n'a pas modifié le fichier depuis le merge-base (mbote-v1 est
  le descendant autoritaire) ;
- **DIVERGENCE** sinon : `main` porte des changements non repris dans
  `feat/mbote-v1`. Chaque divergence DOIT être listée ici avec sa justification,
  sinon le script sort en **exit 1** (CI rouge).

Leçon fondatrice : la régression `@node-rs/argon2`/`qrcode` perdue au merge
b1→adm (découverte C3, 2026-11-12) — une divergence de merge se perd
silencieusement quand elle n'est vérifiée nulle part. Cet invariant rend la
classe de bug **visible immédiatement** le jour où `main` évoluera (hotfix
prod, dependabot).

**Exclusions du check** (artefacts générés, aucune logique applicative —
justifiés ici une fois pour toutes) :

| Motif                       | Pourquoi exclu                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.next/` (tout niveau)      | Sorties de build Next (snapshots sandbox côté main : `admin/.next/*`) — régénérées à chaque build, jamais sources de vérité |
| `node_modules/`             | Dépendances installées (lockfile = source de vérité)                                                                     |
| `coverage/`                 | Rapports de test générés                                                                                                 |
| `*.tsbuildinfo`             | Cache TypeScript incrémental                                                                                             |
| `dev.log`                   | Journal du dev server sandbox                                                                                            |
| `db/*.db`, `db/*.db-wal/-shm` | Bases SQLite locales de preuve/harnais (données, pas code)                                                             |

## Divergences actuelles

**Aucune divergence pour l'instant** (vérifié 2026-11-13 : 0 divergence sur les
699 fichiers partagés hors artefacts générés — les 2 commits de snapshot
sandbox sur `main` n'ajoutent que des artefacts de build `.next/` et des
fichiers identiques aux deux branches).

## Procédure quand le check détecte une divergence

1. Exécuter `bash scripts/check-merge-clean.sh` depuis wt-adm → la liste des
   fichiers divergents non documentés est affichée.
2. Pour chaque fichier, trancher explicitement :
   - le changement de `main` est **utile** → le porter dans `feat/mbote-v1`
     (cherry-pick ou réapplication), puis effacer la ligne ici ;
   - le changement de `main` est **obsolète/sandbox** → l'ajouter au tableau
     des exclusions du script (motif + justification) OU documenter la
     divergence ci-dessous avec sa justification.
3. Relancer le check → exit 0 attendu avec la mention « divergence(s)
   documentée(s) ».
4. Un commit contenant la résolution + la mise à jour de ce fichier.

## Historique des divergences résolues

| Date       | Fichier(s) | Résolution                                      |
| ---------- | ---------- | ------------------------------------------------ |
| 2026-11-13 | (aucune)   | Invariant créé (Cl. 2 vague D2+D3) — 0 divergence |
