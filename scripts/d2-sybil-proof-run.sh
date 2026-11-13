#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# d2-sybil-proof-run — PREUVE D2 : Sybil phase 0 (PoW + réputation + plafonds)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b).
#
#   bash scripts/d2-sybil-proof-run.sh
#
# Étapes : sonde prérequis (WebCrypto + worker + bench PoW 20 bits desktop +
# CPU throttled ×4 — bloquante) → build standalone TOUJOURS (leçon É8) →
# migrations (leçon É10 : APRÈS le build) → serveur prod :3165 → suite API
# (PoW valide/invalide/rejeu, plafonds 10/3/50, DMs 10, rate-limit 3/h/IP,
# T0 mesh sans PoW, fonctions pures) → RESTART serveur (rate store frais,
# leçon D1) → preuve navigateur (PoW visible en worker, badge réputation,
# compteurs, plafond atteint + toast, bench window.__mbotePow) → greps →
# tsc + lint. (Le check-merge-clean de fin de vague est exécuté MANUELLEMENT
# après commit — il exige un arbre propre ; voir docs/proofs/D2-sybil.md.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB="$ROOT/db/d2-sybil-proof.db"
PORT=3165
BASE="http://127.0.0.1:$PORT"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[d2-proof] $(date +%H:%M:%S) — $*"; }

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
  echo "serveur non prêt après 60 s"; tail -30 /tmp/d2-server.log; exit 1
}

# ── 1. sonde prérequis (bloquante) ───────────────────────────────────────────
say "1. sonde prérequis (WebCrypto itéré + Web Worker + bench PoW 20 bits ×1/×4)"
timeout 180 bun scripts/d2-prereq-probe.ts > "$ASSETS/d2-prereq-run.txt" 2>&1 || {
  tail -20 "$ASSETS/d2-prereq-run.txt"; exit 1; }

# ── 2. build production standalone (TOUJOURS — leçon É8) ─────────────────────
say "2. build standalone"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bun run build > /tmp/d2-build.log 2>&1 || { say "build ÉCHOUÉ (F-17 — jamais silencieux) : extrait de /tmp/d2-build.log"; tail -40 /tmp/d2-build.log; exit 1; }

# ── 3. migrations (leçon É10 : APRÈS le build) ───────────────────────────────
say "3. migrations"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > "$ASSETS/d2-migrate.txt" 2>&1

# ── 4. serveur prod réel ─────────────────────────────────────────────────────
say "4. serveur prod :$PORT"
DATABASE_URL="file:$DB" MBOTE_EMBED_RELAY=0 PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/d2-server.log 2>&1 &
SERVER_PID=$!
wait_ready

# ── 5. suite API (bun test) ──────────────────────────────────────────────────
say "5. tests API (PoW ×4, plafonds posts/DMs, rate-limit 3/h/IP, T0 mesh, fonctions pures)"
D2_SYBIL_DB="file:$DB" APP_URL="$BASE" DATABASE_URL="file:$DB" \
  bun test tests/d2-sybil.test.ts > "$ASSETS/d2-test-output.txt" 2>&1 || {
  tail -40 "$ASSETS/d2-test-output.txt"; exit 1; }
grep -E "pass|fail" "$ASSETS/d2-test-output.txt" | tail -3

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ── 6. serveur (run 2 — rate store frais) + preuve navigateur ────────────────
say "6. preuve navigateur (run 2 — rate store frais)"
DATABASE_URL="file:$DB" MBOTE_EMBED_RELAY=0 PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js >> /tmp/d2-server.log 2>&1 &
SERVER_PID=$!
wait_ready
D2_DB="file:$DB" DATABASE_URL="file:$DB" bun scripts/d2-browser-proof.ts "$BASE" > "$ASSETS/d2-browser-run.txt" 2>&1 || {
  tail -40 "$ASSETS/d2-browser-run.txt"; exit 1; }
grep -E "onboarded|powBench|badge|OK" "$ASSETS/d2-browser.json" | head -5 || true

# ── 7. greps finaux (invariants serveur) ─────────────────────────────────────
say "7. greps"
{
  echo "## PoW exigé à la création (route identity)"
  grep -c "pow_required\|verifyPowServer" src/app/api/identity/route.ts || true
  echo "## Anti-rejeu global (PowSpent)"
  grep -c "PowSpent" src/app/api/identity/route.ts prisma/schema.prisma || true
  echo "## Plafonds branchés aux points d'application"
  grep -c "quotaVerdict\|POSTS_LIMIT_MESSAGE\|DMS_LIMIT_MESSAGE" src/app/api/posts/route.ts src/app/api/dms/route.ts || true
  echo "## T0 préservé : le bridge mesh n'importe AUCUN module Sybil"
  grep -c "sybil" src/app/api/mesh/bridge/route.ts || echo "0 (aucune référence — attendu)"
  echo "## Bench PoW navigateur (d2-pow-bench.json)"
  cat "$ASSETS/d2-pow-bench.json" 2>/dev/null | head -10 || true
} > "$ASSETS/d2-greps.txt" 2>&1
cat "$ASSETS/d2-greps.txt"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ── 8. qualité ───────────────────────────────────────────────────────────────
say "8. tsc + lint"
bunx tsc --noEmit > /tmp/d2-tsc.log 2>&1 || { tail -20 /tmp/d2-tsc.log; exit 1; }
bun run lint > /tmp/d2-lint.log 2>&1 || { tail -20 /tmp/d2-lint.log; exit 1; }

say "OK — preuve D2 complète (assets docs/proofs/assets/d2-*)"
# Fin de vague : bash scripts/check-merge-clean.sh (après commit — arbre propre
# requis ; sortie collée dans docs/proofs/D2-sybil.md §consolidation).
