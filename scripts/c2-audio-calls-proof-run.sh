#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# c2-audio-calls-proof-run — PREUVE C2 : appels audio 1:1 de bout en bout
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b).
#
#   bash scripts/c2-audio-calls-proof-run.sh
#
# Étapes : sonde prérequis (TURN/DTLS-SRTP/fake-mic — bloquante) → build
# standalone TOUJOURS → serveurs RÉELS (hub relay :3030 + TURN harnais :3478 +
# app :3119) → suite signalisation (8 tests bun, hub in-process) → preuve
# navigateur (A appelle B → sonnerie → réponse → actif < 3 s → raccroche,
# capture fil c2-wire-capture.jsonl) → greps (log serveur sans média) →
# tsc + lint.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PORT=3119
HUB_PORT=3030
TURN_PORT=3478
APP_URL="http://127.0.0.1:$APP_PORT"
HUB_URL="http://127.0.0.1:$HUB_PORT"
ASSETS="$ROOT/docs/proofs/assets"
DB="$ROOT/db/c2-calls-proof.db"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[c2-proof] $(date +%H:%M:%S) — $*"; }

HUB_PID=""; APP_PID=""; TURN_PID=""
cleanup() {
  for p in "$APP_PID" "$HUB_PID" "$TURN_PID"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

# ── 1. sonde prérequis (bloquante) ───────────────────────────────────────────
say "1. sonde prérequis (TURN relay + DTLS-SRTP + fake mic)"
timeout 150 bun scripts/c2-prereq-probe.ts > /tmp/c2-prereq-run.txt 2>&1 || {
  tail -20 /tmp/c2-prereq-run.txt; exit 1; }

# ── 1b. tsc --noEmit — gate AVANT le build (Clarification 1, leçon F-17 : un
#      type faux — ex. TS2345 — bloquait le build, jamais silencieux) ─────────
say "1b. tsc --noEmit (gate avant build — Clarification 1)"
bunx tsc --noEmit > /tmp/c2-tsc-prebuild.log 2>&1 \
  || { say "FAIL — tsc --noEmit : erreurs de type AVANT le build (extrait)"; tail -40 /tmp/c2-tsc-prebuild.log; exit 1; }

# ── 2. build production standalone (TOUJOURS — leçon É8) ─────────────────────
say "2. build standalone"
# ⚠️ NEXT_PUBLIC_SOCKET_URL est BAKÉ dans le bundle client AU BUILD — le
# construire sans lui → le navigateur se connecte à sa propre origine (pas de
# Caddy en preuve) → hub injoignable → aucune signalisation.
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  bun run build > /tmp/c2-build.log 2>&1 || {
  say "build ÉCHOUÉ (F-17 — jamais silencieux) : extrait de /tmp/c2-build.log"; tail -40 /tmp/c2-build.log; exit 1; }

# ── 3. migrations (APRÈS le build — leçon É10) ───────────────────────────────
say "3. migrations"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > "$ASSETS/c2-migrate.txt" 2>&1

# ── 4. serveurs réels ────────────────────────────────────────────────────────
say "4. serveurs (hub :$HUB_PORT · TURN :$TURN_PORT · app :$APP_PORT)"
RELAY_PORT=$HUB_PORT RELAY_EMIT_HOST=127.0.0.1 \
  bun mini-services/relay-service/index.ts > "$ASSETS/c2-hub-log.txt" 2>&1 &
HUB_PID=$!
bun scripts/c2-turn-server.ts > /tmp/c2-turn-log.txt 2>&1 &
TURN_PID=$!

DATABASE_URL="file:$DB" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  RELAY_ALLOWED_ORIGIN="$APP_URL" \
  TURN_URLS="turn:127.0.0.1:$TURN_PORT" \
  TURN_STATIC_CREDENTIALS="c2-user:c2-pass" \
  MBOTE_EMBED_RELAY=0 PORT=$APP_PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/c2-app-log.txt 2>&1 &
APP_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null 2>&1 && curl -sf "$APP_URL/api/stats" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "$APP_URL/api/stats" > /dev/null || { echo "app non prête"; tail -30 /tmp/c2-app-log.txt; exit 1; }
say "   hub + app prêts"

# ── 5. suite signalisation (bun test — hub in-process) ───────────────────────
say "5. tests signalisation (8 scénarios, clés ECDSA réelles)"
timeout 120 bun test tests/c2-calls.test.ts > "$ASSETS/c2-test-output.txt" 2>&1 || {
  tail -30 "$ASSETS/c2-test-output.txt"; exit 1; }
grep -E "pass|fail" "$ASSETS/c2-test-output.txt" | tail -3

# ── 6. preuve navigateur (golden path A→B) ───────────────────────────────────
say "6. preuve navigateur (A appelle B → réponse → actif → raccroche)"
timeout 240 bun scripts/c2-browser-proof.ts "$APP_URL" "$HUB_URL" > "$ASSETS/c2-browser-run.txt" 2>&1 || {
  tail -40 "$ASSETS/c2-browser-run.txt"; exit 1; }
grep -E "establishMs|hubRelayMs|ok" "$ASSETS/c2-browser.json" | head -5

# ── 7. benchmark + greps finaux ──────────────────────────────────────────────
say "7. benchmarks + greps"
{
  echo "## capture fil call:* (c2-wire-capture.jsonl) — signalisation uniquement"
  wc -l < "$ASSETS/c2-wire-capture.jsonl" | xargs echo "trames call:* capturées :"
  echo "## log hub — aucun octet de média (le hub ne voit que SDP/ICE)"
  grep -cE "call-offer|call-answer|call-ice" "$ASSETS/c2-hub-log.txt" 2>/dev/null || echo "(le hub ne logge PAS les payloads — signalisation seulement, by design)"
} > "$ASSETS/c2-greps.txt" 2>&1

kill "$APP_PID" 2>/dev/null || true; APP_PID=""
kill "$HUB_PID" 2>/dev/null || true; HUB_PID=""
kill "$TURN_PID" 2>/dev/null || true; TURN_PID=""

# ── 8. qualité ───────────────────────────────────────────────────────────────
say "8. tsc + lint"
bunx tsc --noEmit > /tmp/c2-tsc.log 2>&1 || { tail -20 /tmp/c2-tsc.log; exit 1; }
bun run lint > /tmp/c2-lint.log 2>&1 || { tail -20 /tmp/c2-lint.log; exit 1; }

say "OK — preuve C2 complète (assets docs/proofs/assets/c2-*)"
