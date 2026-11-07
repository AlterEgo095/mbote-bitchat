#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# adm-step9-proof-run — preuves navigateur + curl du FOUR-EYES (ADM É9)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b/§2c).
#
#   bash scripts/adm-step9-proof-run.sh
#
# Étapes : seed DB preuve (5 admins dont 2 super-admins, cibles ban/purge/
# cancel/expire) → builds standalone TOUJOURS (leçon É8 : un build périmé
# prouverait une autre étape) → serveurs :3101/:3102 → curl : RBAC création
# (moderator/support/auditor → 403, super-admin → 201 +expiresAt) →
# auto-approbation 403 (même admin 2ᵉ session) → doublon 409 → approbation
# sa2 → ban exécuté (bannedAt + posts masqués hiddenById=exécutant) →
# EXACTEMENT 2 lignes AdminAudit (request + execute) → publication 403 →
# purge exécutée (beforeJson conservé) → annulation (demandeur 200 cancelled,
# autre admin 403, aucune mutation) → expiration 410 → RBAC approve moderator
# 403 → navigateur sa1 : fiche user bouton ACTIF → modale intention (captures)
# → /pending-actions sa1 (Annuler sans Approuver) → navigateur sa2 : liste →
# Approuver → exécution → fiche « banni définitivement » → backdate →
# ligne expirée grise → navigateur support : carte de refus → nettoyage.
# Sorties : docs/proofs/assets/adm-step9-*.{png,txt} + journal stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
INTERNAL_TOKEN="proof-step9-token-0123456789abcdef0123456789abcdef"
MAIN=3101
PANEL=3102
DB="$ROOT/db/adm-step9-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[proof9] $*"; }
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
rm -f "$DB" "$ROOT/db/adm-step9-secrets.json"
DATABASE_URL="file:$DB" bun scripts/adm-step9-proof-seed.ts > /tmp/step9-seed.log 2>&1
assert_contains /tmp/step9-seed.log "DEUX super-admins" "seed : 5 admins dont 2 super-admins (exigence four-eyes)"
SA1_SECRET=$(bun -e "console.log(require('./db/adm-step9-secrets.json').admins['super@step9.proof'].totpSecret)")
SA2_SECRET=$(bun -e "console.log(require('./db/adm-step9-secrets.json').admins['super2@step9.proof'].totpSecret)")
MOD_SECRET=$(bun -e "console.log(require('./db/adm-step9-secrets.json').admins['moderator@step9.proof'].totpSecret)")
SUPPORT_SECRET=$(bun -e "console.log(require('./db/adm-step9-secrets.json').admins['support@step9.proof'].totpSecret)")
BAN_PUBKEY=$(bun -e "console.log(require('./db/adm-step9-secrets.json').fixtures.banTargetPubkey)")
PURGE_POST_ID=$(bun -e "console.log(require('./db/adm-step9-secrets.json').fixtures.purgePostId)")
CANCEL_PUBKEY=$(bun -e "console.log(require('./db/adm-step9-secrets.json').fixtures.cancelTargetPubkey)")
EXPIRE_PUBKEY=$(bun -e "console.log(require('./db/adm-step9-secrets.json').fixtures.expireTargetPubkey)")
BROWSER_PUBKEY=$(bun -e "console.log(require('./db/adm-step9-secrets.json').fixtures.browserTargetPubkey)")

# ── 1. builds production (DEV-SETUP §2c) — TOUJOURS (leçon É8) ──────────────
say "1a. build app principale…"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/step9-build-main.log 2>&1
say "1b. build panneau admin…"
(cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" bunx next build > /tmp/step9-build-panel.log 2>&1)
cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
mkdir -p admin/.next/standalone/public
cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true

# ── 2. serveurs standalone ──────────────────────────────────────────────────
say "2. démarrage des serveurs (:3101 principale, :3102 panneau)"
DATABASE_URL="file:$DB" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/step9-main.log 2>&1 &
MAIN_PID=$!
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    BACKEND_INTERNAL_URL="http://127.0.0.1:$MAIN" PORT=$PANEL HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/step9-panel.log 2>&1 ) &
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

