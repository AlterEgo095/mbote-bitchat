"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C2 — Appels audio 1:1 (WebRTC) — gestionnaire de session côté client
 * ─────────────────────────────────────────────────────────────────────────────
 *  RÔLES :
 *   • signalisation : événements socket.io call:offer/answer/ice/hangup/reject
 *     relayés par le hub (preuve ECDSA `${from}|${kind}|${to}|${callId}|${ts}`
 *     vérifiée côté hub — voir proof.ts callProofMessage) ;
 *   • média : RTCPeerConnection DTLS-SRTP — l'audio ne traverse JAMAIS le
 *     serveur (sauf relay TURN, qui ne voit que du chiffré) ;
 *   • TURN : credentials éphémères via /api/turn-credentials (TTL 10 min) ;
 *     2 échecs d'établissement en 30 s → fallbackMode (notes vocales
 *     recommandées dans l'UI) ;
 *   • knock : POST /api/call-knock fire-and-forget (push type 'incoming_call',
 *     SANS contenu — reprise C1) ;
 *   • hygiène : hangup → pc.close() + tracks stop + listeners détachés +
 *     ringtone stoppé (test « zéro fuite » du harnais).
 *
 *  MUTE : track.enabled = false — le navigateur émet des frames de SILENCE
 *  (le canal RTP reste ouvert, la renégociation est inutile). Le harnais
 *  vérifie enabled === false sur la piste émettrice.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getSocket } from "./socket";
import { signPayload } from "./crypto";
import { callProofMessage, type CallSignalKind } from "./proof";

// ───────────────────────── états publics ─────────────────────────

export type CallState = "idle" | "dialing" | "ringing" | "connecting" | "active" | "ending";
export type CallDirection = "outgoing" | "incoming";
export type TurnMode = "relay" | "direct" | "unavailable";

export interface CallSnapshot {
  state: CallState;
  direction: CallDirection | null;
  peer: string | null;
  peerLabel: string | null;
  callId: string | null;
  muted: boolean;
  startedAt: number | null;
  turnMode: TurnMode;
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

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): CallSnapshot {
    return this.snapshot;
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

  private async getMic(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
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
    s.on("call-reject", (d: { from?: string; callId?: string }) => {
      if (d.callId !== this.callId) return;
      void this.teardown();
      this.set({ ...IDLE, fallbackNotice: this.turnTracker.notice });
    });
  }

  // ── actions publiques ──

  async startOutgoing(peer: string, peerLabel: string | null): Promise<void> {
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
      fallbackNotice: this.turnTracker.notice,
    });

    try {
      const [{ urls, mode }, stream] = await Promise.all([this.fetchTurn(), this.getMic()]);
      this.localStream = stream;
      this.set({ turnMode: mode });
      const pc = await this.makePc(mode, urls);
      this.pc = pc;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.remoteSet = false;
      await this.signal("call-offer", peer, { offer });

      // timeout de sonnerie — pas de réponse en 45 s → abandon propre
      this.dialTimer = setTimeout(() => void this.end("no-answer"), DIAL_TIMEOUT_MS);

      // knock push (fire-and-forget) : réveille le callee hors hub
      const kts = Date.now();
      void signPayload(
        this.identity.signPriv,
        `${this.identity.pubkey}|call-knock|${peer}|${this.callId}|${kts}`
      )
        .then((ksig) =>
          fetch("/api/call-knock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: this.identity?.pubkey,
              to: peer,
              callId: this.callId,
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
      const [{ urls, mode }, stream] = await Promise.all([this.fetchTurn(), this.getMic()]);
      this.localStream = stream;
      this.set({ turnMode: mode });
      const pc = await this.makePc(mode, urls);
      this.pc = pc;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      await pc.setRemoteDescription(incoming.offer);
      this.remoteSet = true;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signal("call-answer", incoming.from, { answer });
      for (const c of this.pendingIce.splice(0)) void pc.addIceCandidate(c).catch(() => undefined);
      this.pendingOffer = null;
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
    return this.snapshot.muted;
  }

  /** Hygiène : ferme TOUT (pc, tracks, audio, timers, ringtone). */
  private async teardown(): Promise<void> {
    if (this.dialTimer) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
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
