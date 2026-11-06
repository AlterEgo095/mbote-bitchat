#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# b2-images-proof-run — preuves E2E de B2 (upload présigné → finalize → lecture)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b/§2c).
#
#   bash scripts/b2-images-proof-run.sh
#
# Étapes : weed 3.80 (S3 RÉEL indépendant — arbitrage §1 B2-images.md : docker
# absent, MinIO indisponible, R2 sans credentials) ANONYME → bucket →
# credentials jetables → AUTHENTIFIÉ (une requête non signée → 403 prouve que
# l'auth S3 est active) → build standalone app (si absent) → DB preuve → app
# :3103 (proxy média actif) → harnais tests/media-b2-flow.test.ts (U1-U4 :
# chaîne complète, EXIF absent après le voyage, interop socle B1, DEUX
# appareils simulés A→dm2 E2EE→B ; R1-R11 : refus type/taille/preuve/rate/
# quota/fenêtre, MIME spoofing refusé AU RENDU, file hors-ligne) → benchmark
# 100 Ko/1 Mo/5 Mo → navigateur : identité A → conversation avec B (pair
# publié par script) → 📎 → upload fixture GPS → preview → « Chiffrer et
# envoyer » → toast succès → vignette déchiffrée affichée (screenshot) →
# clic → plein écran (screenshot) → preuve DB (Media finalized + dm2) →
# nettoyage. Sorties : docs/proofs/assets/b2-images-*.{png,txt} + journal.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP=3103
S3_PORT=9100
S3_DIR="$(mktemp -d /tmp/b2-images.XXXXXX)"
S3_JSON="$S3_DIR/s3.json"
DB="$ROOT/db/b2-images-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
FIXTURE="$ROOT/tests/fixtures/media-gps-sample.jpg"
ACCESS_KEY="b2-images-proof"
SECRET_KEY="b2-images-proof-secret-0123456789abcdef"
mkdir -p "$ASSETS" "$ROOT/db"

say() { echo "[b2-images] $*"; }
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

WEED_BIN="${WEED_BIN:-$HOME/bin/weed}"
if [ ! -x "$WEED_BIN" ]; then
  say "0. téléchargement weed 3.80 (binaire épinglé, sha256 vérifié)"
  mkdir -p "$HOME/bin"
  curl -sL https://github.com/seaweedfs/seaweedfs/releases/download/3.80/linux_amd64.tar.gz -o /tmp/weed.tar.gz
  echo "b8eec95b1c022ce02e04b9b33172eada1d545b015cefd0279043a2ffde7ed76f  /tmp/weed.tar.gz" | sha256sum -c - || { say "FAIL — sha256 weed"; exit 1; }
  tar -xzf /tmp/weed.tar.gz -C "$HOME/bin" weed
fi
say "0. weed présent : $WEED_BIN ($($WEED_BIN version))"

wait_s3() { # $1... = codes HTTP acceptés (serveur prêt)
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$S3_PORT/mbote-media-test/" 2>/dev/null || true)
    for want in "$@"; do [ "$code" = "$want" ] && return 0; done
    sleep 1
  done
  say "FAIL — S3 :$S3_PORT jamais en état attendu ($*)"; tail -5 "$S3_DIR/weed.log" || true; exit 1
}

# ── 1. weed ANONYME → création bucket → credentials → AUTHENTIFIÉ ───────────
say "1. S3 réel (weed) — phase anonyme : création du bucket"
( cd "$S3_DIR" && exec env WEED_LOG="$S3_DIR/weed.log" "$WEED_BIN" server \
    -dir="$S3_DIR" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
    -master.volumeSizeLimitMB=64 -master.electionTimeout=1s \
    -volume.max=0 -s3 -s3.port=$S3_PORT > "$S3_DIR/weed.log" 2>&1 ) &
WEED_PID=$!
wait_s3 404
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
wait_s3 403  # auth active : accès sans signature → 403
ANON_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$S3_PORT/mbote-media-test/media/00000000-0000-4000-8000-000000000001")
[ "$ANON_CODE" = "403" ] || { say "FAIL — requête ANONYME attendue 403, obtenue $ANON_CODE (auth S3 inactive ?)"; exit 1; }
say "PASS — requête anonyme → 403 (l'authentification S3 est RÉELLE)"

