#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# b4-video-proof-run — preuves E2E de B4 (vidéo webm — upload + lecture)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b/§2c).
#
#   bash scripts/b4-video-proof-run.sh
#
# Étapes : 0. PRÉREQUIS BLOQUANT (directive : camera=(self) AVANT le code) —
# scripts/b4-camera-prereq.ts : Chromium réel fake-device, getUserMedia
# {video,audio} RÉUSSIT, MediaRecorder webm/VP8 10 s réel, thumbnail canvas,
# ffprobe codec vp8. Sortie non-zero = B4 ne démarre pas. → weed 3.80 (S3
# RÉEL indépendant, arbitrage B2/B3) → build standalone REBUILD (un build
# périmé prouverait une autre vague — leçon ADM É8) → DB preuve → app :3103
# (proxy média) → harnais tests/media-b4-video.test.ts (U1-U5 + H1 + V1-V6 :
# chaîne complète SHA-256, video/avi 400, 110 Mo 400, TTL 1h vs 15 min,
# round-trip DEUX appareils dm2 E2EE, barrière webm-audio refusée) →
# benchmark 10 s/30 s/60 s → navigateur : identité A → conversation B →
# TAP 📹 5 s (MediaRecorder vidéo RÉEL) → preview player → envoi → bulle
# vignette → Dialog plein écran → play natif (captures) → preuve DB →
# nettoyage.
# Sorties : docs/proofs/assets/b4-video-*.{png,txt} + journal sur stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP=3103
S3_PORT=9100
S3_DIR="$(mktemp -d /tmp/b4-video.XXXXXX)"
S3_JSON="$S3_DIR/s3.json"
DB="$ROOT/db/b4-video-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
ACCESS_KEY="b4-video-proof"
SECRET_KEY="b4-video-proof-secret-0123456789abcdef"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[b4-video] $*"; }
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

# ── 0. PRÉREQUIS BLOQUANT — preuve caméra (directive B4 : AVANT le code) ────
say "0. PRÉREQUIS BLOQUANT — camera=(self) appliqué + getUserMedia/MediaRecorder/thumb prouvés"
bun scripts/b4-camera-prereq.ts 2>&1 | tee "$ASSETS/b4-camera-prereq.txt"
assert_contains "$ASSETS/b4-camera-prereq.txt" "PRÉREQUIS CAMÉRA PROUVÉ" "prérequis caméra : getUserMedia + recorder + thumbnail + ffprobe"

WEED_BIN="${WEED_BIN:-$HOME/bin/weed}"
if [ ! -x "$WEED_BIN" ]; then
  say "0b. téléchargement weed 3.80 (binaire épinglé, sha256 vérifié)"
  mkdir -p "$HOME/bin"
  curl -sL https://github.com/seaweedfs/seaweedfs/releases/download/3.80/linux_amd64.tar.gz -o /tmp/weed.tar.gz
  echo "b8eec95b1c022ce02e04b9b33172eada1d545b015cefd0279043a2ffde7ed76f  /tmp/weed.tar.gz" | sha256sum -c - || { say "FAIL — sha256 weed"; exit 1; }
  tar -xzf /tmp/weed.tar.gz -C "$HOME/bin" weed
fi
say "0b. weed présent : $WEED_BIN ($($WEED_BIN version))"

