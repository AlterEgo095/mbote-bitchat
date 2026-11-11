# B3 — Voice notes web Opus 6–12 kbps (preuves)

**Statut** : LIVRÉ et PROUVÉ — prérequis Opus bloquant levé (ffmpeg + navigateur),
chaîne E2EE complète sur S3 réel indépendant, flux navigateur complet
(hold-to-record → preview → envoi → bulle waveform → play → tap-toggle).
Branche `feat/b1-media-foundation`, worktree externe `/home/z/wt-b1`.

**Directive** : B3 (~3–4 jp, web uniquement — dette RN tracée §8 SCALE-ARCHITECTURE)
— prérequis BLOQUANT « prouver Opus avant l'UI », recorder 6/8/12 kbps 60 s max,
waveform 100 peaks, lecture 1x/1.5x/2x, enveloppe média B2 avec
`contentType: 'audio/opus'` (10 Mo), hold-to-record tranché, tests + preuves.

---

## 1. PRÉREQUIS BLOQUANT — Opus prouvé (avant toute UI, directive)

`scripts/b3-opus-prereq.ts` (rejouable, exit non-zero si une preuve manque) :

| Voie | Preuve (`assets/b3-opus-prereq.txt` + `b3-opus-browser.txt`) |
|---|---|
| **ffmpeg serveur** 7.1.5 + libopus | WAV 30 s (440 Hz, mono 48 kHz) → **6 kbps : 22 093 o** · **8 kbps : 25 678 o** · **12 kbps : 47 453 o** · webm 32 914 o — durées décodées **30.01 s** partout (bornes de taille vérifiées par le script) |
| **Navigateur** Chromium 1200 (playwright-core + `--use-fake-device-for-media-stream`) | `MediaRecorder.isTypeSupported("audio/webm;codecs=opus") === true` · enregistrement RÉEL 5 s @ 8 kbps → **3 600–3 685 o** · `decodeAudioData` → **4.98 s @ 44 100 Hz** · **100 peaks** calculés depuis les samples |

**Décision dépendance (directive : « si un wrapper WASM est nécessaire,
documente-le »)** : AUCUN wrapper WASM n'est nécessaire en V1 — MediaRecorder
NATIF produit de l'opus sur les navigateurs cibles (Chrome/Edge webm ; Firefox
ogg ; prouvé headless). Safari (MediaRecorder sans opus) → bouton micro
DÉSACTIVÉ + message explicite ; fallback WASM (p. ex. `@wasm-audio-encoders/opus`,
MIT) reporté B4+ — NON TESTÉ. Tranché dans la spec §8.2-1.

## 2. Livrables → tests → preuves