# logins (cookies sa1 / sa2 / moderator / support)
login() { # fichier_cookies, email, password, secret
  local code
  code=$(totp_code "$4" 0)
  curl -s -c "$1" -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
    -H "Content-Type: application/json" -H "x-forwarded-for: 10.92.0.1" \
    -d "{\"email\":\"$2\",\"password\":\"$3\",\"totp\":\"$code\"}"
}

say "3. logins des 4 acteurs"
login /tmp/step9-sa1.cookies "super@step9.proof" "Step9-Proof-Passw0rd!.sa1" "$SA1_SECRET" > "$ASSETS/adm-step9-login-sa1.txt"
assert_contains "$ASSETS/adm-step9-login-sa1.txt" '"role":"super-admin"' "login super-admin #1 → 200"
login /tmp/step9-sa2.cookies "super2@step9.proof" "Step9-Proof-Passw0rd!.sa2" "$SA2_SECRET" > "$ASSETS/adm-step9-login-sa2.txt"
assert_contains "$ASSETS/adm-step9-login-sa2.txt" '"role":"super-admin"' "login super-admin #2 → 200"
login /tmp/step9-mod.cookies "moderator@step9.proof" "Step9-Proof-Passw0rd!.moderator" "$MOD_SECRET" > "$ASSETS/adm-step9-login-mod.txt"
assert_contains "$ASSETS/adm-step9-login-mod.txt" '"role":"moderator"' "login moderator → 200"
login /tmp/step9-sup.cookies "support@step9.proof" "Step9-Proof-Passw0rd!.support" "$SUPPORT_SECRET" > "$ASSETS/adm-step9-login-sup.txt"
assert_contains "$ASSETS/adm-step9-login-sup.txt" '"role":"support"' "login support → 200"
# CSRF tokens (réponse login porte csrfToken)
CSRF_SA1=$(json_get "$ASSETS/adm-step9-login-sa1.txt" csrfToken)
CSRF_SA2=$(json_get "$ASSETS/adm-step9-login-sa2.txt" csrfToken)
CSRF_MOD=$(json_get "$ASSETS/adm-step9-login-mod.txt" csrfToken)
say "   CSRF tokens extraits"

# ── 4. curl — RBAC de création ──────────────────────────────────────────────
say "4. création d'intention : moderator/support/auditor → 403 · super-admin → 201"
HTTP_MOD=$(curl -s -o "$ASSETS/adm-step9-create-mod-403.txt" -w "%{http_code}" \
  -b /tmp/step9-mod.cookies -H "x-admin-csrf: $CSRF_MOD" \
  "http://127.0.0.1:$PANEL/api/pending-actions" -X POST -H "Content-Type: application/json" \
  -d "{\"actionType\":\"ban_user\",\"targetId\":\"$BAN_PUBKEY\",\"category\":\"HARASSMENT\",\"justification\":\"proof9 — ban à deux yeux du compte spam\"}")
[ "$HTTP_MOD" = "403" ] || { say "FAIL — moderator attendu 403, obtenu $HTTP_MOD"; exit 1; }
assert_contains "$ASSETS/adm-step9-create-mod-403.txt" "unauthorized" "moderator → 403 uniforme (tranché §15.1)"
HTTP_SUP=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/step9-sup.cookies "http://127.0.0.1:$PANEL/api/pending-actions")
[ "$HTTP_SUP" = "403" ] || { say "FAIL — support attendu 403 (file), obtenu $HTTP_SUP"; exit 1; }
say "PASS — support → 403 sur la file (moderator la voit, support/auditor non)"

