#!/usr/bin/env bash
# =============================================================================
#  nginx-cf-lockdown.sh — Verrouillage de l'origine derrière Cloudflare
#  (condition de sécurité n° 5, moitié VPS du correctif XFF)
# -----------------------------------------------------------------------------
#  OBJECTIF : n'autoriser l'accès HTTP(S) au site Mbote sur nginx qu'aux plages
#  IP officielles de Cloudflare. Toute connexion directe à l'origine (contourne-
#  ment de Cloudflare, seule manière de forger cf-connecting-ip / la chaîne XFF)
#  reçoit 403. En amont, l'application (src/lib/mbote/client-ip.ts) n'accepte
#  l'IP client que sur preuve de traversée Cloudflare → chaîne complète.
#
#  MÉTHODE SÛRE PAR CONSTRUCTION :
#    1. Localise le fichier de conf contenant server_name du domaine
#    2. Sauvegarde horodatée (rollback = restaurer ce fichier + reload)
#    3. Insère allow <plages CF> / deny all APRÈS la ligne server_name
#       (directives de contexte server : l'ordre est indifférent pour nginx)
#    4. `nginx -t` : si le test échoue → restauration automatique, AUCUN reload
#    5. reload uniquement si le test passe (graceful, zéro coupure)
#    6. Preuves : curl direct → 403 attendu, curl via domaine → 200 attendu
#
#  USAGE :
#    sudo ./nginx-cf-lockdown.sh --plan    # affiche la modification sans l'appliquer
#    sudo ./nginx-cf-lockdown.sh --apply   # applique avec garde-fous + preuves
#    sudo ./nginx-cf-lockdown.sh --rollback <fichier-sauvegardé>
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-mbotemesh.aenews.online}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"

log() { echo "[cf-lockdown $(date -u +%FT%TZ)] $*"; }
die() { echo "[cf-lockdown $(date -u +%FT%TZ)] ERREUR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "à exécuter en root (sudo)"

# Plages officielles Cloudflare (https://www.cloudflare.com/ips/ — à jour 2025-11)
CF_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

build_insert() {
  local out="    # ── Verrouillage origine : sources autorisées = infrastructure Cloudflare officielle uniquement"
  out+=$'\n'
  for cidr in $CF_V4; do out+="    allow $cidr;$'\n'"; done
  for cidr in $CF_V6; do out+="    allow $cidr;$'\n'"; done
  out+="    deny all;"
  printf '%s' "$out"
}

# ── Localisation de la conf (suit les liens, ignore les commentaires vides) ──
find_conf() {
  local found
  found=$(grep -rl --include='*.conf' -E "server_name[^;]*${DOMAIN}" "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" "$NGINX_DIR/sites-available" 2>/dev/null | head -1 || true)
  [[ -n "$found" ]] || die "conf nginx contenant server_name $DOMAIN introuvable sous $NGINX_DIR"
  readlink -f "$found" # résout le lien sites-enabled → sites-available (sed -i ne doit PAS casser le lien)
}

CONF=$(find_conf)

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -n "${2:-}" && -f "${2:-}" ]] || die "usage: --rollback <fichier-sauvegardé>"
  cp "$2" "$CONF" && nginx -t && nginx -s reload && log "rollback appliqué depuis $2 — nginx rechargé"
  exit 0
fi

INSERT=$(build_insert)
BACKUP="${CONF}.bak-cflock-$(date -u +%Y%m%d-%H%M%S)"

if [[ "${1:-}" == "--plan" ]]; then
  log "fichier cible : $CONF"
  log "── aperçu de l'insertion (après chaque ligne server_name correspondante) ──"
  echo "$INSERT"
  log "sauvegarde prévue : $BACKUP"
  exit 0
fi

[[ "${1:-}" == "--apply" ]] || die "usage: --plan | --apply | --rollback <fichier>"

# ── Sauvegarde ───────────────────────────────────────────────────────────────
cp -a "$CONF" "$BACKUP"
log "sauvegarde : $BACKUP"

# ── Modification (après CHAQUE server_name du domaine ; blocs :80 et :443) ──
awk -v d="$DOMAIN" -v ins="$INSERT" '{
  print
  if ($0 ~ /server_name/ && $0 ~ d && !done_for_this_block) {
    n = split(ins, L, "\n")
    for (i = 1; i <= n; i++) print L[i]
    inserted = 1
    done_for_this_block = 1
  }
  /server[[:space:]]*\{/ { done_for_this_block = 0 }
}
END { exit !inserted }' "$CONF" > "${CONF}.tmp"
mv "${CONF}.tmp" "$CONF"
log "insertion effectuée"

# ── Test nginx : échec → restauration automatique, JAMAIS de reload ─────────
if ! nginx -t 2>&1; then
  cp -a "$BACKUP" "$CONF"
  log "⚠ nginx -t en échec → configuration restaurée depuis la sauvegarde. AUCUN changement appliqué."
  die "restauration effectuée — inspecter le conflit de directives"
fi
log "nginx -t : OK"

# ── Reload graceful (zéro coupure) ──────────────────────────────────────────
nginx -s reload
log "nginx rechargé"

# ── Preuves ──────────────────────────────────────────────────────────────────
sleep 1
log "PREUVE 1 — curl direct à l'origine en HTTPS avec XFF forgé (attendu 403) :"
curl -sk -o /dev/null -w "  HTTP %{http_code}\n" --resolve "$DOMAIN:443:127.0.0.1" \
  -H "X-Forwarded-For: 6.6.6.6" -H "CF-Connecting-IP: 6.6.6.6" "https://$DOMAIN/" || true
log "PREUVE 1b — curl direct HTTP:80 avec XFF forgé (attendu 403, ou 301 si redirection AVANT le bloc serveur) :"
curl -s -o /dev/null -w "  HTTP %{http_code}\n" --resolve "$DOMAIN:80:127.0.0.1" \
  -H "X-Forwarded-For: 6.6.6.6" "http://$DOMAIN/" || true
log "PREUVE 2 — curl via le domaine public (traversée Cloudflare, attendu 200) :"
curl -s -o /dev/null -w "  HTTP %{http_code}\n" "https://$DOMAIN/" || true
log "TERMINÉ — rollback si nécessaire : sudo $0 --rollback $BACKUP"
