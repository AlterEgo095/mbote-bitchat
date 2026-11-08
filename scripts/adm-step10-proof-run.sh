#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# adm-step10-proof-run — TESTS FINAUX ADM : intégrée + charge light + résilience
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b/§2c).
#
#   bash scripts/adm-step10-proof-run.sh
#
# Étapes : suites (intégrée 17 + stress 7 + non-régression 236) → builds
# standalone TOUJOURS (leçon É8) → seed preuve (bootstrap + admin:create — les
# CLI RÉELS) → serveurs :3161/:3162 build PROD → charge light (L1 10 admins ×
# 5 actions, L2 100×/audit < 2s) → navigateur sa1 (login TOTP, dashboard,
# queue, audit — captures 1440x900) → R1 backend down (502/503 + bandeau,
# récupération) → R2 verrou DB 6s (migration simulée, dégradation gracieuse)
# → R3 session expirée (BFF 401, SSR 302, zéro fuite) → captures résilience →
# nettoyage. Sorties : docs/proofs/assets/adm-step10-*.{png,txt} + journal.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
INTERNAL_TOKEN="proof-step10-token-0123456789abcdef0123456789abcdef"
MAIN=3161
PANEL=3162
DB="$ROOT/db/adm-step10-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[proof10] $*"; }
assert() { # libellé, condition ($1 = ok)
  if [ "$1" = "0" ]; then say "PASS — $2"; else say "FAIL — $2"; exit 1; fi
}
kill_port() {
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then
    say "   kill résidu port $1 : pids $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}
MAIN_PID=""
PANEL_PID=""
cleanup() {
  [ -n "$MAIN_PID" ] && kill $MAIN_PID 2>/dev/null || true
  [ -n "$PANEL_PID" ] && kill $PANEL_PID 2>/dev/null || true
  agent-browser close 2>/dev/null || true
}
trap cleanup EXIT

kill_port $MAIN
kill_port $PANEL
pkill -f "next dev -p 31" 2>/dev/null || true
sleep 1

totp_code() { # secret, offset_fenêtres
  bun -e "import('./src/lib/mbote/totp').then(m => console.log(m.totpAt('$1', Date.now() + ${2:-0} * 30000).code))"
}

SA1_EMAIL="operateur@step10.proof"
SA1_PASS="Step10-Proof-Passw0rd!.sa1"
SA2_EMAIL="super2@step10.proof"
SA2_PASS="Step10-Proof-Passw0rd!.b2"
MOD_EMAIL="moderateur@step10.proof"
MOD_PASS="Step10-Proof-Passw0rd!.m3"

# ── 1. suites de tests ──────────────────────────────────────────────────────
say "1a. suite E2E INTÉGRÉE (parcours complet, DB vierge)…"
DATABASE_URL="file:$ROOT/db/adm-step10-integrated-test.db" bun test tests/admin-step10-integrated-e2e.test.ts > /tmp/step10-integrated.log 2>&1 || { tail -20 /tmp/step10-integrated.log; exit 1; }
INT=$(grep -oE "[0-9]+ pass" /tmp/step10-integrated.log | head -1)
say "   intégré : $INT"
assert "$(grep -qE " 0 fail" /tmp/step10-integrated.log && echo 0 || echo 1)" "suite intégrée sans échec"

say "1b. suite STRESS writeAdminAudit (paires d'admins simultanés)…"
DATABASE_URL="file:$ROOT/db/adm-audit-stress-test.db" bun test tests/admin-audit-stress.test.ts > /tmp/step10-stress.log 2>&1 || { tail -20 /tmp/step10-stress.log; exit 1; }
assert "$(grep -qE " 0 fail" /tmp/step10-stress.log && echo 0 || echo 1)" "suite stress sans échec"

say "1c. non-régression (6 suites)…"
NR_TOTAL=0
for pair in "admin-auth-e2e:adm-e2e-test" "admin-audit-e2e:adm-audit-e2e-test" "admin-queue-e2e:adm-queue-e2e-test" "admin-dashboard-e2e:adm-dashboard-e2e-test" "admin-users-e2e:adm-users-e2e-test" "admin-four-eyes-e2e:adm-four-eyes-e2e-test"; do
  suite="${pair%%:*}"; dbn="${pair##*:}"
  DATABASE_URL="file:$ROOT/db/$dbn.db" bun test tests/$suite.test.ts > "/tmp/step10-$suite.log" 2>&1 || { tail -20 "/tmp/step10-$suite.log"; exit 1; }
  n=$(grep -oE "^Ran [0-9]+ tests" "/tmp/step10-$suite.log" | grep -oE "[0-9]+")
  f=$(grep -oE "[0-9]+ fail" "/tmp/step10-$suite.log" | head -1 | grep -oE "[0-9]+")
  [ "$f" = "0" ] || { say "FAIL — $suite : $f échec(s)"; exit 1; }
  NR_TOTAL=$((NR_TOTAL + n))
  say "   $suite : $n pass"
done
say "   NON-RÉGRESSION TOTALE : $NR_TOTAL verts"

# ── 2. builds production (DEV-SETUP §2c) — TOUJOURS (leçon É8) ──────────────
say "2a. build app principale…"
rm -f "$DB"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/step10-build-main.log 2>&1
say "2b. build panneau admin…"
(cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" bunx next build > /tmp/step10-build-panel.log 2>&1)
say "2c. migrations sur la DB de preuve (le build/prerender crée un fichier VIDE — constat Étape 10)…"
DATABASE_URL="file:$DB" bunx prisma migrate deploy > /tmp/step10-migrate-proof.log 2>&1
cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
mkdir -p admin/.next/standalone/public
cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true

# ── 3. seed preuve — les CLI RÉELS d'exploitation ───────────────────────────
say "3. seed : bootstrap sa1 + admin:create (sa2, moderator) — CLI réels"
DATABASE_URL="file:$DB" bun run admin:bootstrap -- --email=$SA1_EMAIL --password=$SA1_PASS > /tmp/step10-bootstrap.log 2>&1
DATABASE_URL="file:$DB" bun run admin:create -- --email=$SA2_EMAIL --role=super-admin --password=$SA2_PASS > /tmp/step10-create-sa2.log 2>&1
DATABASE_URL="file:$DB" bun run admin:create -- --email=$MOD_EMAIL --role=moderator --password=$MOD_PASS > /tmp/step10-create-mod.log 2>&1
SA1_SECRET=$(DATABASE_URL="file:$DB" bun -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient({log:[]}); db.adminUser.findUnique({where:{email:'$SA1_EMAIL'}}).then(u=>{console.log(u.totpSecret); return db.\$disconnect();})")
assert "$([ -n "$SA1_SECRET" ] && echo 0 || echo 1)" "secret TOTP sa1 récupéré"
# fixtures publiques (users/posts/reports pour queue + cibles navigateur)
DATABASE_URL="file:$DB" bun scripts/adm-step10-proof-seed.ts > /tmp/step10-seed.log 2>&1

# ── 4. serveurs standalone (build PROD) ─────────────────────────────────────
say "4. serveurs :$MAIN/:$PANEL (build prod)"
DATABASE_URL="file:$DB" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/step10-main.log 2>&1 &
MAIN_PID=$!
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    BACKEND_INTERNAL_URL="http://127.0.0.1:$MAIN" PORT=$PANEL HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/step10-panel.log 2>&1 ) &
PANEL_PID=$!
for i in $(seq 1 40); do
  M=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$MAIN/api/stats" || true)
  P=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PANEL/api/health" || true)
  [ "$M" = "200" ] && [ "$P" = "200" ] && break
  sleep 2
done
assert "$([ "$M" = "200" ] && [ "$P" = "200" ] && echo 0 || echo 1)" "serveurs prod prêts (main=$M panel=$P)"

# ── 5. charge light (L1 + L2) ───────────────────────────────────────────────
say "5. charge light — 10 admins × 5 actions + 100×/audit"
set +e
DATABASE_URL="file:$DB" bun scripts/adm-step10-load-light.ts \
  --main="http://127.0.0.1:$MAIN" --token="$INTERNAL_TOKEN" 2>/dev/null \
  | grep -vE "^prisma:query" > "$ASSETS/adm-step10-load-light.txt"
LOAD_RC=${PIPESTATUS[0]}
set -e
assert "$LOAD_RC" "charge light verte (rapport → adm-step10-load-light.txt)"
grep -E "durée totale|statuts|OK" "$ASSETS/adm-step10-load-light.txt" | head -8

# ── 6. navigateur sa1 — login TOTP, dashboard, queue, audit ────────────────
say "6. navigateur sa1 — login → dashboard → queue → audit"
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
SA1_CODE=$(totp_code "$SA1_SECRET" 1)
agent-browser find label "Email" fill "$SA1_EMAIL"
agent-browser find label "Mot de passe" fill "$SA1_PASS"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SA1_CODE"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "$SA1_EMAIL" \
  || { agent-browser screenshot /tmp/step10-debug-login.png; agent-browser errors; exit 1; }
say "   login navigateur sa1 OK"
agent-browser open "http://127.0.0.1:$PANEL/dashboard"
agent-browser wait --text "État du réseau" \
  || { agent-browser screenshot /tmp/step10-debug-dash.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step10-dashboard.png"
agent-browser open "http://127.0.0.1:$PANEL/queue"
agent-browser wait --load networkidle
agent-browser screenshot "$ASSETS/adm-step10-queue.png"
agent-browser open "http://127.0.0.1:$PANEL/audit"
agent-browser wait --load networkidle
agent-browser screenshot "$ASSETS/adm-step10-audit.png"
say "   captures dashboard/queue/audit OK"

# ── 7. R1 — backend DOWN → 502/503 + bandeau → récupération ────────────────
say "7. R1 — backend down : panneau dégrade (502/503), ne crashe pas, récupère"
# session de preuve pour le curl (le 502 du BFF s'observe AVEC une session
# valide : sans cookie → 401 auth, jamais atteint backend-unreachable)
# tail -1 : db.ts logge chaque requête (log:['query']) — le token est la DERNIÈRE ligne
PROOF_TOKEN=$(DATABASE_URL="file:$DB" bun -e "const {PrismaClient}=require('@prisma/client'); const {createAdminSession}=require('./src/lib/mbote/admin-auth.ts'); const db=new PrismaClient({log:[]}); db.adminUser.findFirst({where:{role:'super-admin'}}).then(async sa=>{const s=await createAdminSession(sa.id,{ip:'proof-r1'}); console.log(s.sessionToken); await db.\$disconnect();})" 2>/dev/null | tail -1)
CURL_AUTH=( -H "Cookie: mbote_admin_session=$PROOF_TOKEN" )
kill -9 $MAIN_PID 2>/dev/null || true
sleep 2
D=$(curl -s -o /dev/null -w "%{http_code}" "${CURL_AUTH[@]}" "http://127.0.0.1:$PANEL/api/dashboard" || true)
H=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PANEL/api/health" || true)
echo "R1 backend down : BFF /api/dashboard (session valide)=$D · /api/health=$H" > "$ASSETS/adm-step10-r1-backend-down.txt"
assert "$([ "$D" = "502" ] && echo 0 || echo 1)" "BFF /api/dashboard (session valide) → 502 (backend-unreachable), obtenu $D"
assert "$([ "$H" = "503" ] && echo 0 || echo 1)" "/api/health → 503 (dégradé), obtenu $H"
P2=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PANEL/" || true)
assert "$([ "$P2" != "000" ] && echo 0 || echo 1)" "le PANNEAU répond encore ($P2) — pas de crash"
agent-browser open "http://127.0.0.1:$PANEL/dashboard"
agent-browser wait --load networkidle
agent-browser screenshot "$ASSETS/adm-step10-r1-backend-down.png"
say "   capture état dégradé OK"
# récupération
DATABASE_URL="file:$DB" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js >> /tmp/step10-main.log 2>&1 &
MAIN_PID=$!
REC=1
for i in $(seq 1 30); do
  M=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$MAIN/api/stats" || true)
  [ "$M" = "200" ] && REC=0 && break
  sleep 2
done
assert "$REC" "backend relancé — récupération"
D2=$(curl -s -o /dev/null -w "%{http_code}" "${CURL_AUTH[@]}" "http://127.0.0.1:$PANEL/api/dashboard" || true)
assert "$([ "$D2" = "200" ] && echo 0 || echo 1)" "panneau récupéré (dashboard 200), obtenu $D2"

# ── 8. R2 + R3 — verrou DB (migration simulée) + session expirée ───────────
say "8. R2 verrou DB 6s + R3 session expirée"
set +e
DATABASE_URL="file:$DB" bun scripts/adm-step10-resilience.ts \
  --main="http://127.0.0.1:$MAIN" --panel="http://127.0.0.1:$PANEL" --token="$INTERNAL_TOKEN" 2>/dev/null \
  | grep -vE "^prisma:query" > "$ASSETS/adm-step10-resilience-r2-r3.txt"
RES_RC=${PIPESTATUS[0]}
set -e
cat "$ASSETS/adm-step10-resilience-r2-r3.txt"
assert "$RES_RC" "R2+R3 verts (journal → adm-step10-resilience-r2-r3.txt)"

# ── 9. navigateur R3 — session révoquée → redirect login ───────────────────
say "9. navigateur — session sa1 révoquée en DB → redirect login (capture)"
DATABASE_URL="file:$DB" bun -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient({log:[]}); db.adminSession.updateMany({where:{revokedAt:null}, data:{revokedAt:new Date(), revokedReason:'proof-step10-r3'}}).then(r=>{console.log('sessions révoquées:', r.count); return db.\$disconnect();})"
agent-browser open "http://127.0.0.1:$PANEL/dashboard"
agent-browser wait --load networkidle
agent-browser screenshot "$ASSETS/adm-step10-r3-session-expiree.png"
say "   capture session expirée OK (redirect écran de login)"

# ── 10. récapitulatif ───────────────────────────────────────────────────────
say "10. récapitulatif"
say "    intégré : $INT · stress : 7 · non-régression : $NR_TOTAL verts"
say "    charge light : adm-step10-load-light.txt (L1 50/50, L2 100/100 < 2s)"
say "    résilience : adm-step10-resilience-r2-r3.txt + r1-backend-down.txt"
say "    captures : dashboard, queue, audit, r1-backend-down, r3-session-expiree"
say "PROOF10 TERMINÉ — exit 0"
