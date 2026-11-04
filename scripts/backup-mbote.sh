#!/usr/bin/env bash
# =============================================================================
#  backup-mbote.sh — Sauvegarde chiffrée de la base SQLite Mbote (condition R1)
# -----------------------------------------------------------------------------
#  Exécution : sur le VPS, dans le répertoire de déploiement (VPS_DIR).
#  Conçu pour être lancé par la CI (workflow_dispatch setup-backups.yml) et
#  par le cron quotidien installé via --install-cron.
#
#  Cycle complet (chaque exécution) :
#    1. Snapshot du volume (docker cp custom.db + -wal/-shm si présents)
#    2. Vérification d'intégrité SQLite (PRAGMA integrity_check) sur la copie
#    3. Compaction VACUUM INTO (fichier propre, autonome)
#    4. Chiffrement AES-256-CBC/PBKDF2 (clé .backup-key — ne quitte JAMAIS le VPS)
#    5. TEST DE RESTAURATION : déchiffrement → integrity_check → comptages
#       comparés à la base vivante (test périodique de restauration, chaque jour)
#    6. Rotation : 14 sauvegardes chiffrées conservées
#    7. Statut JSON + journal (surveillance)
#
#  Usage :
#    ./scripts/backup-mbote.sh                 # cycle complet
#    ./scripts/backup-mbote.sh --install-cron  # installe le cron quotidien (idempotent)
#    ./scripts/backup-mbote.sh --status        # affiche le dernier statut
#
#  Sécurité : la clé de chiffrement reste sur le VPS (.backup-key, 0600).
#  Le fichier chiffré peut être externalisé (branche git `backups`, stockage
#  objet…) sans exposer les données. Conserver une copie HORS LIGNE de
#  .backup-key : sans elle, aucune restauration n'est possible.
# =============================================================================
set -euo pipefail

MBOTE_DIR="${MBOTE_DIR:-/opt/mbote-bitchat}"
CONTAINER="${CONTAINER:-mbote-mesh}"
DB_PATH_IN_CONTAINER="${DB_PATH_IN_CONTAINER:-/app/db/custom.db}"
KEEP_DAILY="${KEEP_DAILY:-14}"
BACKUPS_DIR="$MBOTE_DIR/backups"
KEY_FILE="$MBOTE_DIR/.backup-key"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
# Garde anti-exécutions concurrentes (deux crons qui se chevauchent, CI + cron…)
while [[ -e "$BACKUPS_DIR/.staging-$STAMP" || -e "$BACKUPS_DIR/mbote-$STAMP.db.enc" ]]; do
  STAMP="${STAMP}-x"
done

log() { echo "[backup-mbote $(date -u +%FT%TZ)] $*"; }
die() { echo "[backup-mbote $(date -u +%FT%TZ)] ERREUR: $*" >&2; write_status "FAIL" "" "" "0" "{\"error\": \"$1\"}"; exit 1; }

cd "$MBOTE_DIR" || die "répertoire $MBOTE_DIR introuvable"
mkdir -p "$BACKUPS_DIR"
chmod 700 "$BACKUPS_DIR" 2>/dev/null || true

# ── Mode --install-cron : idempotent, n'écrase JAMAIS les crons existants ────
if [[ "${1:-}" == "--install-cron" ]]; then
  CRON_LINE="17 3 * * * cd $MBOTE_DIR && ./scripts/backup-mbote.sh >> $BACKUPS_DIR/cron.log 2>&1"
  if crontab -l 2>/dev/null | grep -Fq "backup-mbote.sh"; then
    log "cron déjà installé — aucune modification"
    crontab -l | grep -F "backup-mbote.sh" || true
  else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    log "cron installé : $CRON_LINE"
  fi
  exit 0
fi

if [[ "${1:-}" == "--status" ]]; then
  cat "$BACKUPS_DIR/last-backup-status.json" 2>/dev/null || echo "aucun statut — aucune sauvegarde encore exécutée"
  exit 0
fi

write_status() {
  # $1=result $2=file $3=sha256 $4=duration_s $5=counts_json
  python3 - "$1" "$2" "$3" "$4" "$5" "$BACKUPS_DIR/last-backup-status.json" <<'PYEOF' 2>/dev/null || true
import sys, json, datetime
result, fname, sha, dur, counts, out = sys.argv[1:7]
try: counts_obj = json.loads(counts)
except Exception: counts_obj = {"raw": counts}
doc = {"at": datetime.datetime.utcnow().isoformat() + "Z", "result": result,
       "file": fname, "sha256": sha, "duration_s": dur, "counts": counts_obj}
with open(out, "w") as f: json.dump(doc, f, indent=2)
PYEOF
}

command -v docker >/dev/null || die "docker absent"
command -v openssl >/dev/null || die "openssl absent"
command -v python3 >/dev/null || die "python3 absent (requis pour integrity_check)"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "conteneur $CONTAINER non actif"

START_TS=$(date +%s)
log "démarrage — conteneur $CONTAINER, base $DB_PATH_IN_CONTAINER"

