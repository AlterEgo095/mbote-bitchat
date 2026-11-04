# Protocoles de tests sur appareils réels — Mbote BitChat

**Statut** : à exécuter par un opérateur disposant des appareils (impossible depuis le sandbox).
**Source** : audit frontend 360° §15 (« Restant NOT VERIFIED ») — cette liste ferme les
points qui exigent du matériel physique. Cocher au fur et à mesure ; tout échec →
ouvrir une anomalie avec capture + logs (`adb logcat`, console Safari iOS).

---

## 0. Préparation commune

- [ ] VPS (ou tunnel) joignable en **HTTPS** avec `prod-verify` à 0 FAIL (cf. `DEPLOY-VPS.md` §10 bis).
- [ ] `NEXT_PUBLIC_SOCKET_URL` défini au build (F-09) — le hub temps réel répond (§7 du runbook).
- [ ] 2 à 3 appareils : **Android ≥ 13** ×2 (BLE 5 conseillé) + **iPhone** (iOS ≥ 16).
- [ ] App native installée : `cd mobile && eas build -p android --profile preview` (ou APK Gradle local),
      puis même commande `-p ios` (compte Apple Developer requis).
- [ ] PWA prête : `https://…` ouverte dans Chrome Android / Safari iOS.

---

## 1. Android natif (2 téléphones minimum)

### 1.1 Permissions BLE (Android 12+)
- [ ] Au premier lancement : demande groupée `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`
      (jamais `ACCESS_FINE_LOCATION` seule — le module `mbote-ble` cible les nouvelles permissions).
- [ ] Refus → l'UI explique et propose de rouvrir les réglages (pas de crash, pas de boucle).
- [ ] Permission `POST_NOTIFICATIONS` (Android 13+) demandée avant d'activer le service mesh.

### 1.2 Mesh BLE réel
- [ ] **Advertise + scan** : téléphone A crée son identité → téléphone B le voit dans « Réseau ».
- [ ] **Publication hors internet** (avion + Wi-Fi coupé sur A, B à portée) : post de A
      arrive sur B via BLE (badge « mesh », compteur de sauts = 0).
- [ ] **Multi-sauts (3 appareils)** : A ─ B ─ C, A et C hors portée directe → le post de A
      atteint C (TTL décrémenté de 2) ; vérifier dans le journal DORS (panneau Routeur).
- [ ] **Fragmentation** : publier un message > 452 o (post long) → réassemblé intact chez B (F-03).
- [ ] **Gigue/doublons** : les deux appareils relaient le même paquet → un seul affichage
      (dédup SHA-256), compteur `duplicate` côté serveur quand ils remontent au pont.
- [ ] **Foreground service** : app passée en arrière puis *swipe-away* → la notification
      « mesh actif » reste ; le service survit 10 min (logcat : `MeshForegroundService`).
- [ ] **Outbox** : A hors ligne publie 5 messages → kill de l'app → relance → messages
      flushés vers le pont dès le retour du réseau (outbox SQLite, F-05).

### 1.3 Downlink (F-04)
- [ ] B hors ligne (avion), A en ligne publie → pont → B récupère le post au retour du
      réseau (< 60 s, polling downlink) et le **redistribue en BLE** aux voisins.

### 1.4 Build & publication
- [ ] `eas build -p android` vert sur CI (`build-android.yml`) — APK/AAB téléchargeable.
- [ ] Icônes/splash adaptatifs corrects (assets Vague 3), scheme `mbote://` ouvre l'app.

---

## 2. iPhone natif (iOS)

- [ ] Build TestFlight/EAS vert (`build-ios.yml`) sur appareil réel (NOT VERIFIED audit).
- [ ] **Permissions** : `NSBluetoothAlwaysUsageDescription` affichée en français cohérent ;
      refus → UI dégradée propre.
- [ ] **Background BLE** : app en arrière-plan → advertise/scan en pause propre ;
      restauration d'état au retour (pas de crash, outbox intacte).