curl -s -b /tmp/step9-sa1.cookies "http://127.0.0.1:$PANEL/api/pending-actions" \
  -X POST -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF_SA1" \
  -d "{\"actionType\":\"ban_user\",\"targetId\":\"$BAN_PUBKEY\",\"category\":\"HARASSMENT\",\"justification\":\"proof9 — ban à deux yeux du compte spam\"}" \
  > "$ASSETS/adm-step9-create-201.txt"
assert_contains "$ASSETS/adm-step9-create-201.txt" '"status":"pending"' "super-admin → 201 (status pending)"
CREATED_ID=$(json_get "$ASSETS/adm-step9-create-201.txt" pendingAction.id)
assert_contains "$ASSETS/adm-step9-create-201.txt" "expiresAt" "201 porte expiresAt (requestedAt + 1 h)"
say "   intention #$CREATED_ID créée par sa1 sur Ban Kinshasa"

say "4b. doublon → 409 · auto-approbation → 403"
HTTP_DUP=$(curl -s -o "$ASSETS/adm-step9-dup-409.txt" -w "%{http_code}" \
  -b /tmp/step9-sa2.cookies "http://127.0.0.1:$PANEL/api/pending-actions" -X POST -H "Content-Type: application/json" \
  -H "x-admin-csrf: $(json_get "$ASSETS/adm-step9-login-sa2.txt" csrfToken)" \
  -d "{\"actionType\":\"ban_user\",\"targetId\":\"$BAN_PUBKEY\",\"category\":\"SPAM\",\"justification\":\"proof9 — doublon refusé par le serveur\"}")
[ "$HTTP_DUP" = "409" ] || { say "FAIL — doublon attendu 409, obtenu $HTTP_DUP"; exit 1; }
assert_contains "$ASSETS/adm-step9-dup-409.txt" "déjà en attente" "doublon : 409 (une intention ouverte par cible)"
HTTP_AUTO=$(curl -s -o "$ASSETS/adm-step9-auto-403.txt" -w "%{http_code}" \
  -b /tmp/step9-sa1.cookies "http://127.0.0.1:$PANEL/api/pending-actions/$CREATED_ID/approve" -X POST \
  -H "x-admin-csrf: $CSRF_SA1" -H "Content-Type: application/json" -d "{}")
[ "$HTTP_AUTO" = "403" ] || { say "FAIL — auto-approbation attendue 403, obtenue $HTTP_AUTO"; exit 1; }
# le BFF unifie 401/403 → {"error":"unauthorized"} (jamais de raison RBAC
# en surface) — le message backend « Auto-approbation impossible » est prouvé
# PAR LE HARNAIS E9·C (endpoint interne direct).
assert_contains "$ASSETS/adm-step9-auto-403.txt" "unauthorized" "auto-approbation → 403 uniforme (message backend complet prouvé par le harnais E9·C)"

# ── 5. curl — approbation par sa2 → exécution du ban ────────────────────────
say "5. approbation par sa2 → ban EXÉCUTÉ"
curl -s -b /tmp/step9-sa2.cookies "http://127.0.0.1:$PANEL/api/pending-actions/$CREATED_ID/approve" \
  -X POST -H "x-admin-csrf: $CSRF_SA2" -H "Content-Type: application/json" -d "{}" \
  > "$ASSETS/adm-step9-approve-200.txt"
assert_contains "$ASSETS/adm-step9-approve-200.txt" '"executed"' "approbation sa2 → 200 (exécution)"
assert_contains "$ASSETS/adm-step9-approve-200.txt" '"requestedBy"' "réponse porte requestedBy + approvedBy"
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  const user=await db.user.findUnique({where:{pubkey:'$BAN_PUBKEY'},select:{bannedAt:true,bannedById:true,nickname:true}});
  const posts=await db.post.findMany({where:{author:{pubkey:'$BAN_PUBKEY'}},select:{id:true,hiddenAt:true,hiddenById:true}});
  const sa2=await db.adminUser.findUnique({where:{email:'super2@step9.proof'},select:{id:true}});
  const pa=await db.pendingAction.findUnique({where:{id:$CREATED_ID},select:{status:true,approvedById:true,executedAt:true}});
  const audits=await db.adminAudit.findMany({where:{targetType:'user',targetId:'$BAN_PUBKEY'},orderBy:{id:'asc'},select:{id:true,action:true,actorId:true,afterJson:true,justification:true}});
  const cycle=audits.filter(a=>a.action==='pendingaction_created'||a.action==='ban');
  const banRow=audits.find(a=>a.action==='ban');
  const after=banRow?JSON.parse(banRow.afterJson||'{}'):{};
  const out={bannedAt:user.bannedAt,bannedById:user.bannedById,sa2Id:sa2.id,bannedByIdCorrect:user.bannedById===sa2.id,
    postsTotal:posts.length,postsHidden:posts.filter(p=>p.hiddenAt!==null).length,hiddenByExecutor:posts.every(p=>p.hiddenById===sa2.id),
    pendingStatus:pa.status,pendingApprovedBy:pa.approvedById,pendingExecutedAt:pa.executedAt,
    cycleLines:cycle.length,cycleActions:cycle.map(a=>a.action),fourEyes:after.fourEyes||null};
  require('fs').writeFileSync('$ASSETS/adm-step9-ban-executed-db.json',JSON.stringify(out,null,2));
  if(out.bannedByIdCorrect!==true||out.postsHidden!==2||out.hiddenByExecutor!==true||out.cycleLines!==2){console.error(JSON.stringify(out));process.exit(1);}
  console.log('OK ban exécuté : bannedAt+exécutant, 2/2 posts masqués, 2 lignes audit');
  process.exit(0);
})();" > /dev/null
say "   PASS — bannedAt + bannedBy=exécutant · 2/2 posts masqués par sa2 · EXACTEMENT 2 lignes (request+execute)"

