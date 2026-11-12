#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-merge-clean — invariant de consolidation + divergences main + dry-merge
#                     (Cl. 1 vague C3+C4 : consolidation · Cl. 2 vague D2+D3 : main ⊆ mbote-v1)
# ─────────────────────────────────────────────────────────────────────────────
# Usage :
#   bash scripts/check-merge-clean.sh                    # invariants branche unique + main
#   bash scripts/check-merge-clean.sh <branche-cible>    # dry-merge d'une branche
#
# Depuis la consolidation (feat/adm-mvp → feat/mbote-v1, b1 archivée), il n'y a
# PLUS qu'UNE branche de travail : feat/mbote-v1. Le check vérifie :
#   1. on est bien sur feat/mbote-v1 et l'arbre est propre ;
#   2. INVARIANT de consolidation : archive/b1-media-foundation est un
#      ancêtre de feat/mbote-v1 (rien n'a été perdu au renommage) ;
#   3. INVARIANT main ⊆ feat/mbote-v1 (Cl. 2 vague D2+D3) : pour chaque
#      fichier présent à la fois dans main et feat/mbote-v1, le contenu de
#      main doit être IDENTIQUE à celui de feat/mbote-v1 OU être l'ancêtre
#      direct (inchangé depuis le merge-base). Toute divergence réelle (main
#      a modifié un fichier partagé sans que mbote-v1 le reprenne) doit être
#      documentée dans docs/DIVERGENCES-MAIN.md avec justification — sinon
#      exit 1. C'est le garde de RÉGRESSION future : le jour où main évolue
#      (hotfix prod, dependabot), toute divergence est visible IMMÉDIATEMENT.
#   4. si <branche-cible> est fournie (ex. pour un futur reopen d'archive),
#      dry-merge réel : git merge --no-commit --no-ff <cible>, liste les
#      conflits éventuels, puis git merge --abort — AUCUN état laissé modifié.
#
# Sortie : exit 0 = invariants OK (et merge propre si cible fournie) ·
#          exit 1 = conflits OU divergences non documentées (liste affichée) ·
#          exit 2 = erreur d'usage/invariant cassé.
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
ACTIVE=$(git for-each-ref 'refs/heads/' --format '%(refname:short)' \
  | grep -v '^main$' | grep -v '^archive/' | grep -vE '^feat/(a1-anti-replay|a2-key-auth|a3-moderation)$' || true)
COUNT_ACTIVE=$(echo "$ACTIVE" | grep -c . || true)
echo "branches de travail actives : $COUNT_ACTIVE ($(echo "$ACTIVE" | tr '\n' ' '))"
if [ "$COUNT_ACTIVE" -ne 1 ] || [ "$ACTIVE" != "$MAIN_BRANCH" ]; then
  echo "ERREUR : consolidation altérée — il doit n'y avoir que $MAIN_BRANCH."
  exit 2
fi
echo "RÉSULTAT : branche unique — 0 conflit PAR CONSTRUCTION (plus de merge à répétition)."

# ── Invariant main ⊆ feat/mbote-v1 — fichiers partagés (Cl. 2 vague D2+D3) ──
# Leçon @node-rs/argon2/qrcode (merge b1→adm C2) : une régression de merge
# PERD une dépendance silencieusement. L'invariant archive ⊆ mbote-v1 devient
# trivial (branche unique) — celui-ci détecte les régressions FUTURES quand
# main évoluera (hotfix prod, dependabot) : pour chaque fichier présent dans
# main ET feat/mbote-v1, main doit être identique OU inchangé depuis le
# merge-base. Sinon la divergence doit être documentée dans
# docs/DIVERGENCES-MAIN.md (justification) — sinon exit 1.
DIVERGENCES_DOC="docs/DIVERGENCES-MAIN.md"
MERGE_BASE=$(git merge-base "$MAIN_BRANCH" main 2>/dev/null || true)
if [ -z "$MERGE_BASE" ]; then
  echo "AVERTISSEMENT : aucun merge-base avec main (historiques sans ancêtre) — check divergence sauté."
else
  MAIN_EXTRA=$(git rev-list --count "$MERGE_BASE"..main)
  if [ "$MAIN_EXTRA" -eq 0 ]; then
    echo "INVARIANT OK : main n'a pas divergé depuis le merge-base (0 commit exclusif) — fichiers partagés à jour par construction."
  else
    echo "main a $MAIN_EXTRA commit(s) exclusif(s) — vérification des $(git ls-tree -r --name-only main | wc -l) fichiers de main..."
    # Exclusions : artefacts GÉNÉRÉS (snapshots sandbox / builds) — aucune
    # logique applicative, mbote-v1 reste autoritaire par construction. La
    # liste est volontairement courte et documentée dans DIVERGENCES-MAIN.md.
    EXCLUDE_RE='(^|/)\.next/|^node_modules/|(^|/)node_modules/|^coverage/|\.tsbuildinfo$|^dev\.log$|^db/[^/]*\.db(-wal|-shm)?$'
    SHARED=$(mktemp); DIVERGED=$(mktemp)
    comm -12 \
      <(git ls-tree -r --name-only main | sort) \
      <(git ls-tree -r --name-only "$MAIN_BRANCH" | sort) \
      | grep -Ev "$EXCLUDE_RE" > "$SHARED" || true
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      MAIN_BLOB=$(git rev-parse "main:$f" 2>/dev/null || true)
      BASE_BLOB=$(git rev-parse "$MERGE_BASE:$f" 2>/dev/null || true)
      MBOTE_BLOB=$(git rev-parse "$MAIN_BRANCH:$f" 2>/dev/null || true)
      # OK si : contenu identique des deux côtés, OU main inchangé depuis le
      # merge-base (mbote-v1 est le descendant autoritaire du fichier).
      if [ "$MAIN_BLOB" = "$MBOTE_BLOB" ] || [ "$MAIN_BLOB" = "$BASE_BLOB" ]; then
        continue
      fi
      echo "$f" >> "$DIVERGED"
    done < "$SHARED"
    SHARED_COUNT=$(wc -l < "$SHARED" | tr -d ' ')
    DIVERGED_COUNT=$(wc -l < "$DIVERGED" | tr -d ' ')
    echo "fichiers partagés main ↔ feat/mbote-v1 (hors artefacts générés) : $SHARED_COUNT"
    if [ "$DIVERGED_COUNT" -eq 0 ]; then
      echo "INVARIANT OK : main ⊆ feat/mbote-v1 — 0 divergence sur les fichiers partagés."
    else
      echo "DIVERGENCE(S) DÉTECTÉE(S) : $DIVERGED_COUNT fichier(s) modifié(s) côté main sans reprise dans feat/mbote-v1 :"
      cat "$DIVERGED" | sed 's/^/  - /'
      MISSING=""
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        if ! grep -qF "$f" "$DIVERGENCES_DOC" 2>/dev/null; then
          MISSING="${MISSING}${f}\n"
        fi
      done < "$DIVERGED"
      if [ -n "$MISSING" ]; then
        rm -f "$SHARED" "$DIVERGED"
        echo "INVARIANT CASSÉ : divergence(s) NON documentée(s) dans $DIVERGENCES_DOC :"
        printf '%b' "$MISSING" | sed 's/^/  · /'
        echo "→ documenter CHAQUE fichier divergent avec sa justification, puis relancer."
        exit 1
      fi
      echo "divergence(s) documentée(s) dans $DIVERGENCES_DOC — OK (exit 0 avec traçabilité)."
    fi
    rm -f "$SHARED" "$DIVERGED"
  fi
fi


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
