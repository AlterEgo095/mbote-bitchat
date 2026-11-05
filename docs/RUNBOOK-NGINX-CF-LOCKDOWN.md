# RUNBOOK — Verrouillage de l'origine derrière Cloudflare (condition n° 5)

> **Statut : PRÊT — EN ATTENTE D'EXÉCUTION SUR LE VPS.**
> La moitié applicative du correctif XFF est déployée (`src/lib/mbote/client-ip.ts`).
> Cette moitié VPS exige un accès interactif à l'hôte (nginx y dessert d'autres
> applications — aucune modification à l'aveugle n'est acceptable).

## 1. Pourquoi ce verrou est nécessaire

Le correctif applicatif (`client-ip.ts`) n'accepte l'IP client que sur **preuve
de traversée Cloudflare** : le dernier maillon de la chaîne `x-forwarded-for`
doit appartenir aux plages officielles publiées par Cloudflare, et `cf-ray`
doit être présent.

Il subsiste un unique trou théorique : une connexion **directe à l'origine**
(en contournant Cloudflare) avec des en-têtes forgés, qui simulerait une
traversée CF. C'est précisément ce que ce verrou ferme : nginx n'accepte le
site Mbote que depuis les IP de l'infrastructure Cloudflare officielle.

Chaîne de confiance après application :

```
client → Cloudflare (plages officielles) → nginx (allow CF / deny all) → app
          écrase cf-connecting-ip            TCP peer ∈ plages CF          client-ip.ts vérifie la preuve
```

## 2. Pré-requis (condition n° 8 de la direction)

| Pré-requis | Statut |
|---|---|
| Audit préalable | ✅ Audit stratégique livré (R6/XFF identifié) |
| Sauvegarde vérifiée | ✅ `setup-backups.yml` — cycle PASS avec test de restauration |
| Plan de retour arrière | ✅ §4 ci-dessous (fichier `.bak-cflock-*` + `--rollback`) |
| Tests validés | ✅ Harnais `client-ip.ts` 9/9 PASS + preuves curl du script |

## 3. Procédure d'exécution (sur le VPS, en root)

```bash
cd /opt/mbote-bitchat            # le script est synchronisé par le déploiement
sudo ./scripts/nginx-cf-lockdown.sh --plan    # 1. VÉRIFIER l'aperçu (fichier cible + insertion)
sudo ./scripts/nginx-cf-lockdown.sh --apply   # 2. Appliquer (nginx -t obligatoire avant reload)
```

Le script :
1. localise la conf contenant `server_name mbotemesh.aenews.online`
   (suit les liens symboliques `sites-enabled` → `sites-available`) ;
2. en fait une copie horodatée `.bak-cflock-AAAAmmjj-HHMMSS` ;
3. insère `allow <15 plages IPv4 CF> / allow <7 plages IPv6 CF> / deny all`
   après chaque ligne `server_name` du domaine (blocs :80 et :443) ;
4. exécute `nginx -t` — **en cas d'échec : restauration automatique, aucun
   reload** ;
5. recharge nginx en graceful (zéro coupure) ;
6. imprime les preuves (curl direct → 403 attendu ; curl via domaine → 200).

⚠ Ce script ne touche QUE le fichier de conf Mbote. Les autres sites du serveur
ne sont pas modifiés. Si nginx héberge le domaine sous un autre `server_name`,
adapter `DOMAIN=...` sans toucher au reste.

## 4. Plan de retour arrière

```bash
sudo ./scripts/nginx-cf-lockdown.sh --rollback /etc/nginx/.../conf.bak-cflock-<HORODATAGE>
# = restaurer le fichier + nginx -t + reload + preuves curl
```

Durée de retour arrière : < 10 secondes. Le commit applicatif se revert
indépendamment (`git revert <sha>` — l'ancien comportement clientIp était
infaillible côté disponibilité, simplement vulnérable côté usurpation).

## 5. Vérification post-application (checklist)

- [ ] `curl https://mbotemesh.aenews.online/` → 200 depuis Internet
- [ ] curl direct à l'origine IP (hors CF) → **403**
- [ ] Application fonctionnelle derrière CF : post + DM + présence relay
- [ ] Rate limiting granulaire : hammering 13 posts/min → 429 sur l'IP fautive,
      pas sur les autres clients
- [ ] Les autres sites nginx du VPS répondent normalement

## 6. Journal d'exécution

| Date | Exécuteur | Résultat | Preuves |
|---|---|---|---|
| — | — | en attente d'accès VPS interactif | — |
