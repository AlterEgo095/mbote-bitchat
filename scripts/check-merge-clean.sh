#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-merge-clean — invariant de consolidation + dry-merge générique
#                     (Clarification 1, vague C3+C4 : consolidation branches)
# ─────────────────────────────────────────────────────────────────────────────
# Usage :
#   bash scripts/check-merge-clean.sh                    # invariant branche unique
#   bash scripts/check-merge-clean.sh <branche-cible>    # dry-merge d'une branche
#
# Depuis la consolidation (feat/adm-mvp → feat/mbote-v1, b1 archivée), il n'y a
# PLUS qu'UNE branche de travail : feat/mbote-v1. Le check vérifie :
#   1. on est bien sur feat/mbote-v1 et l'arbre est propre ;
#   2. INVARIANT de consolidation : archive/b1-media-foundation est un
#      ancêtre de feat/mbote-v1 (rien n'a été perdu au renommage) ;
#   3. si <branche-cible> est fournie (ex. pour un futur reopen d'archive),
#      dry-merge réel : git merge --no-commit --no-ff <cible>, liste les
#      conflits éventuels, puis git merge --abort — AUCUN état laissé modifié.
#
# Sortie : exit 0 = invariant OK (et merge propre si cible fournie) ·
#          exit 1 = conflits détectés (liste affichée) · exit 2 = erreur
#          d'usage/invariant cassé.
# Règle (SCALE-ARCHITECTURE §8.1) : conflits > 3 fichiers = résoudre
# MAINTENANT, pas au déploiement.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

MAIN_BRANCH="feat/mbote-v1"
ARCHIVE_BRANCH="archive/b1-media-foundation"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TARGET="${1:-}"

echo "── check-merge-clean ──────────────────────────────────────────────"
echo "branche courante : $BRANCH"
if [ "$BRANCH" != "$MAIN_BRANCH" ]; then
  echo "ERREUR : à exécuter depuis $MAIN_BRANCH (worktree wt-adm)."
  exit 2
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERREUR : arbre de travail sale — commitez ou stash avant le check."
  exit 2
fi

# ── Invariant de consolidation : l'archive b1 est un ancêtre de mbote-v1 ────
if ! git rev-parse --verify "$ARCHIVE_BRANCH" >/dev/null 2>&1; then
  echo "ERREUR : branche d'archive $ARCHIVE_BRANCH introuvable — consolidation altérée."
  exit 2
fi
if git merge-base --is-ancestor "$ARCHIVE_BRANCH" "$MAIN_BRANCH"; then
  DIVERGENCE=$(git rev-list --left-right --count "$MAIN_BRANCH"..."$ARCHIVE_BRANCH" | awk '{print $2}')
  echo "INVARIANT OK : $ARCHIVE_BRANCH ⊆ $MAIN_BRANCH (commits b1 hors mbote-v1 : $DIVERGENCE)"
else
  echo "INVARIANT CASSÉ : $ARCHIVE_BRANCH n'est plus un ancêtre de $MAIN_BRANCH."
  exit 2
fi

# Branches de travail actives locales (hors main, archive/*, vieilles branches
# mortes a1-a3) — il doit en rester exactement UNE : feat/mbote-v1.
ACTIVE=$(git for-each-ref 'refs/heads/*' --format '%(refname:short)' \
  | grep -v '^main$' | grep -v '^archive/' | grep -vE '^feat/(a1-anti-replay|a2-key-auth|a3-moderation)$' || true)
COUNT_ACTIVE=$(echo "$ACTIVE" | grep -c . || true)
echo "branches de travail actives : $COUNT_ACTIVE ($(echo "$ACTIVE" | tr '\n' ' '))"
if [ "$COUNT_ACTIVE" -ne 1 ] || [ "$ACTIVE" != "$MAIN_BRANCH" ]; then
  echo "ERREUR : consolidation altérée — il doit n'y avoir que $MAIN_BRANCH."
  exit 2
fi
echo "RÉSULTAT : branche unique — 0 conflit PAR CONSTRUCTION (plus de merge à répétition)."

# ── Dry-merge optionnel d'une branche cible (ex. reopen d'archive) ──────────
if [ -n "$TARGET" ]; then
  if ! git rev-parse --verify "$TARGET" >/dev/null 2>&1; then
    echo "ERREUR : branche cible $TARGET introuvable."
    exit 2
  fi
  BASE=$(git merge-base HEAD "$TARGET")
  echo "dry-merge : $MAIN_BRANCH ← $TARGET (merge-base $(git rev-parse --short $BASE))"
  echo "commits cible non fusionnés : $(git rev-list --count "$BASE".."$TARGET")"
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
fi

exit 0
