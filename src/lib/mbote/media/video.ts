/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  video — recorder vidéo B4 (webm VP8/VP9, fallback MP4 Safari ; pas de
 *  transcodage V1 — spec MEDIA-ENVELOPE-SPEC §9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - durée max 60 s (auto-stop + garde d'envoi 61 s → REFUS) ;
 *  - taille max 100 Mo (limite serveur PAR TYPE — B2_UPLOAD_LIMITS) ;
 *  - résolution : contrainte `ideal` 720p — le navigateur donne la meilleure
 *    résolution ≤ 720p que le device supporte (souvent 480p sur les webcams
 *    modestes : « 480p par défaut, 720p si supporté » — tranché §9.2) ;
 *  - bitrate : 1 Mbps fixé en entrée, l'encodeur VP8 adapte en interne
 *    (quantification adaptative) — vidéos 60 s @ 480p ≈ 5–15 Mo, dans la
 *    limite 100 Mo ;
 *  - conteneur : webm (VP8+Opus) partout où MediaRecorder le propose —
 *    fallback MP4 (Safari, H.264+AAC) si webm absent ;
 *  - PAS de transcodage V1 : on envoie TEL QUEL (directive) ;
 *  - thumbnail : <video> → canvas 320 px → JPEG (générée CÔTÉ EXPÉDITEUR,
 *    voyage comme une petite image B2 — strip canvas appliqué, elle est
 *    régénérée localement donc sans EXIF de toute façon) ;
 *  - sniff à la RÉCEPTION (barrière de rendu — miroir §6.7-iii/§8.4) :
 *    MP4 (ftyp) ou webm vidéo (EBML + piste V_VP8/V_VP9/V_AV1 dans les
 *    premiers 64 Ko) — un webm AUDIO (voice note B3 : A_OPUS sans piste
 *    vidéo) ou un MP3 renommé est REFUSÉ.
 */

export const VIDEO_MAX_DURATION_S = 60;
/** Limite PAR TYPE côté serveur = 100 Mo (directive B4) — garde client miroir. */
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_THUMB_WIDTH = 320;
export const VIDEO_THUMB_QUALITY = 0.8;
/** Bitrate vidéo d'entrée — l'encodeur adapte en interne (tranché §9.2). */
export const VIDEO_BITS_PER_SECOND = 1_000_000;
/** Bitrate audio embarqué (Opus) — la voix dans la vidéo, pas une note voix. */
export const VIDEO_AUDIO_BITS_PER_SECOND = 32_000;

export type VideoContainer = "video/webm" | "video/mp4";

export function isVideoRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ||
      MediaRecorder.isTypeSupported("video/webm") ||
      MediaRecorder.isTypeSupported("video/mp4"))
  );
}

export const VIDEO_UNSUPPORTED_MESSAGE =
  "Vidéo non disponible sur ce navigateur — utilisez Chrome ou Firefox.";

export function pickVideoRecorderMime(): string {
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
    "video/mp4", // Safari (H.264 + AAC) — fallback
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  throw new Error(VIDEO_UNSUPPORTED_MESSAGE);
}

// ── sniff conteneur (barrière de rendu à la réception) ──────────────────────

function hasMp4Ftyp(b: Uint8Array): boolean {
  // bytes 4..8 === "ftyp" (ISO BMFF — boîte minimale 12 octets)
  return (
    b.length >= 12 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  );
}

function isEbml(b: Uint8Array): boolean {
  return (
    b.length > 4 &&
    b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
  );
}

/** L'ID de codec vidéo Matroska apparaît en ASCII dans l'élément Tracks. */
function hasVideoCodecId(b: Uint8Array): boolean {
  const window = b.subarray(0, Math.min(b.length, 64 * 1024));
  const ascii = String.fromCharCode(...Array.from(window));
  return ascii.includes("V_VP8") || ascii.includes("V_VP9") || ascii.includes("V_AV1");
}

export type SniffedVideoContainer = VideoContainer;

/**
 * Sniff le PLAINTEXT déchiffré : renvoie le conteneur vidéo si (et seulement
 * si) c'est une vidéo réelle (MP4 ftyp, ou EBML avec piste vidéo V_*). Un
 * webm AUDIO (A_OPUS sans V_*) — c.-à-d. une voice note B3 déguisée — et un
 * MP3 renommé renvoient null → REFUS de rendu (miroir §6.7-iii).
 */
export function sniffVideoContainer(bytes: Uint8Array): SniffedVideoContainer | null {
  if (hasMp4Ftyp(bytes)) return "video/mp4";
  if (isEbml(bytes) && hasVideoCodecId(bytes)) return "video/webm";
  return null;
}

export function assertPlayableVideo(bytes: Uint8Array, declaredType?: string): SniffedVideoContainer {
  const container = sniffVideoContainer(bytes);
  if (!container) {
    throw new Error("magic-bytes-mismatch: ce média n'est pas une vidéo (MP4 ftyp ou webm avec piste V_* requis)");
  }
  // Le client B4 déclare le CONTENEUR RÉEL (uploadVideoNote pose le sniff) —
  // toute divergence déclaré/sniffé = client cassé ou altération → REFUS
  // (miroir strict de assertPlayableVoice, §6.7-iii).
  if (declaredType && declaredType !== container) {
    throw new Error(`magic-bytes-mismatch: déclaré « ${declaredType} », sniffé « ${container} »`);
  }
  return container;
}

// ── garde d'envoi (miroir des refus serveur) ────────────────────────────────

export interface VideoCandidate {
  bytes: Uint8Array;
  durationMs: number;
}

