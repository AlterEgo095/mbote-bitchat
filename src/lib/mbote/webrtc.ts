"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C2 — Appels audio 1:1 (WebRTC) — gestionnaire de session côté client
 *  C3 — extension vidéo 1:1 : MÊMES patterns (signalisation signée call:*,
 *  TURN éphémère, DTLS-SRTP, knock push) — seule la piste média change :
 *  m-line vidéo dans l'offre, fallback audio si caméra absente/refusée,
 *  dégradation adaptative 480p→360p→240p via RTCRtpSender.setParameters.
 * ─────────────────────────────────────────────────────────────────────────────
 *  RÔLES :
 *   • signalisation : événements socket.io call:offer/answer/ice/hangup/reject
 *     relayés par le hub (preuve ECDSA `${from}|${kind}|${to}|${callId}|${ts}`
 *     vérifiée côté hub — voir proof.ts callProofMessage) ;
 *   • C3 : call:media porte l'état des pistes locales (videoOn/audioOn) —
 *     annonce signée, même mécanique — pour l'indicateur « caméra coupée »
 *     distant (les frames noires de track.enabled=false ne sont PAS détectables
 *     côté receiver sans ce message) ;
 *   • média : RTCPeerConnection DTLS-SRTP — l'audio/vidéo ne traversent JAMAIS
 *     le serveur (sauf relay TURN, qui ne voit que du chiffré) ;
 *   • TURN : credentials éphémères via /api/turn-credentials (TTL 10 min) ;
 *     2 échecs d'établissement en 30 s → fallbackMode (notes vocales
 *     recommandées dans l'UI) ;
 *   • knock : POST /api/call-knock fire-and-forget (push type 'incoming_call'
 *     ou 'incoming_video_call' — SANS contenu — reprise C1) ;
 *   • hygiène : hangup → pc.close() + tracks stop + listeners détachés +
 *     ringtone stoppé (test « zéro fuite » du harnais).
 *
 *  MUTE : track.enabled = false — le navigateur émet des frames de SILENCE
 *  (le canal RTP reste ouvert, la renégociation est inutile). Le harnais
 *  vérifie enabled === false sur la piste émettrice. Même pattern pour la
 *  caméra (frames noires).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getSocket } from "./socket";
import { signPayload } from "./crypto";
import { callProofMessage, type CallSignalKind } from "./proof";

// ───────────────────────── états publics ─────────────────────────

export type CallState = "idle" | "dialing" | "ringing" | "connecting" | "active" | "ending";
export type CallDirection = "outgoing" | "incoming";
export type TurnMode = "relay" | "direct" | "unavailable";
/** C3 : type d'appel — l'offreur décide, le répondeur suit le SDP de l'offre. */
export type CallType = "audio" | "video";
/** C3 : étages de dégradation vidéo (adaptatif réseau). */
export type VideoQuality = "high" | "medium" | "low";

export interface CallSnapshot {
  state: CallState;
  direction: CallDirection | null;
  peer: string | null;
  peerLabel: string | null;
  callId: string | null;
  muted: boolean;
  startedAt: number | null;
  turnMode: TurnMode;
  /** C3 : type d'appel résolu (fallback caméra → "audio") */
  callType: CallType;
  /** C3 : caméra locale ON — false si coupée ou fallback audio */
  cameraOn: boolean;
  /** C3 : état DISTANT annoncé via call:media (null = pas encore annoncé) */
  remoteCameraOn: boolean | null;
  remoteMuted: boolean | null;
  /** C3 : réseau dégradé (packet loss vidéo > 5 % via getStats) — indicateur UI */
  unstable: boolean;
  /** C3 : étage de qualité vidéo courant (480p/360p/240p) */
  videoQuality: VideoQuality;
  /** C3 : id du flux local courant (change au flip caméra) — sync preview PiP */
  localStreamId: string | null;
  /** C3 : id du flux vidéo distant (null = audio seul / pas encore reçu) */
  remoteStreamId: string | null;
  /** raison du fallback notes vocales (2 échecs TURN/30 s) — null sinon */
  fallbackNotice: string | null;
  error: string | null;
}

