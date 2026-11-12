# C3 — Appels vidéo 1:1 (WebRTC E2EE) — preuve

Date : 2026-11-12 · Branche : `feat/mbote-v1` (union consolidée) · Worktree : `wt-adm`
Runner : `bash scripts/c3-video-calls-proof-run.sh` — **exit 0** (rejouable, DEV-SETUP §2b)

Extension directe de C2 : MÊMES patterns (signalisation signée call:\*, TURN
éphémère, DTLS-SRTP, knock push, fallback notes vocales) — seule la piste média
change. Aucun nouveau prérequis infrastructure (C2 a déjà validé TURN +
DTLS-SRTP + fake devices + WebSocket ; le fix CSP ws:// de C2 reste en place).

## 1. Prérequis bloquants — TOUS PASSÉS (avant le code, directive)

| Prérequis | Résultat | Preuve |
|---|---|---|
| P1. Caméra fake 640×480@24 (contraintes C3 exactes) | **camOk: true** — tracks vidéo+audio live, settings 640×480@24 | `c3-prereq-probe.json` |
| P2. Contrôles encodeur : `RTCRtpSender.setParameters` (maxBitrate + scaleResolutionDownBy) acceptés puis relus | **encOk: true** — 450 000 bps + 1.5 rejoués à l'identique | idem |
| P3. Offre SDP avec m-line vidéo ACTIVE (`m=video <port≠0>`) | **sdpOk: true** | idem |
| Permissions-Policy / CSP | **déjà en place** (aucun changement) : `camera=(self)` posé depuis B4, `media-src blob:` depuis B3, `connect-src ws://` fixé en C2 | next.config.ts |

## 2. Livrables → tests → preuves

| Livrable | Test | Preuve |
|---|---|---|
| `webrtc.ts` — `startOutgoing(peer, label, mode)` : getUserMedia 640×480@24, FALLBACK AUDIO SEUL (caméra absente/refusée → NotAllowedError/NotFoundError/OverconstrainedError), offer `offerToReceiveVideo`, répondeur lit `m=video` du SDP (offerHasVideo, port 0 = m-line rejetée) | harnais V1/V6 + navigateur E1-E4 + F1 | `c3-test-output.txt`, `c3-browser.json` |
| Dégradation adaptative : `VideoQualityController` PUR (480p 900k → 360p 450k+scale 1.5 → 240p 200k+scale 2, hystérésis 2 mesures > 5 %, descente seule) + monitor getStats 2 s (inbound + remote-inbound vidéo) → `setParameters` (AUCUNE renégociation) | V5 (pur) + E7 navigateur (stats simulées → setParameters réels capturés + badge) | `c3-browser.json` `setParametersApplied`, capture `c3-video-degraded-a.png` |
| Indicateur « Connexion instable » (packet loss > 5 %) + étage affiché (480p/360p/240p) | E7 navigateur | capture `c3-video-degraded-a.png` (badge ambre + « 360p ») |
| `call:media` {videoOn, audioOn} signé — annonce d'état pistes (les frames noires de `track.enabled=false` sont INDÉTECTABLES côté receiver sans ce message) | V2/V3 (booléens stricts, anti-usurpation) + E5 navigateur | captures `c3-video-camera-off-b.png` |
| `toggleCamera` (track.enabled) / `flipCamera` (replaceTrack + facingMode) — AUCUNE renégociation | E5/E6 navigateur (flip → appel toujours actif, preview vivant) | `c3-browser.json` `flipKeptCallAlive` |
| Knock vidéo : type `incoming_video_call`, preuve étendue `` `${from}|call-knock|${to}|${callId}|${type}|${ts}` `` — falsification du type → 401 | V7 (chaîne client ↔ route) + E8 navigateur (video:true sur le fil) | `c3-browser.json` `knockVideo: true, knockStatus: 202` |
| sw.js v7 : rendu distinct audio (« 🔊 Appel de X ») vs vidéo (« 📹 Appel vidéo de X ») — toujours knock-only SANS contenu | relecture + tap-routing inchangé (`/?view=messages`) | sw.js `afficherKnock` |
| CallView : vidéo distante en grand + PiP local miroir (coin haut-droit), boutons caméra/flip/plein écran, indicateurs, badge qualité | E4-E7 navigateur | captures `c3-video-*.png` |
| Hub : relais `call:media` (borne CALL_ICE_MAX, champs strictement booléens — le hub ne voit JAMAIS de média) | V2/V3/V4 | `c3-test-output.txt` — **7 pass / 0 fail** |

## 3. Golden path navigateur (deux navigateurs réels, build prod)

`c3-browser.json` : **ok: true** — tous les vérins verts :

```
E1 onboarding A (« C3-Appelant ») + B (« C3-Appelé ») — identités réelles
E2 A clique le bouton VIDÉO de l'en-tête DM → « Sonnerie (vidéo)… »
E3 B reçoit « Appel vidéo entrant » (call:offer m=video relayé, hub RÉEL)
E4 B répond → DTLS-SRTP audio+VIDÉO → timer actif
   establishMs = 767 ms (budget < 5 000 ms — la caméra coûte ~100 ms de plus que l'audio C2)
   VIDÉO DISTANTE réellement décodée : videoWidth×videoHeight = 640×480 côté A
   preview local PiP vivant des DEUX côtés (videoWidth > 0)
E5 A coupe sa caméra → B voit l'indicateur « Caméra coupée » sur écran noir
   (call:media signé relayé) — capture c3-video-camera-off-b.png
E6 A remet la caméra puis la PIVOTE → replaceTrack sans renégociation,
   l'appel reste actif, le preview continue (flipKeptCallAlive: true)
E7 dégradation SIMULÉE (wrapper getStats : 20 lost/100 received = 16,7 % > 5 %)
   → setParameters {maxBitrate: 450000, scaleResolutionDownBy: 1.5} RÉELLEMENT
   appliqué par le monitor de l'app + badge « Connexion instable » + « 360p »
   (capture c3-video-degraded-a.png) — puis remise __mboteDegraded=false
E8 knock POST /api/call-knock → HTTP 202, body {video: true}
E9 B raccroche → overlays disparus des DEUX côtés, 0 élément média résiduel
   (residualMediaElements: 0 — zéro fuite pc/tracks/audio/vidéo)
F1 FALLBACK : caméra REFUSÉE (wrapper getUserMedia → NotAllowedError sur video,
   audio réel via fake device) → l'appel démarre AUDIO SEUL et s'établit
   quand même : B sonne « Appel audio avec C3-Fallback », timer actif,
   AUCUNE zone vidéo (fallbackNoVideoStage: true) — captures c3-fallback-*.png
```

## 4. Benchmark (directive : établissement < 5 s, relay < 100 ms)

```
hubRelayMs  = 5 ms     (call:offer émis → call-offer reçu, trames horodatées)
establishMs = 767 ms   (clic Répondre de B → timer actif chez A — budget 5 000 ms)
```

L'établissement vidéo (767 ms) est ~50 ms plus lent que l'audio C2 (722 ms) :
l'initialisation de l'encodeur VP8 + la seconde m-line. Très loin du budget 5 s.

## 5. Capture fil — signalisation uniquement, m=video visible

`c3-wire-capture.jsonl` (wrapper WebSocket + wrapper getStats/setParameters in-page,
aucun code app modifié) : **32 trames call:\*** — paires émission/relayage
(call:offer/call-offer, call:answer/call-answer, call:ice/call-ice,
**call:media/call-media** ×10, call:hangup/call-hangup). Taille max 6 072 o
(SDP vidéo complet < borne 16 Ko du hub). `sdpHasVideo: true` sur le call:offer.
AUCUN flux continu, AUCUN octet de média : la vidéo est DTLS-SRTP pair-à-pair.

## 6. Bugs réels attrapés pendant la preuve (tous corrigés)

1. **Hub de preuve mort sur :3030** (conflit d'environnement — 2 exécutions) :
   le dev server du repo principal embarque son relay (instrumentation) et
   occupe TOUJOURS :3030/:3031 — le hub de preuve échouait à se binder
   (`Failed to start server. Is port 3030 in use?`) PUIS bindait :3033 et
   CRASHAIT sur :3031 interne. Les navigateurs rejoignaient un hub étranger ou
   mort — E3 ne recevait JAMAIS l'offre. FIX : ports dédiés :3033/:3035 +
   garde-fous DURS (`kill -0 $HUB_PID` + curl hub APRÈS la boucle d'attente —
   elle s'épuisait en silence). **Classe C2 bug n°3 récurrente** — la
   procédure est maintenant blindée dans le runner.
2. **callType de B absent à la sonnerie** (revue avant exécution) : le
   call-offer handler ne définissait pas callType → l'overlay de B aurait sonné
   « Appel audio » pour un appel vidéo. FIX : `callType: offerHasVideo(sdp)`
   dans le set() ringing — l'annonce est lue dans le SDP de l'offre.
3. **Sink vidéo non ré-attaché au flip** (revue) : garde `srcObject === null`
   bloquait le ré-attachement après replaceTrack (nouveau flux). FIX : suivi
   `attachedId` par ref — ré-attachement à chaque changement d'id de flux.
4. **Rate limit hub compte les refus de taille** (découverte harnais V4) :
   `callRateOk()` incrémente AVANT la borne SDP — un payload refusé consomme un
   slot. Comportement fail-closed cohérent (documenté, sockets séparés dans le
   test) — PAS un bug, un constat de contrat.
5. **Deps perdues au merge C2** (régression découverte au tsc, hors C3) :
   `@node-rs/argon2`/`qrcode`/`@types/qrcode` avaient disparu du package.json
   au merge b1→adm — rétablies (union §8.1). Voir commit ed59653.

## 7. NON TESTÉ (explicite)

- **Caméras physiques réelles** : fake device en sandbox — résolution réelle,
  autofocus, rotation d'appareil non couverts (classe dépendance externe).
- **Flip caméra sur mobile multi-caméras** : replaceTrack validé (l'appel
  survit, le flux change), mais facingMode environment/user réel n'existe pas
  dans le fake device (une seule caméra virtuelle) — à re-jouer sur device
  Android réel (procédure DEVICE-TEST-PROTOCOL).
- **Plein écran natif** (`requestFullscreen`) : l'agrandissement C3 est un
  layout plein-viewport (classe Dialog), pas l'API fullscreen — suffisant pour
  l'appel ; l'API native reste disponible côté PWA sans preuve dédiée.
- **iOS Safari** : preuve Chromium uniquement ; VP8/H264 WebRTC natif présent
  sur Safari mais non rejoué (classe dépendance externe).
- **Remontée d'étage qualité** : descente seule (480p→360p→240p, hystérésis
  2 mesures) — la remontée sur réseau qui rétablit est hors périmètre C3.
- **Réseau 3G réel / packet loss physique** : la dégradation est SIMULÉE via
  wrapper getStats (setParameters/indicateurs réels) ; la mesure RDC 48 h
  (NETWORK-MEASUREMENT-48H) reste la référence avant ouverture publique.
- **coturn réel / FCM device réel** : repris de C2 §non-testé (inchangés).
- **Appels de groupe** : C4 (MLS) — cette vague est 1:1 uniquement.
