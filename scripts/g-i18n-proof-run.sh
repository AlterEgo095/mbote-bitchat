#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# g-i18n-proof-run — PREUVE G : i18n FR/EN + non-régression C1 (reload post-MLS)
# runner rejouable (DEV-SETUP §2b/§7, même squelette que f-ui-fixes-proof-run).
# ─────────────────────────────────────────────────────────────────────────────
#   bash scripts/g-i18n-proof-run.sh
#
# Étapes : gate tsc (root + panneau) → GATE i18n (parité catalogues, clés
# résolues, sentinelles d'extraction — AVANT le build, comme tsc) → build
# standalone app → migrations + seed (f-seed) → serveurs RÉELS (hub :3047 +
# app :3130 — SYBIL_BYPASS=1 : le harnais crée 4 identités > plafond D2
# 3/h/IP, le bypass ne touche QUE ce plafond, jamais PoW ni preuve ECDSA ;
# SYBIL_BYPASS_TEST=1 : marqueur runners de test, le server.js standalone
# force NODE_ENV=production) → preuve navigateur (g-i18n-proof.ts : C1 reload
# post-MLS, détection navigateur, switch FR↔EN, persistance LS+serveur,
# roaming par adoption serveur, dates Intl, pluriels CLDR, axe EN ≥ 90)
# → P4 simule tests.yml (bun test tests/ : 0 fail) → exit 0 si tout est vert.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PORT=3130
HUB_PORT=3047
EMIT_PORT=3049
APP_URL="http://127.0.0.1:$APP_PORT"
HUB_URL="http://127.0.0.1:$HUB_PORT"
ASSETS="$ROOT/docs/proofs/assets"
DB="$ROOT/db/g-i18n.db"
FDB="$ROOT/db/g-i18n-ci.db"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[g-proof] $(date +%H:%M:%S) — $*"; }

# Kill des résidus des runs précédents (un serveur fantôme tient le port et
# sert une DB périmée — leçon F : jamais de port fantôme).
kill_port() {
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then
    say "   kill résidu port $1 : pids $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}
for port in $APP_PORT $HUB_PORT $EMIT_PORT; do kill_port "$port"; done
sleep 1
for port in $APP_PORT $HUB_PORT $EMIT_PORT; do
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    say "FAIL — port $port toujours occupé après kill"
    exit 1
  fi
done

HUB_PID=""; APP_PID=""
cleanup() {
  for p in "$APP_PID" "$HUB_PID"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

# ── 1. gate tsc (app principale + panneau admin) ─────────────────────────────
say "1. tsc --noEmit (gate avant build)"
bunx tsc --noEmit > /tmp/g-tsc-main.log 2>&1 \
  || { say "FAIL — tsc app principale : erreurs de type (extrait)"; tail -40 /tmp/g-tsc-main.log; exit 1; }
(cd admin && bunx tsc --noEmit) > /tmp/g-tsc-panel.log 2>&1 \
  || { say "FAIL — tsc panneau admin : erreurs de type (extrait)"; tail -40 /tmp/g-tsc-panel.log; exit 1; }

# ── 1b. gate i18n (Clarification 2 — extraction PROUVÉE avant le build) ──────
say "1b. gate i18n (parité catalogues, clés résolues, sentinelles)"
bun scripts/g-i18n-gate.ts || { say "FAIL — gate i18n"; exit 1; }

# ── 2. build production standalone (app ; le panneau n'est pas exercé par G) ─
say "2. build standalone (app)"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  bun run build > /tmp/g-build-main.log 2>&1 \
  || { say "build app ÉCHOUÉ (jamais silencieux) : extrait"; tail -40 /tmp/g-build-main.log; exit 1; }

# ── 3. migrations + seed (User.locale créé par 0012_g_i18n_preferences) ──────
say "3. migrations + seed"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > /tmp/g-migrate.log 2>&1
DATABASE_URL="file:$DB" bun scripts/f-seed.ts > /tmp/g-seed.log 2>&1
cat /tmp/g-seed.log

# ── 4. serveurs réels ────────────────────────────────────────────────────────
say "4. serveurs (hub :$HUB_PORT · app :$APP_PORT)"
RELAY_PORT=$HUB_PORT EMIT_PORT=$EMIT_PORT RELAY_EMIT_HOST=127.0.0.1 \
  bun mini-services/relay-service/index.ts > /tmp/g-hub.log 2>&1 &
HUB_PID=$!
DATABASE_URL="file:$DB" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  RELAY_ALLOWED_ORIGIN="$APP_URL" \
  RELAY_EMIT_URL="http://127.0.0.1:$EMIT_PORT" \
  RELAY_EMIT_TOKEN="g-emit-token" \
  ADMIN_INTERNAL_TOKEN="g-proof-internal-token-0123456789abcdef" \
  BACKUP_STATUS_PATH="$ROOT/db/g-backup-status.json" \
  SYBIL_BYPASS=1 SYBIL_BYPASS_TEST=1 \
  MBOTE_EMBED_RELAY=0 PORT=$APP_PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/g-main.log 2>&1 &
APP_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "$APP_URL/api/stats" > /dev/null 2>&1 && curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf "$APP_URL/api/stats" > /dev/null || { echo "app non prête"; tail -30 /tmp/g-main.log; exit 1; }
say "   serveurs prêts"

# ── 5. preuve navigateur G ───────────────────────────────────────────────────
say "5. preuve navigateur (C1 reload + i18n + axe EN)"
timeout 420 bun scripts/g-i18n-proof.ts "$APP_URL" || {
  say "FAIL — preuve navigateur G"; exit 1; }

# ── 6. P4 — simule tests.yml : bun test tests/ : 0 fail ─────────────────────
say "6. P4 simule tests.yml (bun test tests/)"
rm -f "$FDB" "$FDB-wal" "$FDB-shm"
DATABASE_URL="file:$FDB" bun run db:push > /dev/null 2>&1
if DATABASE_URL="file:$FDB" timeout 300 bun test tests/ > "$ASSETS/G/p4-ci-sim-g.txt" 2>&1; then
  grep -E "pass|skip|fail" "$ASSETS/G/p4-ci-sim-g.txt" | tail -3
else
  tail -30 "$ASSETS/G/p4-ci-sim-g.txt"; say "FAIL — P4 la suite CI contient des fails"; exit 1
fi
if grep -qE "\(fail\)|[1-9][0-9]* fail" "$ASSETS/G/p4-ci-sim-g.txt"; then
  say "FAIL — P4 fails détectés"; exit 1
fi

say "OK — preuve G complète — assets docs/proofs/assets/G/"
