#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# adm-step7-proof-run — preuves navigateur + curl de la gestion utilisateurs
# (ADM Étape 7)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b/§2c).
#
#   bash scripts/adm-step7-proof-run.sh
#
# Étapes : seed DB preuve (alice riche, cible de suspension à clé réelle,
# poids 3+1, ancien compte -48 h, 22 fillers) → builds (si absents) → serveurs
# standalone :3101 (app principale) + :3102 (panneau) → curl : login support →
# GET /api/users (page 1 : 20 items, totalUsers, nextCursor) → page 2 (items
# distincts) → cursor malformé → 400 → q=alice → 1 résultat → q vide → 400 →
# login auditor → 403 → support POST warn → 403 (lecture seule mutations) →
# POST /ban (interne + BFF) → 404 → probe publication cible → 200 → login
# moderator → warn alice 200 (justification §6) → suspend 24 h 200 → probe
# publication cible → 403 → navigateur : /users (capture annuaire) →
# recherche alice (capture) → fiche alice (capture) → moderator : formulaire
# warn (capture) → confirmé (capture après — fiche rejetée serveur) →
# suspend 24 h (capture fiche suspendu + ban désactivé) → preuve DB
# (AdminAudit warn+suspend §6, UserWarning) → nettoyage.
# Sorties : docs/proofs/assets/adm-step7-*.{png,txt} + journal sur stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
INTERNAL_TOKEN="proof-step7-token-0123456789abcdef0123456789abcdef"
MAIN=3101
PANEL=3102
DB="$ROOT/db/adm-step7-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[proof7] $*"; }
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
json_get() { # fichier, chemin pointé (ex items.0.pseudo)
  bun -e "const b=JSON.parse(require('fs').readFileSync('$1','utf8'));console.log('$2'.split('.').reduce((o,k)=>o?.[k],b))"
}

# ── 0. seed idempotent + secrets ────────────────────────────────────────────
say "0. seed DB de preuve"
rm -f "$DB" "$ROOT/db/adm-step7-secrets.json"
DATABASE_URL="file:$DB" bun scripts/adm-step7-proof-seed.ts > /tmp/step7-seed.log 2>&1
assert_contains /tmp/step7-seed.log '"users":34' "seed : 34 comptes (page 1=20, page 2=14)"
SUPPORT_SECRET=$(bun -e "console.log(require('./db/adm-step7-secrets.json').admins['support@step7.proof'].totpSecret)")
MOD_SECRET=$(bun -e "console.log(require('./db/adm-step7-secrets.json').admins['moderator@step7.proof'].totpSecret)")
AUDITOR_SECRET=$(bun -e "console.log(require('./db/adm-step7-secrets.json').admins['auditor@step7.proof'].totpSecret)")

# ── 0b. tsc --noEmit app + panneau — gate AVANT les builds (Clarification 1,
#      leçon F-17 : un type faux — ex. TS2345 — bloquait le build) ────────────
say "0b. tsc --noEmit app + panneau (gate avant builds — Clarification 1)"
bunx tsc --noEmit > /tmp/step7-tsc-main.log 2>&1 \
  || { say "FAIL — tsc app principale : erreurs de type (extrait)"; tail -40 /tmp/step7-tsc-main.log; exit 1; }
(cd admin && bunx tsc --noEmit) > /tmp/step7-tsc-panel.log 2>&1 \
  || { say "FAIL — tsc panneau admin : erreurs de type (extrait)"; tail -40 /tmp/step7-tsc-panel.log; exit 1; }

# ── 1. builds production (DEV-SETUP §2c) ────────────────────────────────────
if [ ! -f .next/standalone/server.js ]; then
  say "1a. build app principale…"
  NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/step7-build-main.log 2>&1
fi
if [ ! -f admin/.next/standalone/server.js ]; then
  say "1b. build panneau admin…"
  (cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" bunx next build > /tmp/step7-build-panel.log 2>&1)
  cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
  mkdir -p admin/.next/standalone/public
  cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true
fi

# ── 2. serveurs standalone ──────────────────────────────────────────────────
say "2. démarrage des serveurs (:3101 principale, :3102 panneau)"
DATABASE_URL="file:$DB" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/step7-main.log 2>&1 &
MAIN_PID=$!
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    BACKEND_INTERNAL_URL="http://127.0.0.1:$MAIN" PORT=$PANEL HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/step7-panel.log 2>&1 ) &
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