# ── 1. Snapshot (db + wal + shm si présents) ─────────────────────────────────
STAGE="$BACKUPS_DIR/.staging-$STAMP"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
docker cp "$CONTAINER:$DB_PATH_IN_CONTAINER" "$STAGE/custom.db" >/dev/null
for SUFFIX in -wal -shm; do
  docker exec "$CONTAINER" test -f "${DB_PATH_IN_CONTAINER}${SUFFIX}" 2>/dev/null \
    && docker cp "$CONTAINER:${DB_PATH_IN_CONTAINER}${SUFFIX}" "$STAGE/custom.db${SUFFIX}" >/dev/null || true
done
log "snapshot copié ($(du -sh "$STAGE" | cut -f1))"

# ── 2. Vérification d'intégrité + comptages sur la copie ─────────────────────
readarray -t CHECK < <(python3 - "$STAGE/custom.db" <<'PYEOF'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
ic = conn.execute("PRAGMA integrity_check").fetchone()[0]
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()][:10]
counts = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
print(ic); print(__import__("json").dumps(counts, separators=(",", ":")))
PYEOF
)
INTEGRITY="${CHECK[0]:-inconnu}"
COPY_COUNTS="${CHECK[1]:-{\}}"
[[ "$INTEGRITY" == "ok" ]] || die "integrity_check de la copie: $INTEGRITY (sauvegarde interrompue, précédente conservée)"
log "intégrité de la copie: ok — tables: $COPY_COUNTS"

# ── 3. Compaction (fichier final autonome) ───────────────────────────────────
python3 - "$STAGE/custom.db" "$STAGE/final.db" <<'PYEOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
src.execute("VACUUM INTO ?", (sys.argv[2],))
src.close()
PYEOF

# ── 4. Clé + chiffrement ─────────────────────────────────────────────────────
if [[ ! -f "$KEY_FILE" ]]; then
  openssl rand -base64 32 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  log "⚠ clé de chiffrement GÉNÉRÉE : $KEY_FILE — en conserver une copie hors ligne, sans elle aucune restauration n'est possible"
fi
chmod 600 "$KEY_FILE"
ENC_NAME="mbote-$STAMP.db.enc"
openssl enc -aes-256-cbc -pbkdf2 -iter 300000 -salt \
  -in "$STAGE/final.db" -out "$BACKUPS_DIR/$ENC_NAME" -pass file:"$KEY_FILE"
SHA=$(sha256sum "$BACKUPS_DIR/$ENC_NAME" | awk '{print $1}')
ENC_SIZE=$(stat -c%s "$BACKUPS_DIR/$ENC_NAME" 2>/dev/null || stat -f%z "$BACKUPS_DIR/$ENC_NAME")

# ── 5. TEST DE RESTAURATION (déchiffre + rouvre + compare les comptages) ─────
RESTORE_DIR="$STAGE/restore-test"
mkdir -p "$RESTORE_DIR"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 \
  -in "$BACKUPS_DIR/$ENC_NAME" -out "$RESTORE_DIR/restored.db" -pass file:"$KEY_FILE"
readarray -t RCHECK < <(python3 - "$RESTORE_DIR/restored.db" <<'PYEOF'
import sqlite3, sys, json
conn = sqlite3.connect(sys.argv[1])
ic = conn.execute("PRAGMA integrity_check").fetchone()[0]
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()][:10]
counts = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
print(ic); print(json.dumps(counts, separators=(",", ":")))
PYEOF
)
R_INTEGRITY="${RCHECK[0]:-inconnu}"
R_COUNTS="${RCHECK[1]:-{\}}"
[[ "$R_INTEGRITY" == "ok" ]] || die "restauration: integrity_check = $R_INTEGRITY"
[[ "$R_COUNTS" == "$COPY_COUNTS" ]] || die "restauration: comptages divergents vivant=$COPY_COUNTS restauré=$R_COUNTS"
log "TEST DE RESTAURATION : PASS (integrité ok, comptages identiques)"

# ── 6. Rotation (14 sauvegardes chiffrées) ───────────────────────────────────
ls -1t "$BACKUPS_DIR"/mbote-*.db.enc 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | while read -r OLD; do
  rm -f "$OLD"; log "rotation: suppression $(basename "$OLD")"
done

# ── 7. Statut + journal ──────────────────────────────────────────────────────
DUR=$(( $(date +%s) - START_TS ))
write_status "PASS" "$ENC_NAME" "$SHA" "$DUR" "$R_COUNTS"
{
  echo "$(date -u +%FT%TZ) PASS file=$ENC_NAME bytes=$ENC_SIZE sha256=$SHA duration_s=$DUR tables=$R_COUNTS"
} >> "$BACKUPS_DIR/backup.log"
# Garde le journal ≤ 1 Mo
[[ -f "$BACKUPS_DIR/backup.log" ]] && [[ "$(stat -c%s "$BACKUPS_DIR/backup.log")" -gt 1048576 ]] \
  && tail -n 500 "$BACKUPS_DIR/backup.log" > "$BACKUPS_DIR/backup.log.tmp" && mv "$BACKUPS_DIR/backup.log.tmp" "$BACKUPS_DIR/backup.log" || true

log "TERMINÉ en ${DUR}s — $ENC_NAME ($ENC_SIZE octets, sha256 $SHA)"
echo "BACKUP_PASS $ENC_NAME"