| Livrable | Test | Preuve |
|---|---|---|
| `src/lib/mbote/media/opus.ts` (constantes 6/8/12, sniff conteneurs, validateVoiceForSend 61 s → refus, VoiceRecorder auto-stop 60 s, computePeaksFromSamples partagé) | harnais `tests/media-b3-voice.test.ts` S1–S5 + V5 (**unitaires toujours verts : 10/10 en suite globale**) | fixtures `tests/fixtures/voice-30s-{6k,8k,12k}.ogg`, `voice-30s-8k.webm`, `voice-reject.mp3` (produites par le prereq) |
| Pipeline B3 (upload/download voix, SANS strip — Opus n'a pas d'EXIF, arbitrage §8.2-3) | V1 E2E : uploadVoiceNote → presign `audio/opus` → PUT présigné → finalize → downloadVoiceNote → **SHA-256 IDENTIQUE** | `assets/b3-voice-test-output.txt` (harnais **0 fail** contre weed RÉEL) |
| Whitelist serveur `audio/opus` + limites PAR TYPE (audio 10 Mo, image reste 5 Mo) | V2 : `audio/mpeg` → **400** · V3 : 11 Mo → **400** ET 6 Mo image → 400 ET 10 Mo pile → 201 | idem |
| Round-trip DEUX appareils (A enregistre → dm2 E2EE **durée+peaks chiffrés** → B reçoit → SHA-256 identique, waveform conservée) | V4 (scellement ECDH P-256 + AES-GCM réel, `/api/dms` réel) | idem + `assets/b3-voice-db.txt` (`Media audio/opus finalized`) |
| Garde 61 s AVANT tout octet | V5 : uploadVoiceNote(61 s) rejette avec **0 fetch** émis (interception compteur) | unitaire |
| Benchmark 6/8/12 kbps (directive) | chaîne complète mesurée | `assets/b3-voice-bench.txt` : **51 / 39 / 59 ms TOTAL** (22/25/46 Ko) |
| UI `VoiceNote.tsx` + MessagesView (hold-to-record, preview, bulle, play, seek, 1x/1.5x/2x) | `scripts/b3-browser-proof.ts` (Chromium réel + fake device sur l'app STANDALONE) | captures : `b3-voice-recording.png` (chrono), `b3-voice-preview.png` (Opus 4.1 s, waveform, Annuler/Envoyer), `b3-voice-sent-bubble.png` + `b3-voice-playing.png` (bulle, lecture), `b3-voice-browser.txt` (toutes étapes) |

## 3. Preuves navigateur (app standalone réelle + S3 réel)

Runner `bash scripts/b3-voice-notes-proof-run.sh` → **exit 0** : prereq → weed
3.80 authentifié (anonyme → 403, tiers indépendant — même arbitrage B2) → app
:3103 → harnais (0 fail) → benchmark → navigateur (Chromium piloté par
playwright-core, micro = fake device TON) :

1. identité A créée dans l'UI → pair B publié par script → conversation « E2E actif » ;
2. **HOLD-TO-RECORD** : pointerdown 4 s sur le micro → chrono `● 3.9 s` visible → release ;
3. **preview** : dialog « Envoyer une note vocale — Opus 4.1 s » avec waveform + lecture + Annuler/Envoyer ;
4. « Chiffrer et envoyer » → toast **« Note vocale envoyée »** (uploadVoiceNote réel → weed) ;
5. **bulle voix** rendue (waveform 100 peaks, 0:04, 3 Ko) — download → decrypt → sniff ;
6. **play/pause** (lecture démarrée, progression) ;
7. **tap-toggle** : tap court → enregistre, 2e tap → stop → preview (fallback a11y).

## 4. Trois bugs réels attrapés PAR LES PREUVES NAVIGATEUR (valeur de la discipline)

1. **Permissions-Policy `microphone=()`** (héritage durcissement template) :
   le navigateur REFUSAIT tout getUserMedia, même consenti — les notes vocales
   étaient impossibles PAR CONSTRUCTION. Corrigé : `microphone=(self)`
   (next.config.ts ; camera/geolocation/payment restent refusés).
2. **CSP sans `media-src`** : `default-src 'self'` bloquait le blob audio local
   → lecture muette. Corrigé : `media-src 'self' blob:` (blob lié à son origine).
3. **Course tap-toggle** : le click du MÊME tap stoppait l'enregistrement à
   peine démarré (état async). Corrigé : anti-rebond 250 ms (le click du même
   tap est avalé ; le tap suivant arrête). VoiceRecorder.stop() est aussi
   devenu tolérant aux captures dégénérées (< 200 ms, sans en-tête webm) — le
   refus honnête reste à l'ENVOI (validateVoiceForSend).

Chacun est invisible des tests unitaires — exactement la classe de bugs que la
directive « preuves navigateur » cherche.

## 5. Tests exécutés (commandes exactes)

```bash
# prérequis bloquant (exit non-zero = B3 ne démarre pas)
bun scripts/b3-opus-prereq.ts                                    # → PRÉREQUIS OPUS PROUVÉ

# harnais B3 complet (unitaires + E2E weed réel)
MEDIA_B3_E2E=1 BASE_URL=http://127.0.0.1:3103 DATABASE_URL=file:db/b3-voice-proof.db \
MEDIA_S3_ENDPOINT=http://127.0.0.1:9100 MEDIA_S3_REGION=us-east-1 MEDIA_S3_BUCKET=mbote-media-test \
MEDIA_S3_ACCESS_KEY_ID=b3-voice-proof MEDIA_S3_SECRET_ACCESS_KEY=… \
  bun test tests/media-b3-voice.test.ts                          # → 10 pass, 0 fail

# NON-RÉGRESSION B1/B2 : suite complète wt-b1
bun test                                                          # → 95 tests, 0 fail (25 skip = gated)

# preuves navigateur + benchmark + DB
bash scripts/b3-voice-notes-proof-run.sh                          # → exit 0
```

## 6. NON TESTÉ (explicite, discipline)

- **mesh BLE réel** (appareil physique) — le transport voix passe la voie
  internet ; le budget 20–40 Ko/message à 8 kbps est dimensionné pour le mesh
  mais non mesuré sur radio.
- **Migration RN** (expo-av + fallback WASM) — dette tracée SCALE-ARCHITECTURE §8.
- **Charge réelle** (100 uploads simultanés) — même statut que B2.
- **iOS Safari** — MediaRecorder sans opus → bouton désactivé (par conception,
  arbitrage §8.2-1) ; à tester manuellement sur device avant ouverture publique.
- **strip EXIF voix** : N/A par construction (aucune métadonnée EXIF dans un
  conteneur opus — documenté §8.2-3, pas un trou : le serveur reste aveugle).

## 7. Rejouabilité

```bash
bash scripts/b3-voice-notes-proof-run.sh
# prereq (ffmpeg+chromium) → weed épinglé → app standalone → harnais →
# benchmark → navigateur (7 étapes, 4 captures) → preuve DB. Exit 0 attendu.
```