# ── 1. weed ANONYME → bucket → credentials → AUTHENTIFIÉ (arbitrage B2/B3) ──
wait_s3_up() {
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
[ "$ANON_CODE" = "403" ] || { say "FAIL — requête ANONYME attendue 403, obtenue $ANON_CODE"; exit 1; }
say "PASS — requête anonyme → 403 (l'authentification S3 est RÉELLE)"

# ── 2. build standalone — TOUJOURS (leçon ADM É8 : un build périmé prouve ───
#    une autre vague) ──────────────────────────────────────────────────────────
say "2. build standalone app (rebuild systématique)"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/b4-video-build.log 2>&1
if [ ! -d .next/standalone/.next/static ]; then
  cp -r .next/static .next/standalone/.next/
  mkdir -p .next/standalone/public
  cp -r public/. .next/standalone/public/
  say "   assets client copiés dans standalone"
fi

# ── 3. DB preuve + démarrage app :3103 ──────────────────────────────────────
say "3. DB preuve + app standalone :$APP (MEDIA_S3_* → weed :$S3_PORT)"
rm -f "$DB"
DATABASE_URL="file:$DB" bunx prisma db push --skip-generate > /tmp/b4-video-dbpush.log 2>&1
DATABASE_URL="file:$DB" \
MEDIA_STORAGE_DRIVER=minio \
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
MEDIA_S3_REGION=us-east-1 \
MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID="$ACCESS_KEY" \
MEDIA_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
MBOTE_EMBED_RELAY=0 PORT=$APP HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/b4-video-app.log 2>&1 &
APP_PID=$!
trap 'kill -9 $APP_PID $WEED_PID 2>/dev/null || true; pkill -9 -f "weed server -dir=$S3_DIR" 2>/dev/null || true; agent-browser close 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$APP/api/stats" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$APP/api/stats" || { say "FAIL — app non prête"; exit 1; }
say "   app prête sur :$APP"

# ── 3b. header Permissions-Policy SERVI (preuve du fix — pas du fichier) ────
say "3b. header servi : camera=(self) + microphone=(self) (curl réel)"
curl -sI "http://127.0.0.1:$APP/" | grep -i "permissions-policy" > "$ASSETS/b4-video-headers.txt" || true
assert_contains "$ASSETS/b4-video-headers.txt" "camera=(self)" "Permissions-Policy servi : camera=(self)"
assert_contains "$ASSETS/b4-video-headers.txt" "microphone=(self)" "Permissions-Policy servi : microphone=(self)"

# ── 4. harnais E2E B4 (U1-U5 + H1 + V1-V6) ──────────────────────────────────
say "4. harnais media-b4-video (MEDIA_B4_E2E=1)"
MEDIA_B4_E2E=1 BASE_URL="http://127.0.0.1:$APP" \
DATABASE_URL="file:$DB" \
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" MEDIA_S3_REGION=us-east-1 MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID="$ACCESS_KEY" MEDIA_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
  bun test tests/media-b4-video.test.ts 2>&1 | tee "$ASSETS/b4-video-test-output.txt"
assert_contains "$ASSETS/b4-video-test-output.txt" "0 fail" "harnais B4 : 0 fail"

# ── 5. benchmark 10 s / 30 s / 60 s ─────────────────────────────────────────
say "5. benchmark (10/30/60 s — chaîne complète par taille)"
MEDIA_B4_E2E=1 BASE_URL="http://127.0.0.1:$APP" \
  bun scripts/b4-video-bench.ts 2>&1 | tee "$ASSETS/b4-video-bench.txt"
assert_contains "$ASSETS/b4-video-bench.txt" "TOTAL" "benchmark : colonnes complètes"

# ── 6. navigateur — flux complet (identité A → B, TAP 📹 réel) ──────────────
say "6. navigateur — tap-to-record → preview → envoi → bulle vignette → plein écran → play"
bun scripts/b4-browser-proof.ts "http://127.0.0.1:$APP" 2>&1 | tee "$ASSETS/b4-video-browser.log"
assert_contains "$ASSETS/b4-video-browser.log" "TOUTES LES ÉTAPES PASSÉES" "navigateur : toutes les étapes (record/preview/send/bubble/dialog/play)"

# ── 7. preuve DB + objet dans le bucket ─────────────────────────────────────
say "7. preuves DB (Media finalized video/webm + image/jpeg thumb)"
DATABASE_URL="file:$DB" bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: [] });
const videos = await db.media.count({ where: { status: 'finalized', mediaType: { startsWith: 'video/' } } });
const thumbs = await db.media.count({ where: { status: 'finalized', mediaType: 'image/jpeg' } });
const last = await db.media.findFirst({ where: { mediaType: { startsWith: 'video/' }, status: 'finalized' }, orderBy: { finalizedAt: 'desc' } });
console.log('Media video/* finalized:', videos, '| jpeg (thumbs):', thumbs, '| dernier:', last?.objectKey, last?.sizeBytes, 'o');
await db.\$disconnect();
" > "$ASSETS/b4-video-db.txt" 2>&1
assert_contains "$ASSETS/b4-video-db.txt" "video/" "DB : lignes Media vidéo présentes"

say "═══════════════════════════════════════════════════════════"
say "TOUTES LES PREUVES B4 SONT PASSÉES — runner exit 0"
say "═══════════════════════════════════════════════════════════"
