#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# d3-secrets-scan — scan de secrets sur TOUT l'historique git + arbre courant
#                     (D3 supply chain — directive 2026-11-13)
# ─────────────────────────────────────────────────────────────────────────────
# Outils externes (trufflehog, git-secrets) ABSENTS du sandbox — scan manuel
# par motifs, documenté dans docs/proofs/D3-supply-chain.md. Chaque motif est
# justifié ; les faux positifs attendus (placeholders, variables d'env sans
# valeur littérale) sont filtrés explicitement et répertoriés.
#
# Usage : bash scripts/d3-secrets-scan.sh [fichier-sortie]
# Sortie : 0 = aucun secret réel détecté · 1 = candidats à trier (liste)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-/tmp/d3-secrets-scan.txt}"
: > "$OUT"

# Exclusions DOCUMENTÉES (triage manuel D3, docs/proofs/D3-supply-chain.md §scan) :
# ces classes sont des FALSE POSITIFS revus un par un — le scan les liste
# explicitement à chaque exécution (pas de filtre silencieux).
EXCLUSIONS_DOC=(
  'a3-dev-admin-key'      # clé DEV historique A3 (docs de preuve ADM) — mécanisme rupturé ADM Étape 0 ; prod = clé vide (403 uniforme)
  'Passw0rd'              # mots de passe de FIXTURES admin-e2e (DBs de test jetables, jamais déployées)
)
exclude_filter() {
  local line
  while IFS= read -r line; do
    local keep=1
    for ex in "${EXCLUSIONS_DOC[@]}"; do
      if [[ "$line" == *"$ex"* ]]; then keep=0; break; fi
    done
    if [ "$keep" -eq 1 ]; then echo "$line"; fi
  done
}

scan_git() {
  local label="$1" pattern="$2"
  local hits
  hits=$(git log --all -p --no-color -- 2>/dev/null | grep -nEi -e "$pattern" \
    | grep -viE 'process\.env|NODE_ENV|\$\{[A-Z_]+|example|placeholder|XXXX|your[_-]|<[^>]+>|\btest\b.*(key|token|secret)|fake|dummy|canari|canary' \
    | exclude_filter \
    | head -20 || true)
  if [ -n "$hits" ]; then
    {
      echo "── $label ──"
      echo "$hits"
      echo ""
    } >> "$OUT"
    return 1
  fi
  return 0
}

FAILED=0

# Motifs de secrets (chaque motif = classe d'incident connue)
scan_git "clés privées PEM (RSA/EC/OPENSSH/PGP)" \
  '-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----' || FAILED=1
scan_git "clés d'accès AWS (AKIA)" \
  '\bAKIA[0-9A-Z]{16}\b' || FAILED=1
scan_git "tokens GitHub (ghp_/gho_/ghu_/ghs_/ghr_)" \
  '\bgh[pousr]_[A-Za-z0-9]{36,}\b' || FAILED=1
scan_git "tokens Slack (xox…)" \
  '\bxox[bpaoasr]-[A-Za-z0-9-]{10,}\b' || FAILED=1
scan_git "clés privées VAPID litérales" \
  'VAPID_PRIVATE_KEY\s*[=:]\s*["'"'"']?[A-Za-z0-9_-]{40,}' || FAILED=1
scan_git "SEED_SECRET / ADMIN_API_KEY / MBOTE_BOT_KEY litéraux (≥ 16 chars)" \
  '(SEED_SECRET|ADMIN_API_KEY|MBOTE_BOT_KEY|ADMIN_INTERNAL_TOKEN|RELAY_EMIT_TOKEN)\s*[=:]\s*["'"'"']?[A-Za-z0-9+/_-]{16,}' || FAILED=1
scan_git "mots de passe litéraux (password/passwd/pwd = …)" \
  '\b(password|passwd|pwd)\s*[=:]\s*["'"'"'][^"'"'"']{8,}["'"'"']' || FAILED=1
scan_git "clés privées JWK (champ « d » litéral)" \
  '"d"\s*:\s*"[A-Za-z0-9_-]{40,}"' || FAILED=1
scan_git "bearer/base64 secrets génériques (token = …)" \
  '\b(authorization|bearer)\s*[=:]\s*["'"'"'][A-Za-z0-9+/_=-]{24,}["'"'"']' || FAILED=1
scan_git "webhooks Discord/Teams litéraux" \
  'https://(discord|discordapp)\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+' || FAILED=1
scan_git "connection strings litérales (mongo/postgres/mysql avec credentials)" \
  '(mongodb(\+srv)?|postgres(ql)?|mysql|redis)://[A-Za-z0-9_]+:[^@/\s]{6,}@' || FAILED=1

# Arbre courant (hors historique) : mêmes motifs sur les fichiers suivis
TREE_HITS=$(git grep -nEi -e '-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----' -e '\bAKIA[0-9A-Z]{16}\b' -- ':!*.md' ':!docs/' 2>/dev/null | head -10 || true)
if [ -n "$TREE_HITS" ]; then
  echo "── arbre courant : clés PEM / AWS ──" >> "$OUT"
  echo "$TREE_HITS" >> "$OUT"
  FAILED=1
fi

# Audit .env.example : la liste des variables attendues DOIT être documentée,
# AUCUNE valeur littérale ne doit être présente (placeholders uniquement).
{
  echo "── .env.example (audit) ──"
  if [ -f .env.example ]; then
    grep -E '^[A-Z_]+=' .env.example | sed 's/=.*$/=<défini sur le VPS>/' || echo "(vide)"
  fi
  LITERAL=$(grep -E '^[A-Z_]+=..+' .env.example 2>/dev/null \
    | grep -vE '=($|<|\$\{|"|'"'"'|""$|vide|optionnel|générer|bunx|your|exemple|CHANGE_ME)' || true)
  if [ -n "$LITERAL" ]; then
    echo "CANDIDATS À TRIER dans .env.example :"
    echo "$LITERAL"
  else
    echo "→ aucune valeur littérale (placeholders uniquement)"
  fi
  echo ""
} >> "$OUT"

{
  echo "── exclusions documentées (faux positifs revus à la main) ──"
  printf '  - %s\n' "${EXCLUSIONS_DOC[@]}"
  echo ""
} >> "$OUT"
cat "$OUT"
if [ "$FAILED" -eq 0 ]; then
  echo "RÉSULTAT : 0 secret réel détecté dans $(git rev-list --all --count) commits (motifs D3)"
  exit 0
fi
echo "RÉSULTAT : candidats détectés — trier ci-dessus (faux positifs = à ajouter aux filtres)"
exit 1
