# ADMIN-TROUBLESHOOTING — Erreurs courantes du panneau et résolutions

**Version** : 1.0 · **Date** : 2026-11-08 (Kinshasa WAT) · **Étape 10**
**Complément de** : `docs/ADMIN-OPERATIONS.md` (usage normal) · `docs/specs/ADMIN-ACCESS-RUNBOOK.md` (installation/accès).

Symptôme → cause probable → diagnostic → résolution. Les commandes se lancent sur le VPS sauf mention contraire.

---

## 1. « Session expirée » / retour au login en boucle

**Symptômes** : après login, retour immédiat à l'écran d'authentification ; ou 302 systématique sur les pages.

**Causes & résolutions** :
1. **Idle 30 min** (révocation paresseuse) — se reconnecter, c'est tout.
2. **Cookie rejeté** : le cookie est `HttpOnly; SameSite=Strict; Secure` sur le domaine admin — vérifier que l'URL est bien `https://admin.…` (jamais l'IP directe), et que Cloudflare Access n'est pas contourné par un autre domaine.
3. **Horloge TOTP décalée** : le serveur accepte ±30 s — si l'app d'authentification dérive, se resynchroniser ; en dernier recours, code de secours (break-glass, §6 du runbook).
4. **Toutes les sessions révoquées** : un break-glass (le vôtre ou un incident) révoque TOUT — relogin normal après re-enrôlement TOTP.

**Diagnostic** :
```bash
docker exec mbote-mesh sh -c "sqlite3 /app/db/custom.db \"SELECT id, adminUserId, revokedAt, revokedReason, expiresAt FROM AdminSession ORDER BY createdAt DESC LIMIT 5;\""
# revokedReason='logout' | 'break-glass' | 'idle-timeout' — l'audit raconte le reste (action=logout / break-glass)
```

## 2. Bandeau rouge « Backend injoignable » (dashboard)

**Cause** : le panneau ne joint plus l'app principale (`mbote`).

**Diagnostic** :
```bash
docker compose ps                                  # mbote est-il Up / healthy ?
docker logs mbote-mesh --since 10m 2>&1 | tail -30
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/stats   # depuis le VPS
```

**Résolutions** :
- Conteneur down/crash-loop → `docker compose up -d --build` puis re-vérifier.
- Le panneau **reste utilisable** pendant la panne (bandeau + pages rendues) ; il récupère seul dès que le backend répond — bouton **Rafraîchir**.

## 3. 502 sur toutes les actions du panneau

Le BFF répond `502 { backend-unreachable }` quand l'app principale ne répond PAS (réskill/timeout). Cause = même famille que §2. Vérifier `BACKEND_INTERNAL_URL` du conteneur `mbote-admin` (attendu `http://mbote:3000`) et le réseau Docker (`docker network inspect <réseau>` — les deux conteneurs doivent partager le réseau).

⚠️ Distinction importante : **502 = backend injoignable** ; **401 = session invalide** (re-login) ; **403 = rôle insuffisant** (normal — ex. un moderator ne voit pas l'audit). Ne pas confondre un 403 légitime avec une panne.

## 4. Migration en cours / verrou base de données

**Symptômes** (fenêtre de quelques secondes pendant un déploiement) : actions du panneau refusées, parfois **401 « session invalide »** alors que la session est bonne — c'est le mode **fail-closed** : le verify côté app principale ne peut pas lire la DB verrouillée, le panneau refuse au lieu de deviner. Aucune donnée n'est exposée, aucun crash (prouvé R2, `docs/proofs/ADM-step10.md`).

**Diagnostic** :
```bash
docker logs mbote-mesh --since 5m 2>&1 | grep -iE "migrat|locked|busy"
docker exec mbote-mesh sh -c "sqlite3 /app/db/custom.db \"SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 3;\""
```

**Résolution** : attendre la fin du verrou (le boot exécute `prisma migrate deploy` AVANT de servir) puis recharger — récupération automatique prouvée. Si une migration reste bloquée (`finished_at IS NULL`) : `docker exec -it mbote-mesh bunx prisma migrate resolve --rolled-back <nom>` puis redémarrer le conteneur.

**Amélioration tracée (post-déploiement)** : distinguer « backend occupé (5xx) » de « session invalide (401) » au verify du panneau — le raffinement touche ~20 sites d'appel (`admin/src/lib/admin-backend.ts`), volontairement non entrepris en Étape 10.

## 5. « database is locked » dans les logs

**Ne devrait plus arriver** : trois barrières ont été posées à l'Étape 10 (preuve `docs/proofs/ADM-step10.md` §C-E) —
1. mutex d'écriture in-process (une seule transaction d'écriture admin à la fois — `src/lib/mbote/write-mutex.ts`) ;
2. `journal_mode=WAL` posé au boot (`src/lib/db.ts` — persistant au fichier) ;
3. `connection_limit=1` forcé (file FIFO déterministe — `src/lib/db.ts`).

