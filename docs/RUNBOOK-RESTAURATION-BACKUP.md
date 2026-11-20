# RUNBOOK — Restauration des sauvegardes MBotE

> Audit plateforme 2026-11 §4.6 — procédure de restauration documentée et
> **clé de chiffrement copiée hors VPS** (préalable indispensable : sans la
> clé, aucun .db.enc n'est restaurable — le VPS est alors une seule surface
> de défaillance).

## 1. Ce qui existe déjà (état 2026-11-20)

| Élément | Valeur |
|---|---|
| Script | `/opt/mbote-bitchat/scripts/backup-mbote.sh` (créé par `setup-backups.yml`, rejouable via Actions) |
| Cron | `17 3 * * *` (crontab `aenews` — 03:17 WAT = 02:17 UTC, quotidien) |
| Sortie | `/opt/mbote-bitchat/backups/mbote-<STAMP>.db.enc` (~240 KB) |
| Chiffrement | AES-256-CBC · PBKDF2 300 000 itérations · clé = `/opt/mbote-bitchat/.backup-key` (0600) |
| Test de restauration | À CHAQUE exécution : déchiffrement → `PRAGMA integrity_check` → comparaison des comptages avec la base vivante (statut : `backups/last-backup-status.json`, dernier = PASS) |
| Rotation | 14 sauvegardes conservées |
| Intégrité | `sha256` de chaque .db.enc journalisé (`backups/backup.log`, `backup.log` ≤ 1 Mo) |

Surveillance minimale : vérifier `backups/last-backup-status.json` (`"result": "PASS"`)
et la présence d'un fichier du jour dans `backups/`. Une semaine sans PASS = incident.

## 2. Clé de chiffrement — custody

- Source de vérité : `/opt/mbote-bitchat/.backup-key` (VPS, 0600, propriétaire `aenews`).
- **Copie hors ligne obligatoire** (audit 2026-11) : remise au titulaire du projet le
  2026-11-20, à conserver dans un gestionnaire de secrets (1Password/Bitwarden/KeePass) —
  **JAMAIS dans le repo, jamais en clair dans un canal public, jamais dans le VPS uniquement**.
- Rotation de la clé : générer une nouvelle clé (`openssl rand -base64 32`), re-chiffrer
  la sauvegarde la plus récente, puis remplacer `.backup-key`. Les anciennes sauvegardes
  restent lisibles avec l'ANCIENNE clé tant qu'elle n'est pas détruite — ne détruire
  l'ancienne clé qu'après la rotation complète des archives.

## 3. Restauration complète (procédure)

### 3.1 Préparation (sur le VPS, ou sur toute machine ayant le .db.enc + la clé)

```bash
# Lister les sauvegardes disponibles (le plus récent PASS d'abord)
ls -lt /opt/mbote-bitchat/backups/mbote-*.db.enc | head -5
cat /opt/mbote-bitchat/backups/last-backup-status.json   # vérifier result=PASS
```

### 3.2 Déchiffrement + vérification d'intégrité

```bash
KEY=/opt/mbote-bitchat/.backup-key
ENC=/opt/mbote-bitchat/backups/mbote-<STAMP>.db.enc

openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 \
  -in "$ENC" -out /tmp/restored.db -pass file:"$KEY"

python3 - /tmp/restored.db <<'EOF'
import sqlite3, sys, json
conn = sqlite3.connect(sys.argv[1])
print("integrity_check:", conn.execute("PRAGMA integrity_check").fetchone()[0])
for t in [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")][:10]:
    print(t, conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])
EOF
# attendu : integrity_check = ok, comptages cohérents avec last-backup-status.json
```

Si le déchiffrement échoue (`bad decrypt`) : mauvaise clé → essayer la copie hors ligne ;
les sauvegardes plus anciennes peuvent avoir été créées avec une clé de rotation antérieure.

### 3.3 Remplacement de la base vivante (fenêtre d'arrêt ~10 s)

```bash
# 0. (recommandé) sauvegarder l'état actuel AVANT d'écraser
docker cp mbote-mesh:/app/db/custom.db /opt/mbote-bitchat/backups/pre-restore-$(date -u +%Y%m%d-%H%M%S).db

# 1. arrêter les writers (relay émet, mesh écrit)
cd /opt/mbote-bitchat
docker compose stop relay admin

# 2. glisser la base restaurée dans le volume (le mesh doit être STOPPÉ pour éviter
#    que WAL/-shm résiduels ne corrompent la bascule)
docker compose stop mesh
docker cp /tmp/restored.db mbote-mesh:/app/db/custom.db
# nettoyer les fichiers WAL/SHM résiduels de la session précédente
docker run --rm -v mbote-bitchat_db:/d alpine sh -c 'rm -f /d/custom.db-wal /d/custom.db-shm'

# 3. redémarrer la stack complète
docker compose up -d
# 4. vérifier
sleep 15 && docker ps --filter name=mbote --format '{{.Names}} {{.Status}}'
curl -fsS http://127.0.0.1:3000/api/stats | head -c 200
```

Vérifications post-restauration :
- `docker logs mbote-mesh --tail 30` — aucune erreur Prisma/SQLite ;
- `/api/stats` répond ; panneau admin : connexion OK ;
- déclencher manuellement un backup (`./scripts/backup-mbote.sh`) — son test de
  restauration quotidien valide la base en place.

### 3.4 Restauration partielle (extraction d'enregistrements seulement)

Si l'objectif est de récupérer des données ciblées (pas de bascule complète) :

```bash
python3 - /tmp/restored.db <<'EOF'
import sqlite3, sys, json
src = sqlite3.connect(sys.argv[1])
for row in src.execute("SELECT * FROM DirectMessage WHERE id = ?", (42,)):
    print(row)
EOF
# puis réinsertion ciblée sur la base vivante (attention aux contraintes/références)
```

## 4. Externalisation des archives (recommandé, hors périmètre 2026-11)

Les .db.enc sont chiffrés : ils peuvent être copiés hors VPS sans exposer les données
(S3/R2/rsync vers une 2ᵉ machine + vérification du sha256). Le script actuel ne les
pousse nulle part — P2, à implémenter quand un stockage objet est choisi.

## 5. Limites connues

- Snapshot par `docker cp` (pas de point de cohérence SQLite instantané) : une écriture
  en vol peut théoriquement figer un état intermédiaire — mitigé par `-wal` copié avec
  la base + le test de restauration quotidien qui rejette toute copie incohérente.
- Rétention 14 jours sur le MÊME disque : un décès du disque détruit tout — l'externalisation (§4) est la vraie réponse.
- La clé ne quitte le VPS que par remise manuelle (fait 2026-11-20) — à refaire après CHAQUE rotation.
