# C2 — Appels audio 1:1 (WebRTC E2EE) — preuve

Date : 2026-11-11 · Branche : `feat/b1-media-foundation` · Worktree : `wt-b1`
Runner : `bash scripts/c2-audio-calls-proof-run.sh` — **exit 0** (rejouable, DEV-SETUP §2b)

## 1. Prérequis bloquants — TOUS PASSÉS (avant d'écrire le code, directive)

| Prérequis | Résultat | Preuve |
|---|---|---|
| P1. TURN réel joignable | **turn_relay: true** — `iceTransportPolicy:'relay'` FORCÉ → connectionState=connected, candidate `relay`, 3 539 octets audio reçus (plus fort que turnutils_uclient : vrai chemin de prod DTLS-SRTP) | `c2-prereq-probe.json` |
| P2. DTLS-SRTP dans le Chromium Playwright | **dtls_srtp: true** — host-to-host connecté, 3 923 octets | idem |
| P3. micro fake | **fake_mic: true** — track « Fake Default Audio Input » live | idem |
| Signaling decision | **hub socket.io existant réutilisé** (rooms `dm:<pubkey>` déjà proof-gated F-08) — une seule implémentation `hub.ts` (embedded + standalone, zéro dérive F-22) | hub.ts §C2 |
| TURN prod coturn | `deploy/docker-compose.turn.yml` livré (443 TCP/TLS prioritaire CGNAT RDC, schéma REST auth-secret) — **NON TESTÉ en sandbox** (pas de docker/root) : re-jouer turnutils_uclient + sonde navigateur au déploiement VPS | compose + §8 |

Serveur TURN du harnais : **node-turn** (process bun local :3478) — coturn non
installable en sandbox (pas de root, `apt` refusé). Le chemin relay est validé
avec un VRAI client WebRTC, ce qui couvre le protocole TURN/allocations.

## 2. Livrables → tests → preuves

