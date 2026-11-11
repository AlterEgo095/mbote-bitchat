/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  opus — voice notes B3 : enregistrement Opus 6–12 kbps (spec MEDIA-ENVELOPE-
 *  SPEC §8) + sniff conteneurs + waveform 100 peaks.
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRÉREQUIS PROUVÉ (scripts/b3-opus-prereq.ts + tests/b3-opus-prereq.test.ts,
 *  bloquant avant B3 UI) :
 *   - NAVIGATEUR (Chromium 1200 headless, playwright-core + fake audio device) :
 *     MediaRecorder.isTypeSupported("audio/webm;codecs=opus") === TRUE ·
 *     enregistrement réel 5 s @ 8 kbps → 3 685 o · decodeAudioData décode le
 *     webm/opus → durée 4,98 s @ 44 100 Hz · 100 peaks calculés ;
 *   - SERVEUR (ffmpeg 7.1.5 + libopus) : encodage 6/8/12 kbps d'un WAV 30 s →
 *     tailles 22/31/46 Ko · décodage → durée ≈ 30 s · intégrité round-trip.
 *
 *  DÉCISIONS TRANCHÉES (arbitrages spec §8) :
 *   1. V1 = MediaRecorder NATIF (Chrome/Edge/Firefox produisent opus en webm ;
 *      Firefox en ogg) — AUCUN wrapper WASM requis (la directive demandait de
 *      le documenter SI nécessaire : il ne l'est pas pour les navigateurs cibles
 *      RDC = Chrome Android). Safari (MediaRecorder sans opus) → bouton micro
 *      désactivé + message explicite. Fallback WASM (p. ex.
 *      @wasm-audio-encoders/opus, licence MIT) reporté B4+ — NON TESTÉ.
 *   2. Bitrates : 6 kbps (mesh) / 8 kbps (défaut) / 12 kbps (confort) —
 *      budget mesh 20–40 Ko par message de 30 s.
 *   3. Durée max 60 s (auto-stop + refus d'envoi au-delà) — budget 20–40 Ko.
 *   4. Conteneur : webm/opus PREFERRED, ogg/opus accepté (Firefox) — le type
 *      déclaré partout est « audio/opus » (canonique), le SNIFF du plaintext
 *      accepte les DEUX conteneurs (EBML+webm | OggS+OpusHead).
 *   5. Waveform : 100 peaks calculés à l'arrêt (decodeAudioData du blob
 *      enregistré) et voyagent dans le dm2 E2EE (le destinataire les affiche
 *      SANS re-décoder ; re-décodage fallback si absents).
 *   6. Pas de strip EXIF : Opus n'a PAS de métadonnées EXIF (conteneur audio,
 *      rien à nettoyer — documenté §8.3). La confidentialité reste intégrale :
 *      l'objet stocké est le chiffré enveloppe v1 (pipeline B2 identique).
 *   7. RN mobile : capture expo-av + fallback WASM = dette §8 SCALE-ARCHITECTURE
 *      (NON TESTÉ, hors vagues web).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── constantes (spec §8.1) ───────────────────────────────────────────────────

export const VOICE_BITRATES = {
  mesh: 6000,
  default: 8000,
  comfort: 12000,
} as const;

export type VoiceBitrateKey = keyof typeof VOICE_BITRATES;

/** Durée max d'une note vocale (60 s — budget mesh 20–40 Ko par message). */
export const VOICE_MAX_DURATION_S = 60;
/** Limite d'upload audio — 10 Mo (spec §2 ; l'UI borne à 60 s bien avant). */
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
/** Nombre de peaks de la waveform. */
export const VOICE_PEAKS = 100;

/** Types MIME opus acceptés par MediaRecorder, par préférence. */
const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
] as const;

/** Le navigateur courant peut-il enregistrer de l'opus nativement ? */
export function isOpusRecordingSupported(): boolean {
  if (typeof MediaRecorder === "undefined") return false;
  return RECORDER_MIME_CANDIDATES.some((m) => MediaRecorder.isTypeSupported(m));
}

/** Message UI quand l'enregistrement est impossible (Safari, RN, http non sûr). */
export const VOICE_UNSUPPORTED_MESSAGE =
  "Notes vocales indisponibles sur ce navigateur (Opus requis — Chrome, Edge ou Firefox).";