- [ ] Publication mesh A→B signée et vérifiée (même protocole qu'Android — parité
      `check:parity` déjà verte en CI ; ce test valide le natif Swift réel).
- [ ] Push notifications : la réponse du bot DM arrive en notification (si APNs activé).

---

## 3. PWA installée

### 3.1 Chrome Android
- [ ] Badge « Installer » (beforeinstallprompt) → installation → icône + splash maskable corrects.
- [ ] Lancement **standalone** (pas de barre d'URL), safe-areas respectées.
- [ ] Raccourcis `?view=` : appui long sur l'icône → Canaux / Messages / Réseau s'ouvrent
      directement sur la bonne vue (F-14).
- [ ] **Mise à jour SW v4 (F-26)** : déployer une nouvelle version → toast « mise à jour
      disponible » → consentement → rechargement → nouvelle version active.
- [ ] `share_target` : partage d'un texte depuis une autre app → composer prérempli (F-49).

### 3.2 Safari iOS
- [ ] « Sur l'écran d'accueil » → standalone, safe-area du header (encoche) correcte.
- [ ] Pas de scroll horizontal, clavier ne recouvre pas le composer.
- [ ] Hors-ligne : mode avion → shell servi par le SW (`offline.html` si navigation absente
      du cache), données en cache visibles (F-25), file d'attente des actions.

### 3.3 Réseaux dégradés (audit §15.3)
- [ ] Coupure/retour réseau (Wi-Fi off 2 min) : like + post mis en file → flush automatique,
      **rollback du like** si le serveur refuse (F-28), aucun doublon à l'arrivée.
- [ ] Throttle lent (DevTools « Slow 3G » ou Netem) : scroll infini et DM toujours utilisables,
      timeouts fetch (F-32) affichent un message au lieu de pendre.

---

## 4. Navigateurs (matrice — audit §15.6)

| Point | Chrome desktop | Firefox | Safari macOS/iOS |
|---|---|---|---|
| Création identité (WebCrypto ECDSA P-256) | ☐ | ☐ | ☐ |
| Post signé + like + DM bot E2E | ☐ | ☐ | ☐ |
| Socket.io temps réel (WSS) | ☐ | ☐ | ☐ |
| SW + offline shell | ☐ | ☐ | ☐ (limites SW iOS connues) |
| Rendu 390 px / 768 px / 1440 px | ☐ | ☐ | ☐ |

> Safari/iOS : valider spécifiquement `crypto.subtle` en contexte sécurisé (HTTPS) et le
> stockage IndexedDB persistant (blocage ITP après 7 jours d'inactivité — documenter le
> comportement de l'outbox).

---

## 5. Accessibilité terrain (complément axe, audit §15.5)

L'audit automatique **axe-core est passé à 0 violation sur les 5 vues** (Vague 6).
Reste le test humain :

- [ ] TalkBack (Android) : parcours complet identité → post → like → DM sans blocage ;
      les libellés comme « J'aime · N » annoncent le compteur.
- [ ] VoiceOver (iOS) : idem ; le menu avatar annonce « Menu de mon identité - XX ».
- [ ] Navigation clavier seule (desktop) : tabulation ordonnée, focus visible, Enter sur
      bouton « Ouvrir » des canaux, Échap ferme les dialogues.
- [ ] Zoom 200 % : pas de perte de contenu, pas de scroll horizontal.

---

## 6. Charge terrain (complément tests/load-bridge.ts)

Le script automatisé `bun tests/load-bridge.ts` (100 posts/min via pont, bursts, flood de
fragments) est **vert en environnement de développement** (Vague 6). En production :

- [ ] Rejouer `tests/load-bridge.ts` contre le VPS depuis une machine externe.
- [ ] Observer la RAM/CPU des conteneurs pendant la phase C (flood fragments).
- [ ] Vérifier que les 429 portent bien `Retry-After` côté clients réels.

---

**Résultat attendu** : toutes les cases cochées ⇒ les derniers NOT VERIFIED de l'audit
(§15 + §20) passent à VERIFIED et la maturité peut être réévaluée au-delà de 8/10.