const IDLE: CallSnapshot = {
  state: "idle",
  direction: null,
  peer: null,
  peerLabel: null,
  callId: null,
  muted: false,
  startedAt: null,
  turnMode: "direct",
  callType: "audio",
  cameraOn: false,
  remoteCameraOn: null,
  remoteMuted: null,
  unstable: false,
  videoQuality: "high",
  localStreamId: null,
  remoteStreamId: null,
  fallbackNotice: null,
  error: null,
};

// ───────────────────────── TURN : anti-échec en cascade ─────────────────────────

const TURN_FAILURE_WINDOW_MS = 30_000;
const TURN_FAILURE_THRESHOLD = 2;

class TurnFailureTracker {
  private failures: number[] = [];
  private fallbackNotice: string | null = null;

  recordFailure(): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t <= TURN_FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= TURN_FAILURE_THRESHOLD) {
      this.fallbackNotice =
        "Appels indirects (TURN) indisponibles momentanément — utilisez une note vocale chiffrée en attendant.";
    }
  }

  recordSuccess(): void {
    this.failures = [];
    this.fallbackNotice = null;
  }

  get notice(): string | null {
    return this.fallbackNotice;
  }
}

// ─────────────── C3 : qualité vidéo adaptative (480p → 360p → 240p) ───────────────

export interface VideoQualityStage {
  quality: VideoQuality;
  /** bitrate max (bps) appliqué via RTCRtpSender.setParameters */
  maxBitrate: number;
  /** réduction d'échelle appliquée par l'encodeur (1 = résolution native) */
  scaleResolutionDownBy: number;
}

/** Étages C3 : 480p (900 kbps) → 360p (450 kbps) → 240p (200 kbps). */
export const VIDEO_QUALITY_STAGES: readonly VideoQualityStage[] = [
  { quality: "high", maxBitrate: 900_000, scaleResolutionDownBy: 1 },
  { quality: "medium", maxBitrate: 450_000, scaleResolutionDownBy: 1.5 },
  { quality: "low", maxBitrate: 200_000, scaleResolutionDownBy: 2 },
];

/** Filet de sécurité (index hors bornes impossible — jamais utilisé en pratique). */
const HIGH_STAGE: VideoQualityStage = { quality: "high", maxBitrate: 900_000, scaleResolutionDownBy: 1 };

/** Directive C3 : packet loss > 5 % = connexion instable (indicateur UI). */
export const PACKET_LOSS_BAD_RATIO = 0.05;
/** Hystérésis : N mesures consécutives dégradées avant de descendre d'un étage. */
const DEGRADE_CONSECUTIVE_BAD = 2;

/**
 * Contrôleur PUR (testable en harnais) : ne touche JAMAIS à l'encodeur —
 * décide uniquement quand descendre d'un étage. Descente seule (la remontée
 * d'étage est hors périmètre C3 — NON TESTÉ, documenté dans la preuve).
 */
export class VideoQualityController {
  private stageIndex = 0;
  private consecutiveBad = 0;

  get stage(): VideoQualityStage {
    // index borné par measure() (jamais > STAGES.length - 1) — fallback explicite
    return VIDEO_QUALITY_STAGES[this.stageIndex] ?? HIGH_STAGE;
  }

  /** Feed une mesure de packet loss (0-1). Retourne "down" si un étage est descendu. */
  measure(lossRatio: number): "down" | "hold" {
    if (!Number.isFinite(lossRatio) || lossRatio < 0) return "hold";
    if (lossRatio > PACKET_LOSS_BAD_RATIO) {
      this.consecutiveBad += 1;
      if (this.consecutiveBad >= DEGRADE_CONSECUTIVE_BAD && this.stageIndex < VIDEO_QUALITY_STAGES.length - 1) {
        this.stageIndex += 1;
        this.consecutiveBad = 0;
        return "down";
      }
    } else {
      this.consecutiveBad = 0;
    }
    return "hold";
  }
}

