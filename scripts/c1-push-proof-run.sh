#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# c1-push-proof-run — preuves E2E des PUSH NOTIFICATIONS (C1, knock sans contenu)
# ─────────────────────────────────────────────────────────────────────────────
# REJOUABLE : une seule commande (DEV-SETUP §2b/§2c).
#
#   bash scripts/c1-push-proof-run.sh
#
# Étapes : harnais E2E (app dev :3203 + mini push service HTTPS :3204 en
# process séparé — subscribe/unsubscribe/upsert/rate limits + knocks RÉELS
# captés sur le fil) → builds standalone TOUJOURS (leçon É8) → app
# standalone :3103 (VAPID) → preuve navigateur (carte notifications, ACTIVER
# = subscribe réel + POST signé, rendu de notification via le SW) → dumps
# (capture du fil, log serveur, DB PushSubscription) → nettoyage.
# Sorties : docs/proofs/assets/c1-*.{png,txt,jsonl} + journal stdout.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP=3103
DB_HARNESS="$ROOT/db/push-c1-e2e-test.db"
DB_BROWSER="$ROOT/db/c1-browser-proof.db"
ASSETS="$ROOT/docs/proofs/assets"
mkdir -p "$ROOT/db" "$ASSETS"

say() { echo "[c1-proof] $*"; }
assert_contains() { # fichier, aiguille, libellé — grep -F : aiguille LITTÉRALE
  # (le run 3-5 : « [push:sender] » = classe de caractères en grep BRE —
  #  l'aiguille ne matchait jamais son propre fichier !)
  if grep -Fq "$2" "$1"; then say "PASS — $3"; else say "FAIL — $3 (aiguille '$2' absente de $1)"; exit 1; fi
}
kill_port() {
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then
    say "   kill résidu port $1 : pids $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}
kill_port 3103
kill_port 3203
kill_port 3204
sleep 1

# clés VAPID de preuve (jetables — régénérées à chaque run)
say "0. génération des clés VAPID de preuve"
VAPID_KEYS=$(bunx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=$(echo "$VAPID_KEYS" | awk '/^Public Key:/{getline; print}')
VAPID_PRIVATE_KEY=$(echo "$VAPID_KEYS" | awk '/^Private Key:/{getline; print}')
[ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ] || { say "FAIL — clés VAPID"; exit 1; }
say "   clés générées (pub ${VAPID_PUBLIC_KEY:0:16}…)"

# ── 1. harnais E2E (app dev + mini push service, tout géré par le harnais) ──
say "1. harnais E2E push (12 scénarios — subscribe/upsert/rate limits + knocks réels)"
rm -f "$DB_HARNESS"
PUSH_C1_E2E=1 BASE_URL="http://127.0.0.1:3203" PUSH_TEST_PORT=3204 \
DATABASE_URL="file:$DB_HARNESS" VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
  bun test tests/push-c1.test.ts > "$ASSETS/c1-harness-output.txt" 2>&1 || {
    tail -20 "$ASSETS/c1-harness-output.txt"; say "FAIL — harnais push"; exit 1;
  }
assert_contains "$ASSETS/c1-harness-output.txt" "12 pass" "harnais push : 12/12 verts"
assert_contains "$ASSETS/c1-harness-output.txt" "0 fail" "harnais push : 0 fail"

# capture du FIL (Wireshark-like) — le body est CHIFFRÉ aes128gcm
cp "$ROOT/db/push-c1-capture.jsonl" "$ASSETS/c1-wire-capture.jsonl"
assert_contains "$ASSETS/c1-wire-capture.jsonl" '"content-encoding":"aes128gcm"' "fil : content-encoding aes128gcm (RFC 8291 — payload chiffré)"
assert_contains "$ASSETS/c1-wire-capture.jsonl" '"authorization":"vapid t=' "fil : VAPID JWT (RFC 8292)"
if grep -q "SECRET-E2EE\|contenu-qui-ne-doit-pas-fuire\|new_message" "$ASSETS/c1-wire-capture.jsonl"; then
  say "FAIL — contenu en clair SUR LE FIL (le payload doit être chiffré)"; exit 1
fi
say "PASS — fil : AUCUN contenu lisible (body chiffré, knock opaque)"
# le clair n'existe que dans le LOG SERVEUR, knock-only
# le log serveur : les workers Next écrivent encore plusieurs secondes après
# le SIGTERM du parent — BOUCLE d'attente de la ligne knock (le run 3/4 a
# asserté un fichier non flushé)
LOG_OK=""
for _ in $(seq 1 30); do
  if grep -q 'payload knock → {"type":"new_message"' "$ROOT/db/push-c1-server.log" 2>/dev/null; then
    LOG_OK="1"; break
  fi
  sleep 1
done
[ -n "$LOG_OK" ] || { say "FAIL — le log serveur n'a jamais montré le payload knock"; exit 1; }
cp "$ROOT/db/push-c1-server.log" "$ASSETS/c1-server-log.txt"
assert_contains "$ASSETS/c1-server-log.txt" '[push:sender] payload knock → {"type":"new_message","fromLabel":"Alice-Push"}' "log serveur : payload knock-only visible (type + fromLabel)"
# NB : « ciphertext » est un NOM DE COLONNE des logs SQL Prisma (légitime) —
# la garde porte sur le CONTENU secret du message de test uniquement
if grep -Fq "SECRET-E2EE" "$ASSETS/c1-server-log.txt" || grep -Fq "contenu-qui-ne-doit-pas-fuire" "$ASSETS/c1-server-log.txt"; then
  say "FAIL — contenu du message dans le log (knock-only violé)"; exit 1
fi
say "PASS — log serveur : AUCUN contenu de message (knock-only prouvé)"

# dump DB harnais
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB_HARNESS'}}});
(async()=>{
  const subs=await db.pushSubscription.findMany({select:{id:true,userId:true,endpoint:true,disabledAt:true,createdAt:true,userAgent:true}});
  const out={total:subs.length,active:subs.filter(s=>s.disabledAt===null).length,disabled:subs.filter(s=>s.disabledAt!==null).length,
    sample:subs.slice(0,3).map(s=>({userId:s.userId.slice(0,10)+'…',endpoint:s.endpoint.slice(0,50)+'…',disabledAt:s.disabledAt}))};
  require('fs').writeFileSync('$ASSETS/c1-db-subscriptions.json',JSON.stringify(out,null,2));
  console.log('subs total='+out.total+' active='+out.active+' disabled='+out.disabled);
  process.exit(0);
})();" > /dev/null
say "   dump DB → c1-db-subscriptions.json"

# ── 2. builds standalone TOUJOURS (leçon É8) ────────────────────────────────
say "2. build standalone de l'app (TOUJOURS)"
rm -f "$DB_BROWSER"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$DB_BROWSER" bunx next build > /tmp/c1-build.log 2>&1
# le standalone n'inclut NI .next/static NI public/ — copie obligatoire
# (leçon step8 : sans elle, tous les chunks 404 et la SPA ne boot pas)
cp -r .next/static .next/standalone/.next/ 2>/dev/null || true
mkdir -p .next/standalone/public
cp -r public/. .next/standalone/public/ 2>/dev/null || true

# ── 3. app standalone :3103 (VAPID) ─────────────────────────────────────────
say "3. app standalone :3103"
DATABASE_URL="file:$DB_BROWSER" bunx prisma migrate deploy > /dev/null 2>&1
DATABASE_URL="file:$DB_BROWSER" ADMIN_INTERNAL_TOKEN="c1-proof-token" \
  MBOTE_EMBED_RELAY=0 PORT=$APP HOSTNAME=127.0.0.1 \
  VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
  bun .next/standalone/server.js > /tmp/c1-standalone.log 2>&1 &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true' EXIT
wait_up() {
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$1" && return 0
    sleep 1
  done
  say "FAIL — serveur non prêt : $1"; exit 1
}
wait_up "http://127.0.0.1:$APP/api/stats"
say "   app prête"

# ── 4. preuve navigateur (SW réel + subscribe réel + rendu notification) ────
say "4. preuve navigateur (Chromium — subscribe pushManager RÉEL)"
bun scripts/c1-browser-proof.ts "http://127.0.0.1:$APP" > "$ASSETS/c1-browser-proof-log.txt" 2>&1 || {
  tail -20 "$ASSETS/c1-browser-proof-log.txt"; say "FAIL — preuve navigateur"; exit 1;
}
assert_contains "$ASSETS/c1-browser-proof-log.txt" "flux Activer complet" "navigateur : flux Activer complet (état UI = réel, invariant §1.8)"
assert_contains "$ASSETS/c1-browser-proof-log.txt" "notification rendue" "navigateur : notification rendue par le SW (title Mbote, body knock)"

# la DB navigateur : 0 subscription en SANDBOX (le Chromium OSS de Playwright
# n'a pas les Google API keys — son push service interne FCM refuse le
# subscribe, NON TESTÉ documenté). La preuve des SUBSCRIPTIONS en DB vient
# du HARNAIS (c1-db-subscriptions.json) avec un push service RÉEL local.
bun -e "
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:'file:$DB_BROWSER'}}});
(async()=>{
  const subs=await db.pushSubscription.findMany({where:{disabledAt:null},select:{userId:true,endpoint:true,userAgent:true}});
  const out={count:subs.length,sandbox:'Chromium OSS sans Google API keys — subscribe FCM réel NON TESTÉ (classe dépendance externe)',
    note:'la preuve des subscriptions en DB = harnais (mini push service réel local)',sample:subs.map(s=>({userId:s.userId.slice(0,10)+'…',endpoint:s.endpoint.slice(0,60)+'…'}))};
  require('fs').writeFileSync('$ASSETS/c1-browser-db.json',JSON.stringify(out,null,2));
  console.log('OK navigateur : '+out.count+' subscription(s) (attendu 0 en sandbox — documenté)');
  process.exit(0);
})();" > /dev/null
say "   PASS — état navigateur documenté (c1-browser-db.json)"

