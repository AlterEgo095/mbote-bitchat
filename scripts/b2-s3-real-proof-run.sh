#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# b2-s3-real-proof-run — SigV4 B1 contre un S3 RÉEL indépendant (prérequis B2)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une commande, un seul tour d'outils.
#
#   bash scripts/b2-s3-real-proof-run.sh
#
# Pourquoi SeaweedFS et pas MinIO (arbitrage B2 §1, tranché 2026-11-06) :
#   - docker ABSENT du sandbox (deploy/docker-compose.minio.yml injouable ici,
#     reste la voie de rejeu VPS/dev local) ;
#   - dl.min.io bloqué (HTTP 410 sur tous les chemins) et AUCUN binaire MinIO
#     publié sur GitHub releases → MinIO indisponible en sandbox ;
#   - R2/B2 réel : credentials opérateur indisponibles ;
#   - s3rver ÉCARTÉ après lecture de son code : « Signature version 4
#     calculation is unimplemented » (lib/middleware/authentication.js) — il
#     n'aurait PAS validé nos signatures ;
#   - SeaweedFS 3.80 : serveur S3 indépendant, validation SigV4 COMPLÈTE
#     (weed/s3api/auth_signature_v4.go — signature re-calculée, expiration
#     appliquée GET et PUT). Binaire épinglé + sha256 ci-dessous.
#
# Étapes : weed (download épinglé si absent) → démarrage ANONYME → création
# bucket → injection credentials (-s3.config) → restart authentifié (l'anonyme
# doit être refusé 403) → bun test tests/media-real-s3.test.ts (G1–G6 dont
# expiration 61 s) → captures dans docs/proofs/assets/b2-s3-real-*.txt.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WEED_VERSION="3.80"
WEED_TARBALL_SHA256="b8eec95b1c022ce02e04b9b33172eada1d545b015cefd0279043a2ffde7ed76f"
WEED_URL="https://github.com/seaweedfs/seaweedfs/releases/download/${WEED_VERSION}/linux_amd64.tar.gz"
WEED_BIN="${WEED_BIN:-$HOME/bin/weed}"
S3_PORT=9100
S3_DIR="$(mktemp -d /tmp/b2-s3-real.XXXXXX)"
S3_JSON="$S3_DIR/s3.json"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ASSETS" "$HOME/bin"

say() { echo "[b2-s3-real] $*"; }

cleanup() {
  [ -n "${WEED_PID:-}" ] && kill -9 "$WEED_PID" 2>/dev/null || true
  pkill -9 -f "weed server -dir=$S3_DIR" 2>/dev/null || true
  rm -rf "$S3_DIR"
}
trap cleanup EXIT

# ── 0. binaire épinglé ───────────────────────────────────────────────────────
if [ ! -x "$WEED_BIN" ]; then
  say "0. téléchargement SeaweedFS ${WEED_VERSION} (épinglé + sha256 vérifié)"
  curl -sL -o /tmp/seaweed.tar.gz "$WEED_URL"
  echo "$WEED_TARBALL_SHA256  /tmp/seaweed.tar.gz" | sha256sum -c - >/dev/null
  tar xzf /tmp/seaweed.tar.gz -C /tmp weed
  mv /tmp/weed "$WEED_BIN"
  rm -f /tmp/seaweed.tar.gz
else
  say "0. binaire weed présent : $WEED_BIN ($($WEED_BIN version))"
fi

wait_s3() { # $1... = codes HTTP acceptés (serveur prêt)
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$S3_PORT/mbote-media-test/" 2>/dev/null || true)
    for want in "$@"; do [ "$code" = "$want" ] && return 0; done
    sleep 1
  done
  say "FAIL — S3 :$S3_PORT jamais en état attendu ($*)"; tail -5 "$S3_DIR/weed.log" || true; exit 1
}

# ── 1. démarrage ANONYME + création du bucket ────────────────────────────────
say "1. weed anonyme (création bucket) → $S3_DIR"
( cd "$S3_DIR" && exec env WEED_LOG="$S3_DIR/weed.log" "$WEED_BIN" server \
    -dir="$S3_DIR" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
    -master.volumeSizeLimitMB=64 -master.electionTimeout=1s \
    -volume.max=0 -s3 -s3.port=$S3_PORT > "$S3_DIR/weed.log" 2>&1 ) &
WEED_PID=$!
wait_s3 404  # serveur prêt, bucket absent (404 = NoSuchBucket)
HTTP_CREATE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$S3_PORT/mbote-media-test")
[ "$HTTP_CREATE" = "200" ] || { say "FAIL — création bucket anonyme: $HTTP_CREATE"; exit 1; }
say "   bucket mbote-media-test créé (HTTP 200, phase anonyme)"

# ── 2. restart avec credentials (l'anonyme doit devenir 403) ─────────────────
say "2. injection credentials + restart authentifié"
kill -9 "$WEED_PID" 2>/dev/null || true; wait "$WEED_PID" 2>/dev/null || true
cat > "$S3_JSON" <<'EOF'
{
  "identities": [
    {
      "name": "mbote-media-test",
      "credentials": [
        { "accessKey": "mbote-media-test", "secretKey": "mbote-media-test-secret" }
      ],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
EOF
( cd "$S3_DIR" && exec env WEED_LOG="$S3_DIR/weed.log" "$WEED_BIN" server \
    -dir="$S3_DIR" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
    -master.volumeSizeLimitMB=64 -master.electionTimeout=1s \
    -volume.max=0 -s3 -s3.port=$S3_PORT -s3.config="$S3_JSON" > "$S3_DIR/weed.log" 2>&1 ) &
WEED_PID=$!
wait_s3 403
say "   requête non signée → 403 (auth SigV4 active, bucket préservé du restart)"

# ── 3. bun test — G1…G6 (dont expiration 61 s réelle) ────────────────────────
say "3. bun test tests/media-real-s3.test.ts (G1–G6)"
MEDIA_REAL_S3=1 MEDIA_S3_EXPIRY_TEST=1 \
  MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
  bun test tests/media-real-s3.test.ts 2>&1 | tee "$ASSETS/b2-s3-real-test-output.txt"
if grep -q "0 fail" <(tail -20 "$ASSETS/b2-s3-real-test-output.txt"); then
  say "PASS — tests S3 réel : $(grep -E '[0-9]+ pass' "$ASSETS/b2-s3-real-test-output.txt" | tail -1)"
else
  say "FAIL — voir $ASSETS/b2-s3-real-test-output.txt"; exit 1
fi

# ── 4. scénario scripté complémentaire (sortie lisible pour la preuve) ───────
say "4. scénario scripté (PUT → GET → falsifié → expiration)"
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" MEDIA_S3_EXPIRY_TEST=1 bun scripts/b2-smoke-s3-real.ts 2>&1 \
  | tee "$ASSETS/b2-s3-real-smoke-output.txt" || true

say "═══ PRÉREQUIS B2 PROUVÉ — SigV4 B1 parle à un S3 réel indépendant ═══"
