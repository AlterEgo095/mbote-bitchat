# Kit de mesure réseau RDC — guide pour les volontaires (48 h)

**Projet :** Mbote BitChat · **Durée de la mesure :** 48 heures · **Difficulté : aucune compétence technique requise**

Vous tenez entre les mains une petite « sonde » : un programme qui teste, **toutes les 5 minutes**, la connexion vers notre site `https://mbotemesh.aenews.online` et note les résultats dans un fichier. En 48 h, elle écrit environ 575 lignes.

**Ce que la sonde NE fait PAS :**
- ❌ Elle n'enregistre **aucune donnée personnelle** (pas de contacts, pas de SMS, pas de position, pas de contenu de navigation).
- ❌ Elle n'utilise presque rien : **moins de 10 Mo de données** sur les 48 h (quelques kilo-octets par mesure).
- ✅ Elle note seulement : l'heure, des **durées en millisecondes**, un code de réponse du site, et le code du datacenter Cloudflare qui vous a répondu (ex. `HKG`, `JNB`).

Merci — ces mesures réelles depuis les réseaux congolais (Vodacom, Airtel, Orange) servent à décider où installer le serveur de l'application.

---

## 1. Ce qu'il vous faut

| Option | Matériel | Remarques |
|---|---|---|
| **A (recommandée)** | Un téléphone **Android** + l'application gratuite **Termux** | Se charge très bien, fonctionne pendant la charge |
| **B** | Un **ordinateur portable** (Windows, Mac ou Linux) avec Node.js installé | Doit rester allumé et branché 48 h, en données mobiles |

Dans les deux cas :
- une **SIM de l'opérateur à tester** (Vodacom RDC, Airtel RDC ou Orange RDC) avec des données mobiles actives ;
- un **chargeur** pour toute la durée ;
- **le Wi-Fi désactivé** pendant toute la mesure (sinon la sonde mesurerait votre Wi-Fi et non le réseau mobile — mesures invalides).

---

## 2. Installation — Android avec Termux (pas à pas)

1. **Installer Termux** depuis **F-Droid** : <https://f-droid.org/packages/com.termux/>
   ⚠️ Ne prenez PAS la version du Play Store (obsolète, elle ne marche pas).
2. **Ouvrir Termux** (icône noire avec un chevron `>`). Taper ces deux commandes (validez avec Entrée après chaque ligne, laissez finir) :
   ```
   pkg update -y && pkg upgrade -y
   pkg install nodejs -y
   ```
3. **Vérifier** : tapez `node -v` → il doit afficher `v18` ou plus (ex. `v20.11.0`). Si oui, tout est prêt.
4. **Récupérer la sonde** : le coordinateur vous a envoyé le fichier **`probe.mjs`** (par e-mail ou WhatsApp). Téléchargez-le, puis dans Termux :
   ```
   termux-setup-storage
   ```
   → Termux demande l'autorisation d'accéder aux fichiers : **Autoriser**. Puis :
   ```
   mkdir -p ~/probe
   cp /sdcard/Download/probe.mjs ~/probe/
   cd ~/probe
   ```
   (si le fichier est ailleurs, adaptez le chemin, ex. `/sdcard/WhatsApp/Media/...`)
5. **Installer l'antienne anti-veille** (empêche Android de tuer la sonde) :
   ```
   pkg install termux-api -y
   termux-wake-lock
   ```

## 2 bis. Installation — ordinateur portable

1. Installer **Node.js** (version 18 ou plus) depuis <https://nodejs.org> (bouton « LTS »), en laissant toutes les options par défaut.
2. Vérifier dans un terminal (PowerShell sur Windows) : `node -v` → `v18` ou plus.
3. Créer un dossier `probe`, y placer le fichier **`probe.mjs`** reçu du coordinateur, puis ouvrir un terminal **dans ce dossier**.

---

## 3. Préparer l'appareil : SIM, données, étiquette

1. **Insérez UNIQUEMENT la SIM de l'opérateur à tester** (si votre téléphone a deux SIM, désactivez les données de l'autre).
2. **Données mobiles : ACTIVÉES. Wi-Fi : DÉSACTIVÉ** (y compris la reconnexion automatique aux réseaux connus). Testez en ouvrant un site dans le navigateur : il doit passer par les données mobiles.
3. Choisissez votre **étiquette** avec le coordinateur, au format strict :
   ```
   <operateur>-<ville>-<numero-appareil>
   ```
   - tout en **minuscules**, **sans espace**, **sans accent** ;
   - `operateur` ∈ `vodacom` | `airtel` | `orange` ;
   - exemples : `vodacom-rdc-kinshasa-1`, `airtel-rdc-lubumbashi-2`, `orange-rdc-goma-1`.
4. Notez l'heure de début.

---

## 4. Lancer la mesure (commande exacte)

