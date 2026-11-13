#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# d1-search-proof-run — PREUVE D1 : recherche FTS5 + frontière DM + benchmark
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b).
#
#   bash scripts/d1-search-proof-run.sh
#
# Étapes : sonde FTS5 (prérequis bloquant) → build standalone TOUJOURS (leçon
# É8) → migrations (leçon É10 : APRÈS le build — le prerender crée un fichier
# DB vide) → seed (3 users, posts piégés, DM ciphertext « secret », 10k bench)
# → serveur prod :3163 → suite API (hits, diacritiques, frontière DM, triggers
# hide/delete, suspension, pagination, benchmark 10k < 200 ms, rate limit 429)
# → RESTART serveur (rate store frais) → preuve navigateur (onboarding réel,
# recherche publique + DM locale, navigation + flash, frontière réseau
# type=posts, état vide) → preuves grep (0 fetch dans l'index DM) →
# check-merge-clean (fin de vague, Clarification 2).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB="$ROOT/db/d1-search-proof.db"
PORT=3163
BASE="http://127.0.0.1:$PORT"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[d1-proof] $(date +%H:%M:%S) — $*"; }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_ready() {
  for _ in $(seq 1 60); do
    if curl -sf "$BASE/api/stats" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "serveur non prêt après 60 s"; tail -30 /tmp/d1-server.log; exit 1
}

# ── 1. sonde prérequis (bloquante) ───────────────────────────────────────────
say "1. sonde FTS5 (prérequis bloquant)"
rm -f /tmp/fts5-probe.db /tmp/fts5-probe.db-wal /tmp/fts5-probe.db-shm
bun scripts/d1-fts5-probe.ts > "$ASSETS/d1-fts5-probe.txt"

# ── 1b. tsc --noEmit — gate AVANT le build (Clarification 1, leçon F-17 : un
#      type faux — ex. TS2345 — bloquait le build, jamais silencieux) ─────────
say "1b. tsc --noEmit (gate avant build — Clarification 1)"
bunx tsc --noEmit > /tmp/d1-tsc-prebuild.log 2>&1 \
  || { say "FAIL — tsc --noEmit : erreurs de type AVANT le build (extrait)"; tail -40 /tmp/d1-tsc-prebuild.log; exit 1; }

# ── 2. build production standalone (TOUJOURS — leçon É8) ─────────────────────
say "2. build standalone"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bun run build > /tmp/d1-build.log 2>&1 || { say "build ÉCHOUÉ (F-17 — jamais silencieux) : extrait de /tmp/d1-build.log"; tail -40 /tmp/d1-build.log; exit 1; }

# ── 3. migrations (leçon É10 : APRÈS le build) + seed ────────────────────────
say "3. migrations + seed"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > "$ASSETS/d1-migrate.txt" 2>&1
DATABASE_URL="file:$DB" bun scripts/d1-search-seed.ts > "$ASSETS/d1-seed.txt" 2>&1
say "   seed: $(cat "$ASSETS/d1-seed.txt")"

# ── 4. serveur prod :3163 (run 1 — tests API) ────────────────────────────────
say "4. serveur :$PORT (run 1)"
DATABASE_URL="file:$DB" MBOTE_EMBED_RELAY=0 PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/d1-server.log 2>&1 &
SERVER_PID=$!
wait_ready

# ── 5. suite API (bun test) ──────────────────────────────────────────────────
say "5. tests API (hits, diacritiques, frontière DM, triggers, pagination, benchmark, 429)"
D1_SEARCH_BASE_URL="$BASE" D1_SEARCH_DB="file:$DB" \
  bun test tests/d1-search.test.ts > "$ASSETS/d1-test-output.txt" 2>&1 || {
  tail -40 "$ASSETS/d1-test-output.txt"; exit 1; }
grep -E "benchmark|pass|fail" "$ASSETS/d1-test-output.txt" | tail -8 || true

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ── 6. serveur (run 2 — rate store frais) + preuve navigateur ────────────────
say "6. preuve navigateur (run 2 — rate store frais)"
DATABASE_URL="file:$DB" MBOTE_EMBED_RELAY=0 PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js >> /tmp/d1-server.log 2>&1 &
SERVER_PID=$!
wait_ready
bun scripts/d1-browser-proof.ts "$BASE" > "$ASSETS/d1-browser-run.txt" 2>&1 || {
  tail -40 "$ASSETS/d1-browser-run.txt"; exit 1; }
tail -6 "$ASSETS/d1-browser-run.txt"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ── 7. preuves grep : la recherche DM ne touche JAMAIS le réseau ─────────────
say "7. preuves grep (frontière DM locale)"
{
  echo "## grep fetch/XMLHttpRequest/WebSocket dans dm-search-index.ts (attendu : 0)"
  grep -nE "fetch\(|XMLHttpRequest|WebSocket|axios" src/lib/mbote/dm-search-index.ts || echo "(aucune occurrence — 0 requête réseau)"
  echo ""
  echo "## structure GlobalSearch : la section DM n'utilise QUE searchLocalDm"
  grep -n "apiSearchPosts\|searchLocalDm" src/components/mbote/GlobalSearch.tsx
  echo ""
  echo "## garde serveur : /api/search refuse type=dms (route.ts)"
  grep -n "type !== \"posts\"" src/app/api/search/route.ts
} > "$ASSETS/d1-grep-frontiere-dm.txt" 2>&1
if grep -qE "fetch\(|XMLHttpRequest|WebSocket|axios" src/lib/mbote/dm-search-index.ts; then
  echo "FAIL — dm-search-index.ts contient un appel réseau"; exit 1
fi

# ── 8. check-merge-clean (fin de vague — Clarification 2) ────────────────────
say "8. check-merge-clean (feat/b1-media-foundation → feat/adm-mvp)"
bash scripts/check-merge-clean.sh > "$ASSETS/d1-merge-clean.txt" 2>&1 \
  || echo "   (exit $? — conflits listés dans l'asset, règle §8.1 : > 3 = bloquant)"

# ── 9. qualité : tsc + lint ──────────────────────────────────────────────────
say "9. tsc + lint"
bunx tsc --noEmit > /tmp/d1-tsc.log 2>&1 || { tail -20 /tmp/d1-tsc.log; exit 1; }
bun run lint > /tmp/d1-lint.log 2>&1 || { tail -20 /tmp/d1-lint.log; exit 1; }

cp /tmp/d1-server.log "$ASSETS/d1-server-log.txt" 2>/dev/null || true
say "OK — preuve D1 complète (assets dans docs/proofs/assets/d1-*)"
