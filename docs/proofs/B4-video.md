# B4 — Vidéo webm/mp4 : upload + lecture (preuves)

**Statut** : LIVRÉ et PROUVÉ — recorder réel, pipeline B2 chiffré, thumbnail,
player natif, TTL 1 h. Branche `feat/b1-media-foundation`, worktree externe
`/home/z/wt-b1` (règle DEV-SETUP §2).

**Directive** : B4 (~3–4 jp) — Permissions-Policy `camera=(self)` vérifiée
**AVANT** d'écrire le code ; whitelist `video/mp4` + `video/webm` (100 Mo,
rejet avi/mov/mkv clair) ; recorder 60 s max, 480p défaut / 720p si supporté,
bitrate adaptatif, preview avant envoi ; pas de compression V1 ; thumbnail
canvas 320 px envoyée comme petite image ; lecture progressive (voir arbitrage
§9.2-4 — tranchée : téléchargement intégral puis player natif, un
`<video src=presignedUrl>` lirait du CIPHERTEXT) ; pipeline B2 réutilisé ;
bouton 📹 tap-to-start/stop ; rejets 61 s / 110 Mo / video/avi.

**Arbitrages** : MEDIA-ENVELOPE-SPEC.md §9.2 (10 points tranchés) — dont
§9.2-4 « lecture progressive » (E2EE ⇒ full-blob), §9.2-5 conteneur RÉEL
déclaré, §9.2-6 tap-to-stop, §9.2-7 barrière de rendu vidéo (webm AUDIO
refusé), §9.2-8 TTL 1 h par type.

---

## 1. Prérequis bloquant PROUVÉ AVANT le code (directive)

`bash scripts/b4-camera-prereq.ts` → `docs/proofs/assets/b4-camera-prereq.txt` :

| Preuve | Valeur mesurée |
|---|---|
| next.config.ts porte `camera=(self)` | garde de code — le fix précède tout recorder |
| getUserMedia({video, audio}) | **RÉUSSI** — flux 640×480 (fake device Chromium réel) |
| MediaRecorder webm/VP8+opus 10 s | **515 278 o (503 Ko)** — octets RÉELS |
| thumbnail canvas 320 px | 4 179 o JPEG (fake device = image unie ; contenu réel → ~20 Ko) |
| ffprobe du webm enregistré | codec **vp8**, durée **9,96 s** |
| Header SERVI (runner 3b, curl réel) | `camera=(self)`, `microphone=(self)`, `geolocation=()` |

Sans le fix, getUserMedia renverrait NotAllowedError niveau NAVIGATEUR (bug
B3 `microphone=()`). La leçon est enregistrée : le tableau exhaustif §8.4
(20 directives) ferme tous les défauts permissifs d'un coup.

## 2. Livrables → tests → preuves (chaque livrable a son témoignage)