# ── 3. curl — login support + GET /api/users (page 1) ───────────────────────
say "3. curl — login support + GET /api/users"
SUPPORT_CODE=$(totp_code "$SUPPORT_SECRET" 0)
curl -s -c /tmp/step7-support.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.1" \
  -d "{\"email\":\"support@step7.proof\",\"password\":\"Step7-Proof-Passw0rd!.support\",\"totp\":\"$SUPPORT_CODE\"}" \
  > "$ASSETS/adm-step7-login-support.txt"
assert_contains "$ASSETS/adm-step7-login-support.txt" '"role":"support"' "login support → 200 rôle support"
CSRF=$(json_get "$ASSETS/adm-step7-login-support.txt" csrfToken)
ACTOR=$(json_get "$ASSETS/adm-step7-login-support.txt" adminUserId)
[ -n "$CSRF" ] && [ -n "$ACTOR" ] || { say "FAIL — csrf/actor absents du login"; exit 1; }

curl -s -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users" > "$ASSETS/adm-step7-users-page1.txt"
assert_contains "$ASSETS/adm-step7-users-page1.txt" '"mode":"list"' "annuaire : mode liste (cursor)"
P1_LEN=$(bun -e "const b=JSON.parse(require('fs').readFileSync('$ASSETS/adm-step7-users-page1.txt','utf8'));console.log(b.items.length)")
[ "$P1_LEN" = "20" ] || { say "FAIL — page 1 attendue 20 items, obtenue $P1_LEN"; exit 1; }
say "PASS — page 1 = 20 comptes (directive)"
NEXT_CURSOR=$(json_get "$ASSETS/adm-step7-users-page1.txt" nextCursor)
[ -n "$NEXT_CURSOR" ] && [ "$NEXT_CURSOR" != "null" ] || { say "FAIL — nextCursor absent"; exit 1; }

say "3b. page 2 via curseur — items DISTINCTS"
curl -s -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users?cursor=$(bun -e "console.log(encodeURIComponent('$NEXT_CURSOR'))")" > "$ASSETS/adm-step7-users-page2.txt"
assert_contains "$ASSETS/adm-step7-users-page2.txt" '"items"' "page 2 servie"
OVERLAP=$(bun -e "
const fs=require('fs');
const p1=JSON.parse(fs.readFileSync('$ASSETS/adm-step7-users-page1.txt','utf8')).items.map(i=>i.pubkey);
const p2=JSON.parse(fs.readFileSync('$ASSETS/adm-step7-users-page2.txt','utf8')).items.map(i=>i.pubkey);
console.log(p2.filter(id=>p1.includes(id)).length);")
[ "$OVERLAP" = "0" ] || { say "FAIL — chevauchement page 1/page 2 : $OVERLAP"; exit 1; }
say "PASS — page 2 : 0 chevauchement avec la page 1 (cursor keyset)"

say "3c. cursor malformé → 400 · q vide → 400"
HTTP_BAD=$(curl -s -o "$ASSETS/adm-step7-cursor-bad.txt" -w "%{http_code}" \
  -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users?cursor=pas-du-base64!!")
[ "$HTTP_BAD" = "400" ] || { say "FAIL — cursor malformé attendu 400, obtenu $HTTP_BAD"; exit 1; }
HTTP_QEMPTY=$(curl -s -o "$ASSETS/adm-step7-q-empty.txt" -w "%{http_code}" \
  -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users?q=")
[ "$HTTP_QEMPTY" = "400" ] || { say "FAIL — q vide attendu 400, obtenu $HTTP_QEMPTY"; exit 1; }
say "PASS — validations 400 propagées (cursor, q vide)"

say "3d. recherche q=alice → 1 résultat (fiche joignable)"
curl -s -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users?q=alice" > "$ASSETS/adm-step7-search-alice.txt"
assert_contains "$ASSETS/adm-step7-search-alice.txt" '"pseudo":"Alice Kinshasa"' "recherche alice → 1 résultat"
ALICE_PUBKEY=$(json_get "$ASSETS/adm-step7-search-alice.txt" items.0.pubkey)
curl -s -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users/$ALICE_PUBKEY" > "$ASSETS/adm-step7-fiche-alice.txt"
assert_contains "$ASSETS/adm-step7-fiche-alice.txt" '"pseudo":"Alice Kinshasa"' "fiche alice → 200 (données publiques)"
assert_contains "$ASSETS/adm-step7-fiche-alice.txt" 'marché central' "fiche : la bio publique est servie"

say "3e. ANTI-FUITE : aucun email/password/IP dans annuaire et fiche"
if grep -qE '"email"|"password"|"ip"' "$ASSETS/adm-step7-users-page1.txt" "$ASSETS/adm-step7-fiche-alice.txt"; then
  say "FAIL — donnée privée détectée dans le payload"; exit 1
fi
say "PASS — payload sans email/password/IP (invariants §1)"

# ── 4. curl — auditor → 403 (arbitrage §13.1) ───────────────────────────────
say "4. curl — login auditor → 403 sur /api/users"
AUDITOR_CODE=$(totp_code "$AUDITOR_SECRET" 0)
curl -s -c /tmp/step7-auditor.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.2" \
  -d "{\"email\":\"auditor@step7.proof\",\"password\":\"Step7-Proof-Passw0rd!.auditor\",\"totp\":\"$AUDITOR_CODE\"}" \
  > "$ASSETS/adm-step7-login-auditor.txt"
assert_contains "$ASSETS/adm-step7-login-auditor.txt" '"role":"auditor"' "login auditor → 200"
HTTP_AUD=$(curl -s -o "$ASSETS/adm-step7-auditor-403.txt" -w "%{http_code}" \
  -b /tmp/step7-auditor.cookies "http://127.0.0.1:$PANEL/api/users")
[ "$HTTP_AUD" = "403" ] || { say "FAIL — auditor attendu 403, obtenu $HTTP_AUD"; exit 1; }
assert_contains "$ASSETS/adm-step7-auditor-403.txt" 'unauthorized' "auditor → 403 uniforme (§13.1)"

# ── 5. curl — support POST warn → 403 (lecture seule mutations) ─────────────
say "5. curl — support POST warn → 403 (directive : mutations = moderator)"
HTTP_SUP=$(curl -s -o "$ASSETS/adm-step7-support-warn-403.txt" -w "%{http_code}" \
  -b /tmp/step7-support.cookies -X POST "http://127.0.0.1:$PANEL/api/users/$ALICE_PUBKEY/warn" \
  -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF" \
  -d '{"category":"SPAM","justification":"tentative support — doit être refusée"}')
[ "$HTTP_SUP" = "403" ] || { say "FAIL — support warn attendu 403, obtenu $HTTP_SUP"; exit 1; }
say "PASS — support → 403 sur warn (lecture seule mutations)"

# ── 6. curl — ban → 404 (four-eyes Étape 9, arbitrage §13.9) ────────────────
say "6. curl — AUCUNE route ban (interne + BFF)"
HTTP_BAN_BFF=$(curl -s -o "$ASSETS/adm-step7-ban-404-bff.txt" -w "%{http_code}" \
  -b /tmp/step7-support.cookies -X POST "http://127.0.0.1:$PANEL/api/users/$ALICE_PUBKEY/ban" \
  -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF" \
  -d '{"category":"SPAM","justification":"ban doit être refusé — four-eyes Étape 9"}')
[ "$HTTP_BAN_BFF" = "404" ] || { say "FAIL — BFF ban attendu 404, obtenu $HTTP_BAN_BFF"; exit 1; }
HTTP_BAN_INT=$(curl -s -o "$ASSETS/adm-step7-ban-404-internal.txt" -w "%{http_code}" \
  -H "x-admin-internal: $INTERNAL_TOKEN" -X POST "http://127.0.0.1:$MAIN/api/internal/admin/users/$ALICE_PUBKEY/ban" \
  -H "Content-Type: application/json" \
  -d '{"category":"SPAM","justification":"ban doit être refusé — four-eyes Étape 9"}')
[ "$HTTP_BAN_INT" = "404" ] || { say "FAIL — interne ban attendu 404, obtenu $HTTP_BAN_INT"; exit 1; }
say "PASS — ban → 404 sur les DEUX surfaces (arbitrage §13.9)"

# ── 7. probe publication — AVANT suspension ─────────────────────────────────
say "7. probe publication cible (clé réelle) — avant suspension : 200"
PROBE1=$(bun scripts/adm-step7-posts-probe.ts "http://127.0.0.1:$MAIN" > "$ASSETS/adm-step7-probe-before.txt" 2>&1 && cat "$ASSETS/adm-step7-probe-before.txt")
assert_contains "$ASSETS/adm-step7-probe-before.txt" '"status":200' "probe AVANT suspension → 200 (témoin)"

# ── 8. navigateur — support : annuaire + recherche + fiche ──────────────────
say "8. navigateur — login support → /users (capture annuaire)"
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
SUPPORT_CODE_BROWSER=$(totp_code "$SUPPORT_SECRET" 1)  # fenêtre N+1 : anti-rejeu Étape 3
agent-browser find label "Email" fill "support@step7.proof"
agent-browser find label "Mot de passe" fill "Step7-Proof-Passw0rd!.support"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SUPPORT_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "support@step7.proof" \
  || { agent-browser screenshot /tmp/step7-debug-login.png; agent-browser errors; exit 1; }
say "   login navigateur OK"
agent-browser open "http://127.0.0.1:$PANEL/users"
agent-browser wait --text "Comptes du réseau"
# page 1 = 20 comptes les plus RÉCENTS (tri inscription DESC — arbitrage §13.8)
# → les fillers créés en dernier ; Alice est retrouvée via la recherche (8b).
agent-browser wait --text "zz-filler-22"
agent-browser screenshot "$ASSETS/adm-step7-users-list.png"
say "   capture adm-step7-users-list.png (annuaire page 1, colonnes directive)"

say "8b. recherche navigateur — « alice »"
agent-browser find label "Recherche par pseudo" fill "alice"
agent-browser find role button click --name "Rechercher"
agent-browser wait --text "1 résultat(s)"
agent-browser screenshot "$ASSETS/adm-step7-users-search.png"
say "   capture adm-step7-users-search.png (recherche LIKE)"

say "8c. fiche alice (support — lecture seule mutations)"
agent-browser find role link click --name "Fiche →"
agent-browser wait --text "Fiche utilisateur"
agent-browser wait --text "Alice Kinshasa"
agent-browser wait --text "Reports ouverts reçus"
agent-browser screenshot "$ASSETS/adm-step7-fiche-support.png"
say "   capture adm-step7-fiche-support.png (fiche, données publiques uniquement)"

# ── 9. navigateur — moderator : warn puis suspend ───────────────────────────
say "9. navigateur — re-login moderator → fiche alice → warn (justification §6)"
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
agent-browser wait --text "Se connecter"
MOD_CODE_BROWSER=$(totp_code "$MOD_SECRET" 0)
agent-browser find label "Email" fill "moderator@step7.proof"
agent-browser find label "Mot de passe" fill "Step7-Proof-Passw0rd!.moderator"
agent-browser find label "Code TOTP (6 chiffres)" fill "$MOD_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "moderator@step7.proof" \
  || { agent-browser screenshot /tmp/step7-debug-login-mod.png; agent-browser errors; exit 1; }
agent-browser open "http://127.0.0.1:$PANEL/users/$ALICE_PUBKEY"
agent-browser wait --text "Alice Kinshasa"
agent-browser find role button click --name "Avertir" || { agent-browser errors; exit 1; }
agent-browser wait --text "justification obligatoire"
agent-browser find label "Texte de justification" fill "Spam répété sur le fil public — avertissement après 1 signalement vérifié"
agent-browser screenshot "$ASSETS/adm-step7-warn-form.png"
say "   capture adm-step7-warn-form.png (formulaire §6)"
agent-browser find role button click --name "Confirmer (attend le serveur)"
agent-browser wait --text "OK (2xx)" \
  || { agent-browser screenshot /tmp/step7-debug-warn.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step7-after-warn.png"
say "   capture adm-step7-after-warn.png (notice 2xx + fiche rejetée depuis le serveur)"
agent-browser wait --text "Historique des actions admin (1)"

say "9b. suspend 24 h (dropdown durée + justification)"
agent-browser find role button click --name "Suspendre…"
agent-browser wait --text "Durée"
agent-browser find label "Texte de justification" fill "Relais de spam confirmé — suspension temporaire 24 h pour contraindre l'arrêt"
agent-browser screenshot "$ASSETS/adm-step7-suspend-form.png"
say "   capture adm-step7-suspend-form.png (dropdown 24h/7j/30j)"
agent-browser find role button click --name "Confirmer (attend le serveur)"
agent-browser wait --text "suspendu" \
  || { agent-browser screenshot /tmp/step7-debug-suspend.png; agent-browser errors; exit 1; }
agent-browser wait --text "Lever la suspension"
agent-browser screenshot "$ASSETS/adm-step7-after-suspend.png"
say "   capture adm-step7-after-suspend.png (fiche suspendu + ban désactivé + levée offerte)"

# ── 10. curl suspend cible → 200 puis probe publication → 403 (A3) ──────────
say "10. curl — moderator suspend la cible (24h) → 200 · probe → 403"
MOD_CODE_CURL=$(totp_code "$MOD_SECRET" 1) # fenêtre N+1 — le navigateur a brûlé la fenêtre 0 (anti-rejeu É3)
curl -s -c /tmp/step7-mod.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.3" \
  -d "{\"email\":\"moderator@step7.proof\",\"password\":\"Step7-Proof-Passw0rd!.moderator\",\"totp\":\"$MOD_CODE_CURL\"}" \
  > "$ASSETS/adm-step7-login-moderator.txt"
assert_contains "$ASSETS/adm-step7-login-moderator.txt" '"role":"moderator"' "login moderator (curl) → 200"
MOD_CSRF=$(json_get "$ASSETS/adm-step7-login-moderator.txt" csrfToken)
SUSP_PUBKEY=$(bun -e "console.log(require('./db/adm-step7-secrets.json').suspTarget.pubkey)")
HTTP_SUSP=$(curl -s -o "$ASSETS/adm-step7-suspend-200.txt" -w "%{http_code}" \
  -b /tmp/step7-mod.cookies -X POST "http://127.0.0.1:$PANEL/api/users/$SUSP_PUBKEY/suspend" \
  -H "Content-Type: application/json" -H "x-admin-csrf: $MOD_CSRF" \
  -d '{"category":"SPAM","duration":"24h","justification":"Relais de spam confirmé — suspension temporaire 24 h (preuve curl)"}')
[ "$HTTP_SUSP" = "200" ] || { say "FAIL — suspend attendu 200, obtenu $HTTP_SUSP"; exit 1; }
assert_contains "$ASSETS/adm-step7-suspend-200.txt" '"suspendedUntil"' "suspend → 200 + suspendedUntil posé"
bun scripts/adm-step7-posts-probe.ts "http://127.0.0.1:$MAIN" > "$ASSETS/adm-step7-probe-during.txt" 2>&1 || true
assert_contains "$ASSETS/adm-step7-probe-during.txt" '"status":403' "probe PENDANT suspension → 403 (publication refusée)"
assert_contains "$ASSETS/adm-step7-probe-during.txt" 'suspendu' "refus 403 = compte suspendu (message A3)"
curl -s -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users/$ALICE_PUBKEY" > "$ASSETS/adm-step7-fiche-after-actions.txt"
assert_contains "$ASSETS/adm-step7-fiche-after-actions.txt" '"status":"suspendu"' "fiche reflète la suspension (actif → suspendu)"
assert_contains "$ASSETS/adm-step7-fiche-after-actions.txt" '"warnings":1' "compteur avertissements = 1"

# ── 11. preuve DB — audit append-only + UserWarning ─────────────────────────
say "11. preuve DB — AdminAudit (format §6) + UserWarning + ModerationAction"
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  const audits = await db.adminAudit.findMany({
    where:{ targetType:'user', targetId:'$ALICE_PUBKEY' },
    orderBy:{ createdAt:'asc' },
    select:{ action:true, actorRole:true, justification:true },
  });
  const w = await db.userWarning.findFirst({ where:{ user:{ pubkey:'$ALICE_PUBKEY' } } });
  const out = { audits, warning: w ? { category: w.category, note: w.note } : null };
  require('fs').writeFileSync('$ASSETS/adm-step7-audit-db.txt', JSON.stringify(out,null,2));
  console.log(JSON.stringify(out));
  if (audits.length !== 2) { console.error('attendu 2 lignes audit (warn+suspend)'); process.exit(1); }
  if (!audits[0].justification?.startsWith('SPAM: ')) { console.error('justification warn malformée'); process.exit(1); }
  if (!audits[1].justification?.startsWith('SPAM: ')) { console.error('justification suspend malformée'); process.exit(1); }
  if (!w || w.category !== 'SPAM') { console.error('UserWarning absent'); process.exit(1); }
  process.exit(0);
})();" > /dev/null
say "   PASS — AdminAudit warn+suspend (justification §6) + UserWarning en DB"

# ── 12. DÉGRADATION — kill backend → 502 ────────────────────────────────────
say "12. kill backend → 502 (curl, sémantique BFF Étape 6)"
kill "$MAIN_PID" 2>/dev/null || true
sleep 2
HTTP_502=$(curl -s -o "$ASSETS/adm-step7-degradation-502.txt" -w "%{http_code}" \
  -b /tmp/step7-support.cookies "http://127.0.0.1:$PANEL/api/users")
[ "$HTTP_502" = "502" ] || { say "FAIL — backend killé attendu 502, obtenu $HTTP_502"; exit 1; }
assert_contains "$ASSETS/adm-step7-degradation-502.txt" 'backend-unreachable' "kill backend → BFF 502 backend-unreachable"

say "TERMINÉ — preuves Étape 7 : $ASSETS/adm-step7-*.{png,txt}"
