#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# adm-step5-proof-run — preuves navigateur + curl du dashboard (ADM Étape 5)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande, un seul tour d'outils (DEV-SETUP §2b — les
# serveurs ne survivent pas aux tours ; tout se rejoue from scratch ici).
#
#   bash scripts/adm-step5-proof-run.sh
#
# Étapes : seed DB preuve → builds (si absents) → serveurs standalone :3101
# (app principale) + :3102 (panneau) → login support (curl) → JSON 4 clés →
# token seul 401 → login auditor → 403 → navigateur : login support →
# /dashboard (screenshot valeurs) → clic Rafraîchir → login auditor →
# /dashboard (screenshot Accès refusé) → re-login support (code fenêtre N+1)
# → kill backend → 502 curl → reload → bandeau « Backend injoignable »
# (screenshot) → nettoyage.
# Sorties : docs/proofs/assets/adm-step5-*.{png,txt} + journal sur stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
INTERNAL_TOKEN="proof-step5-token-0123456789abcdef0123456789abcdef"
MAIN=3101
PANEL=3102
DB="$ROOT/db/adm-step5-proof.db"
BACKUP_FILE="$ROOT/db/adm-step5-backup-status.json"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[proof] $*"; }
assert_contains() { # fichier, aiguille, libellé
  if grep -q "$2" "$1"; then say "PASS — $3"; else say "FAIL — $3 (aiguille '$2' absente de $1)"; exit 1; fi
}

# Kill des résidus des runs précédents (un panel « fantôme » tient :3102 et
# sert un build périmé depuis un répertoire supprimé — incident runs 3→5 :
# le $! d'un sous-shell n'est pas le pid du serveur, et fuser est ABSENT du
# sandbox). Kill par PID via ss, puis assertion ports libres.
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

totp_code() { # secret, offset_fenêtres (0=now, 1=fenêtre suivante)
  bun -e "import('./src/lib/mbote/totp').then(m => console.log(m.totpAt('$1', Date.now() + ${2:-0} * 30000).code))"
}

# ── 0. seed idempotent + secrets ────────────────────────────────────────────
say "0. seed DB de preuve"
rm -f "$DB" "$ROOT/db/adm-step5-secrets.json"
DATABASE_URL="file:$DB" STEP5_BACKUP_FILE="$BACKUP_FILE" bun scripts/adm-step5-proof-seed.ts > /tmp/step5-seed.log 2>&1
assert_contains /tmp/step5-seed.log '"reportsOuverts":2' "seed : 2 reports ouverts"
SUPPORT_SECRET=$(bun -e "console.log(require('./db/adm-step5-secrets.json').admins['support@step5.proof'].totpSecret)")
AUDITOR_SECRET=$(bun -e "console.log(require('./db/adm-step5-secrets.json').admins['auditor@step5.proof'].totpSecret)")

# ── 1. builds production (DEV-SETUP §2c — jamais next dev pour capturer) ────
if [ ! -f .next/standalone/server.js ]; then
  say "1a. build app principale…"
  NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB" bunx next build > /tmp/step5-build-main.log 2>&1
