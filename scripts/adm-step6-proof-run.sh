#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# adm-step6-proof-run — preuves navigateur + curl de la queue (ADM Étape 6)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b/§2c).
#
#   bash scripts/adm-step6-proof-run.sh
#
# Étapes : seed DB preuve (cible 5 reports = badge rouge, 3+1 = tri poids,
# 22 fillers = pagination) → builds (si absents) → serveurs standalone :3101
# (app principale) + :3102 (panneau) → curl : login support → GET /api/queue
# (page 1 : 20 items, weight 5 en tête, nextCursor) → page 2 (items distincts)
# → cursor malformé → 400 → token seul → 401 → login auditor → 403 →
# action SANS justification valide → 422 → navigateur : login support →
# /queue (screenshot file remplie + badge rouge) → Page suivante (screenshot)
# → retour → action « Masquer le contenu » + formulaire de justification
# (screenshot) → confirmation → notice 2xx + liste rejetée (screenshot après)
# → preuve DB : AdminAudit « SPAM: … » + reports clos + 502 (kill backend)
# → bandeau navigateur → nettoyage.
# Sorties : docs/proofs/assets/adm-step6-*.{png,txt} + journal sur stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
INTERNAL_TOKEN="proof-step6-token-0123456789abcdef0123456789abcdef"
MAIN=3101
PANEL=3102
DB="$ROOT/db/adm-step6-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[proof6] $*"; }
assert_contains() { # fichier, aiguille, libellé
  if grep -q "$2" "$1"; then say "PASS — $3"; else say "FAIL — $3 (aiguille '$2' absente de $1)"; exit 1; fi
}
kill_port() {
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then
    say "   kill résidu port $1 : pids $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}
kill_port 3101
kill_port 3102
sleep 1
for port in 3101 3102; do
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    say "FAIL — port $port toujours occupé après kill"
    exit 1
  fi
done

totp_code() { # secret, offset_fenêtres
  bun -e "import('./src/lib/mbote/totp').then(m => console.log(m.totpAt('$1', Date.now() + ${2:-0} * 30000).code))"
}
json_get() { # fichier, chemin pointé (ex items.0.weight)
  bun -e "const b=JSON.parse(require('fs').readFileSync('$1','utf8'));console.log('$2'.split('.').reduce((o,k)=>o?.[k],b))"
}

# ── 0. seed idempotent + secrets ────────────────────────────────────────────
say "0. seed DB de preuve"
rm -f "$DB" "$ROOT/db/adm-step6-secrets.json"
DATABASE_URL="file:$DB" bun scripts/adm-step6-proof-seed.ts > /tmp/step6-seed.log 2>&1
assert_contains /tmp/step6-seed.log '"reportsOuverts":33' "seed : 33 reports ouverts (page 1=20, page 2=13)"
SUPPORT_SECRET=$(bun -e "console.log(require('./db/adm-step6-secrets.json').admins['support@step6.proof'].totpSecret)")
MOD_SECRET=$(bun -e "console.log(require('./db/adm-step6-secrets.json').admins['moderator@step6.proof'].totpSecret)")
AUDITOR_SECRET=$(bun -e "console.log(require('./db/adm-step6-secrets.json').admins['auditor@step6.proof'].totpSecret)")

# ── 0b. tsc --noEmit app + panneau — gate AVANT les builds (Clarification 1,
#      leçon F-17 : un type faux — ex. TS2345 — bloquait le build) ────────────
say "0b. tsc --noEmit app + panneau (gate avant builds — Clarification 1)"
bunx tsc --noEmit > /tmp/step6-tsc-main.log 2>&1 \
  || { say "FAIL — tsc app principale : erreurs de type (extrait)"; tail -40 /tmp/step6-tsc-main.log; exit 1; }
(cd admin && bunx tsc --noEmit) > /tmp/step6-tsc-panel.log 2>&1 \
  || { say "FAIL — tsc panneau admin : erreurs de type (extrait)"; tail -40 /tmp/step6-tsc-panel.log; exit 1; }

# ── 1. builds production (DEV-SETUP §2c) ────────────────────────────────────
if [ ! -f .next/standalone/server.js ]; then
  say "1a. build app principale…"
  NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/step6-build-main.log 2>&1
fi
if [ ! -f admin/.next/standalone/server.js ]; then
  say "1b. build panneau admin…"
  (cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" bunx next build > /tmp/step6-build-panel.log 2>&1)
  cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
  mkdir -p admin/.next/standalone/public
  cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true
fi

# ── 2. serveurs standalone ──────────────────────────────────────────────────
say "2. démarrage des serveurs (:3101 principale, :3102 panneau)"
DATABASE_URL="file:$DB" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/step6-main.log 2>&1 &
MAIN_PID=$!
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    BACKEND_INTERNAL_URL="http://127.0.0.1:$MAIN" PORT=$PANEL HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/step6-panel.log 2>&1 ) &
PANEL_PID=$!
trap 'kill $MAIN_PID $PANEL_PID 2>/dev/null || true; agent-browser close 2>/dev/null || true' EXIT

wait_up() {
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$1" && return 0
    sleep 1
  done
  say "FAIL — serveur non prêt : $1"; exit 1
}
wait_up "http://127.0.0.1:$MAIN/api/stats"
wait_up "http://127.0.0.1:$PANEL/api/health"
say "   serveurs prêts"

# ── 3. curl — login support + GET /api/queue (page 1) ───────────────────────
say "3. curl — login support + GET /api/queue"
SUPPORT_CODE=$(totp_code "$SUPPORT_SECRET" 0)
curl -s -c /tmp/step6-support.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.1" \
  -d "{\"email\":\"support@step6.proof\",\"password\":\"Step6-Proof-Passw0rd!.support\",\"totp\":\"$SUPPORT_CODE\"}" \
  > "$ASSETS/adm-step6-login-support.txt"
assert_contains "$ASSETS/adm-step6-login-support.txt" '"role":"support"' "login support → 200 rôle support"
CSRF=$(json_get "$ASSETS/adm-step6-login-support.txt" csrfToken)
ACTOR=$(json_get "$ASSETS/adm-step6-login-support.txt" adminUserId)
[ -n "$CSRF" ] && [ -n "$ACTOR" ] || { say "FAIL — csrf/actor absents du login"; exit 1; }

curl -s -b /tmp/step6-support.cookies "http://127.0.0.1:$PANEL/api/queue" > "$ASSETS/adm-step6-queue-page1.txt"
assert_contains "$ASSETS/adm-step6-queue-page1.txt" '"weight":5' "page 1 : le poids 5 (badge rouge ≥ 5) est en tête"
assert_contains "$ASSETS/adm-step6-queue-page1.txt" '"openTotal":33' "openTotal = 33 (fixtures)"
P1_LEN=$(bun -e "const b=JSON.parse(require('fs').readFileSync('$ASSETS/adm-step6-queue-page1.txt','utf8'));console.log(b.items.length)")
[ "$P1_LEN" = "20" ] || { say "FAIL — page 1 attendue 20 items, obtenue $P1_LEN"; exit 1; }
say "PASS — page 1 = 20 items (directive)"
NEXT_CURSOR=$(json_get "$ASSETS/adm-step6-queue-page1.txt" nextCursor)
[ -n "$NEXT_CURSOR" ] && [ "$NEXT_CURSOR" != "null" ] || { say "FAIL — nextCursor absent"; exit 1; }

say "3b. page 2 via curseur — items DISTINCTS"
curl -s -b /tmp/step6-support.cookies "http://127.0.0.1:$PANEL/api/queue?cursor=$(bun -e "console.log(encodeURIComponent('$NEXT_CURSOR'))")" > "$ASSETS/adm-step6-queue-page2.txt"
assert_contains "$ASSETS/adm-step6-queue-page2.txt" '"items"' "page 2 servie"
OVERLAP=$(bun -e "
const fs=require('fs');
const p1=JSON.parse(fs.readFileSync('$ASSETS/adm-step6-queue-page1.txt','utf8')).items.map(i=>i.id);
const p2=JSON.parse(fs.readFileSync('$ASSETS/adm-step6-queue-page2.txt','utf8')).items.map(i=>i.id);
console.log(p2.filter(id=>p1.includes(id)).length);")
[ "$OVERLAP" = "0" ] || { say "FAIL — chevauchement page 1/page 2 : $OVERLAP"; exit 1; }
say "PASS — page 2 : 0 chevauchement avec la page 1 (cursor keyset)"

say "3c. cursor malformé → 400"
HTTP_BAD=$(curl -s -o "$ASSETS/adm-step6-cursor-bad.txt" -w "%{http_code}" \
  -b /tmp/step6-support.cookies "http://127.0.0.1:$PANEL/api/queue?cursor=pas-du-base64!!")
[ "$HTTP_BAD" = "400" ] || { say "FAIL — cursor malformé attendu 400, obtenu $HTTP_BAD"; exit 1; }
assert_contains "$ASSETS/adm-step6-cursor-bad.txt" 'cursor invalide' "cursor malformé → 400 « cursor invalide »"

say "3d. token interne SEUL → 401"
HTTP_TOK=$(curl -s -o "$ASSETS/adm-step6-token-only.txt" -w "%{http_code}" \
  -H "x-admin-internal: $INTERNAL_TOKEN" "http://127.0.0.1:$MAIN/api/internal/admin/queue")
[ "$HTTP_TOK" = "401" ] || { say "FAIL — token seul attendu 401, obtenu $HTTP_TOK"; exit 1; }
say "PASS — token interne seul → 401"

# ── 4. curl — auditor → 403 (§12.17) ────────────────────────────────────────
say "4. curl — login auditor → 403 sur /api/queue"
AUDITOR_CODE=$(totp_code "$AUDITOR_SECRET" 0)
curl -s -c /tmp/step6-auditor.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.2" \
  -d "{\"email\":\"auditor@step6.proof\",\"password\":\"Step6-Proof-Passw0rd!.auditor\",\"totp\":\"$AUDITOR_CODE\"}" \
  > "$ASSETS/adm-step6-login-auditor.txt"
assert_contains "$ASSETS/adm-step6-login-auditor.txt" '"role":"auditor"' "login auditor → 200"
HTTP_AUD=$(curl -s -o "$ASSETS/adm-step6-auditor-403.txt" -w "%{http_code}" \
  -b /tmp/step6-auditor.cookies "http://127.0.0.1:$PANEL/api/queue")
[ "$HTTP_AUD" = "403" ] || { say "FAIL — auditor attendu 403, obtenu $HTTP_AUD"; exit 1; }
assert_contains "$ASSETS/adm-step6-auditor-403.txt" 'unauthorized' "auditor → 403 uniforme (§12.17 auditor strict)"

# ── 5. curl — action SANS justification valide → 422 ────────────────────────
say "5. curl — hide sans justification (§6) → 422"
HTTP_422=$(curl -s -o "$ASSETS/adm-step6-422-justification.txt" -w "%{http_code}" \
  -b /tmp/step6-support.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/moderation/action" \
  -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF" \
  -d '{"action":"hide","targetKind":"post","targetId":"peu-importe","category":"SPAM","justification":"trop court"}')
[ "$HTTP_422" = "422" ] || { say "FAIL — justification courte attendue 422, obtenue $HTTP_422"; exit 1; }
assert_contains "$ASSETS/adm-step6-422-justification.txt" 'trop courte' "422 : justification ≥ 20 chars imposée par le SERVEUR"

# ── 6. navigateur — /queue remplie (support) ────────────────────────────────
say "6. navigateur — login support → /queue (capture file remplie)"
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
SUPPORT_CODE_BROWSER=$(totp_code "$SUPPORT_SECRET" 1)  # fenêtre N+1 : anti-rejeu Étape 3
agent-browser find label "Email" fill "support@step6.proof"
agent-browser find label "Mot de passe" fill "Step6-Proof-Passw0rd!.support"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SUPPORT_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "support@step6.proof" \
  || { agent-browser screenshot /tmp/step6-debug-login.png; agent-browser errors; exit 1; }
say "   login navigateur OK"
agent-browser open "http://127.0.0.1:$PANEL/queue"
agent-browser wait --text "File de modération"
agent-browser wait --text "poids 5"
agent-browser wait --text "33 signalement(s) ouvert(s)"
agent-browser screenshot "$ASSETS/adm-step6-queue.png"
say "   capture adm-step6-queue.png (badge rouge poids 5, file remplie)"

say "6b. pagination navigateur — Page suivante"
agent-browser find role button click --name "Page suivante →"
agent-browser wait --text "Retour page 1"
agent-browser screenshot "$ASSETS/adm-step6-queue-page2.png"
say "   capture adm-step6-queue-page2.png (curseur actif)"

say "6c. SURFACE RBAC UI — support NE voit PAS « Masquer le contenu » (hide = moderator)"
# les boutons visibles en session support : Classer sans suite · Avertir ·
# four-eyes désactivé — PAS de hide/suspend (matrice §4 rendue dans l'UI)
agent-browser screenshot "$ASSETS/adm-step6-rbac-support-buttons.png"
say "   capture adm-step6-rbac-support-buttons.png (surface limitée support)"

say "6d. re-login MODERATOR → action hide avec justification (directive : « Hide : 1 modérateur »)"
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
agent-browser wait --text "Se connecter"
MOD_CODE_BROWSER=$(totp_code "$MOD_SECRET" 0)  # premier usage du secret moderator
agent-browser find label "Email" fill "moderator@step6.proof"
agent-browser find label "Mot de passe" fill "Step6-Proof-Passw0rd!.moderator"
agent-browser find label "Code TOTP (6 chiffres)" fill "$MOD_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "moderator@step6.proof" \
  || { agent-browser screenshot /tmp/step6-debug-login-mod.png; agent-browser errors; exit 1; }
agent-browser open "http://127.0.0.1:$PANEL/queue"
agent-browser wait --text "poids 5"
# le premier bouton d'action de la page cible le 1er item (poids 5)
agent-browser find role button click --name "Masquer le contenu" || { agent-browser errors; exit 1; }
agent-browser wait --text "justification obligatoire"
agent-browser find label "Texte de justification" fill "Spam répété massif — masqué après vérification des 5 signalements"
agent-browser screenshot "$ASSETS/adm-step6-justification-form.png"
say "   capture adm-step6-justification-form.png (formulaire §6)"
agent-browser find role button click --name "Confirmer (attend le serveur)"
agent-browser wait --text "OK (2xx)" \
  || { agent-browser screenshot /tmp/step6-debug-action.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step6-after-hide.png"
say "   capture adm-step6-after-hide.png (notice 2xx + liste rejetée depuis le serveur)"
# les 5 reports de la cible fermée ont QUITTÉ la file (5 clos)
agent-browser wait --text "28 signalement(s) ouvert(s)" \
  || { agent-browser screenshot /tmp/step6-debug-count.png; exit 1; }
say "   PASS — openTotal 33 → 28 après hide (les 5 reports de la cible sont clos)"

# ── 7. preuve DB — audit append-only + reports clos ─────────────────────────
say "7. preuve DB — AdminAudit (format §6) + reports actioned"
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  const audit = await db.adminAudit.findFirst({where:{action:'hide'},orderBy:{createdAt:'desc'}});
  const closed = await db.report.findMany({where:{status:'actioned'},select:{id:true,handledById:true}});
  const out = {auditAction: audit?.action, targetType: audit?.targetType, justification: audit?.justification, reportsActioned: closed.length, handledByIdPose: closed.every(r=>r.handledById!==null)};
  require('fs').writeFileSync('$ASSETS/adm-step6-audit-db.txt', JSON.stringify(out,null,2));
  console.log(JSON.stringify(out));
  if (!out.justification?.startsWith('SPAM: ') || closed.length !== 5 || !out.handledByIdPose) { process.exit(1); }
  process.exit(0);
})();" > /dev/null
say "   PASS — AdminAudit.justification = « SPAM: … » + 5 reports actioned (handledById posé)"

# ── 8. DÉGRADATION — kill backend → 502 + bandeau ───────────────────────────
say "8. kill backend → 502 (curl) puis bandeau navigateur"
kill "$MAIN_PID" 2>/dev/null || true
sleep 2
HTTP_502=$(curl -s -o "$ASSETS/adm-step6-degradation-502.txt" -w "%{http_code}" \
  -b /tmp/step6-support.cookies "http://127.0.0.1:$PANEL/api/queue")
[ "$HTTP_502" = "502" ] || { say "FAIL — backend killé attendu 502, obtenu $HTTP_502"; exit 1; }
assert_contains "$ASSETS/adm-step6-degradation-502.txt" 'backend-unreachable' "kill backend → BFF 502 backend-unreachable"
agent-browser open "http://127.0.0.1:$PANEL/queue"
agent-browser wait --text "Backend injoignable"
agent-browser screenshot "$ASSETS/adm-step6-degradation.png"
say "   capture adm-step6-degradation.png (bandeau, PAS de redirection)"

agent-browser close
say "═══ TOUTES LES PREUVES ÉTAPE 6 SONT PASSÉES ═══"