# ── 5. fail-closed : sans clés VAPID → 503 ──────────────────────────────────
say "5. fail-closed : app SANS VAPID → /api/push/config 503"
DATABASE_URL="file:$DB_BROWSER" ADMIN_INTERNAL_TOKEN="c1-proof-token" \
  MBOTE_EMBED_RELAY=0 PORT=3131 HOSTNAME=127.0.0.1 \
  bun .next/standalone/server.js > /tmp/c1-standalone2.log 2>&1 &
APP2_PID=$!
trap 'kill $APP_PID $APP2_PID 2>/dev/null || true' EXIT
wait_up "http://127.0.0.1:3131/api/stats"
HTTP_503=$(curl -s -o "$ASSETS/c1-config-503.txt" -w "%{http_code}" "http://127.0.0.1:3131/api/push/config")
[ "$HTTP_503" = "503" ] || { say "FAIL — config sans VAPID attendue 503, obtenue $HTTP_503"; exit 1; }
assert_contains "$ASSETS/c1-config-503.txt" "Push non configuré" "503 fail-closed (UI masquée, sender no-op)"
kill $APP2_PID 2>/dev/null || true
say "   PASS — sans clés : push DÉSACTIVÉ proprement"

say "TERMINÉ — preuves C1 : $ASSETS/c1-*.{png,txt,jsonl,json}"