**Si cela réapparaît** :
```bash
bun -e "const {Database}=require('bun:sqlite'); const d=new Database('/app/db/custom.db',{readonly:true}); console.log(d.query('PRAGMA journal_mode').get());"
# attendu : {"journal_mode":"wal"}
docker inspect mbote-mesh --format '{{.HostConfig.Cpus}}'   # une SEULE instance du conteneur (SQLite = fichier local)
```
Si `delete` au lieu de `wal` : le fichier a été recréé SANS passer par le boot applicatif — redémarrer `mbote-mesh` (le PRAGMA se re-positionne au boot). Deux instances d'app sur la même DB est un anti-pattern interdit (SCALE-ARCHITECTURE §8 — palier 2 = Postgres).

## 6. 410 Gone sur une intention four-eyes

L'intention a expiré (TTL 1 h, évaluation paresseuse). Le super-admin demandeur recrée l'intention ; l'ancienne est marquée `expired` dans l'audit (`pendingaction_expired`). Aucune action n'a été exécutée.

## 7. 409 « une intention est déjà en attente »

Une seule intention OUVERTE par (type, cible) — index unique partiel en base (migration `0008_etape10_audit_stress`), y compris sous course simultanée de création (stress S4). Attendre l'approbation/annulation/expiration de la première, ou en demander l'annulation au demandeur.

## 8. 422 justification invalide

Format attendu : `CATÉGORIE: texte` avec texte ≥ 20 caractères (ex. `SPAM: publi répétée de liens de paris sur 3 posts`). La catégorie fait partie de la liste serveur (`src/lib/mbote/justification.ts`). L'erreur est affichable dans l'UI — elle ne masque pas le reste.

## 9. L'audit semble « bloqué » / append-only

Toute tentative d'UPDATE/DELETE sur `AdminAudit` échoue au niveau SQLite (triggers `admin_audit_no_update` / `admin_audit_no_delete`, migration 0004) — **c'est le comportement voulu**. Si une ligne semble fausse : ajouter une ligne corrective (le journal est un append-only, pas une table modifiable).

## 10. La queue affiche « file vide » mais un contenu est litigieux

La queue ne liste QUE les contenus **signalés** (poids = COUNT de reports ouverts). Sans report, pas d'entrée : faire signaler par un utilisateur, ou agir via `/users` (warn/suspend directement sur la fiche — visible si l'URL de la fiche est connue).

## 11. Le dashboard affiche « uptime critique » juste après un deploy

L'uptime est celui du PROCESS : un redémarrage remet le compteur à zéro — orange puis vert dès 1 h. Attendu après chaque deploy ; pas un incident.

## 12. Perdu le mot de passe ET le TOTP (et les codes de secours)

Procédure break-glass du runbook (`ADMIN-ACCESS-RUNBOOK.md` §4) : connexion par code de secours → régénération TOTP forcée → 2 NOUVEAUX codes. Si les codes de secours sont aussi perdus : un autre super-admin crée un compte de remplacement (`admin:create`) et le compte perdu est désactivé via CLI — l'audit garde la trace des deux opérations. Un seul super-admin sur l'installation + perte totale des secrets = incident grave : restaurer depuis un export hors ligne des secrets (le bootstrap les affiche UNE fois — d'où la règle « stocker offline » de la checklist §5).
