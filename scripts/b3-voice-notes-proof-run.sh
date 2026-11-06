#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# b3-voice-notes-proof-run — preuves E2E de B3 (voice notes Opus web)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b/§2c).
#
#   bash scripts/b3-voice-notes-proof-run.sh
#
# Étapes : 0. PRÉREQUIS BLOQUANT (directive) — ffmpeg 6/8/12 kbps (WAV 30 s →
# tailles + durées décodées) + navigateur Chromium réel (playwright-core, fake
# device) : MediaRecorder webm;opus → 5 s → decodeAudioData + 100 peaks. Sortie
# non-zero = B3 ne démarre pas. → weed 3.80 (S3 RÉEL indépendant, même arbitrage
# B2) → build standalone (si absent) → DB preuve → app :3103 (proxy média) →
# harnais tests/media-b3-voice.test.ts (S1-S5, V5 unitaires + V1-V4 E2E : chaîne
# complète, audio/mpeg 400, 11 Mo 400, round-trip DEUX appareils dm2 E2EE avec
# durée+peaks chiffrés) → benchmark 6/8/12 kbps → navigateur : identité A →
# conversation B → HOLD-TO-RECORD 4 s (MediaRecorder réel) → preview → envoi →
# bulle waveform → play → tap-toggle (captures) → preuve DB → nettoyage.
# Sorties : docs/proofs/assets/b3-voice-*.{png,txt} + journal sur stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP=3103
S3_PORT=9100
S3_DIR="$(mktemp -d /tmp/b3-voice.XXXXXX)"
S3_JSON="$S3_DIR/s3.json"
DB="$ROOT/db/b3-voice-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
ACCESS_KEY="b3-voice-proof"
SECRET_KEY="b3-voice-proof-secret-0123456789abcdef"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[b3-voice] $*"; }
assert_contains() {
  if grep -q "$2" "$1"; then say "PASS — $3"; else say "FAIL — $3 (aiguille '$2' absente de $1)"; exit 1; fi
}
kill_port() {
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then say "   kill résidu port $1 : pids $pids"; kill -9 $pids 2>/dev/null || true; fi
}
kill_port $APP
kill_port $S3_PORT
sleep 1

# ── 0. PRÉREQUIS BLOQUANT — preuve Opus (ffmpeg + navigateur) ───────────────
say "0. PRÉREQUIS BLOQUANT — preuve Opus encode/decode (directive B3)"
bun scripts/b3-opus-prereq.ts 2>&1 | tee "$ASSETS/b3-opus-prereq.txt"
assert_contains "$ASSETS/b3-opus-prereq.txt" "PRÉREQUIS OPUS PROUVÉ" "prérequis Opus : ffmpeg 6/8/12 + navigateur (MediaRecorder webm;opus réel)"

WEED_BIN="${WEED_BIN:-$HOME/bin/weed}"
if [ ! -x "$WEED_BIN" ]; then
  say "0b. téléchargement weed 3.80 (binaire épinglé, sha256 vérifié)"
  mkdir -p "$HOME/bin"
  curl -sL https://github.com/seaweedfs/seaweedfs/releases/download/3.80/linux_amd64.tar.gz -o /tmp/weed.tar.gz
  echo "b8eec95b1c022ce02e04b9b33172eada1d545b015cefd0279043a2ffde7ed76f  /tmp/weed.tar.gz" | sha256sum -c - || { say "FAIL — sha256 weed"; exit 1; }
  tar -xzf /tmp/weed.tar.gz -C "$HOME/bin" weed
fi
say "0b. weed présent : $WEED_BIN ($($WEED_BIN version))"

# ── 1. weed ANONYME → création bucket → credentials → AUTHENTIFIÉ ───────────
wait_s3_up() { # le S3 répond-il (N'IMPORTE quel code HTTP — connexion active) ?
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$S3_PORT/" || true)
    [ "$code" != "000" ] && return 0
    sleep 1
  done
  say "FAIL — S3 :$S3_PORT jamais joignable"; tail -5 "$S3_DIR/weed.log" || true; exit 1
}
say "1. S3 réel (weed) — phase anonyme : création du bucket"
( cd "$S3_DIR" && exec env WEED_LOG="$S3_DIR/weed.log" "$WEED_BIN" server \
    -dir="$S3_DIR" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
    -master.volumeSizeLimitMB=64 -master.electionTimeout=1s \
    -volume.max=0 -s3 -s3.port=$S3_PORT > "$S3_DIR/weed.log" 2>&1 ) &
WEED_PID=$!
wait_s3_up
HTTP_CREATE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$S3_PORT/mbote-media-test")
[ "$HTTP_CREATE" = "200" ] || { say "FAIL — création bucket anonyme : $HTTP_CREATE"; exit 1; }
say "   bucket mbote-media-test créé (HTTP 200, phase anonyme)"

