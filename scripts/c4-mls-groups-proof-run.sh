#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# c4-mls-groups-proof-run — PREUVE C4 : groupes privés MLS de bout en bout
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b).
#
#   bash scripts/c4-mls-groups-proof-run.sh
#
# Étapes : build standalone TOUJOURS → serveurs RÉELS (hub :3033 + emit :3035 +
# app :3122 — ports dédiés, leçon C3 : le dev principal occupe :3030/:3031) →
# migrations → suite adversariale SYSTÈME W1-W7 (3 clients MLS réels vs le
# serveur réel : forward secrecy, epoch rotation, replay, collusion, invariants
# serveur, single-use) → preuve navigateur (3 identités réelles via l'UI
# GroupsView) → greps (ciphertext opaque en DB) → benchmarks → tsc + lint.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PORT=3122
HUB_PORT=3033
EMIT_PORT=3035
APP_URL="http://127.0.0.1:$APP_PORT"
HUB_URL="http://127.0.0.1:$HUB_PORT"
ASSETS="$ROOT/docs/proofs/assets"
DB="$ROOT/db/c4-mls-proof.db"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[c4-proof] $(date +%H:%M:%S) — $*"; }

HUB_PID=""; APP_PID=""
cleanup() {
  for p in "$APP_PID" "$HUB_PID"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

# ── 1. build production standalone (TOUJOURS — leçon É8) ─────────────────────
say "1. build standalone"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  bun run build > /tmp/c4-build.log 2>&1

# ── 2. migrations (APRÈS le build — leçon É10) ───────────────────────────────
say "2. migrations"
rm -f "$DB" "$DB-wal" "$DB-shm"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > "$ASSETS/c4-migrate.txt" 2>&1

# ── 3. serveurs réels ────────────────────────────────────────────────────────
say "3. serveurs (hub :$HUB_PORT · emit :$EMIT_PORT · app :$APP_PORT)"
RELAY_PORT=$HUB_PORT EMIT_PORT=$EMIT_PORT RELAY_EMIT_HOST=127.0.0.1 \
  bun mini-services/relay-service/index.ts > "$ASSETS/c4-hub-log.txt" 2>&1 &
HUB_PID=$!
DATABASE_URL="file:$DB" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SOCKET_URL="$HUB_URL" \
  RELAY_ALLOWED_ORIGIN="$APP_URL" \
  RELAY_EMIT_URL="http://127.0.0.1:$EMIT_PORT" \
  RELAY_EMIT_TOKEN="c4-emit-token" \
  MBOTE_EMBED_RELAY=0 PORT=$APP_PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/c4-app-log.txt 2>&1 &
APP_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null 2>&1 && curl -sf "$APP_URL/api/stats" > /dev/null 2>&1; then break; fi
  sleep 1
done
kill -0 "$HUB_PID" 2>/dev/null || { echo "hub MORT"; tail -20 "$ASSETS/c4-hub-log.txt"; exit 1; }
curl -sf "$HUB_URL/?EIO=4&transport=polling" > /dev/null || { echo "hub non joignable"; tail -20 "$ASSETS/c4-hub-log.txt"; exit 1; }
curl -sf "$APP_URL/api/stats" > /dev/null || { echo "app non prête"; tail -30 /tmp/c4-app-log.txt; exit 1; }
say "   hub (vivant) + app prêts"

# ── 4. suite adversariale système (3 clients MLS réels) ──────────────────────
say "4. tests adversariaux système W1-W7 (3 clients MLS réels vs serveur réel)"
APP_URL="$APP_URL" timeout 180 bun test tests/c4-groups.test.ts > "$ASSETS/c4-test-output.txt" 2>&1 || {
  tail -40 "$ASSETS/c4-test-output.txt"; exit 1; }
grep -E "pass|fail" "$ASSETS/c4-test-output.txt" | tail -2
grep -E "\[BENCH\]" "$ASSETS/c4-test-output.txt" | tee "$ASSETS/c4-bench.txt"

# ── 5. preuve navigateur (3 identités réelles via l'UI) ──────────────────────
say "5. preuve navigateur (création groupe 3 membres, messages, retrait, forward secrecy)"
timeout 420 bun scripts/c4-browser-proof.ts "$APP_URL" "$HUB_URL" > "$ASSETS/c4-browser-run.txt" 2>&1 || {
  tail -40 "$ASSETS/c4-browser-run.txt"; exit 1; }
grep -E "createMs|sendMs|ok" "$ASSETS/c4-browser.json" | head -5

# ── 6. greps : invariant ciphertext opaque EN BASE ───────────────────────────
say "6. greps (ciphertext opaque en DB + aucun plaintext)"
{
  echo "## messages de groupe en base — invariant ciphertext opaque"
  DATABASE_URL="file:$DB" bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const msgs = await db.groupMessage.findMany({ select: { ciphertext: true } });
console.log('messages stockés :', msgs.length);
const leaks = msgs.filter((m) => {
  const raw = Buffer.from(m.ciphertext, 'base64').toString('latin1');
  return /M1-secret|M2-after-removal|M3-collusion|SECRET-OPAQUE|Bonjour/.test(raw);
});
console.log('fuites plaintext :', leaks.length, '(attendu 0 — MLS est E2EE)');
process.exit(leaks.length === 0 ? 0 : 1);
"
  echo "## enveloppes de handshake stockées :"
  DATABASE_URL="file:$DB" bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const env = await db.groupEnvelope.findMany({ select: { kind: true } });
console.log('commits+welcomes :', env.length);
"
} > "$ASSETS/c4-greps.txt" 2>&1
grep -E "fuites|messages stockés" "$ASSETS/c4-greps.txt" || { cat "$ASSETS/c4-greps.txt"; exit 1; }

kill "$APP_PID" 2>/dev/null || true; APP_PID=""
kill "$HUB_PID" 2>/dev/null || true; HUB_PID=""

# ── 7. qualité ───────────────────────────────────────────────────────────────
say "7. tsc + lint"
bunx tsc --noEmit > /tmp/c4-tsc.log 2>&1 || { tail -20 /tmp/c4-tsc.log; exit 1; }
bun run lint > /tmp/c4-lint.log 2>&1 || { tail -20 /tmp/c4-lint.log; exit 1; }

say "OK — preuve C4 complète (assets docs/proofs/assets/c4-*)"
