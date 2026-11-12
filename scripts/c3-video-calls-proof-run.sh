#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# c3-video-calls-proof-run — PREUVE C3 : appels vidéo 1:1 de bout en bout
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b).
#
#   bash scripts/c3-video-calls-proof-run.sh
#
# Étapes : sonde prérequis (caméra fake 640×480@24 + contrôles encodeur +
# m=video — bloquante) → build standalone TOUJOURS → serveurs RÉELS (hub
# relay :3030 + TURN harnais :3478 + app :3121) → suite signalisation vidéo
# (7 tests bun, hub in-process) + non-régression C2 (8 tests) → preuve
# navigateur (vidéo E2E : vidéos décodées, mute caméra + indicateur distant,
# flip, dégradation simulée → setParameters, knock vidéo, fallback caméra
# refusée, capture fil c3-wire-capture.jsonl) → greps → tsc + lint.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PORT=3121
# ⚠️ 3033 ≠ 3030 : le dev server du repo principal (embarquant son relay via
# instrumentation) occupe TOUJOURS 3030 en sandbox — le hub de preuve échouait
# à se binder (« Failed to start server. Is port 3030 in use? ») et les
# navigateurs rejoignaient le hub du DEV (autre DB, autre origine) — E3 ne
# recevait JAMAIS l'offre. Port dédié = rejetable n'importe quand.
HUB_PORT=3033
TURN_PORT=3478
APP_URL="http://127.0.0.1:$APP_PORT"
HUB_URL="http://127.0.0.1:$HUB_PORT"
ASSETS="$ROOT/docs/proofs/assets"
DB="$ROOT/db/c3-video-proof.db"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[c3-proof] $(date +%H:%M:%S) — $*"; }