**Android / Termux, Linux, Mac :**
```bash
cd ~/probe
termux-wake-lock
PROBE_LABEL=airtel-rdc-lubumbashi-2 node probe.mjs
```
(remplacez l'étiquette par la vôtre — laissez `node probe.mjs` tel quel)

**Windows (PowerShell) :**
```powershell
cd C:\Users\Vous\probe
$env:PROBE_LABEL="airtel-rdc-lubumbashi-2"
node probe.mjs
```

Vous verrez une ligne toutes les 5 minutes, du genre :
```
[2025-06-01T10:05:00Z] airtel-rdc-lubumbashi-2 | dns=120 tcp=180 tls=95 http=640 status=200 bytes=1234 colo=JNB icmp=45
```
C'est normal que ça défile lentement : **laissez tourner 48 h, appareil branché en permanence**. L'écran peut s'éteindre.

---

## 5. Que faire en cas de coupure ?

| Situation | Quoi faire |
|---|---|
| Le réseau mobile coupe quelques minutes | **Rien.** Les lignes manquantes sont notées en erreur, la sonde reprend seule dès le retour du réseau. |
| Termux/l'ordinateur s'est fermé, ou le téléphone a redémarré | **Relancez exactement la même commande** (§4). La sonde lit le fichier `.end-at` et s'arrêtera **à la même heure de fin prévue** — vous ne perdez que le temps d'arrêt. |
| Vous voulez recommencer une campagne à zéro | Supprimez le fichier `probe-data/probe-<votre-étiquette>.end-at` puis relancez. |
| Le message `ERREUR: ...` apparaît parfois | Normal sur un réseau mobile : la mesure est enregistrée comme échec, c'est justement une donnée utile. |

---

## 6. Fin de la mesure : récupérer et envoyer le CSV

1. Après 48 h, la sonde affiche **« RÉSUMÉ DE LA SONDE »** puis s'arrête d'elle-même (message « durée du protocole atteinte »). Vous pouvez aussi l'arrêter avec **Ctrl+C** : le résumé s'affiche quand même.
2. Les résultats sont ici : **`probe-data/probe-<étiquette>-<date>.csv`** (un fichier par jour, ouvrable dans Excel). Pour les lister : `ls probe-data/`
3. **Envoyer au coordinateur** (e-mail ou WhatsApp) :
   - **Termux :**
     ```
     termux-setup-storage
     cp probe-data/*.csv /sdcard/Download/
     ```
     puis partagez les fichiers depuis le gestionnaire de fichiers du téléphone.
   - **Ordinateur :** joignez directement les fichiers CSV du dossier `probe-data`.

**Confidentialité :** le CSV ne contient que des horodatages (en UTC), des durées en millisecondes, des codes HTTP, des tailles de fichiers et des codes de datacenter. **Aucune donnée personnelle, aucun contenu, aucune position.** L'étiquette ne comporte que l'opérateur, la ville et le numéro d'appareil convenus avec le coordinateur.

---

## 7. Checklist

**Jour 1 — démarrage**
- [ ] SIM du bon opérateur, données mobiles ON, **Wi-Fi OFF**
- [ ] Termux installé + `node -v` ≥ v18 (ou ordinateur avec Node)
- [ ] `probe.mjs` dans `~/probe`
- [ ] `termux-wake-lock` activé (Android)
- [ ] Commande lancée avec la **bonne étiquette**
- [ ] Au moins 1–2 lignes affichées sans message d'erreur permanent
- [ ] **Appareil branché au chargeur**, heure de début notée

**Jour 1 soir**
- [ ] Appareil toujours branché
- [ ] Le terminal tourne toujours (rouvrir Termux montre la sonde en marche)

**Jour 2**
- [ ] Appareil toujours branché, données mobiles toujours actives, Wi-Fi toujours OFF
- [ ] Si coupure d'électricité/redémarrage : relancer la commande (§5)

**Fin (après 48 h)**
- [ ] Message « RÉSUMÉ DE LA SONDE » vu (ou arrêt manuel Ctrl+C)
- [ ] Fichiers CSV récupérés dans `probe-data/`
- [ ] CSV **envoyés** au coordinateur et accusé de réception reçu

---

## 8. Problèmes fréquents

| Message / symptôme | Solution |
|---|---|
| `bash: node: command not found` | Refaire `pkg install nodejs -y` (Termux) ou réinstaller Node.js (PC). |
| `Cannot find module .../probe.mjs` | Vous n'êtes pas dans le bon dossier : faites `cd ~/probe` avant de lancer. |
| `EACCES` en copiant `probe.mjs` | Refaire `termux-setup-storage` et autoriser l'accès aux fichiers. |
| Beaucoup de lignes `ERREUR: ...` d'affilée | Le réseau mobile est coupé : vérifier le forfait/credit data ; la sonde reprendra seule. |
| La sonde s'est arrêtée en pleine nuit | Rouvrir Termux et relancer la même commande — la fin prévue est conservée. |
| Termux se ferme quand l'écran s'éteint | Refaire `termux-wake-lock`, et désactiver l'optimisation de batterie pour Termux dans les réglages Android. |

Une question ? Contactez le coordinateur du protocole (voir `docs/NETWORK-MEASUREMENT-48H.md`).