| Livrable | Test | Preuve |
|---|---|---|
| Signalisation hub (`call:offer/answer/ice/hangup/reject`) : relay vers `dm:<to>`, preuve ECDSA `${from}\|${kind}\|${to}\|${callId}\|${ts}` vérifiée AVANT relay, identité prouvée exigée (socket.data.pubkey), bornes de taille SDP/ICE, rate limit 60/min/socket | S1 + S2a-e (8 tests bun, hub RÉEL in-process, clés ECDSA réelles) | `c2-test-output.txt` — **8 pass / 0 fail** |
| `/api/turn-credentials` : schéma REST coturn (HMAC-SHA1, TTL 600 s) + mode static harnais + fail-closed sans config + preuve de possession + rate limit | S3a (unitaire pur) + navigateur (mode relay actif dans l'overlay) | `c2-browser.json` |
| `/api/call-knock` : knock SANS CONTENU (`{type:'incoming_call', fromLabel}` — reprise C1), preuve ECDSA, rate limit 6/min appelant + 20/min cible, fire-and-forget, 202 uniforme (pas d'énumération) | E7 : POST réel → **HTTP 202** | `c2-browser.json` `knockStatus` |
| `src/lib/mbote/webrtc.ts` : CallManager (dialing→ringing→connecting→active→idle), fallback TURN (2 échecs/30 s → notice notes vocales), mute (track.enabled=false → silence), cleanup complet | S5 (sémantique fallback) + E2E navigateur + purge panic-wipe branchée | `c2-browser.json`, webrtc.ts |
| `CallView.tsx` : overlay global (survit aux vues), sonnerie WebAudio (aucun asset), timer, mute, raccrocher, état TURN transparent, bouton téléphone en-tête DM | E2-E5 | captures `c2-call-*.png` |
| sw.js : rendu distinct du knock d'appel (« Appel de X — touchez pour répondre »), toujours sans contenu | relecture + harnais C1 (knock-only) inchangé | sw.js:127 |

## 3. Golden path navigateur (deux navigateurs réels, build prod)

`c2-browser.json` : **ok: true**

```
E1 onboarding A (« C2-Appelant ») + B (« C2-Appelé ») — identités réelles
E2 A clique le téléphone dans l'en-tête DM → overlay « Sonnerie… » (c2-call-dialing-a.png)
E3 B reçoit « Appel audio avec C2-Appelant » (call:offer relayé par le hub RÉEL)
   → capture (c2-call-ringing-b.png)
E4 B répond → DTLS-SRTP connecté des deux côtés → timer actif
   establishMs = 663-722 ms  (budget < 3 000 ms)
E5 B raccroche → overlays disparus des DEUX côtés, 0 élément audio résiduel
   (hangupClean + residualAudioElements: 0 — zéro fuite pc/tracks/audio/ringtone)
E7 knock POST /api/call-knock → 202 (fire-and-forget confirmé sur le fil)
```

## 4. Benchmark (directive : signalisation < 100 ms, établissement < 3 s)

```
hubRelayMs  = 5 ms    (call:offer émis par A → call-offer reçu par B, trames horodatées)
establishMs = 722 ms  (clic Répondre de B → timer actif chez A)
```

## 5. Capture fil — preuve « aucun média sur la signalisation »

`c2-wire-capture.jsonl` (via wrapper WebSocket in-page — transport-agnostique) :
**14 trames call:\*** — `call:offer` (1 771 o) / `call-ice` (552-579 o) /
`call:answer` (1 672 o) / `call:hangup` — émission (deux-points) et relayage
(tiret) pairées à ~5 ms. AUCUN flux continu, AUCUN octet de média : l'audio est
DTLS-SRTP pair-à-pair, invisible du hub (le hub ne transporte JAMAIS de média —
par construction du code ET par la capture).

## 6. Bugs réels attrapés pendant la preuve (tous corrigés)

1. **CSP bloque le websocket du hub** (next.config.ts F-35) : une entrée
   `connect-src http://…` ne couvre PAS `ws://…` (ni https→wss) sur Chromium
   moderne — l'ouverture du socket échouait SILENCIEUSEMENT (« violates
   connect-src » en console). FIX : les deux schémas listés. **Impact prod** :
   le même bug aurait tué le hub `wss://socket.domain` au déploiement.
2. **Inversion de convention des noms d'événements** : le hub écoute
   `call:offer` (deux-points) et ré-émet `call-offer` (tiret) ; le client faisait
   l'inverse des deux côtés. FIX : mapping documenté dans `signal()` + listeners
   à tirets (S1 du harnais n'a PAS attrapé celui-ci : le harnais émettait les
   noms attendus par le hub — leçon : le harnais doit copier le CLIENT, pas le
   contrat idéal).
3. **Hub périmé sur :3030** (constat d'environnement) : un `bun --hot index.ts`
   démarré à 14:19 gardait le port — tous les hubs suivants mouraient en
   EADDRINUSE (silencieusement, logs dans /tmp) et le trafic de preuve tapait
   le hub SANS handlers call:. FIX process : kill 973 ; le runner nettoie ses
   PIDs (trap EXIT) et vérifie la santé du hub avant les tests.
4. **Prédicat de harnais** : waitForFunction signature (fn, ARG, OPTIONS) —
   options en 3e position sinon défaut 30 s ; et regex `\b00:0\d\b` cassée par
   un label finissant sur un chiffre (« Dbg-B7 » + « 00:01 » = « 700:01 », pas
   de boundary). FIX : `data-testid="call-timer"` (ne rend qu'à l'état actif).

## 7. NON TESTÉ (explicite)

- **coturn réel** (docker-compose.turn.yml) : sandbox sans docker/root —
  re-jouer turnutils_uclient TCP 443 + UDP 3478 + sonde navigateur sur le VPS
  (procédure 10 min dans le compose). La mesure RDC 48 h (CGNAT réel) reste à
  faire avant ouverture publique.
- **FCM/push sur device réel** : repris de C1 §non-testé (procédure Étape 10+C1).
- **100 appels concurrents** : palier 1 — le hub relaye des petits JSON ; la
  charge non rejouée sur les événements call:*.
- **Qualité audio subjective / écho réel** : fake device (tonalité) — pas
  d'évaluation subjective possible en sandbox.
- **Appels de groupe** : C4 (MLS).
- **Firefox/Safari** : preuve navigateur Chromium uniquement (classe dépendance
  externe) ; le fallback WASM Opus ne concerne PAS les appels (Opus natif
  WebRTC partout, y compris Safari).
- **Renégociation mid-call** (ajout vidéo C3) : la signalling supporte déjà les
  offers supplémentaires mais le flow UI C3 n'existe pas encore.