# ── 1b. restart AUTHENTIFIÉ (l'anonyme doit devenir 403) ────────────────────
say "1b. injection credentials + restart authentifié"
kill -9 "$WEED_PID" 2>/dev/null || true; wait "$WEED_PID" 2>/dev/null || true
pkill -9 -f "weed server -dir=$S3_DIR" 2>/dev/null || true
sleep 1
cat > "$S3_JSON" << EOF
{
  "identities": [
    {
      "name": "$ACCESS_KEY",
      "credentials": [{ "accessKey": "$ACCESS_KEY", "secretKey": "$SECRET_KEY" }],
      "actions": ["Admin", "Read", "Write", "List"]
    }
  ]
}
EOF
( cd "$S3_DIR" && exec env WEED_LOG="$S3_DIR/weed-auth.log" "$WEED_BIN" server \
    -dir="$S3_DIR" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
    -master.volumeSizeLimitMB=64 -master.electionTimeout=1s \
    -volume.max=0 -s3 -s3.port=$S3_PORT -s3.config="$S3_JSON" > "$S3_DIR/weed-auth.log" 2>&1 ) &
WEED_PID=$!
wait_s3_up
ANON_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$S3_PORT/mbote-media-test/media/00000000-0000-4000-8000-000000000001")
[ "$ANON_CODE" = "403" ] || { say "FAIL — requête ANONYME attendue 403, obtenue $ANON_CODE (auth S3 inactive ?)"; exit 1; }
say "PASS — requête anonyme → 403 (l'authentification S3 est RÉELLE)"
# ── 2. build app standalone (si absent) ─────────────────────────────────────
if [ ! -f .next/standalone/server.js ]; then
  say "2. build standalone app…"
  NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/b3-voice-build.log 2>&1
else
  say "2. build standalone déjà présent"
fi
if [ ! -d .next/standalone/.next/static ]; then
  cp -r .next/static .next/standalone/.next/
  mkdir -p .next/standalone/public
  cp -r public/. .next/standalone/public/
  say "   assets client copiés dans standalone (static + public)"
fi

# ── 3. DB preuve + démarrage app :3103 ──────────────────────────────────────
say "3. DB preuve + app standalone :$APP (MEDIA_S3_* → weed :$S3_PORT)"
DATABASE_URL="file:$DB" bunx prisma db push --skip-generate > /tmp/b3-voice-dbpush.log 2>&1
DATABASE_URL="file:$DB" \
MEDIA_STORAGE_DRIVER=minio \
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
MEDIA_S3_REGION=us-east-1 \
MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID="$ACCESS_KEY" \
MEDIA_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
MBOTE_EMBED_RELAY=0 PORT=$APP HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/b3-voice-app.log 2>&1 &
APP_PID=$!
trap 'kill -9 $APP_PID $WEED_PID 2>/dev/null || true; pkill -9 -f "weed server -dir=$S3_DIR" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$APP/api/stats" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$APP/api/stats" || { say "FAIL — app non prête"; exit 1; }
say "   app prête sur :$APP"

# ── 4. harnais E2E B3 (S1-S5 + V1-V5) ───────────────────────────────────────
say "4. harnais media-b3-voice (MEDIA_B3_E2E=1)"
MEDIA_B3_E2E=1 BASE_URL="http://127.0.0.1:$APP" \
DATABASE_URL="file:$DB" \
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" MEDIA_S3_REGION=us-east-1 MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID="$ACCESS_KEY" MEDIA_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
  bun test tests/media-b3-voice.test.ts 2>&1 | tee "$ASSETS/b3-voice-test-output.txt"
assert_contains "$ASSETS/b3-voice-test-output.txt" "0 fail" "harnais B3 : 0 fail"

# ── 5. benchmark 6 / 8 / 12 kbps ────────────────────────────────────────────
say "5. benchmark (6/8/12 kbps — chaîne complète par bitrate)"
MEDIA_B3_E2E=1 BASE_URL="http://127.0.0.1:$APP" \
  bun scripts/b3-voice-bench.ts 2>&1 | tee "$ASSETS/b3-voice-bench.txt"
assert_contains "$ASSETS/b3-voice-bench.txt" "TOTAL" "benchmark : colonnes complètes"

# ── 6. navigateur — flux complet (identité A → B, HOLD-TO-RECORD réel) ──────
say "6. navigateur — hold-to-record → preview → envoi → bulle waveform → play"
bun scripts/b3-browser-proof.ts "http://127.0.0.1:$APP" 2>&1 | tee "$ASSETS/b3-voice-browser.log"
assert_contains "$ASSETS/b3-voice-browser.log" "TOUTES LES ÉTAPES PASSÉES" "navigateur : toutes les étapes (record/preview/send/bubble/play/tap)"

# ── 7. preuve DB + objet dans le bucket ─────────────────────────────────────
say "7. preuves DB (Media finalized audio/opus)"
DATABASE_URL="file:$DB" bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: [] });
const voice = await db.media.count({ where: { status: 'finalized', mediaType: 'audio/opus' } });
const images = await db.media.count({ where: { status: 'finalized', mediaType: { startsWith: 'image/' } } });
const last = await db.media.findFirst({ where: { mediaType: 'audio/opus', status: 'finalized' }, orderBy: { finalizedAt: 'desc' } });
console.log('Media audio/opus finalized:', voice, '| images:', images, '| dernier:', last?.objectKey, last?.sizeBytes, 'o');
await db.\$disconnect();
" > "$ASSETS/b3-voice-db.txt" 2>&1
assert_contains "$ASSETS/b3-voice-db.txt" "audio/opus finalized:" "DB : lignes Media audio/opus présentes"

say "═══════════════════════════════════════════════════════════"
say "TOUTES LES PREUVES B3 SONT PASSÉES — runner exit 0"
say "═══════════════════════════════════════════════════════════"