fi
if [ ! -f admin/.next/standalone/server.js ]; then
  say "1b. build panneau admin…"
  (cd admin && NEXT_TELEMETRY_DISABLED=1 ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" bunx next build > /tmp/step5-build-panel.log 2>&1)
  cp -r admin/.next/static admin/.next/standalone/.next/ 2>/dev/null || true
  mkdir -p admin/.next/standalone/public
  cp -r admin/public/. admin/.next/standalone/public/ 2>/dev/null || true
fi

# ── 2. serveurs standalone ──────────────────────────────────────────────────
say "2. démarrage des serveurs (:3101 principale, :3102 panneau)"
DATABASE_URL="file:$DB" BACKUP_STATUS_PATH="$BACKUP_FILE" ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  MBOTE_EMBED_RELAY=0 PORT=$MAIN HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/step5-main.log 2>&1 &
MAIN_PID=$!
# exec → $! est le VRAI pid bun (pas un sous-shell — le trap tue le bon process)
( cd admin/.next/standalone && exec env ADMIN_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    BACKEND_INTERNAL_URL="http://127.0.0.1:$MAIN" PORT=$PANEL HOSTNAME=127.0.0.1 \
    bun server.js > /tmp/step5-panel.log 2>&1 ) &
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

# ── 3. curl — session support valide : les 4 clés ───────────────────────────
say "3. curl — login support + GET /api/dashboard (4 clés)"
SUPPORT_CODE=$(totp_code "$SUPPORT_SECRET" 0)
curl -s -c /tmp/step5-support.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.90.0.1" \
  -d "{\"email\":\"support@step5.proof\",\"password\":\"Step5-Proof-Passw0rd!.support\",\"totp\":\"$SUPPORT_CODE\"}" \
  > "$ASSETS/adm-step5-login-support.txt"
assert_contains "$ASSETS/adm-step5-login-support.txt" '"role":"support"' "login support → 200 rôle support"

curl -s -b /tmp/step5-support.cookies "http://127.0.0.1:$PANEL/api/dashboard" > "$ASSETS/adm-step5-dashboard-json.txt"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"activeUsers"' "JSON clé activeUsers"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"openReports"' "JSON clé openReports"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"uptime"' "JSON clé uptime"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"backup"' "JSON clé backup"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"h24":2' "JSON valeur h24=2 (fixtures)"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"d7":4' "JSON valeur d7=4 (fixtures)"
assert_contains "$ASSETS/adm-step5-dashboard-json.txt" '"value":2' "JSON valeur reports ouverts=2"
# anti-fuite : rien de sensible dans le payload
if grep -qE "step5.proof|pubkey|ciphertext|\"ip\"|\"email\"" "$ASSETS/adm-step5-dashboard-json.txt"; then
  say "FAIL — fuite détectée dans le payload /api/dashboard"; exit 1
fi
say "PASS — anti-fuite payload (pas d'email, pas d'IP, pas de contenu DM, pas de pubkey)"

say "3b. endpoint interne — token SEUL → 401"
HTTP_TOKEN_ONLY=$(curl -s -o "$ASSETS/adm-step5-internal-token-only.txt" -w "%{http_code}" \
  -H "x-admin-internal: $INTERNAL_TOKEN" "http://127.0.0.1:$MAIN/api/internal/admin/stats")
[ "$HTTP_TOKEN_ONLY" = "401" ] || { say "FAIL — token seul attendu 401, obtenu $HTTP_TOKEN_ONLY"; exit 1; }
say "PASS — token interne seul → 401 (aucune action sans session + acteur)"

# ── 4. curl — auditor → 403 (BFF) ───────────────────────────────────────────
say "4. curl — login auditor + GET /api/dashboard → 403"
AUDITOR_CODE=$(totp_code "$AUDITOR_SECRET" 0)
curl -s -c /tmp/step5-auditor.cookies -X POST "http://127.0.0.1:$PANEL/api/admin/auth/login" \
  -H "Content-Type: application/json" -H "x-forwarded-for: 10.90.0.2" \
  -d "{\"email\":\"auditor@step5.proof\",\"password\":\"Step5-Proof-Passw0rd!.auditor\",\"totp\":\"$AUDITOR_CODE\"}" \
  > "$ASSETS/adm-step5-login-auditor.txt"
assert_contains "$ASSETS/adm-step5-login-auditor.txt" '"role":"auditor"' "login auditor → 200 rôle auditor"
HTTP_AUD=$(curl -s -o "$ASSETS/adm-step5-auditor-403.txt" -w "%{http_code}" \
  -b /tmp/step5-auditor.cookies "http://127.0.0.1:$PANEL/api/dashboard")
[ "$HTTP_AUD" = "403" ] || { say "FAIL — auditor attendu 403, obtenu $HTTP_AUD"; exit 1; }
assert_contains "$ASSETS/adm-step5-auditor-403.txt" 'unauthorized' "auditor → 403 message uniforme « unauthorized »"

# ── 5. navigateur — dashboard support (valeurs SSR) ─────────────────────────
say "5. navigateur — login support → /dashboard (capture)"
agent-browser set viewport 1440 900
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser wait --load networkidle
SUPPORT_CODE_BROWSER=$(totp_code "$SUPPORT_SECRET" 1)  # fenêtre N+1 : le code du login curl (N) est consommé — anti-rejeu Étape 3
agent-browser find label "Email" fill "support@step5.proof"
agent-browser find label "Mot de passe" fill "Step5-Proof-Passw0rd!.support"
agent-browser find label "Code TOTP (6 chiffres)" fill "$SUPPORT_CODE_BROWSER"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "support@step5.proof" \
  || { agent-browser screenshot /tmp/step5-debug-login.png; agent-browser errors; exit 1; }
say "   login navigateur OK (état session active visible)"
agent-browser open "http://127.0.0.1:$PANEL/dashboard"
agent-browser wait --text "Utilisateurs actifs"
agent-browser wait --text "2 / 4"
agent-browser screenshot "$ASSETS/adm-step5-dashboard.png"
say "   capture adm-step5-dashboard.png"

say "5b. rafraîchissement manuel (bouton)"
agent-browser find role button click --name "Rafraîchir"
agent-browser wait --text "Dernier rafraîchissement"
agent-browser screenshot "$ASSETS/adm-step5-dashboard-refresh.png"
say "   capture adm-step5-dashboard-refresh.png"

# ── 6. navigateur — auditor → Accès refusé (UI, rendu serveur) ──────────────
say "6. navigateur — session auditor → /dashboard (capture Accès refusé)"
AUDITOR_CODE2=$(totp_code "$AUDITOR_SECRET" 1)  # fenêtre suivante : anti-rejeu respecté
# NB : PAS de clic « Se déconnecter » ici — sur une page fraîchement chargée,
# le csrf en mémoire est vide (défaut corrigé dans AdminAuthPanel : l'UI ne
# bascule plus en anonymous si le serveur refuse). On efface simplement le
# cookie dans le navigateur : la session support (S2) reste vivante côté
# serveur — sans conséquence (TTL idle 30 min), la preuve n'en dépend pas.
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/"
agent-browser wait --load networkidle
agent-browser wait --text "Se connecter"
agent-browser find label "Email" fill "auditor@step5.proof"
agent-browser find label "Mot de passe" fill "Step5-Proof-Passw0rd!.auditor"
agent-browser find label "Code TOTP (6 chiffres)" fill "$AUDITOR_CODE2"
agent-browser find role button click --name "Se connecter"
agent-browser wait --text "auditor@step5.proof"
agent-browser open "http://127.0.0.1:$PANEL/dashboard"
agent-browser wait --text "Accès refusé"
agent-browser screenshot "$ASSETS/adm-step5-auditor-refused.png"
say "   capture adm-step5-auditor-refused.png"

# ── 7. DÉGRADATION — kill backend → 502 + bandeau ───────────────────────────
say "7. kill backend → 502 (curl) puis bandeau navigateur (cookie support de l'étape 3)"
kill "$MAIN_PID" 2>/dev/null || true
sleep 2
HTTP_502=$(curl -s -o "$ASSETS/adm-step5-degradation-502.txt" -w "%{http_code}" \
  -b /tmp/step5-support.cookies "http://127.0.0.1:$PANEL/api/dashboard")
[ "$HTTP_502" = "502" ] || { say "FAIL — backend killé attendu 502, obtenu $HTTP_502"; exit 1; }
assert_contains "$ASSETS/adm-step5-degradation-502.txt" 'backend-unreachable' "kill backend → BFF 502 backend-unreachable"

# réinjecter la session support de l'étape 3 (jamais déconnectée — le cookie
# curl reste valide) : détermination, pas de re-login TOTP fragile ici
SUPPORT_TOKEN=$(awk '$6=="mbote_admin_session" {print $7}' /tmp/step5-support.cookies)
[ -n "$SUPPORT_TOKEN" ] || { say "FAIL — token support introuvable dans le cookie jar"; exit 1; }
agent-browser cookies clear
agent-browser open "http://127.0.0.1:$PANEL/" > /dev/null
agent-browser cookies set mbote_admin_session "$SUPPORT_TOKEN"
agent-browser open "http://127.0.0.1:$PANEL/dashboard"
agent-browser wait --text "Backend injoignable"
agent-browser screenshot "$ASSETS/adm-step5-degradation.png"
say "   capture adm-step5-degradation.png (bandeau, PAS de redirection)"

agent-browser close
say "═══ TOUTES LES PREUVES ÉTAPE 5 SONT PASSÉES ═══"