| Livrable | Test (automatisé) | Preuve (fichier rejouable) |
|---|---|---|
| Recorder vidéo 60 s max / 480p-720p / bitrate 1 Mbps | harnais U2 (61 s → REFUS), U4 (harness sans caméra → false propre) | `b4-video-recording.png` (chrono réel pendant 5 s), `b4-camera-prereq.txt` (10 s → 503 Ko, vp8, 9,96 s) |
| Thumbnail canvas 320 px (~20 Ko) | harnais U3 (hors navigateur → erreur propre) | `b4-camera-browser.txt` (4 179 o générés), `b4-video-sent-bubble.png` (vignette déchiffrée dans la bulle) |
| Whitelist video/mp4 + video/webm, 100 Mo PAR TYPE | harnais V2 (video/avi → 400 « convertissez d'abord »), V3 (110 Mo → 400 « 104857600 »), U2 (garde client 110 Mo) | `b4-video-test-output.txt` (0 fail) |
| Pipeline B2 chiffré (CEK client, presign, PUT, finalize) | harnais V1 (webm réel 503 Ko : upload → download → **SHA-256 identique**), U5 (garde 61 s AVANT tout fetch — compteur 0) | `b4-video-test-output.txt` |
| **TTL lecture 1 h pour video/** (15 min inchangées image/audio) | harnais V4 (vidéo > 3500 s ≤ 3600 s · image ≤ 900 s) | `b4-video-test-output.txt` |
| Round-trip DEUX appareils (dm2 E2EE : vidéo + vignette + durée) | harnais V5 (A envoie → B ouvre le dm2 → SHA-256 identiques vidéo ET vignette) | `b4-video-test-output.txt` |
| Barrière de rendu vidéo (magic bytes) | harnais V6 (dm2 déclarant video/webm portant des octets AUDIO → **REFUS magic-bytes-mismatch**), U1 (webm audio B3 → null · MP4 ftyp → video/mp4 · divergence déclaré/sniffé → refus) | `b4-video-test-output.txt` |
| Permissions-Policy servi | harnais H1 (camera=(self) + microphone=(self) + geolocation=()) | `b4-video-headers.txt` (curl réel sur l'app standalone) |
| UI MessagesView : 📹 tap-to-start/stop + preview + bulle | navigateur (script `b4-browser-proof.ts`) | `b4-video-recording.png` → `b4-video-preview.png` → `b4-video-sent-bubble.png` → `b4-video-dialog-loading.png` → `b4-video-playing.png` |
| Benchmark 10 s / 30 s / 60 s | script `b4-video-bench.ts` | `b4-video-bench.txt` (tableau ci-dessous) |

## 3. Benchmark (chaîne complète : chiffrement → presign → PUT → finalize → download → decrypt)

```
durée         tailleKo  chiffre  presign  put  finalize  download  decrypt  TOTAL (ms)
10 s (réel)       502        18         9    25         19         19        35     126
30 s (3×10 s)     1507        67         7    63         38         48        81     304
60 s (6×10 s)     3015       143        10   108         65         71       194     590
```

Honnêteté des mesures : le 10 s est un webm RÉEL (MediaRecorder) ; les 30/60 s
mesurent la CHAÎNE crypto/réseau à la taille cible (blocs de 10 s — pas de
transcodage, la lecture player est prouvée sur le réel). Cohérent avec la
directive : 60 s @ 480p ≈ 5–15 Mo en conditions réelles de caméra ; le fake
device compresse mieux (3 Mo), la limite 100 Mo absorbe les deux.

## 4. Suites de tests exécutées (commandes exactes)

```bash
# prereq caméra (BLOQUANT) — Chromium réel, fake device
bun scripts/b4-camera-prereq.ts
# → PRÉREQUIS CAMÉRA PROUVÉ (getUserMedia + MediaRecorder + thumbnail + ffprobe)

# harnais B4 (13 tests : 5 unitaires TOUJOURS + 8 E2E avec le runner)
MEDIA_B4_E2E=1 BASE_URL=http://127.0.0.1:3103 … bun test tests/media-b4-video.test.ts
# → 12 pass, 1 skip (comptage bun), 0 fail — sortie intégrale : assets/b4-video-test-output.txt

# NON-RÉGRESSION B1→B3 :
bun test tests/media-foundation.test.ts   # → 35 pass, 0 fail
bun test tests/media-b2-flow.test.ts      # → 15 skip sans runner (E2E) — harness dédié B2
bun test tests/media-b3-voice.test.ts     # → 10 pass, 0 fail (unitaires voix)
```

## 5. Preuves navigateur (app standalone :3103, weed réel :9100)

Runner : `bash scripts/b4-video-proof-run.sh` → exit 0 (`TOUTES LES PREUVES
B4 SONT PASSÉES`). Le runner REBUILD systématiquement (leçon ADM É8 — un
build périmé prouverait une autre vague). Captures (1440×900, fake
video+audio device) :

| Fichier | Ce qu'il montre |
|---|---|
| `b4-camera-prereq.txt` | getUserMedia RÉUSSI + recorder 10 s + thumbnail + ffprobe VP8 |
| `b4-video-headers.txt` | header `Permissions-Policy: camera=(self), microphone=(self), …` SERVI |
| `b4-video-recording.png` | chrono ● 5.x s pendant l'enregistrement réel (fake device) |
| `b4-video-preview.png` | preview : player + durée + taille + résolution + boutons Annuler/Chiffrer et envoyer |
| `b4-video-sent-bubble.png` | toast « Vidéo envoyée — WebM 5.2 s · 324 Ko · chiffrée (AES-256-GCM) » + bulle vignette déchiffrée + badge 5 s |
| `b4-video-dialog-loading.png` | Dialog plein écran : « Vidéo chiffrée · 324 Ko · video/webm · 5 s » + état de téléchargement |
| `b4-video-playing.png` | player natif `<video controls>` affichant les FRAMES réelles de la vidéo enregistrée |
| `b4-video-db.txt` | 7 Media video/* finalized + 4 jpeg (thumbs) en DB |

## 6. Bugs réels attrapés par les preuves pendant l'écriture

1. **`Buffer` côté navigateur (bug de construction)** : la première passe du
   flux navigateur échouait avec « Vidéo indéchiffrable » chez l'EXPÉDITEUR
   (`b4-video-debug-fail.png` — capture conservée). Cause :
   `signPayloadSafe` local dans VideoBubble utilisait
   `Buffer.from(...).toString("base64url")` — Buffer n'existe PAS dans le
   navigateur → ReferenceError → catch générique. Correction : réutiliser
   `signPayload` de `crypto.ts` (b64url pur web) comme tous les composants.
   La preuve navigateur a vu ce que le harnais bun (Buffer défini) ne voyait
   JAMAIS — troisième occurrence de la classe (B3 : Permissions-Policy + CSP).
2. **MP4 synthétique malformé** (harnais U1) : la boîte ftyp écrite à
   l'offset 8 au lieu de 4 → sniff null. Puis `hasMp4Ftyp` exigeait
   `length > 12` (boîte minimale = 12) — corrigé en `>= 12`.
3. **Barrière déclaré/sniffé renforcée** : `assertPlayableVideo` acceptait
   tout `video/*` déclaré — un webm déclaré mp4 passait. Corrigé : égalité
   stricte déclaré/sniffé (le client B4 pose le conteneur réel) — testé U1.
4. **URLs relatives dans le harnais** (V4/V5/V6) : les presign servies sont
   des chemins `/media-proxy/…` — `fetch()` bun exige une URL absolue
   (le client réel passe par `toFetchUrl`). Corrigé par résolution
   `new URL(path, BASE_URL)`.

## 7. NON TESTÉ (explicite — spec §9.4)

Transcodage (AUCUN en V1) · HLS (V1 = direct) · vidéo > 60 s (refusée par
construction) · mesh BLE (vidéo impossible par conception — budget octets) ·
migration RN (dette tracée SCALE-ARCHITECTURE §8, 8–12 jp) · **Safari iOS**
(le fallback `video/mp4` H.264 y est prévu mais aucun Safari dans le sandbox
— test manuel requis avant ouverture, même jalon que la voix §8.5) · charge
réelle (bench = 10 s réel + blocs de taille, honnêteté §3).