function pickRecorderMime(): string {
  for (const m of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  throw new Error("aucun conteneur opus supporté par MediaRecorder");
}

// ── sniff conteneurs (barrière au rendu — miroir de sniffImageType §6.7-iii) ─

export type SniffedOpusContainer = "audio/webm" | "audio/ogg";

/**
 * Sniff pur JS des conteneurs opus :
 *  - webm/opus : magic EBML (1A 45 DF A3) + DocType « webm » dans les 64
 *    premiers octets ;
 *  - ogg/opus : « OggS » + « OpusHead » dans les 64 premiers octets (l'en-tête
 *    d'identification opus est le PREMIER paquet ogg).
 * Un MP3 (FF FB / ID3) ou un WAV (RIFF) ne passe JAMAIS.
 */
export function sniffOpusContainer(bytes: Uint8Array): SniffedOpusContainer | null {
  if (bytes.length < 16) return null;
  const ebml =
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (ebml) {
    const head = new TextDecoder().decode(bytes.slice(4, 64));
    return head.includes("webm") ? "audio/webm" : null;
  }
  const isOgg = bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
  if (isOgg) {
    const head = new TextDecoder().decode(bytes.slice(0, 64));
    return head.includes("OpusHead") ? "audio/ogg" : null;
  }
  return null;
}

/**
 * Barrière de rendu (§6.7-iii appliquée à la voix) : le plaintext déchiffré
 * DOIT être un conteneur opus cohérent avec le type déclaré (toujours
 * « audio/opus » — canonique). Toute divergence → REFUS (jamais rendu).
 */
export function assertPlayableVoice(bytes: Uint8Array, declaredType?: string): SniffedOpusContainer {
  if (declaredType && declaredType !== "audio/opus") {
    throw new Error(`type déclaré ${declaredType} ≠ audio/opus — MIME spoofing suspecté`);
  }
  const sniffed = sniffOpusContainer(bytes);
  if (!sniffed) {
    throw new Error("pas un conteneur opus (sniff null) — rendu refusé");
  }
  return sniffed;
}

// ── waveform (100 peaks — partagée navigateur / harness) ─────────────────────

/**
 * Peaks normalisés [0..1] depuis les échantillons Float32 d'un canal.
 * ALGORITHME PARTAGÉ : la version navigateur l'applique sur l'AudioBuffer de
 * decodeAudioData ; les tests l'appliquent sur du PCM synthétique — mêmes
 * résultats (arbitrage : la waveform n'est PAS calculée par un code différent
 * selon la plateforme).
 */
export function computePeaksFromSamples(samples: Float32Array, n = VOICE_PEAKS): number[] {
  const peaks: number[] = [];
  if (samples.length === 0) {
    for (let i = 0; i < n; i++) peaks.push(0);
    return peaks;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * samples.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * samples.length) / n));
    let m = 0;
    for (let j = a; j < b; j++) {
      const v = Math.abs(samples[j]);
      if (v > m) m = v;
    }
    peaks.push(Math.round(m * 100) / 100);
  }
  return peaks;
}

/**
 * Décode des octets audio (webm/opus ou ogg/opus) → durée + peaks.
 * Navigateur uniquement (AudioContext) — les tests serveur utilisent ffmpeg
 * (b3-opus-prereq) pour la mesure de durée.
 */
export async function decodeAndMeasure(
  bytes: Uint8Array
): Promise<{ durationMs: number; sampleRate: number; peaks: number[] }> {
  const Ctx: typeof AudioContext | undefined =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext indisponible (hors navigateur)");
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice(0).buffer as ArrayBuffer);
    const ch = buffer.getChannelData(0);
    return {
      durationMs: Math.round(buffer.duration * 1000),
      sampleRate: buffer.sampleRate,
      peaks: computePeaksFromSamples(ch),
    };
  } finally {
    void ctx.close();
  }
}

// ── validation d'envoi (pure — testable sans navigateur) ─────────────────────

export interface VoiceCandidate {
  bytes: Uint8Array;
  durationMs: number;
}

export type VoiceValidation =
  | { ok: true; container: SniffedOpusContainer }
  | { ok: false; reason: string };

/**
 * Garde d'envoi côté client (miroir des refus serveur) :
 * durée ≤ 60 s (61 s → REFUS, directive), taille ≤ 10 Mo, conteneur opus.
 */
export function validateVoiceForSend(c: VoiceCandidate): VoiceValidation {
  if (!Number.isFinite(c.durationMs) || c.durationMs <= 0) {
    return { ok: false, reason: "durée invalide (enregistrement vide ?)" };
  }
  if (c.durationMs > VOICE_MAX_DURATION_S * 1000 + 250 /* tolérance horloge */) {
    return { ok: false, reason: `durée ${(c.durationMs / 1000).toFixed(1)} s > max ${VOICE_MAX_DURATION_S} s` };
  }
  if (c.bytes.length <= 0 || c.bytes.length > VOICE_MAX_BYTES) {
    return { ok: false, reason: `taille ${c.bytes.length} o hors bornes (1…${VOICE_MAX_BYTES})` };
  }
  const container = sniffOpusContainer(c.bytes);
  if (!container) {
    return { ok: false, reason: "enregistrement non reconnu comme opus (conteneur inattendu)" };
  }
  return { ok: true, container };
}

