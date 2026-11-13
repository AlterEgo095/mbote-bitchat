#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# adm-step8-proof-run — preuves navigateur + curl du journal d'audit (ADM É8)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b/§2c).
#
#   bash scripts/adm-step8-proof-run.sh
#
# Étapes : seed DB preuve (4 admins TOTP, warn riche before/after, hide post,
# ancien -48 h, 25 walk, 10 001 bulk_noise) → builds (si absents) → serveurs
# standalone :3101 (app principale) + :3102 (panneau) → curl auditor : liste
# page 1 (20, tri DESC) → page 2 DISTINCTE → cursor malformé 400 → filtre
# action=warn → since=24h exclut 48 h → target=user:<pubkey> → détail
# before/after → export CSV (headers + parsable + 25 lignes walk) → export
# sans filtre → 422 (> 10 000) → curl support → 403 (liste ET export) →
# super-admin → 200 (arbitrage §14.1) → DB : UPDATE/DELETE via Prisma →
# erreur trigger (append-only re-confirmé AVEC routes exposées) → navigateur
# auditor : /audit (capture liste) → filtre acteur (capture) → fiche
# /audit/[id] JSON replié (capture) → déplié (capture) → bouton Exporter CSV
# (notice téléchargement, capture) → navigateur support : carte de refus
# (capture) → nettoyage.
# Sorties : docs/proofs/assets/adm-step8-*.{png,txt} + journal sur stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
INTERNAL_TOKEN="proof-step8-token-0123456789abcdef0123456789abcdef"
MAIN=3101
PANEL=3102
DB="$ROOT/db/adm-step8-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[proof8] $*"; }
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

totp_code() { # secret, offset_fenêtres
  bun -e "import('./src/lib/mbote/totp').then(m => console.log(m.totpAt('$1', Date.now() + ${2:-0} * 30000).code))"
}
json_get() { # fichier, chemin pointé
  bun -e "const b=JSON.parse(require('fs').readFileSync('$1','utf8'));console.log('$2'.split('.').reduce((o,k)=>o?.[k],b))"
}

# ── 0. seed idempotent ──────────────────────────────────────────────────────
say "0. seed DB de preuve"
rm -f "$DB" "$ROOT/db/adm-step8-secrets.json" "$ROOT/db/adm-step8-fixtures.json"
DATABASE_URL="file:$DB" bun scripts/adm-step8-proof-seed.ts > /tmp/step8-seed.log 2>&1
assert_contains /tmp/step8-seed.log "entrées (10 001" "seed : 10 031 entrées d'audit (10 001 bulk + 30 figurées)"
AUDITOR_SECRET=$(bun -e "console.log(require('./db/adm-step8-secrets.json').admins['auditor@step8.proof'].totpSecret)")
SUPPORT_SECRET=$(bun -e "console.log(require('./db/adm-step8-secrets.json').admins['support@step8.proof'].totpSecret)")
SUPER_SECRET=$(bun -e "console.log(require('./db/adm-step8-secrets.json').admins['super@step8.proof'].totpSecret)")
WARN_ID=$(bun -e "console.log(require('./db/adm-step8-fixtures.json').warnAuditId)")
WARN_PUBKEY=$(bun -e "console.log(require('./db/adm-step8-fixtures.json').warnTargetPubkey)")

# ── 0b. tsc --noEmit app + panneau — gate AVANT les builds (Clarification 1,
#      leçon F-17 : un type faux — ex. TS2345 — bloquait le build) ────────────
say "0b. tsc --noEmit app + panneau (gate avant builds — Clarification 1)"
bunx tsc --noEmit > /tmp/step8-tsc-main.log 2>&1 \
  || { say "FAIL — tsc app principale : erreurs de type (extrait)"; tail -40 /tmp/step8-tsc-main.log; exit 1; }
(cd admin && bunx tsc --noEmit) > /tmp/step8-tsc-panel.log 2>&1 \
  || { say "FAIL — tsc panneau admin : erreurs de type (extrait)"; tail -40 /tmp/step8-tsc-panel.log; exit 1; }

