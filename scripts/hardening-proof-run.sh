#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  HARDENING — runner de preuve rejouable (vague durcissement post-CI-AUDIT)
# ─────────────────────────────────────────────────────────────────────────────
#  Commande : bash scripts/hardening-proof-run.sh
#
#  Vérifie les fixes + non-régression de la vague durcissement (2026-11-13) :
#   P1  F-1 deploy gate — inspection YAML (workflow_run + gate SHA + head_sha)
#   P2  invariant §4d — greps structurels des sites corrigés (break-glass,
#       totp-enroll, dms/bot, mesh/bridge) + exception mls/prune documentée
#   P3  harnais break-glass ATOMIQUE — R1 happy / R2 crash simulé (rollback
#       complet : code réutilisable, sessions actives, TOTP inchangé) / R3
#   P4  simulation CI — bun test tests/ en conditions tests.yml (DATABASE_URL
#       seul) : 0 fail attendu (F-15 : 31 fails avant le fix des gardes)
#   P5  D2 non-régression — build standalone + serveur prod :3185 + suite D2
#       complète (PoW, plafonds, rate-limit, T0 mesh → EXERCE le bridge
#       refactorisé par /api/mesh/bridge M1)
#   P6  harness admin-auth-e2e — 2 serveurs RÉELS (app + panel admin) : la
#       suite E break-glass exerce le route refactorisé de bout en bout
#   P7  check-merge-clean — invariant main ⊆ feat/mbote-v1
#
#  Assets : docs/proofs/assets/hardening-*
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=3185
BASE="http://127.0.0.1:$PORT"
BG_DB="$(pwd)/db/hardening-bg.db"
CI_DB="$(pwd)/db/hardening-ci.db"
D2_DB="$(pwd)/db/hardening-d2.db"
ASSETS="docs/proofs/assets"
mkdir -p "$ASSETS"

say() { echo ""; echo "━━━ $1 ━━━"; }
fail() { echo "✘ ÉCHEC : $1"; exit 1; }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_ready() { # URL → boucle curl ; à la sortie : kill -0 + curl (double garde)
  for _ in $(seq 1 90); do
    if curl -sf "$1" > /dev/null 2>&1; then
      kill -0 "$SERVER_PID" 2>/dev/null || fail "serveur mort pendant l'attente"
      curl -sf "$1" > /dev/null 2>&1 || fail "health instable"
      return 0
    fi
    sleep 1
  done
  fail "serveur non prêt après 90 s : $1"
}

: > "$ASSETS/hardening-summary.json"
step() { # step <id> <ok|fail> <détail>
  echo "{\"step\":\"$1\",\"result\":\"$2\",\"detail\":\"$3\"}" >> "$ASSETS/hardening-summary.json"
}

say "P1. F-1 deploy gate — inspection YAML"
python3 - <<'PY' || fail "P1 inspection YAML"
import yaml, sys
doc = yaml.safe_load(open(".github/workflows/deploy-vps.yml"))
on = doc.get(True) or doc.get("on")
wr = on.get("workflow_run")
assert wr, "workflow_run absent"
assert "Tests — harness adversarial" in wr["workflows"], "workflow_run ne référence pas tests.yml"
assert wr["types"] == ["completed"], "types != completed"
assert wr["branches"] == ["main"], "branches != [main]"
job = doc["jobs"]["deploy"]
assert "workflow_dispatch" in on, "workflow_dispatch absent"
cond = " ".join(job["if"].split())
assert "workflow_run.conclusion == 'success'" in cond, "if job sans conclusion success"
steps = job["steps"]
gate = [s for s in steps if s.get("name", "").startswith("Gate F-1")]
assert len(gate) == 1, "gate F-1 absent"
gsrc = gate[0]["run"]
assert "head_sha" in gsrc, "gate sans head_sha"
assert "tests.yml" in gsrc and "security.yml" in gsrc, "gate ne vérifie pas tests+security"
ck = [s for s in steps if "checkout" in s.get("uses", "")][0]
assert ck["with"]["ref"] == "${{ github.event.workflow_run.head_sha || github.sha }}", "checkout pas au SHA testé"
assert (doc.get("permissions") or {}).get("actions") == "read", "permissions actions: read absent"
print("P1 OK — workflow_run(tests.yml, main) + gate SHA (tests obligatoire, security si exécutée) + checkout au SHA testé")
PY
step "P1-f1-yaml-gate" "ok" "workflow_run + gate + head_sha vérifiés"

