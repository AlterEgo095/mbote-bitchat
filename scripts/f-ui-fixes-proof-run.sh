#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# f-ui-fixes-proof-run — PREUVE F : corrections UI (Critiques #1 #2 #15 #39
# #47 #72 + Majeurs) — runner rejouable (DEV-SETUP §2b/§7).
# ─────────────────────────────────────────────────────────────────────────────
#   bash scripts/f-ui-fixes-proof-run.sh [avant|apres]
#
# Étapes : gate tsc (root + panneau, Clarification 1) → builds standalone
# (app + panneau) → migrations + seed (f-seed) → serveurs RÉELS (hub :3044 +
# app :3128 + panneau :3129) → preuve navigateur (f-ui-fixes-proof.ts) →
# P4 simule tests.yml (bun test tests/ : 0 fail) → exit 0 si tout est vert.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PHASE="${1:-apres}"
APP_PORT=3128
PANEL_PORT=3129
HUB_PORT=3044
EMIT_PORT=3046
APP_URL="http://127.0.0.1:$APP_PORT"
PANEL_URL="http://127.0.0.1:$PANEL_PORT"
HUB_URL="http://127.0.0.1:$HUB_PORT"
ASSETS="$ROOT/docs/proofs/assets"
DB="$ROOT/db/f-ui-fixes.db"
FDB="$ROOT/db/f-ui-fixes-ci.db"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[f-proof] $(date +%H:%M:%S) — $*"; }

# Kill des résidus des runs précédents (un serveur fantôme tient le port et
# sert une DB périmée — incident : deux identités homonymes dans les contacts).
kill_port() {
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then
    say "   kill résidu port $1 : pids $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}
for port in $APP_PORT $PANEL_PORT $HUB_PORT $EMIT_PORT; do kill_port "$port"; done
sleep 1
for port in $APP_PORT $PANEL_PORT $HUB_PORT $EMIT_PORT; do
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    say "FAIL — port $port toujours occupé après kill"
    exit 1
  fi
done

HUB_PID=""; APP_PID=""; PANEL_PID=""
cleanup() {
  for p in "$PANEL_PID" "$APP_PID" "$HUB_PID"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

# ── 1. gate tsc (Clarification 1) : app principale + panneau admin ───────────
say "1. tsc --noEmit (gate avant build — Clarification 1)"
bunx tsc --noEmit > /tmp/f-tsc-main.log 2>&1 \
  || { say "FAIL — tsc app principale : erreurs de type (extrait)"; tail -40 /tmp/f-tsc-main.log; exit 1; }
(cd admin && bunx tsc --noEmit) > /tmp/f-tsc-panel.log 2>&1 \
  || { say "FAIL — tsc panneau admin : erreurs de type (extrait)"; tail -40 /tmp/f-tsc-panel.log; exit 1; }

# ── 2. builds production standalone (TOUJOURS — leçon É8) ────────────────────
say "2. builds standalone (app + panneau)"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  bun run build > /tmp/f-build-main.log 2>&1 \
  || { say "build app ÉCHOUÉ (jamais silencieux) : extrait"; tail -40 /tmp/f-build-main.log; exit 1; }
(cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="f-proof-internal-token-0123456789abcdef" bunx next build) > /tmp/f-build-panel.log 2>&1 \
  || { say "build panneau ÉCHOUÉ (jamais silencieux) : extrait"; tail -40 /tmp/f-build-panel.log; exit 1; }
cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
mkdir -p admin/.next/standalone/public
cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true

# ── 3. migrations + seed ─────────────────────────────────────────────────────
say "3. migrations + seed"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > /tmp/f-migrate.log 2>&1
DATABASE_URL="file:$DB" bun scripts/f-seed.ts > /tmp/f-seed.log 2>&1
cat /tmp/f-seed.log

# ── 4. serveurs réels ────────────────────────────────────────────────────────
say "4. serveurs (hub :$HUB_PORT · app :$APP_PORT · panneau :$PANEL_PORT)"
RELAY_PORT=$HUB_PORT EMIT_PORT=$EMIT_PORT RELAY_EMIT_HOST=127.0.0.1 \
  bun mini-services/relay-service/index.ts > /tmp/f-hub.log 2>&1 &
HUB_PID=$!
DATABASE_URL="file:$DB" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  RELAY_ALLOWED_ORIGIN="$APP_URL" \
  RELAY_EMIT_URL="http://127.0.0.1:$EMIT_PORT" \
  RELAY_EMIT_TOKEN="f-emit-token" \
  ADMIN_INTERNAL_TOKEN="f-proof-internal-token-0123456789abcdef" \
  BACKUP_STATUS_PATH="$ROOT/db/f-backup-status.json" \
  MBOTE_EMBED_RELAY=0 PORT=$APP_PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/f-main.log 2>&1 &
APP_PID=$!
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="f-proof-internal-token-0123456789abcdef" \
    BACKEND_INTERNAL_URL="$APP_URL" PORT=$PANEL_PORT HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/f-panel.log 2>&1 ) &
PANEL_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "$APP_URL/api/stats" > /dev/null 2>&1 && curl -sf "$PANEL_URL/api/health" > /dev/null 2>&1 && curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf "$APP_URL/api/stats" > /dev/null || { echo "app non prête"; tail -30 /tmp/f-main.log; exit 1; }
curl -sf "$PANEL_URL/api/health" > /dev/null || { echo "panneau non prêt"; tail -30 /tmp/f-panel.log; exit 1; }
say "   serveurs prêts"

# ── 5. preuve navigateur (phase avant|apres) ─────────────────────────────────
say "5. preuve navigateur (phase $PHASE)"
timeout 420 bun scripts/f-ui-fixes-proof.ts "$PHASE" "$APP_URL" "$PANEL_URL" || {
  say "FAIL — preuve navigateur phase $PHASE"; exit 1; }

# ── 6. P4 — simule tests.yml : bun test tests/ : 0 fail ─────────────────────
say "6. P4 simule tests.yml (bun test tests/)"
rm -f "$FDB" "$FDB-wal" "$FDB-shm"
DATABASE_URL="file:$FDB" bun run db:push > /dev/null 2>&1
if DATABASE_URL="file:$FDB" timeout 300 bun test tests/ > "$ASSETS/F/p4-ci-sim-$PHASE.txt" 2>&1; then
  grep -E "pass|skip|fail" "$ASSETS/F/p4-ci-sim-$PHASE.txt" | tail -3
else
  tail -30 "$ASSETS/F/p4-ci-sim-$PHASE.txt"; say "FAIL — P4 la suite CI contient des fails"; exit 1
fi
if grep -qE "\(fail\)|[1-9][0-9]* fail" "$ASSETS/F/p4-ci-sim-$PHASE.txt"; then
  say "FAIL — P4 fails détectés"; exit 1
fi

say "OK — preuve F complète (phase $PHASE) — assets docs/proofs/assets/F/"