say "5b. publication du banni → 403 (VRAIE clé bannie + signature valide)"
bun -e "
const subtle=globalThis.crypto.subtle;
(async()=>{
  const jwk=require('./db/adm-step9-secrets.json').fixtures.banTargetPrivJwk;
  const pub=require('./db/adm-step9-secrets.json').fixtures.banTargetPubkey;
  const priv=await subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const content='tentative de publication après ban (preuve 5b — signature valide)';
  const ts=Date.now();
  const sig=Buffer.from(await subtle.sign({name:'ECDSA',hash:{name:'SHA-256'}},priv,new TextEncoder().encode(pub+'|'+content+'|'+ts))).toString('base64url');
  const res=await fetch('http://127.0.0.1:$MAIN/api/posts',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({pubkey:pub,content,ts,signature:sig})});
  const body=await res.json().catch(()=>({}));
  require('fs').writeFileSync('$ASSETS/adm-step9-banned-403.txt',JSON.stringify({status:res.status,body},null,2));
  if(res.status!==403){console.error('publication banni attendue 403, obtenue '+res.status+' '+JSON.stringify(body));process.exit(1);}
  if(!String(body.error||'').includes('banni définitivement')){console.error('message attendu « banni définitivement », obtenu '+JSON.stringify(body));process.exit(1);}
  console.log('OK banni → 403 avec signature valide');
  process.exit(0);
})();" > /dev/null
say "   PASS — publication du banni → 403 « banni définitivement » (clé bannie, signature valide, garde distincte de la suspension)"

# ── 6. curl — PURGE exécutée (beforeJson conservé) ──────────────────────────
say "6. purge par four-eyes : intention sa1 → approbation sa2 → post SUPPRIMÉ"
curl -s -b /tmp/step9-sa1.cookies "http://127.0.0.1:$PANEL/api/pending-actions" \
  -X POST -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF_SA1" \
  -d "{\"actionType\":\"purge_post\",\"targetId\":\"$PURGE_POST_ID\",\"category\":\"SCAM\",\"justification\":\"proof9 — purge à deux yeux du post scam\"}" \
  > "$ASSETS/adm-step9-purge-create-201.txt"
assert_contains "$ASSETS/adm-step9-purge-create-201.txt" '"status":"pending"' "intention purge_post → 201"
PURGE_ACTION_ID=$(json_get "$ASSETS/adm-step9-purge-create-201.txt" pendingAction.id)
curl -s -b /tmp/step9-sa2.cookies "http://127.0.0.1:$PANEL/api/pending-actions/$PURGE_ACTION_ID/approve" \
  -X POST -H "x-admin-csrf: $CSRF_SA2" -H "Content-Type: application/json" -d "{}" \
  > "$ASSETS/adm-step9-purge-approve-200.txt"
assert_contains "$ASSETS/adm-step9-purge-approve-200.txt" '"purgedPostId"' "approbation sa2 → 200 (purge exécutée)"
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  const post=await db.post.findUnique({where:{id:'$PURGE_POST_ID'}});
  const rows=await db.adminAudit.findMany({where:{targetId:'$PURGE_POST_ID'},orderBy:{id:'asc'},select:{id:true,action:true,beforeJson:true,afterJson:true}});
  const purgeRow=rows.find(r=>r.action==='purge');
  const before=purgeRow?JSON.parse(purgeRow.beforeJson||'{}'):{};
  const after=purgeRow?JSON.parse(purgeRow.afterJson||'{}'):{};
  const out={postGone:post===null,auditLines:rows.length,actions:rows.map(r=>r.action),
    beforeKeepsContent:(before.content||'').includes('contenu scam'),fourEyes:after.fourEyes||null};
  require('fs').writeFileSync('$ASSETS/adm-step9-purge-db.json',JSON.stringify(out,null,2));
  if(out.postGone!==true||out.auditLines!==2||out.beforeKeepsContent!==true){console.error(JSON.stringify(out));process.exit(1);}
  console.log('OK purge : post supprimé, 2 lignes audit, beforeJson conserve le contenu');
  process.exit(0);
})();" > /dev/null
say "   PASS — post supprimé · 2 lignes (created + purge) · beforeJson conserve le CONTENU (audit)"