HUB_PID=""; APP_PID=""; TURN_PID=""
cleanup() {
  for p in "$APP_PID" "$HUB_PID" "$TURN_PID"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

# ── 1. sonde prérequis (bloquante) ───────────────────────────────────────────
say "1. sonde prérequis (caméra fake 640×480@24 + encodeur + m=video)"
timeout 150 bun scripts/c3-prereq-probe.ts > /tmp/c3-prereq-run.txt 2>&1 || {
  tail -20 /tmp/c3-prereq-run.txt; exit 1; }

# ── 2. build production standalone (TOUJOURS — leçon É8) ─────────────────────
say "2. build standalone"
# ⚠️ NEXT_PUBLIC_SOCKET_URL est BAKÉ dans le bundle client AU BUILD (leçon C2)
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  bun run build > /tmp/c3-build.log 2>&1

# ── 3. migrations (APRÈS le build — leçon É10) ───────────────────────────────
say "3. migrations"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > "$ASSETS/c3-migrate.txt" 2>&1

# ── 4. serveurs réels ────────────────────────────────────────────────────────
say "4. serveurs (hub :$HUB_PORT · TURN :$TURN_PORT · app :$APP_PORT)"
# ⚠️ EMIT_PORT=3035 ≠ 3031 : même leçon que HUB_PORT — 3031 est occupé par le
# dev server principal ; sans override le hub de preuve bindait :3033 puis
# CRASHAIT sur :3031 (process mort → aucune signalisation relayée).
RELAY_PORT=$HUB_PORT EMIT_PORT=3035 RELAY_EMIT_HOST=127.0.0.1 \
  bun mini-services/relay-service/index.ts > "$ASSETS/c3-hub-log.txt" 2>&1 &
HUB_PID=$!
bun scripts/c2-turn-server.ts > /tmp/c3-turn-log.txt 2>&1 &
TURN_PID=$!

DATABASE_URL="file:$DB" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  RELAY_ALLOWED_ORIGIN="$APP_URL" \
  TURN_URLS="turn:127.0.0.1:$TURN_PORT" \
  TURN_STATIC_CREDENTIALS="c2-user:c2-pass" \
  MBOTE_EMBED_RELAY=0 PORT=$APP_PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/c3-app-log.txt 2>&1 &
APP_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null 2>&1 && curl -sf "$APP_URL/api/stats" > /dev/null 2>&1; then break; fi
  sleep 1
done
# garde-fous DURS : le process hub doit être VIVANT et répondre (leçon E3 :
# la boucle ci-dessus s'épuise en silence — un hub mort passait inaperçu car
# seul le check app était vérifié après la boucle)
kill -0 "$HUB_PID" 2>/dev/null || { echo "hub MORT — voir $ASSETS/c3-hub-log.txt"; tail -20 "$ASSETS/c3-hub-log.txt"; exit 1; }
curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null || { echo "hub non joignable :$HUB_PORT"; tail -20 "$ASSETS/c3-hub-log.txt"; exit 1; }
curl -sf "$APP_URL/api/stats" > /dev/null || { echo "app non prête"; tail -30 /tmp/c3-app-log.txt; exit 1; }
say "   hub (vivant) + app prêts"

# ── 5. suites harnais (bun test — hub in-process) ────────────────────────────
say "5a. tests signalisation vidéo C3 (7 scénarios, clés ECDSA réelles)"
timeout 120 bun test tests/c3-video-calls.test.ts > "$ASSETS/c3-test-output.txt" 2>&1 || {
  tail -30 "$ASSETS/c3-test-output.txt"; exit 1; }
grep -E "pass|fail" "$ASSETS/c3-test-output.txt" | tail -2

say "5b. non-régression C2 (8 scénarios)"
timeout 120 bun test tests/c2-calls.test.ts > "$ASSETS/c3-c2-regression.txt" 2>&1 || {
  tail -30 "$ASSETS/c3-c2-regression.txt"; exit 1; }
grep -E "pass|fail" "$ASSETS/c3-c2-regression.txt" | tail -2

# ── 6. preuve navigateur (vidéo E2E) ─────────────────────────────────────────
say "6. preuve navigateur (vidéo A→B + mute caméra + flip + dégradation + fallback)"
timeout 360 bun scripts/c3-browser-proof.ts "$APP_URL" "$HUB_URL" > "$ASSETS/c3-browser-run.txt" 2>&1 || {
  tail -40 "$ASSETS/c3-browser-run.txt"; exit 1; }
grep -E "establishMs|hubRelayMs|offerSdpHasVideo|ok" "$ASSETS/c3-browser.json" | head -6

# ── 7. benchmark + greps finaux ──────────────────────────────────────────────
say "7. benchmarks + greps"
{
  echo "## capture fil call:* (c3-wire-capture.jsonl) — signalisation uniquement"
  wc -l < "$ASSETS/c3-wire-capture.jsonl" | xargs echo "trames call:* capturées :"
  echo "## offre vidéo sur le fil (m=video dans call:offer) :"
  grep -c '"sdpHasVideo":true' "$ASSETS/c3-wire-capture.jsonl" || true
  echo "## événements call:media traversés :"
  grep -c '"call-media"\|"call:media"' "$ASSETS/c3-wire-capture.jsonl" || true
  echo "## log hub — le hub ne logge PAS les payloads (signalisation only, by design)"
  grep -cE "call-offer|call-answer|call-ice|call-media" "$ASSETS/c3-hub-log.txt" 2>/dev/null || true
} > "$ASSETS/c3-greps.txt" 2>&1

kill "$APP_PID" 2>/dev/null || true; APP_PID=""
kill "$HUB_PID" 2>/dev/null || true; HUB_PID=""
kill "$TURN_PID" 2>/dev/null || true; TURN_PID=""

# ── 8. qualité ───────────────────────────────────────────────────────────────
say "8. tsc + lint"
bunx tsc --noEmit > /tmp/c3-tsc.log 2>&1 || { tail -20 /tmp/c3-tsc.log; exit 1; }
bun run lint > /tmp/c3-lint.log 2>&1 || { tail -20 /tmp/c3-lint.log; exit 1; }

say "OK — preuve C3 complète (assets docs/proofs/assets/c3-*)"
