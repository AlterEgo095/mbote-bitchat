#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-merge-clean — vérifie que feat/b1-media-foundation se merge PROPREMENT
#                     dans feat/adm-mvp (Clarification 2, vague D1+C2)
# ─────────────────────────────────────────────────────────────────────────────
# Usage :
#   bash scripts/check-merge-clean.sh            # depuis un worktree sur feat/adm-mvp
#
# Ce que fait le script :
#   1. vérifie qu'on est bien sur feat/adm-mvp et que l'arbre est propre ;
#   2. git merge --no-commit --no-ff feat/b1-media-foundation (dry-merge réel) ;
#   3. liste les fichiers en conflit (git diff --name-only --diff-filter=U) ;
#   4. git merge --abort — AUCUN état laissé modifié.
#
# Sortie : exit 0 = merge propre (0 conflit) · exit 1 = conflits détectés
# (liste affichée). La règle (SCALE-ARCHITECTURE §8.1) : conflits > 3 fichiers
# = résoudre MAINTENANT, pas au déploiement.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
TARGET="feat/b1-media-foundation"

echo "── check-merge-clean ──────────────────────────────────────────────"
echo "branche courante : $BRANCH"
if [ "$BRANCH" != "feat/adm-mvp" ]; then
  echo "ERREUR : à exécuter depuis feat/adm-mvp (worktree wt-adm)."
  exit 2
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERREUR : arbre de travail sale — commitez ou stash avant le check."
  exit 2
fi

if ! git rev-parse --verify "$TARGET" >/dev/null 2>&1; then
  echo "ERREUR : branche $TARGET introuvable."
  exit 2
fi

BASE=$(git merge-base HEAD "$TARGET")
HEAD_ADMD=$(git rev-parse --short HEAD)
HEAD_B1=$(git rev-parse --short "$TARGET")
echo "merge-base : $(git rev-parse --short $BASE)"
echo "feat/adm-mvp : $HEAD_ADMD ← feat/b1-media-foundation : $HEAD_B1"
COMMITS_B1=$(git rev-list --count "$BASE".."$TARGET")
echo "commits b1 non fusionnés : $COMMITS_B1"

CONFLICTS_FILE=$(mktemp)
trap 'rm -f "$CONFLICTS_FILE"' EXIT

if git merge --no-commit --no-ff "$TARGET" >/dev/null 2>&1; then
  echo "RÉSULTAT : merge PROPRE — 0 conflit (merge annulé, aucun état modifié)."
  git merge --abort 2>/dev/null || git merge --quit 2>/dev/null || true
  exit 0
fi

git diff --name-only --diff-filter=U > "$CONFLICTS_FILE" || true
COUNT=$(wc -l < "$CONFLICTS_FILE" | tr -d ' ')
echo "RÉSULTAT : $COUNT fichier(s) en conflit :"
cat "$CONFLICTS_FILE" | sed 's/^/  - /'
echo "(merge annulé — aucun état modifié)"
if [ "$COUNT" -gt 3 ]; then
  echo "RÈGLE §8.1 : > 3 conflits → RÉSOUDRE MAINTENANT, pas au déploiement."
fi
exit 1