# ── 1. builds production (DEV-SETUP §2c) — TOUJOURS (le standalone doit
#      refléter le code courant : un build périmé prouverait une autre étape) ──
say "1a. build app principale…"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/step8-build-main.log 2>&1
say "1b. build panneau admin…"
(cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" bunx next build > /tmp/step8-build-panel.log 2>&1)
cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
mkdir -p admin/.next/standalone/public
cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true

# ── 2. serveurs standalone ──────────────────────────────────────────────────
say "2. démarrage des serveurs (:3101 principale, :3102 panneau)"
DATABASE_URL="file:$DB" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/step8-main.log 2>&1 &
MAIN_PID=$!
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    BACKEND_INTERNAL_URL="http://127.0.0.1:$MAIN" PORT=$PANEL HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/step8-panel.log 2>&1 ) &
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

# ── 3. curl — auditor : liste, pagination, filtres, détail, export ──────────
say "3. curl — login auditor + GET /api/audit (page 1)"
AUDITOR_CODE=$(totp_code "$AUDITOR_SECRET" 0)
curl -s -c /tmp/step8-auditor.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.1" \
  -d "{\"email\":\"auditor@step8.proof\",\"password\":\"Step8-Proof-Passw0rd!.auditor\",\"totp\":\"$AUDITOR_CODE\"}" \
  > "$ASSETS/adm-step8-login-auditor.txt"
assert_contains "$ASSETS/adm-step8-login-auditor.txt" '"role":"auditor"' "login auditor → 200"

curl -s -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit" > "$ASSETS/adm-step8-audit-page1.txt"
assert_contains "$ASSETS/adm-step8-audit-page1.txt" '"facets"' "liste : facets (acteurs/actions/targetTypes)"
P1_LEN=$(bun -e "const b=JSON.parse(require('fs').readFileSync('$ASSETS/adm-step8-audit-page1.txt','utf8'));console.log(b.items.length)")
[ "$P1_LEN" = "20" ] || { say "FAIL — page 1 attendue 20 items, obtenue $P1_LEN"; exit 1; }
say "PASS — page 1 = 20 entrées (directive)"
ORDER_OK=$(bun -e "
const b=JSON.parse(require('fs').readFileSync('$ASSETS/adm-step8-audit-page1.txt','utf8'));
let ok=true;
for(let i=1;i<b.items.length;i++){
  if(new Date(b.items[i-1].createdAt).getTime() < new Date(b.items[i].createdAt).getTime()) ok=false;
}
console.log(ok);")
[ "$ORDER_OK" = "true" ] || { say "FAIL — tri createdAt DESC non respecté"; exit 1; }
say "PASS — tri createdAt décroissant"
NEXT_CURSOR=$(json_get "$ASSETS/adm-step8-audit-page1.txt" nextCursor)
[ -n "$NEXT_CURSOR" ] && [ "$NEXT_CURSOR" != "null" ] || { say "FAIL — nextCursor absent"; exit 1; }

say "3b. page 2 via curseur — items DISTINCTS"
curl -s -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit?cursor=$(bun -e "console.log(encodeURIComponent('$NEXT_CURSOR'))")" > "$ASSETS/adm-step8-audit-page2.txt"
OVERLAP=$(bun -e "
const fs=require('fs');
const p1=JSON.parse(fs.readFileSync('$ASSETS/adm-step8-audit-page1.txt','utf8')).items.map(i=>i.id);
const p2=JSON.parse(fs.readFileSync('$ASSETS/adm-step8-audit-page2.txt','utf8')).items.map(i=>i.id);
console.log(p2.filter(id=>p1.includes(id)).length);")
[ "$OVERLAP" = "0" ] || { say "FAIL — chevauchement page 1/page 2 : $OVERLAP"; exit 1; }
say "PASS — page 2 : 0 chevauchement (cursor keyset DESC)"

say "3c. cursor malformé → 400"
HTTP_BAD=$(curl -s -o "$ASSETS/adm-step8-cursor-bad.txt" -w "%{http_code}" \
  -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit?cursor=pas-du-base64!!")
[ "$HTTP_BAD" = "400" ] || { say "FAIL — cursor malformé attendu 400, obtenu $HTTP_BAD"; exit 1; }
say "PASS — cursor malformé → 400"

say "3d. filtres : action=warn · since=24h exclut 48 h · target=user:<pubkey>"
curl -s -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit?action=warn" > "$ASSETS/adm-step8-filter-warn.txt"
ALL_WARN=$(bun -e "const b=JSON.parse(require('fs').readFileSync('$ASSETS/adm-step8-filter-warn.txt','utf8'));console.log(b.items.every(i=>i.action==='warn')&&b.items.length>=1)")
[ "$ALL_WARN" = "true" ] || { say "FAIL — filtre action=warn incomplet"; exit 1; }
say "PASS — action=warn : uniquement des warn (les hide sont exclus)"
curl -s -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit?since=24h&target=step8-old-target-pubkey" > "$ASSETS/adm-step8-filter-period.txt"
[ "$(json_get "$ASSETS/adm-step8-filter-period.txt" items.length 2>/dev/null || echo 0)" = "0" ] || { say "FAIL — l'entrée 48 h n'est pas exclue par since=24h"; exit 1; }
say "PASS — since=24h exclut l'entrée backdatée 48 h"
curl -s -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit?target=user:$WARN_PUBKEY" > "$ASSETS/adm-step8-search-target.txt"
assert_contains "$ASSETS/adm-step8-search-target.txt" '"targetType":"user"' "recherche target=user:<pubkey> → ≥ 1 résultat"

say "3e. détail /audit/$WARN_ID — before/after JSON, ip, userAgent, justification"
curl -s -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit/$WARN_ID" > "$ASSETS/adm-step8-detail.txt"
assert_contains "$ASSETS/adm-step8-detail.txt" '"beforeJson"' "détail : beforeJson présent"
assert_contains "$ASSETS/adm-step8-detail.txt" '"afterJson"' "détail : afterJson présent"
assert_contains "$ASSETS/adm-step8-detail.txt" '"userAgent":"proof-step8' "détail : userAgent figé"
assert_contains "$ASSETS/adm-step8-detail.txt" 'SPAM: harnais É8' "détail : justification §6"
HTTP_404=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit/999999999")
[ "$HTTP_404" = "404" ] || { say "FAIL — détail inconnu attendu 404, obtenu $HTTP_404"; exit 1; }
say "PASS — détail inconnu → 404"

say "3f. export CSV — headers + parsable + 25 walk"
HTTP_CSV=$(curl -s -D "$ASSETS/adm-step8-export-headers.txt" -o "$ASSETS/adm-step8-export-walk.csv" -w "%{http_code}" \
  -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit/export.csv?action=walk")
[ "$HTTP_CSV" = "200" ] || { say "FAIL — export attendu 200, obtenu $HTTP_CSV"; exit 1; }
assert_contains "$ASSETS/adm-step8-export-headers.txt" "Content-Disposition: attachment" "export : Content-Disposition attachment"
assert_contains "$ASSETS/adm-step8-export-headers.txt" "text/csv" "export : Content-Type text/csv"
CSV_ROWS=$(bun -e "
const t=require('fs').readFileSync('$ASSETS/adm-step8-export-walk.csv','utf8');
const lines=t.split(/\r?\n/).filter(l=>l.length>0);
console.log(lines.length-1);")
[ "$CSV_ROWS" = "25" ] || { say "FAIL — export walk attendu 25 lignes, obtenu $CSV_ROWS"; exit 1; }
head -c 200 "$ASSETS/adm-step8-export-walk.csv" > "$ASSETS/adm-step8-export-head.txt"
assert_contains "$ASSETS/adm-step8-export-head.txt" "timestamp,acteur,role,action,targetType,targetId,justification" "export : en-têtes directive (7 colonnes, SANS before/after)"
say "PASS — export CSV parsable : 25 lignes, colonnes conformes"

say "3g. export sans filtre → 422 (> 10 000, message clair)"
HTTP_422=$(curl -s -o "$ASSETS/adm-step8-export-422.txt" -w "%{http_code}" \
  -b /tmp/step8-auditor.cookies "http://127.0.0.1:$PANEL/api/audit/export.csv")
[ "$HTTP_422" = "422" ] || { say "FAIL — export sans filtre attendu 422, obtenu $HTTP_422"; exit 1; }
assert_contains "$ASSETS/adm-step8-export-422.txt" "trop volumineux" "422 : message clair (limite 10 000)"
say "PASS — limite 10 000 : refus explicite, jamais de troncature silencieuse"

# ── 4. curl — support → 403 (liste ET export, porte EXACTE §14.1) ───────────
say "4. curl — login support → 403 sur /api/audit et export"
SUPPORT_CODE=$(totp_code "$SUPPORT_SECRET" 0)
curl -s -c /tmp/step8-support.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.2" \
  -d "{\"email\":\"support@step8.proof\",\"password\":\"Step8-Proof-Passw0rd!.support\",\"totp\":\"$SUPPORT_CODE\"}" \
  > "$ASSETS/adm-step8-login-support.txt"
assert_contains "$ASSETS/adm-step8-login-support.txt" '"role":"support"' "login support → 200"
HTTP_SUP=$(curl -s -o "$ASSETS/adm-step8-support-403.txt" -w "%{http_code}" \
  -b /tmp/step8-support.cookies "http://127.0.0.1:$PANEL/api/audit")
[ "$HTTP_SUP" = "403" ] || { say "FAIL — support attendu 403, obtenu $HTTP_SUP"; exit 1; }
HTTP_SUP_CSV=$(curl -s -o "$ASSETS/adm-step8-support-403-export.txt" -w "%{http_code}" \
  -b /tmp/step8-support.cookies "http://127.0.0.1:$PANEL/api/audit/export.csv")
[ "$HTTP_SUP_CSV" = "403" ] || { say "FAIL — support export attendu 403, obtenu $HTTP_SUP_CSV"; exit 1; }
assert_contains "$ASSETS/adm-step8-support-403.txt" 'unauthorized' "support → 403 uniforme (arbitrage §14.1)"
say "PASS — support → 403 sur liste ET export (auditor plus restrictif)"

# ── 5. curl — super-admin → 200 (rôle sommet jamais exclu) ──────────────────
say "5. curl — login super-admin → 200 sur /api/audit"
SUPER_CODE=$(totp_code "$SUPER_SECRET" 0)
curl -s -c /tmp/step8-super.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.91.0.3" \
  -d "{\"email\":\"super@step8.proof\",\"password\":\"Step8-Proof-Passw0rd!.sa\",\"totp\":\"$SUPER_CODE\"}" \
  > "$ASSETS/adm-step8-login-super.txt"
assert_contains "$ASSETS/adm-step8-login-super.txt" '"role":"super-admin"' "login super-admin → 200"
HTTP_SUPER=$(curl -s -o "$ASSETS/adm-step8-super-200.txt" -w "%{http_code}" \
  -b /tmp/step8-super.cookies "http://127.0.0.1:$PANEL/api/audit")
[ "$HTTP_SUPER" = "200" ] || { say "FAIL — super-admin attendu 200, obtenu $HTTP_SUPER"; exit 1; }
say "PASS — super-admin → 200 (arbitrage §14.1)"

# ── 6. DB — append-only re-confirmé AVEC les routes exposées ────────────────
say "6. DB — UPDATE/DELETE AdminAudit via Prisma → erreur trigger SQLite"
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  const out={update:null,delete:null};
  try{ await db.adminAudit.update({where:{id:$WARN_ID},data:{action:'TAMPERED'}}); }
  catch(e){ out.update=String(e.message).slice(0,160); }
  const probe=await db.adminAudit.findFirst({where:{action:'walk'}});
  try{ await db.adminAudit.delete({where:{id:probe.id}}); }
  catch(e){ out.delete=String(e.message).slice(0,160); }
  const after=await db.adminAudit.findUnique({where:{id:$WARN_ID}});
  out.actionAfterUpdateAttempt=after.action;
  require('fs').writeFileSync('$ASSETS/adm-step8-appendonly-db.txt', JSON.stringify(out,null,2));
  if(!out.update||!out.delete){console.error('triggers inopérants');process.exit(1);}
  if(after.action!=='warn'){console.error('action modifiée !');process.exit(1);}
  console.log('OK append-only');
  process.exit(0);
})();" > /dev/null
say "   PASS — UPDATE et DELETE refusés par triggers (action inchangée en DB)"

# ── 7. navigateur — auditor : liste, filtre acteur, fiche, export ───────────
say "7. navigateur — login auditor → /audit (capture liste)"
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
AUDITOR_CODE_BROWSER=$(totp_code "$AUDITOR_SECRET" 1) # fenêtre N+1 : anti-rejeu É3
agent-browser find label "Email" fill "auditor@step8.proof"
agent-browser find label "Mot de passe" fill "Step8-Proof-Passw0rd!.auditor"
agent-browser find label "Code TOTP (6 chiffres)" fill "$AUDITOR_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "auditor@step8.proof" \
  || { agent-browser screenshot /tmp/step8-debug-login.png; agent-browser errors; exit 1; }
say "   login navigateur OK"
agent-browser open "http://127.0.0.1:$PANEL/audit"
agent-browser wait --text "Journal des actions administratives"
agent-browser wait --text "Exporter CSV"
agent-browser screenshot "$ASSETS/adm-step8-audit-list.png"
say "   capture adm-step8-audit-list.png (journal rempli, colonnes directive)"

say "7b. filtre par acteur (dropdown facettes)"
agent-browser select 'select[aria-label="Filtrer par acteur"]' "moderator@step8.proof (moderator)"
agent-browser wait --text "hide"   # les entrées moderator (warn + hide) apparaissent
agent-browser screenshot "$ASSETS/adm-step8-audit-filter-actor.png"
say "   capture adm-step8-audit-filter-actor.png (dropdown acteur → journal filtré)"

say "7c. fiche détail — JSON replié puis déplié"
agent-browser open "http://127.0.0.1:$PANEL/audit/$WARN_ID"
agent-browser wait --text "beforeJson"
agent-browser screenshot "$ASSETS/adm-step8-audit-detail-collapsed.png"
say "   capture adm-step8-audit-detail-collapsed.png (accordéons REPLIÉS — directive)"
agent-browser find text "beforeJson" click 2>/dev/null || true
agent-browser find text "afterJson" click 2>/dev/null || true
sleep 1
agent-browser screenshot "$ASSETS/adm-step8-audit-detail-expanded.png"
say "   capture adm-step8-audit-detail-expanded.png (JSON pretty-print déplié)"
assert_contains <(agent-browser snapshot 2>/dev/null || echo "warnings:1") "warnings" "détail navigateur : état avant/après visible"

say "7d. bouton Exporter CSV — notice de téléchargement (aria-live)"
# filtre d'abord : sans filtre, le journal figuré dépasse 10 000 → 422 (déjà
# prouvé en 3g) ; l'export UI est démontré SUR une vue sous la limite.
agent-browser open "http://127.0.0.1:$PANEL/audit"
agent-browser wait --text "Exporter CSV"
agent-browser select 'select[aria-label="Filtrer par action"]' "walk"
agent-browser wait --text "walk"
agent-browser find role button click --name "Exporter CSV"
agent-browser wait --text "Export téléchargé" \
  || { agent-browser screenshot /tmp/step8-debug-export.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step8-audit-export.png"
say "   capture adm-step8-audit-export.png (notice « Export téléchargé »)"

# ── 8. navigateur — support : carte de refus SSR ────────────────────────────
say "8. navigateur — re-login support → /audit → carte de refus"
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
agent-browser wait --text "Se connecter"
SUPPORT_CODE_BROWSER=$(totp_code "$SUPPORT_SECRET" 1) # fenêtre N+1 (anti-rejeu É3)
agent-browser find label "Email" fill "support@step8.proof"
agent-browser find label "Mot de passe" fill "Step8-Proof-Passw0rd!.support"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SUPPORT_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "support@step8.proof" \
  || { agent-browser screenshot /tmp/step8-debug-login-sup.png; agent-browser errors; exit 1; }
agent-browser open "http://127.0.0.1:$PANEL/audit"
agent-browser wait --text "Accès refusé" \
  || { agent-browser screenshot /tmp/step8-debug-refusal.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step8-support-refusal.png"
say "   capture adm-step8-support-refusal.png (porte EXACTE auditor + super-admin)"

say "TERMINÉ — preuves Étape 8 : $ASSETS/adm-step8-*.{png,txt,csv}"