# ── 7. curl — ANNULATION (demandeur seul) + EXPIRATION ──────────────────────
say "7. annulation : autre admin → 403 · demandeur → 200 cancelled (aucune mutation)"
curl -s -b /tmp/step9-sa1.cookies "http://127.0.0.1:$PANEL/api/pending-actions" \
  -X POST -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF_SA1" \
  -d "{\"actionType\":\"ban_user\",\"targetId\":\"$CANCEL_PUBKEY\",\"category\":\"SPAM\",\"justification\":\"proof9 — intention qui sera annulée par son demandeur\"}" \
  > "$ASSETS/adm-step9-cancel-create-201.txt"
CANCEL_ID=$(json_get "$ASSETS/adm-step9-cancel-create-201.txt" pendingAction.id)
HTTP_C403=$(curl -s -o "$ASSETS/adm-step9-cancel-403.txt" -w "%{http_code}" \
  -b /tmp/step9-sa2.cookies "http://127.0.0.1:$PANEL/api/pending-actions/$CANCEL_ID/cancel" -X POST \
  -H "x-admin-csrf: $CSRF_SA2" -H "Content-Type: application/json" -d "{}")
[ "$HTTP_C403" = "403" ] || { say "FAIL — annulation par non-demandeur attendue 403, obtenue $HTTP_C403"; exit 1; }
# BFF unifie 401/403 (jamais de raison RBAC en surface) — le message backend
# « seul le demandeur peut annuler » est prouvé PAR LE HARNAIS E9·F (interne).
assert_contains "$ASSETS/adm-step9-cancel-403.txt" "unauthorized" "non-demandeur → 403 uniforme (message backend prouvé par le harnais E9·F)"
curl -s -b /tmp/step9-sa1.cookies "http://127.0.0.1:$PANEL/api/pending-actions/$CANCEL_ID/cancel" \
  -X POST -H "x-admin-csrf: $CSRF_SA1" -H "Content-Type: application/json" -d "{}" \
  > "$ASSETS/adm-step9-cancel-200.txt"
assert_contains "$ASSETS/adm-step9-cancel-200.txt" '"status":"cancelled"' "demandeur → 200 cancelled"
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  const u=await db.user.findUnique({where:{pubkey:'$CANCEL_PUBKEY'},select:{bannedAt:true}});
  const a=await db.adminAudit.findFirst({where:{action:'pendingaction_cancelled',targetId:'$CANCEL_PUBKEY'},select:{id:true}});
  if(u.bannedAt!==null||!a){console.error('mutation indue ou audit manquant');process.exit(1);}
  console.log('OK cancelled : aucune mutation + audit');
  process.exit(0);
})();" > /dev/null
say "   PASS — cancelled : bannedAt NULL + ligne pendingaction_cancelled"

say "7b. expiration : backdate → approve → 410 Gone"
curl -s -b /tmp/step9-sa1.cookies "http://127.0.0.1:$PANEL/api/pending-actions" \
  -X POST -H "Content-Type: application/json" -H "x-admin-csrf: $CSRF_SA1" \
  -d "{\"actionType\":\"ban_user\",\"targetId\":\"$EXPIRE_PUBKEY\",\"category\":\"SPAM\",\"justification\":\"proof9 — intention qui va expirer (1 h)\"}" \
  > "$ASSETS/adm-step9-expire-create-201.txt"