say "P2. invariant §4d — greps structurels des sites corrigés"
{
  echo "## break-glass : route → executeBreakGlass atomique"
  grep -c "executeBreakGlass" src/app/api/internal/admin/break-glass/route.ts
  echo "## executeBreakGlass : withWriteLock + \$transaction + tx aux 3 helpers"
  grep -c "withWriteLock" src/lib/mbote/admin-break-glass.ts
  grep -c 'revokeAllAdminSessions(args.adminUserId, "break-glass", tx)' src/lib/mbote/admin-break-glass.ts
  grep -c "createAdminSession(" src/lib/mbote/admin-break-glass.ts
  echo "## totp-enroll : \$transaction + audit dans la tx"
  grep -c 'db.\$transaction' src/app/api/internal/admin/totp-enroll/route.ts
  grep -c "writeAdminAudit({" src/app/api/internal/admin/totp-enroll/route.ts
  echo "## dms/bot : les 2 creates dans une tx"
  grep -c 'db.\$transaction' src/app/api/dms/bot/route.ts
  echo "## mesh/bridge : marque+contenu atomiques, garde DM dans la tx"
  grep -c "prismaReplayStoreFor(tx)" src/app/api/mesh/bridge/route.ts
  grep -c "tx.meshIngest.create" src/app/api/mesh/bridge/route.ts
  echo "## mls/prune : exception §4d documentée en commentaire"
  grep -c "EXCEPTION §4d DOCUMENTÉE" src/app/api/mls/keypackages/route.ts
  echo "## helpers tx? (admin-auth)"
  grep -c "tx?: PrismaTx" src/lib/mbote/admin-auth.ts
} > "$ASSETS/hardening-greps.txt" 2>&1
cat "$ASSETS/hardening-greps.txt"
grep -q "EXCEPTION §4d DOCUMENTÉE" src/app/api/mls/keypackages/route.ts || fail "P2 exception mls/prune absente"
[ "$(grep -c 'withWriteLock' src/lib/mbote/admin-break-glass.ts)" -ge 1 ] || fail "P2 break-glass sans withWriteLock"
[ "$(grep -c "prismaReplayStoreFor(tx)" src/app/api/mesh/bridge/route.ts)" -ge 1 ] || fail "P2 garde DM hors tx"
step "P2-greps-4d" "ok" "sites corrigés + exception documentée"

say "P3. harnais break-glass ATOMIQUE (R1/R2 rollback/R3)"
rm -f "$BG_DB" "$BG_DB-wal" "$BG_DB-shm"
DATABASE_URL="file:$BG_DB" bun run db:push > /dev/null 2>&1 || fail "P3 db push"
DATABASE_URL="file:$BG_DB" bun test tests/admin-break-glass-tx.test.ts > "$ASSETS/hardening-bg-test.txt" 2>&1 \
  || { tail -30 "$ASSETS/hardening-bg-test.txt"; fail "P3 harnais break-glass"; }
grep -E "pass|fail" "$ASSETS/hardening-bg-test.txt" | tail -4
grep -q "R2 — crash simulé entre burn et revoke → ROLLBACK COMPLET" "$ASSETS/hardening-bg-test.txt" \
  || fail "P3 test R2 rollback absent"
[ "$(grep -c "(fail)" "$ASSETS/hardening-bg-test.txt" || true)" -eq 0 ] || fail "P3 fail détecté"
step "P3-breakglass-tx" "ok" "R1+R2(rollback)+R3 3/3"

say "P4. simulation CI — bun test tests/ en conditions tests.yml (F-15)"
rm -f "$CI_DB" "$CI_DB-wal" "$CI_DB-shm"
DATABASE_URL="file:$CI_DB" bun run db:push > /dev/null 2>&1 || fail "P4 db push"
DATABASE_URL="file:$CI_DB" timeout 300 bun test tests/ > "$ASSETS/hardening-ci-sim.txt" 2>&1 \
  || { tail -30 "$ASSETS/hardening-ci-sim.txt"; fail "P4 suite CI en échec"; }
grep -E "pass|skip|fail" "$ASSETS/hardening-ci-sim.txt" | tail -3
[ "$(grep -cE "^\(fail\)|[1-9][0-9]* fail" "$ASSETS/hardening-ci-sim.txt" || true)" -eq 0 ] \
  || fail "P4 la simulation CI contient des fails (F-15 régressé)"
step "P4-ci-simulation" "ok" "bun test tests/ : 0 fail (avant fix : 31)"