export type VideoValidation =
  | { ok: true; container: SniffedVideoContainer }
  | { ok: false; reason: string };

export function validateVideoForSend(c: VideoCandidate): VideoValidation {
  if (!Number.isFinite(c.durationMs) || c.durationMs <= 0) {
    return { ok: false, reason: "durée invalide (enregistrement vide ?)" };
  }
  if (c.durationMs > VIDEO_MAX_DURATION_S * 1000 + 250 /* tolérance horloge */) {
    return {
      ok: false,
      reason: `durée ${(c.durationMs / 1000).toFixed(1)} s > max ${VIDEO_MAX_DURATION_S} s`,
    };
  }
  if (c.bytes.length <= 0 || c.bytes.length > VIDEO_MAX_BYTES) {
    return { ok: false, reason: `taille ${c.bytes.length} o hors bornes (1…${VIDEO_MAX_BYTES})` };
  }
  const container = sniffVideoContainer(c.bytes);
  if (!container) {
    return { ok: false, reason: "enregistrement non reconnu comme vidéo (conteneur inattendu)" };
  }
  return { ok: true, container };
}

// ── thumbnail (côté expéditeur — générée à l'arrêt de l'enregistrement) ─────

export interface CapturedThumbnail {
  bytes: Uint8Array; // JPEG
  width: number;
  height: number;
}

/**
 * Capture une vignette JPEG 320 px depuis les OCTETS de la vidéo :
 * <video> (object URL du blob local) → seek 1 s → canvas → toDataURL.
 * Nécessite un navigateur (harness Node → erreur propre — les tests E2E de
 * thumbnail passent par la preuve navigateur, comme B3).
 */
export async function captureVideoThumbnail(
  bytes: Uint8Array,
  mime: string
): Promise<CapturedThumbnail> {
  if (typeof document === "undefined") {
    throw new Error("thumbnail indisponible hors navigateur");
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("vidéo illisible (metadata)"));
      setTimeout(() => reject(new Error("vidéo : metadata en attente (timeout)")), 5000);
    });
    const seekTo = Math.min(1, Math.max(0, (video.duration || 1) / 2));
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = seekTo;
      setTimeout(resolve, 3000); // certains codecs ne déclenchent pas onseeked
    });
    const w = VIDEO_THUMB_WIDTH;
    const h = Math.max(1, Math.round((video.videoHeight / (video.videoWidth || w)) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d indisponible");
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", VIDEO_THUMB_QUALITY);
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { bytes: out, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── enregistreur (MediaRecorder natif — webm VP8/VP9, fallback MP4) ─────────

export interface VideoRecording {
  bytes: Uint8Array;
  /** conteneur réel sniffré (video/webm | video/mp4) */
  container: SniffedVideoContainer;
  durationMs: number;
  width: number;
  height: number;
  /** vignette JPEG 320 px capturée à l'arrêt (peut être null en harness) */
  thumb: CapturedThumbnail | null;
}

export interface VideoRecorderOptions {
  onTick?: (elapsedMs: number) => void;
  onAutoStop?: () => void;
}

/**
 * Enregistreur vidéo. Cycle : start() → (tap pour arrêter) → stop() →
 * VideoRecording. Auto-stop à 60 s (directive : « au-delà : refus » — le
 * recorder arrête proprement, la garde d'envoi refuse 61 s).
 * cancel() jette l'enregistrement sans résultat.
 */
export class VideoRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: VideoRecorderOptions;

  constructor(opts: VideoRecorderOptions = {}) {
    this.opts = opts;
  }

  get recording(): boolean {
    return this.rec !== null && this.rec.state === "recording";
  }

  async start(): Promise<void> {
    if (this.recording) throw new Error("enregistrement déjà en cours");
    if (!isVideoRecordingSupported()) {
      throw new Error(VIDEO_UNSUPPORTED_MESSAGE);
    }
    const mime = pickVideoRecorderMime();
    // 720p ideal — le navigateur retombe sur la meilleure résolution du
    // device (480p typique des webcams modestes — tranché §9.2).
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings() ?? {};
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, {
      mimeType: mime,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND,
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
    }, VIDEO_MAX_DURATION_S * 1000);
    this.width = Number(settings.width) || 640;
    this.height = Number(settings.height) || 480;
  }

  private width = 0;
  private height = 0;

  /** Arrête et sniff. La thumbnail est capturée ICI (côté expéditeur). */
  async stop(): Promise<VideoRecording> {
    const rec = this.rec;
    if (!rec || rec.state === "inactive") throw new Error("aucun enregistrement en cours");
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    if (this.timer) clearInterval(this.timer);
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    rec.stop();
    await stopped;
    this.stream?.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: rec.mimeType.split(";")[0] });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    this.rec = null;
    this.stream = null;

    const durationMs = Math.max(1, Date.now() - this.startedAt);
    const container = sniffVideoContainer(bytes);
    if (!container) {
      // capture dégénérée (tap trop court) — pas de crash : la preview ne
      // s'ouvre pas, le REFUS honnête est affiché (pattern B3 stop()).
      throw new Error("enregistrement illisible (trop court ?) — réessayez");
    }
    let thumb: CapturedThumbnail | null = null;
    try {
      thumb = await captureVideoThumbnail(bytes, container);
    } catch {
      thumb = null; // harness/Node ou metadata en attente — envoi reste possible
    }
    return {
      bytes,
      container,
      durationMs,
      width: this.width,
      height: this.height,
      thumb,
    };
  }

  async cancel(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } finally {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.rec = null;
      this.stream = null;
      this.chunks = [];
    }
  }
}