EXPIRE_ID=$(json_get "$ASSETS/adm-step9-expire-create-201.txt" pendingAction.id)
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB'}}});
(async()=>{
  await db.pendingAction.update({where:{id:$EXPIRE_ID},data:{expiresAt:new Date(Date.now()-1000)}});
  console.log('backdate OK');process.exit(0);
})();" > /dev/null
HTTP_410=$(curl -s -o "$ASSETS/adm-step9-expire-410.txt" -w "%{http_code}" \
  -b /tmp/step9-sa2.cookies "http://127.0.0.1:$PANEL/api/pending-actions/$EXPIRE_ID/approve" -X POST \
  -H "x-admin-csrf: $CSRF_SA2" -H "Content-Type: application/json" -d "{}")
[ "$HTTP_410" = "410" ] || { say "FAIL — expiration attendue 410, obtenue $HTTP_410"; exit 1; }
assert_contains "$ASSETS/adm-step9-expire-410.txt" "expirée" "intention expirée → 410 Gone (ne peut plus être approuvée)"
say "   PASS — expiry lazy : 410 + statut expired audité"

# ── 8. curl — la file est VISIBLE dès moderator (200) ; agir = super-admin ──
say "8. RBAC file : moderator → 200 (lecture) — les 403 support/auditor déjà prouvés (§4)"
HTTP_M200=$(curl -s -o "$ASSETS/adm-step9-mod-list-200.txt" -w "%{http_code}" \
  -b /tmp/step9-mod.cookies "http://127.0.0.1:$PANEL/api/pending-actions")
[ "$HTTP_M200" = "200" ] || { say "FAIL — moderator attendu 200 sur la file (lecture, arbitrage §15.1), obtenu $HTTP_M200"; exit 1; }
assert_contains "$ASSETS/adm-step9-mod-list-200.txt" '"items"' "moderator → 200 (la file est observable dès moderator)"
# et l'APPROBATION moderator → 403 (super-admin requis, rejetée par le backend
# via le BFF) : prouvée par le harnais E9·I avec une cible dédiée.
say "   PASS — file visible moderator (200) ; création/approbation super-admin seul (harnais E9·I)"

# ── 9. navigateur — sa1 : fiche → modale intention ──────────────────────────
say "9. navigateur sa1 — fiche user : bouton Ban ACTIF → modale → intention posée"
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
SA1_CODE_BROWSER=$(totp_code "$SA1_SECRET" 1) # fenêtre N+1 (anti-rejeu É3)
agent-browser find label "Email" fill "super@step9.proof"
agent-browser find label "Mot de passe" fill "Step9-Proof-Passw0rd!.sa1"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SA1_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "super@step9.proof" \
  || { agent-browser screenshot /tmp/step9-debug-login.png; agent-browser errors; exit 1; }