// ───────────────────────── ringtone (WebAudio — aucun asset) ─────────────────────────

class Ringtone {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private lfoTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.ctx) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.osc = this.ctx.createOscillator();
      this.gain = this.ctx.createGain();
      this.osc.type = "sine";
      this.gain.gain.value = 0; // piloté par la modulation sonnerie
      this.osc.frequency.value = 440;
      this.osc.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.osc.start();
      // motif sonnerie FR : 1,5 s à 440 Hz / 3,5 s de silence
      let ringing = true;
      const setTone = () => {
        if (!this.gain || !this.ctx) return;
        this.gain.gain.setTargetAtTime(ringing ? 0.08 : 0, this.ctx.currentTime, 0.05);
        if (this.osc) this.osc.frequency.setTargetAtTime(ringing ? 440 : 0, this.ctx.currentTime, 0.01);
        ringing = !ringing;
      };
      setTone();
      this.lfoTimer = setInterval(setTone, 1500);
    } catch {
      /* AudioContext indisponible : appel silencieux (l'UI montre quand même l'appel) */
    }
  }

  stop(): void {
    if (this.lfoTimer) clearInterval(this.lfoTimer);
    this.lfoTimer = null;
    try {
      this.osc?.stop();
    } catch {
      /* déjà arrêté */
    }
    this.osc = null;
    this.gain = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

// ───────────────────────── gestionnaire de session ─────────────────────────

interface IdentityHandle {
  pubkey: string;
  signPriv: CryptoKey;
}

interface IncomingOffer {
  from: string;
  callId: string;
  offer: RTCSessionDescriptionInit;
  peerLabel: string | null;
}

const DIAL_TIMEOUT_MS = 45_000;

/** C3 : l'offre annonce-t-elle une m-line vidéo ACTIVE (port ≠ 0) ? */
function offerHasVideo(sdp: string | undefined): boolean {
  if (!sdp) return false;
  for (const line of sdp.split("\n")) {
    const m = /^m=video\s+(\d+)\b/i.exec(line.trim());
    if (m && m[1] !== "0") return true;
  }
  return false;
}

class CallManager {
  private snapshot: CallSnapshot = IDLE;
  private listeners = new Set<() => void>();

  private identity: IdentityHandle | null = null;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private callId: string | null = null;
  private peer: string | null = null;
  private pendingOffer: IncomingOffer | null = null;
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  private ringtone = new Ringtone();
  private turnTracker = new TurnFailureTracker();
  /** libellés publics de l'annuaire (nickname par pubkey — pour l'UI) */
  private labels = new Map<string, string>();
  /** résolveur injecté par l'UI (annuaire) — appelé pour les appels ENTRANTS */
  private labelResolver: ((pubkey: string) => Promise<string | null>) | null = null;
  private bound = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  // ── C3 ──
  private remoteVideoStream: MediaStream | null = null;
  private videoSender: RTCRtpSender | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private qualityController = new VideoQualityController();
  private facing: "user" | "environment" = "user";

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): CallSnapshot {
    return this.snapshot;
  }

  /** C3 : flux vidéo DISTANT (null en audio / pas encore reçu) — attaché par CallView. */
  getRemoteVideoStream(): MediaStream | null {
    return this.remoteVideoStream;
  }

  /** C3 : flux local (audio[+vidéo]) — preview PiP de CallView. */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** Libellé public (annuaire) — alimenté par l'UI avant l'appel. */
  setLabel(pubkey: string, nickname: string): void {
    this.labels.set(pubkey, nickname);
  }

  /** Résolveur annuaire (injecté par MessagesView) — pour nommer l'APPELANT. */
  setLabelResolver(fn: (pubkey: string) => Promise<string | null>): void {
    this.labelResolver = fn;
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private set(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.notify();
  }

  // ── signalisation (preuves signées, relayées par le hub) ──

  private async signal(
    kind: CallSignalKind,
    to: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.identity) return;
    const ts = Date.now();
    const callId = this.callId ?? "";
    const signature = await signPayload(
      this.identity.signPriv,
      callProofMessage(kind, this.identity.pubkey, to, callId, ts)
    );
    // ⚠️ mapping des noms : la PREUVE porte le kind à tiret (call-offer), le
    // SOCKET émet le nom à deux-points (call:offer) — convention inverse du
    // relayage (le hub ré-émet les noms à tiret vers le destinataire).
    const socketEvent = `call:${kind.split("-")[1]}`;
    getSocket().emit(socketEvent, { from: this.identity.pubkey, to, callId, ts, sig: signature, ...payload });
  }

  // ── infrastructure WebRTC ──

  private async fetchTurn(): Promise<{ urls: RTCIceServer[]; mode: TurnMode }> {
    if (!this.identity) return { urls: [], mode: "unavailable" };
    try {
      const ts = Date.now();
      const signature = await signPayload(this.identity.signPriv, `${this.identity.pubkey}|turn-cred|${ts}`);
      const res = await fetch(
        `/api/turn-credentials?me=${encodeURIComponent(this.identity.pubkey)}&ts=${ts}&signature=${encodeURIComponent(signature)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        available: boolean;
        urls?: string[];
        username?: string;
        credential?: string;
      };
      if (!json.available || !json.urls?.length || !json.username || !json.credential) {
        return { urls: [], mode: "unavailable" };
      }
      return {
        urls: [{ urls: json.urls, username: json.username, credential: json.credential }],
        mode: "relay",
      };
    } catch {
      return { urls: [], mode: "unavailable" };
    }
  }

  private async makePc(turnMode: TurnMode, iceServers: RTCIceServer[]): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({
      iceServers,
      // TURN configuré → chemin normal (relay en dernier recours) ; sinon host only
      iceTransportPolicy: "all",
    });

    pc.onicecandidate = (e) => {
      if (e.candidate && this.peer) {
        void this.signal("call-ice", this.peer, { candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      if (e.track.kind === "video") {
        // C3 : sink vidéo distant — l'attachement <video> se fait dans CallView.
        if (!this.remoteVideoStream || this.remoteVideoStream.id !== e.streams[0].id) {
          this.remoteVideoStream = e.streams[0];
          this.set({ remoteStreamId: e.streams[0].id });
        }
        return; // l'audio arrive par son propre event ontrack
      }
      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.autoplay = true;
        this.remoteAudio.setAttribute("data-mbote-call-audio", "");
        document.body.appendChild(this.remoteAudio);
      }
      this.remoteAudio.srcObject = e.streams[0];
      void this.remoteAudio.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.turnTracker.recordSuccess();
        this.set({ state: "active", startedAt: Date.now(), error: null });
        this.startQualityMonitor(pc);
      } else if (pc.connectionState === "failed") {
        this.turnTracker.recordFailure();
        void this.end("failed");
      } else if (pc.connectionState === "disconnected") {
        // grâce de 3 s avant abandon (coupure réseau brève)
        setTimeout(() => {
          if (pc.connectionState === "disconnected") void this.end("network");
        }, 3000);
      }
    };
    return pc;
  }

  private async getMedia(callType: CallType): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (callType !== "video") return navigator.mediaDevices.getUserMedia({ audio });
    // C3 : vidéo 640×480@24 (directive) — caméra absente/refusée → FALLBACK AUDIO SEUL
    // (l'appel s'établit quand même, uniquement dégradé en audio — preuve E-scénario)
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio,
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24 },
          facingMode: { ideal: this.facing },
        },
      });
    } catch (e) {
      if (
        e instanceof DOMException &&
        (e.name === "NotFoundError" || e.name === "OverconstrainedError" || e.name === "NotAllowedError")
      ) {
        return navigator.mediaDevices.getUserMedia({ audio });
      }
      throw e;
    }
  }

  // ── C3 : monitor qualité — getStats toutes les 2 s, dégradation automatique ──

  private startQualityMonitor(pc: RTCPeerConnection): void {
    if (this.snapshot.callType !== "video" || this.qualityTimer) return;
    const tick = async () => {
      if (!this.pc || this.pc !== pc || pc.connectionState !== "connected") return;
      try {
        const stats = await pc.getStats();
        let worst = 0;
        stats.forEach((r) => {
          const report = r as unknown as {
            type?: string;
            kind?: string;
            packetsLost?: number;
            packetsReceived?: number;
          };
          if (
            (report.type === "inbound-rtp" || report.type === "remote-inbound-rtp") &&
            report.kind === "video" &&
            typeof report.packetsLost === "number" &&
            typeof report.packetsReceived === "number"
          ) {
            const total = report.packetsLost + report.packetsReceived;
            if (total > 0) worst = Math.max(worst, report.packetsLost / total);
          }
        });
        const decision = this.qualityController.measure(worst);
        if (decision === "down") void this.applyVideoStage();
        const unstable = worst > PACKET_LOSS_BAD_RATIO;
        if (this.snapshot.unstable !== unstable) this.set({ unstable });
      } catch {
        /* getStats indisponible — indicateurs inchangés */
      }
    };
    this.qualityTimer = setInterval(() => void tick(), 2_000);
  }

  private stopQualityMonitor(): void {
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.qualityTimer = null;
  }

  /** Applique l'étage courant sur le sender vidéo (AUCUNE renégociation). */
  private async applyVideoStage(): Promise<void> {
    const sender = this.videoSender;
    if (!sender || !sender.track) return;
    try {
      const params = sender.getParameters();
      const stage = this.qualityController.stage;
      const encodings = params.encodings?.length ? params.encodings : [{} as RTCRtpEncodingParameters];
      encodings[0] = {
        ...encodings[0],
        maxBitrate: stage.maxBitrate,
        scaleResolutionDownBy: stage.scaleResolutionDownBy,
      };
      params.encodings = encodings;
      await sender.setParameters(params);
      if (this.snapshot.videoQuality !== stage.quality) this.set({ videoQuality: stage.quality });
    } catch {
      /* setParameters refusé — l'étage UI reste inchangé */
    }
  }

  private bindSocket(): void {
    if (this.bound) return;
    this.bound = true;
    const s = getSocket();
    // ⚠️ le hub RELAIE sous des noms à TIRETS (call-offer, call-answer, …) —
    // les noms à deux-points sont ceux que le CLIENT émet vers le hub.
    s.on("call-offer", (d: { from?: string; callId?: string; offer?: RTCSessionDescriptionInit }) => {
      if (!d?.from || !d.callId || !d.offer) return;
      if (this.snapshot.state !== "idle") {
        // déjà en appel → rejet automatique (occupé) : le hub exige un callId valide
        const ts = Date.now();
        if (this.identity) {
          void signPayload(
            this.identity.signPriv,
            callProofMessage("call-reject", this.identity.pubkey, d.from, d.callId, ts)
          ).then((sig) =>
            s.emit("call:reject", { from: this.identity?.pubkey, to: d.from, callId: d.callId, ts, sig })
          );
        }
        return;
      }
      // C3 : le TYPE de l'appel est lu dans le SDP de l'offre (m=video) —
      // l'overlay sonne « Appel vidéo entrant » dès la sonnerie, pas après accept
      this.pendingOffer = {
        from: d.from,
        callId: d.callId,
        offer: d.offer,
        peerLabel: this.labels.get(d.from) ?? null,
      };
      // nomme l'appelant via l'annuaire (asynchrone — l'overlay se met à jour)
      if (!this.labels.has(d.from)) {
        const fromPk: string = d.from;
        const offer = this.pendingOffer;
        const resolver = this.labelResolver;
        if (offer && resolver) {
          void resolver(fromPk)
            .then((name) => {
              if (name) {
                this.labels.set(fromPk, name);
                if (this.pendingOffer?.from === fromPk) {
                  this.pendingOffer.peerLabel = name;
                  this.set({ peerLabel: name });
                }
              }
            })
            .catch(() => undefined);
        }
      }
      this.ringtone.start();
      this.set({
        state: "ringing",
        direction: "incoming",
        peer: d.from,
        peerLabel: this.labels.get(d.from) ?? null,
        callId: d.callId,
        callType: offerHasVideo(d.offer.sdp) ? "video" : "audio",
        remoteCameraOn: null,
        remoteMuted: null,
        unstable: false,
        videoQuality: "high",
        remoteStreamId: null,
        error: null,
      });
    });
    s.on("call-answer", (d: { from?: string; callId?: string; answer?: RTCSessionDescriptionInit }) => {
      if (!this.pc || d.callId !== this.callId || !d.answer) return;
      if (this.dialTimer) clearTimeout(this.dialTimer);
      this.dialTimer = null;
      this.remoteSet = true;
      void this.pc.setRemoteDescription(d.answer).catch(() => void this.end("negotiation"));
      for (const c of this.pendingIce.splice(0)) void this.pc.addIceCandidate(c).catch(() => undefined);
      this.set({ state: "connecting" });
      // C3 : annonce notre état pistes dès que la réponse part/arrive (les deux
      // côtés annoncent — chacun met à jour ses indicateurs distants)
      void this.signalMediaState();
    });
    s.on("call-ice", (d: { from?: string; callId?: string; candidate?: RTCIceCandidateInit }) => {
      if (d.callId !== this.callId || !d.candidate) return;
      if (this.pc && this.remoteSet) void this.pc.addIceCandidate(d.candidate).catch(() => undefined);
      else this.pendingIce.push(d.candidate);
    });
    s.on("call-hangup", (d: { from?: string; callId?: string }) => {
      if (d.callId !== this.callId) return;
      void this.teardown();
      this.set({ ...IDLE, fallbackNotice: this.turnTracker.notice });
    });
    s.on("call-media", (d: { from?: string; callId?: string; videoOn?: unknown; audioOn?: unknown }) => {
      // C3 : état pistes DISTANT (annonce signée call:media) — indicateurs UI
      if (d.callId !== this.callId) return;
      this.set({
        remoteCameraOn: typeof d.videoOn === "boolean" ? d.videoOn : null,
        remoteMuted: typeof d.audioOn === "boolean" ? !d.audioOn : null,
      });
    });
    s.on("call-reject", (d: { from?: string; callId?: string }) => {
      if (d.callId !== this.callId) return;
      void this.teardown();
      this.set({ ...IDLE, fallbackNotice: this.turnTracker.notice });
    });
  }

  // ── actions publiques ──

  async startOutgoing(peer: string, peerLabel: string | null, callType: CallType = "audio"): Promise<void> {
    if (this.snapshot.state !== "idle") return;
    if (!this.identity) {
      this.set({ ...IDLE, error: "Identité non prête" });
      return;
    }
    this.bindSocket();
    this.callId = crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    this.peer = peer;
    this.set({
      state: "dialing",
      direction: "outgoing",
      peer,
      peerLabel,
      callId: this.callId,
      muted: false,
      startedAt: null,
      error: null,
      callType,
      cameraOn: false,
      remoteCameraOn: null,
      remoteMuted: null,
      unstable: false,
      videoQuality: "high",
      remoteStreamId: null,
      fallbackNotice: this.turnTracker.notice,
    });

    try {
      const [{ urls, mode }, stream] = await Promise.all([this.fetchTurn(), this.getMedia(callType)]);
      this.localStream = stream;
      const videoTrack = stream.getVideoTracks()[0] ?? null;
      // C3 : fallback caméra → l'appel démarre AUDIO SEUL (l'UI le reflète)
      const resolvedType: CallType = videoTrack ? callType : "audio";
      this.set({
        turnMode: mode,
        callType: resolvedType,
        cameraOn: !!videoTrack,
        localStreamId: stream.id,
      });
      const pc = await this.makePc(mode, urls);
      this.pc = pc;
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === "video") this.videoSender = sender;
      }

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: !!videoTrack,
      });
      await pc.setLocalDescription(offer);
      this.remoteSet = false;
      await this.signal("call-offer", peer, { offer });

      // timeout de sonnerie — pas de réponse en 45 s → abandon propre
      this.dialTimer = setTimeout(() => void this.end("no-answer"), DIAL_TIMEOUT_MS);

      // knock push (fire-and-forget) : réveille le callee hors hub
      // C3 : le TYPE fait partie de la preuve (anti-falsification du rendu de
      // notification) — `${from}|call-knock|${to}|${callId}|${type}|${ts}`
      const kts = Date.now();
      void signPayload(
        this.identity.signPriv,
        `${this.identity.pubkey}|call-knock|${peer}|${this.callId}|${resolvedType}|${kts}`
      )
        .then((ksig) =>
          fetch("/api/call-knock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: this.identity?.pubkey,
              to: peer,
              callId: this.callId,
              video: resolvedType === "video",
              ts: kts,
              signature: ksig,
            }),
          })
        )
        .catch(() => undefined);
    } catch (e) {
      this.turnTracker.recordFailure();
      await this.teardown();
      this.set({
        ...IDLE,
        error:
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Micro refusé — autorisez le micro pour appeler."
            : "Appel impossible (micro/TURN) — note vocale disponible.",
        fallbackNotice: this.turnTracker.notice,
      });
    }
  }

  async acceptIncoming(): Promise<void> {
    const incoming = this.pendingOffer;
    if (!incoming || !this.identity) return;
    this.ringtone.stop();
    this.callId = incoming.callId;
    this.peer = incoming.from;
    this.set({ state: "connecting", muted: false, startedAt: null });
    try {
      // C3 : l'offre annonce m=video → appel vidéo ; sinon audio. Caméra refusée
      // → fallback AUDIO SEUL (l'answer rejette la m-line vidéo, l'audio passe).
      const wantedType: CallType = offerHasVideo(incoming.offer.sdp) ? "video" : "audio";
      const [{ urls, mode }, stream] = await Promise.all([this.fetchTurn(), this.getMedia(wantedType)]);
      this.localStream = stream;
      const videoTrack = stream.getVideoTracks()[0] ?? null;
      this.set({
        turnMode: mode,
        callType: videoTrack ? "video" : "audio",
        cameraOn: !!videoTrack,
        remoteCameraOn: null,
        remoteMuted: null,
        unstable: false,
        videoQuality: "high",
        remoteStreamId: null,
        localStreamId: stream.id,
      });
      const pc = await this.makePc(mode, urls);
      this.pc = pc;
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === "video") this.videoSender = sender;
      }
      await pc.setRemoteDescription(incoming.offer);
      this.remoteSet = true;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signal("call-answer", incoming.from, { answer });
      for (const c of this.pendingIce.splice(0)) void pc.addIceCandidate(c).catch(() => undefined);
      this.pendingOffer = null;
      // C3 : annonce l'état pistes (le caller l'attend après call-answer)
      void this.signalMediaState();
    } catch (e) {
      this.turnTracker.recordFailure();
      if (incoming) await this.signal("call-reject", incoming.from, {});
      await this.teardown();
      this.set({
        ...IDLE,
        error:
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Micro refusé — autorisez le micro pour répondre."
            : "Réponse impossible — note vocale disponible.",
        fallbackNotice: this.turnTracker.notice,
      });
    }
  }

  async rejectIncoming(): Promise<void> {
    const incoming = this.pendingOffer;
    this.ringtone.stop();
    this.pendingOffer = null;
    if (incoming && this.identity) {
      await this.signal("call-reject", incoming.from, {});
    }
    this.set({ ...IDLE, fallbackNotice: this.turnTracker.notice });
  }

  async end(reason: string): Promise<void> {
    const peer = this.peer;
    if (peer && this.callId && this.identity) {
      try {
        await this.signal("call-hangup", peer, { reason });
      } catch {
        /* le cleanup local reste prioritaire */
      }
    }
    await this.teardown();
    this.set({ ...IDLE, fallbackNotice: this.turnTracker.notice });
  }

  toggleMute(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return this.snapshot.muted;
    track.enabled = !track.enabled;
    this.set({ muted: !track.enabled });
    void this.signalMediaState();
    return this.snapshot.muted;
  }

  /** C3 : coupe/remet la caméra — track.enabled (frames noires, AUCUNE renégociation). */
  toggleCamera(): boolean {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return this.snapshot.cameraOn;
    track.enabled = !track.enabled;
    this.set({ cameraOn: track.enabled });
    void this.signalMediaState();
    return this.snapshot.cameraOn;
  }

  /** C3 : flip caméra (mobile multi-caméras) — replaceTrack, AUCUNE renégociation. */
  async flipCamera(): Promise<void> {
    const sender = this.videoSender;
    if (!sender) return;
    const nextFacing = this.facing === "user" ? "environment" : "user";
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing } },
      });
      const nextTrack = next.getVideoTracks()[0];
      if (!nextTrack) throw new Error("no-video-track");
      await sender.replaceTrack(nextTrack);
      this.facing = nextFacing;
      // le flux local est reconstruit (audio conservé + nouvelle vidéo)
      const audioTrack = this.localStream?.getAudioTracks()[0] ?? null;
      const merged = new MediaStream([...(audioTrack ? [audioTrack] : []), nextTrack]);
      const oldStream = this.localStream;
      this.localStream = merged;
      for (const t of oldStream?.getTracks() ?? []) {
        if (t !== audioTrack && t !== nextTrack) t.stop();
      }
      this.set({ cameraOn: true, localStreamId: merged.id });
      void this.signalMediaState();
    } catch {
      /* pas de 2ᵉ caméra (desktop) — état inchangé, le preview continue */
    }
  }

  /** C3 : annonce l'état pistes locales (call:media signé — même mécanique hub). */
  private async signalMediaState(): Promise<void> {
    if (!this.peer || !this.callId || !this.identity) return;
    try {
      await this.signal("call-media", this.peer, {
        videoOn: this.snapshot.cameraOn,
        audioOn: !this.snapshot.muted,
      });
    } catch {
      /* jamais bloquant */
    }
  }

  /** Hygiène : ferme TOUT (pc, tracks, audio, timers, ringtone, monitor C3). */
  private async teardown(): Promise<void> {
    if (this.dialTimer) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
    this.stopQualityMonitor();
    this.ringtone.stop();
    this.pendingOffer = null;
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* déjà fermé */
      }
      this.pc = null;
    }
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    this.localStream = null;
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.remoteVideoStream = null;
    this.videoSender = null;
    this.facing = "user";
    this.remoteSet = false;
    this.pendingIce = [];
    this.callId = null;
    this.peer = null;
  }

  /** Branché par l'UI (MboteApp) — injecte l'identité pour signer. */
  setIdentity(identity: IdentityHandle | null): void {
    this.identity = identity;
    if (identity) this.bindSocket();
  }

  /** Panique : tout détruire sans envoyer de signalisation. */
  async wipe(): Promise<void> {
    await this.teardown();
    this.set(IDLE);
  }
}

// ── singleton (survit au HMR via globalThis) ──

const g = globalThis as unknown as { __mboteCallManager?: CallManager };
export const callManager: CallManager = g.__mboteCallManager ?? new CallManager();
g.__mboteCallManager = callManager;