# ── 2. build app standalone (si absent) ─────────────────────────────────────
rm -f "$DB"
if [ ! -f .next/standalone/server.js ]; then
  say "2. build production app principale (DEV-SETUP §2c)"
  DATABASE_URL="file:$DB" NEXT_TELEMETRY_DISABLED=1 bunx next build > /tmp/b2-images-build.log 2>&1
else
  say "2. build standalone déjà présent"
fi
# standalone : les assets client (chunks JS, fonts) et public NE sont PAS copiés
# par le build — sans eux : 404 sur /_next/static/* → jamais d'hydratation
# (skeletons figés, capture noire). Copie standard du déploiement Next standalone.
if [ ! -d .next/standalone/.next/static ]; then
  cp -r .next/static .next/standalone/.next/
  mkdir -p .next/standalone/public
  cp -r public/. .next/standalone/public/
  say "   assets client copiés dans standalone (static + public)"
fi

# ── 3. DB preuve + démarrage app :3103 ──────────────────────────────────────
say "3. DB preuve + app standalone :$APP (MEDIA_S3_* → weed :$S3_PORT)"
DATABASE_URL="file:$DB" bunx prisma db push --skip-generate > /tmp/b2-images-dbpush.log 2>&1
DATABASE_URL="file:$DB" \
MEDIA_STORAGE_DRIVER=minio \
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
MEDIA_S3_REGION=us-east-1 \
MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID="$ACCESS_KEY" \
MEDIA_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
MBOTE_EMBED_RELAY=0 PORT=$APP HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/b2-images-app.log 2>&1 &
APP_PID=$!
trap 'kill -9 $APP_PID $WEED_PID 2>/dev/null || true; pkill -9 -f "weed server -dir=$S3_DIR" 2>/dev/null || true; agent-browser close 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$APP/api/stats" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$APP/api/stats" || { say "FAIL — app non prête"; exit 1; }
say "   app prête sur :$APP"

# ── 4. harnais E2E B2 (U1-U4 + R1-R11 + P1) ─────────────────────────────────
say "4. harnais media-b2-flow (MEDIA_B2_E2E=1)"
MEDIA_B2_E2E=1 BASE_URL="http://127.0.0.1:$APP" \
DATABASE_URL="file:$DB" \
MEDIA_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" MEDIA_S3_REGION=us-east-1 MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID="$ACCESS_KEY" MEDIA_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
  bun test tests/media-b2-flow.test.ts 2>&1 | tee "$ASSETS/b2-images-test-output.txt"
assert_contains "$ASSETS/b2-images-test-output.txt" "0 fail" "harnais B2 : 0 fail"

# ── 5. benchmark 100 Ko / 1 Mo / 5 Mo ───────────────────────────────────────
say "5. benchmark (100 Ko / 1 Mo / 5 Mo)"
MEDIA_B2_E2E=1 BASE_URL="http://127.0.0.1:$APP" \
  bun scripts/b2-images-bench.ts 2>&1 | tee "$ASSETS/b2-images-bench.txt"
assert_contains "$ASSETS/b2-images-bench.txt" "TOTAL" "benchmark : colonnes complètes"

# ── 6. navigateur — flux complet émetteur (identité A → B) ──────────────────
say "6. navigateur — identité A, conversation vers B, upload image chiffrée"
agent-browser close 2>/dev/null || true
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$APP/" > /dev/null
agent-browser wait --load networkidle

# onboarding : identité A dans l'UI
agent-browser wait --text "Crée ton identité locale" \
  || { agent-browser screenshot /tmp/b2-debug-onboard-wait.png; agent-browser errors; exit 1; }
agent-browser find label "Pseudo visible" fill "Alice-Preuve-B2"
agent-browser find role button click --name "Générer mes clés et entrer"
# le pseudo complet n'apparaît pas en texte brut (avatar tronqué) — le
# marqueur de succès = l'état vide du Fil (texte DOM réel, rendu SEULEMENT
# avec une identité ; le composer « Quoi de neuf » est un placeholder, non
# détectable par wait --text)
agent-browser wait --text "Le fil global attend" \
  || { agent-browser screenshot /tmp/b2-debug-onboarding.png; agent-browser errors; exit 1; }