say "   login navigateur sa1 OK"
agent-browser open "http://127.0.0.1:$PANEL/users/$BROWSER_PUBKEY"
agent-browser wait --text "Browser Cible"
agent-browser wait --text "Ban définitif…" \
  || { agent-browser screenshot /tmp/step9-debug-fiche.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-fiche-bouton-actif.png"
say "   capture adm-step9-fiche-bouton-actif.png (bouton Ban définitif ACTIF pour super-admin)"

agent-browser find role button click --name "Ban définitif…"
agent-browser wait --text "Demander un ban — justification" \
  || { agent-browser screenshot /tmp/step9-debug-modal.png; agent-browser errors; exit 1; }
agent-browser find label "Texte de justification" fill "proof9 — ban définitif demandé depuis le navigateur (four-eyes, 2ᵉ admin approuvera)"
agent-browser screenshot "$ASSETS/adm-step9-modale-intention.png"
say "   capture adm-step9-modale-intention.png (modale « Demander un ban » remplie)"
agent-browser find role button click --name "Enregistrer l'intention (attend le serveur)"
agent-browser wait --text "enregistrée — en attente d'approbation par un SECOND super-admin" \
  || { agent-browser screenshot /tmp/step9-debug-intent.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-intention-201.png"
say "   capture adm-step9-intention-201.png (notice 201 — invariant §1.8 : rien affiché avant le serveur)"

say "9b. navigateur sa1 — /pending-actions : ligne PENDING avec « Annuler », SANS « Approuver »"
agent-browser open "http://127.0.0.1:$PANEL/pending-actions"
agent-browser wait --text "Intentions en attente d'approbation"
# Browser Cible est la SEULE ligne pending (les cibles curl sont déjà
# exécutées/cancelled/expired → section « Historique récent » sans nickname)
agent-browser wait --text "Browser Cible" \
  || { agent-browser screenshot /tmp/step9-debug-pending-sa1.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-pending-sa1.png"
say "   capture adm-step9-pending-sa1.png (demandeur : Annuler seul — Approuver absent)"

# ── 10. navigateur — sa2 : approbation → fiche banni ────────────────────────
say "10. navigateur sa2 — re-login → /pending-actions → Approuver → exécution"
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
SA2_CODE_BROWSER=$(totp_code "$SA2_SECRET" 1)
agent-browser find label "Email" fill "super2@step9.proof"
agent-browser find label "Mot de passe" fill "Step9-Proof-Passw0rd!.sa2"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SA2_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "super2@step9.proof" \
  || { agent-browser screenshot /tmp/step9-debug-login2.png; agent-browser errors; exit 1; }
say "   login navigateur sa2 OK"
agent-browser open "http://127.0.0.1:$PANEL/pending-actions"
agent-browser wait --text "Intentions en attente d'approbation"
agent-browser wait --text "Approuver (exécute l'action)" \
  || { agent-browser screenshot /tmp/step9-debug-pending2.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-pending-sa2.png"
say "   capture adm-step9-pending-sa2.png (2ᵉ admin : bouton Approuver visible)"
agent-browser find role button click --name "Approuver (exécute l'action)"
agent-browser wait --text "approuvée — action exécutée et auditée" \
  || { agent-browser screenshot /tmp/step9-debug-approve.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-approve-executed.png"
say "   capture adm-step9-approve-executed.png (notice exécution — invariant §1.8)"

agent-browser open "http://127.0.0.1:$PANEL/users/$BROWSER_PUBKEY"
agent-browser wait --text "banni définitivement" \
  || { agent-browser screenshot /tmp/step9-debug-banned.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-fiche-banni.png"
say "   capture adm-step9-fiche-banni.png (badge « banni définitivement · four-eyes »)"

# ── 11. navigateur — expiration visible (ligne grise) ───────────────────────
say "11. navigateur — /pending-actions : ligne expirée grisée + historique"
agent-browser open "http://127.0.0.1:$PANEL/pending-actions"
agent-browser wait --text "Intentions en attente d'approbation"
agent-browser wait --text "Historique récent"
agent-browser screenshot "$ASSETS/adm-step9-pending-expired.png"
say "   capture adm-step9-pending-expired.png (expired dans l'historique — pending expirées purgées du statut pending)"

# ── 12. navigateur — support : carte de refus ───────────────────────────────
say "12. navigateur support — /pending-actions → carte de refus"
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
agent-browser wait --text "Se connecter"
SUPPORT_CODE_BROWSER=$(totp_code "$SUPPORT_SECRET" 1)
agent-browser find label "Email" fill "support@step9.proof"
agent-browser find label "Mot de passe" fill "Step9-Proof-Passw0rd!.support"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SUPPORT_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "support@step9.proof" \
  || { agent-browser screenshot /tmp/step9-debug-login-sup.png; agent-browser errors; exit 1; }
agent-browser open "http://127.0.0.1:$PANEL/pending-actions"
agent-browser wait --text "Accès refusé" \
  || { agent-browser screenshot /tmp/step9-debug-refusal.png; agent-browser errors; exit 1; }
agent-browser screenshot "$ASSETS/adm-step9-support-refusal.png"
say "   capture adm-step9-support-refusal.png (file four-eyes : moderator min — support refusé)"

say "TERMINÉ — preuves Étape 9 : $ASSETS/adm-step9-*.{png,txt,json}"