// ── enregistreur (MediaRecorder natif — webm/opus ou ogg/opus) ───────────────

export interface VoiceRecording {
  /** octets du conteneur opus enregistré */
  bytes: Uint8Array;
  /** type MIME du conteneur (« audio/webm » ou « audio/ogg ») */
  container: SniffedOpusContainer;
  durationMs: number;
  sampleRate: number;
  peaks: number[];
}

export interface VoiceRecorderOptions {
  /** 6 (mesh) | 8 (défaut) | 12 (confort) kbps */
  bitrateKey?: VoiceBitrateKey;
  /** callback par seconde (affichage chrono) */
  onTick?: (elapsedMs: number) => void;
  /** auto-stop atteint (60 s) — le stop() suit avec le résultat */
  onAutoStop?: () => void;
}

/**
 * Enregistreur de note vocale. Cycle : start() → (hold) → stop() → VoiceRecording.
 * Auto-stop à 60 s (directive). cancel() jette l'enregistrement sans résultat.
 * Toute erreur micro (permission refusée, absence d'appareil) remonte telle
 * quelle — l'UI l'affiche, on ne fabrique pas de son.
 */
export class VoiceRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: VoiceRecorderOptions;

  constructor(opts: VoiceRecorderOptions = {}) {
    this.opts = opts;
  }

  get recording(): boolean {
    return this.rec !== null && this.rec.state === "recording";
  }

  async start(): Promise<void> {
    if (this.recording) throw new Error("enregistrement déjà en cours");
    if (!isOpusRecordingSupported()) {
      throw new Error(VOICE_UNSUPPORTED_MESSAGE);
    }
    const mime = pickRecorderMime();
    // getUserMedia exige un contexte sécurisé (https ou localhost) — l'app
    // est servie en https en prod ; en dev sandbox, localhost.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, {
      mimeType: mime,
      audioBitsPerSecond: VOICE_BITRATES[this.opts.bitrateKey ?? "default"],
    });
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = Date.now();
    this.rec.start(250); // paquets réguliers — budget mémoire borné
    this.timer = setInterval(() => {
      this.opts.onTick?.(Date.now() - this.startedAt);
    }, 250);
    this.autoStopTimer = setTimeout(() => {
      this.opts.onAutoStop?.();
      void this.stop().catch(() => undefined);
    }, VOICE_MAX_DURATION_S * 1000);
  }

  /** Arrête et mesure (decode → durée + 100 peaks). Résultat unique. */
  async stop(): Promise<VoiceRecording> {
    const rec = this.rec;
    if (!rec || rec.state === "inactive") throw new Error("aucun enregistrement en cours");
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    if (this.timer) clearInterval(this.timer);
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    rec.stop();
    await stopped;
    this.cleanup();
    const blob = new Blob(this.chunks, { type: rec.mimeType.split(";")[0] });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Mesure TOLÉRANTE : une capture dégénérée (tap < ~200 ms) peut ne pas
    // contenir d'en-tête webm jouable — stop() ne lève PAS (l'utilisateur voit
    // sa preview), le REFUS honnête reste à l'envoi (validateVoiceForSend :
    // sniff null → « enregistrement non reconnu comme opus »). Attrapé par la
    // preuve navigateur tap-toggle (B3).
    let container: SniffedOpusContainer | null = null;
    let durationMs = Math.max(1, Date.now() - this.startedAt);
    let sampleRate = 48000;
    let peaks: number[] = new Array(VOICE_PEAKS).fill(0);
    try {
      container = assertPlayableVoice(bytes);
      const measure = await decodeAndMeasure(bytes);
      durationMs = Math.max(measure.durationMs, durationMs);
      sampleRate = measure.sampleRate;
      peaks = measure.peaks;
    } catch {
      /* capture dégénérée — l'envoi sera refusé proprement */
    }
    return { bytes, container: container ?? "audio/webm", durationMs, sampleRate, peaks };
  }

  /** Annule (jette) — aucune donnée ne sort. */
  async cancel(): Promise<void> {
    const rec = this.rec;
    if (this.timer) clearInterval(this.timer);
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    if (rec && rec.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
      await stopped;
    }
    this.chunks = [];
    this.cleanup();
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
  }
}