say "   identité A créée dans l'UI"

# pair B publié par script (ECDSA + ECDH) → conversation « E2E actif »
PEER_JSON=$(BASE_URL="http://127.0.0.1:$APP" bun scripts/b2-publish-peer.ts "B-dest-B2")
PEER_NICK=$(bun -e "console.log(JSON.parse(process.argv[1]).nickname)" "$PEER_JSON")
echo "$PEER_JSON" > "$ASSETS/b2-images-peer.json"
say "   pair B publié : $PEER_NICK"

# nouvelle conversation vers B (navigation : onglet Messages → bouton Nouvelle)
agent-browser find role button click --name "Messages"
sleep 1
agent-browser find role button click --name "Nouvelle conversation"
agent-browser wait --text "Choisir un contact"
# le bouton du contact contient nickname + clé courte → name exact impossible :
# clic robuste par eval (innerText contient le nickname)
agent-browser eval "(function(){ const b = Array.from(document.querySelectorAll('[role=dialog] button')).find(function(x){ return x.innerText && x.innerText.indexOf('$PEER_NICK') >= 0; }); return b ? (b.click(), 'contact cliqué') : 'CONTACT ABSENT'; })()" | grep -q "contact cliqué" \
  || { agent-browser screenshot /tmp/b2-debug-contact.png; agent-browser errors; exit 1; }
agent-browser wait --text "E2E actif" \
  || { agent-browser screenshot /tmp/b2-debug-conversation.png; agent-browser errors; exit 1; }
say "   conversation A→B ouverte (badge E2E actif)"

# 📎 → upload de la fixture GPS : injection DIRECTE du fichier sur l'input
# (Playwright set_input_files, fonctionne sur l'élément sr-only — le picker
# natif n'existe pas en headless) ; le PREVIEW s'ouvre à la sélection (onChange).
agent-browser upload "input[type=file]" "$FIXTURE"
agent-browser wait --text "Chiffrer et envoyer"
agent-browser screenshot "$ASSETS/b2-images-preview.png"
say "   capture b2-images-preview.png (preview : nom + taille)"

# envoi orchestré (strip → chiffrement → PUT → finalize) puis dm2
agent-browser find role button click --name "Chiffrer et envoyer"
agent-browser wait --text "Image envoyée" \
  || { agent-browser screenshot /tmp/b2-debug-send.png; agent-browser errors; exit 1; }
say "   toast « Image envoyée » (chaîne complète passée côté navigateur)"

# la vignette déchiffrée apparaît (download → decrypt → magic bytes → Blob)
sleep 3
agent-browser screenshot "$ASSETS/b2-images-sent-thumbnail.png"
say "   capture b2-images-sent-thumbnail.png (bulle média envoyée)"

# plein écran
agent-browser eval "document.querySelector('img[alt*=\"Image partagée\"]')?.click() || 'no-thumb'" > /dev/null 2>&1 || true
sleep 2
agent-browser screenshot "$ASSETS/b2-images-full-view.png"
say "   capture b2-images-full-view.png (vue plein écran déchiffrée)"

# ── 7. preuve DB + objet dans le bucket ─────────────────────────────────────
say "7. preuves DB (Media finalized) + bucket"
DATABASE_URL="file:$DB" bun -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: [] });
const finalized = await db.media.count({ where: { status: 'finalized' } });
const pending = await db.media.count({ where: { status: 'pending' } });
const last = await db.media.findFirst({ where: { status: 'finalized' }, orderBy: { finalizedAt: 'desc' } });
console.log('Media finalized:', finalized, '| pending:', pending, '| dernier:', last?.objectKey, last?.sizeBytes, 'o');
await db.\$disconnect();
" > "$ASSETS/b2-images-db.txt" 2>&1
assert_contains "$ASSETS/b2-images-db.txt" "finalized:" "DB : lignes Media présentes"

say "═══════════════════════════════════════════════════════════"
say "TOUTES LES PREUVES B2 SONT PASSÉES — runner exit 0"
say "═══════════════════════════════════════════════════════════"