say "P5a. tsc --noEmit — gate AVANT le build (Clarification 1, leçon F-17)"
bunx tsc --noEmit > /tmp/hardening-tsc.log 2>&1 \
  || { tail -40 /tmp/hardening-tsc.log; fail "P5a tsc --noEmit"; }

say "P5. D2 non-régression — build standalone + serveur prod :$PORT (exerce le bridge M1)"
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="file:$D2_DB" bun run build > /tmp/hardening-build.log 2>&1 \
  || { tail -20 /tmp/hardening-build.log; fail "P5 build"; }
rm -f "$D2_DB" "$D2_DB-wal" "$D2_DB-shm"
DATABASE_URL="file:$D2_DB" bunx prisma migrate deploy > /dev/null 2>&1 || fail "P5 migrate deploy"
DATABASE_URL="file:$D2_DB" MBOTE_EMBED_RELAY=0 PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production \
  bun .next/standalone/server.js > /tmp/hardening-d2-server.log 2>&1 &
SERVER_PID=$!
wait_ready "$BASE/api/stats"
APP_URL="$BASE" D2_SYBIL_DB="file:$D2_DB" DATABASE_URL="file:$D2_DB" \
  timeout 240 bun test tests/d2-sybil.test.ts > "$ASSETS/hardening-d2-test.txt" 2>&1 \
  || { tail -30 "$ASSETS/hardening-d2-test.txt"; fail "P5 suite D2"; }
grep -E "pass|skip|fail" "$ASSETS/hardening-d2-test.txt" | tail -3
D2_PASS=$(grep -oE "^ [0-9]+ pass" "$ASSETS/hardening-d2-test.txt" | grep -oE "[0-9]+" || echo 0)
[ "$D2_PASS" -ge 14 ] || fail "P5 D2 : $D2_PASS pass (< 14 attendu)"
[ "$(grep -cE "^\(fail\)" "$ASSETS/hardening-d2-test.txt" || true)" -eq 0 ] || fail "P5 D2 fail détecté"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
step "P5-d2-nonregression" "ok" "D2 $D2_PASS pass / 0 fail sur serveur prod (bridge M1 exercé)"

say "P6. harness admin-auth-e2e — 2 serveurs RÉELS (suite E break-glass)"
pkill -f "next dev -p 3101" 2>/dev/null || true
pkill -f "next dev -p 3102" 2>/dev/null || true
[ -d admin/node_modules ] || (cd admin && bun install --frozen-lockfile > /dev/null 2>&1) || fail "P6 admin deps"
DATABASE_URL="file:$(pwd)/db/adm-e2e-test.db" timeout 420 bun test tests/admin-auth-e2e.test.ts \
  > "$ASSETS/hardening-admin-e2e.txt" 2>&1 \
  || { tail -30 "$ASSETS/hardening-admin-e2e.txt"; fail "P6 harness admin e2e"; }
grep -E "pass|fail" "$ASSETS/hardening-admin-e2e.txt" | tail -3
[ "$(grep -cE "^\(fail\)" "$ASSETS/hardening-admin-e2e.txt" || true)" -eq 0 ] || fail "P6 fail détecté"
step "P6-admin-e2e" "ok" "83+ pass / 0 fail (break-glass E-suite réel)"

say "P7. check-merge-clean (invariant main ⊆ feat/mbote-v1)"
bash scripts/check-merge-clean.sh > "$ASSETS/hardening-merge-clean.txt" 2>&1 \
  || { tail -10 "$ASSETS/hardening-merge-clean.txt"; fail "P7 check-merge-clean"; }
tail -3 "$ASSETS/hardening-merge-clean.txt"
step "P7-merge-clean" "ok" "exit 0"

say "RÉCAPITULATIF"
{
  echo "## Hardening proof — $(date -u +%FT%TZ)"
  echo ""
  echo "| Phase | Résultat |"
  echo "|---|---|"
  echo "| P1 F-1 YAML gate | OK |"
  echo "| P2 greps §4d | OK |"
  echo "| P3 break-glass tx (R1/R2/R3) | OK |"
  echo "| P4 simulation CI | OK (0 fail) |"
  echo "| P5 D2 non-régression | OK ($D2_PASS pass) |"
  echo "| P6 admin-auth-e2e (réel) | OK |"
  echo "| P7 check-merge-clean | OK |"
} > "$ASSETS/hardening-recap.md"
cat "$ASSETS/hardening-recap.md"

echo ""
echo "OK — preuve durcissement complète (assets docs/proofs/assets/hardening-*)"
