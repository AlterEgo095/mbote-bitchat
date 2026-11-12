"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C2 — CallView : overlay d'appel audio (dialing/ringing/active) + fallback
 *  C3 — extension vidéo : remote en grand + preview local PiP (coin
 *  haut-droit), boutons caméra/flip/plein écran, indicateurs « caméra coupée »
 *  (annonce call:media distante) et « connexion instable » (getStats packet
 *  loss > 5 %), étage de qualité affiché.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Monté au niveau MboteApp (l'appel survit aux changements de vue). Tous les
 *  états viennent du callManager (useSyncExternalStore). Timer, mute, hangup,
 *  ringtone (géré par le manager), indication TURN (relay/direct/indispo) et
 *  notice de fallback notes vocales. Les flux locaux/distant vivent dans le
 *  callManager — attachés aux <video> par refs (srcObject), pas d'état copie.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  Volume2,
  Video,
  VideoOff,
  Camera,
  Maximize2,
  Minimize2,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callManager, type CallSnapshot, type CallType } from "@/lib/mbote/webrtc";

function useCall(): CallSnapshot {
  return useSyncExternalStore(
    (cb) => callManager.subscribe(cb),
    () => callManager.getSnapshot(),
    () => callManager.getSnapshot()
  );
}

function useElapsed(startedAt: number | null, active: boolean): string {
  // la durée est un ÉTAT mis à jour par le timer (Date.now() dans un
  // interval — jamais pendant le rendu, règles impure-function et
  // set-state-in-effect : la première valeur vient du 1er tick à ~0 ms)
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) return;
    const update = () => setSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const t0 = setTimeout(update, 0); // premier tick asynchrone (pas de setState synchrone)
    const t = setInterval(update, 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [active, startedAt]);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

const TURN_LABEL: Record<CallSnapshot["turnMode"], string> = {
  relay: "Relais TURN actif (CGNAT)",
  direct: "Connexion directe",
  unavailable: "TURN indisponible — connexion directe uniquement",
};

const QUALITY_LABEL: Record<CallSnapshot["videoQuality"], string> = {
  high: "480p",
  medium: "360p",
  low: "240p",
};

/** Attachement srcObject par ref (jamais de re-création de flux au render) —
 *  ré-attachement à chaque CHANGEMENT d'id de flux (flip caméra → nouveau flux). */
function useVideoSink(streamId: string | null, isVideo: boolean): React.RefObject<HTMLVideoElement | null> {
  const ref = useRef<HTMLVideoElement | null>(null);
  const attachedId = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isVideo && streamId && attachedId.current !== streamId) {
      const stream = callManagerStream(streamId);
      if (stream) {
        el.srcObject = stream;
        void el.play().catch(() => undefined);
        attachedId.current = streamId;
      }
    } else if (!isVideo || !streamId) {
      if (el.srcObject !== null) el.srcObject = null;
      attachedId.current = null;
    }
  }, [streamId, isVideo]);
  return ref;
}

/** Résout le flux par id (local ou distant) — single source : callManager. */
function callManagerStream(streamId: string): MediaStream | null {
  const local = callManager.getLocalStream();
  if (local && local.id === streamId) return local;
  const remote = callManager.getRemoteVideoStream();
  if (remote && remote.id === streamId) return remote;
  return null;
}

export function CallView() {
  const call = useCall();
  const elapsed = useElapsed(call.startedAt, call.state === "active");
  const [expanded, setExpanded] = useState(false);

  const onAccept = useCallback(() => void callManager.acceptIncoming(), []);
  const onReject = useCallback(() => void callManager.rejectIncoming(), []);
  const onHangup = useCallback(() => void callManager.end("user"), []);
  const onMute = useCallback(() => callManager.toggleMute(), []);
  const onCamera = useCallback(() => callManager.toggleCamera(), []);
  const onFlip = useCallback(() => void callManager.flipCamera(), []);

  const isVideo = call.callType === "video";
  const remoteSink = useVideoSink(call.remoteStreamId, isVideo);
  const localSink = useVideoSink(call.localStreamId, isVideo);

  // plein écran réservé à l'appel vidéo ACTIF — reset à chaque fin d'appel
  // (tick asynchrone — règle set-state-in-effect, même pattern que useElapsed)
  useEffect(() => {
    if (call.state === "idle" && expanded) {
      const t = setTimeout(() => setExpanded(false), 0);
      return () => clearTimeout(t);
    }
  }, [call.state, expanded]);

  if (call.state === "idle") {
    return call.fallbackNotice ? (
      <div
        role="status"
        className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 shadow-lg backdrop-blur dark:text-amber-400"
      >
        {call.fallbackNotice}
      </div>
    ) : null;
  }

  const isRingingIncoming = call.state === "ringing" && call.direction === "incoming";
  const label = call.peerLabel ?? "Contact";
  const dialogLabel = isVideo ? `Appel vidéo avec ${label}` : `Appel audio avec ${label}`;

  return (
    <div
      role="dialog"
      aria-label={dialogLabel}
      data-testid="call-overlay"
      className={`fixed z-50 mx-auto rounded-2xl border bg-background/95 shadow-2xl backdrop-blur ${
        expanded && isVideo
          ? "inset-0 flex flex-col rounded-none"
          : "inset-x-3 top-16 max-w-md p-4 md:top-20"
      }`}
    >
      <div className={`flex items-center gap-3 ${expanded && isVideo ? "p-4" : ""}`}>
        <div
          className={`flex size-11 shrink-0 items-center justify-center rounded-full ${
            isRingingIncoming ? "animate-pulse bg-primary/15" : "bg-primary/10"
          }`}
        >
          {isVideo ? (
            <Video className="size-5 text-primary" aria-hidden="true" />
          ) : (
            <PhoneCall className="size-5 text-primary" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{label}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {call.state === "dialing" && (isVideo ? "Sonnerie (vidéo)…" : "Sonnerie…")}
            {isRingingIncoming && (isVideo ? "Appel vidéo entrant" : "Appel entrant")}
            {call.state === "connecting" && "Connexion…"}
            {call.state === "active" && (
              <>
                <Volume2 className="size-3" aria-hidden="true" />
                {/* harnais C2 : le timer n'existe que dans l'état actif */}
                <span className="font-mono tabular-nums" data-testid="call-timer">
                  {elapsed}
                </span>
              </>
            )}
            {call.state === "ending" && "Fin…"}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 gap-1 px-2 py-0 text-[9px]">
          <Radio className="size-2.5" aria-hidden="true" />
          E2EE
        </Badge>
        {isVideo && call.state === "active" && (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Réduire l'appel" : "Agrandir l'appel en plein écran"}
            aria-pressed={expanded}
            data-testid="call-expand"
          >
            {expanded ? (
              <Minimize2 className="size-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-4" aria-hidden="true" />
            )}
          </Button>
        )}
      </div>

      {/* ── C3 : zone vidéo (remote en grand + preview local PiP) ── */}
      {isVideo && (
        <div
          className={`relative overflow-hidden rounded-xl border bg-black ${
            expanded && isVideo ? "mx-4 mb-2 min-h-0 flex-1" : "mt-3 aspect-video"
          }`}
          data-testid="video-stage"
        >
          <video
            ref={remoteSink}
            className="size-full object-cover"
            playsInline
            autoPlay
            data-testid="remote-video"
            aria-label={`Vidéo de ${label}`}
          />
          {/* écran noir + indicateur quand la caméra DISTANTE est coupée */}
          {call.remoteCameraOn === false && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/90"
              data-testid="remote-camera-off"
              role="status"
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <VideoOff className="size-4" aria-hidden="true" />
                Caméra coupée
              </span>
            </div>
          )}
          {/* preview local PiP — coin haut-droit, miroir selfie */}
          <video
            ref={localSink}
            className="absolute right-2 top-2 size-24 rounded-lg border border-white/20 object-cover shadow-lg sm:size-28"
            style={{ transform: "scaleX(-1)" }}
            playsInline
            autoPlay
            muted
            data-testid="local-video"
            aria-label="Votre caméra"
          />
          {call.cameraOn === false && (
            <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">
              Votre caméra est coupée
            </span>
          )}
          {/* indicateurs réseau/qualité */}
          {call.unstable && (
            <span
              className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-medium text-black"
              role="status"
              data-testid="call-unstable"
            >
              <WifiOff className="size-3" aria-hidden="true" />
              Connexion instable
            </span>
          )}
          <span
            className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 font-mono text-[10px] text-white"
            data-testid="call-quality"
          >
            {QUALITY_LABEL[call.videoQuality]}
          </span>
        </div>
      )}

      {/* état TURN — transparence réseau (directive : TURN 不可用提示) */}
      <p className={`flex items-center gap-1 text-[10px] text-muted-foreground ${isVideo && expanded ? "px-4" : "mt-2"}`}>
        {TURN_LABEL[call.turnMode]}
      </p>
      {call.error && (
        <p role="alert" className={`text-[11px] text-destructive ${isVideo && expanded ? "px-4" : "mt-1"}`}>
          {call.error}
        </p>
      )}

      <div className={`flex items-center justify-center gap-3 ${isVideo && expanded ? "p-4 pb-6" : "mt-3"}`}>
        {isRingingIncoming ? (
          <>
            <Button
              size="lg"
              variant="destructive"
              className="h-12 rounded-full px-6"
              onClick={onReject}
              aria-label="Rejeter l'appel"
            >
              <PhoneOff className="size-5" aria-hidden="true" />
              Rejeter
            </Button>
            <Button
              size="lg"
              className="h-12 rounded-full px-6"
              onClick={onAccept}
              aria-label={isVideo ? "Répondre à l'appel vidéo" : "Répondre à l'appel"}
            >
              <PhoneCall className="size-5" aria-hidden="true" />
              Répondre
            </Button>
          </>
        ) : (
          <>
            <Button
              size="lg"
              variant={call.muted ? "destructive" : "outline"}
              className="h-12 rounded-full px-5"
              onClick={onMute}
              aria-label={call.muted ? "Réactiver le micro" : "Couper le micro"}
              aria-pressed={call.muted}
              data-testid="call-mute"
            >
              {call.muted ? (
                <MicOff className="size-5" aria-hidden="true" />
              ) : (
                <Mic className="size-5" aria-hidden="true" />
              )}
              {call.muted ? "Muet" : "Micro"}
            </Button>
            {isVideo && (
              <Button
                size="lg"
                variant={call.cameraOn ? "outline" : "destructive"}
                className="h-12 rounded-full px-5"
                onClick={onCamera}
                aria-label={call.cameraOn ? "Couper la caméra" : "Réactiver la caméra"}
                aria-pressed={!call.cameraOn}
                data-testid="call-camera"
              >
                {call.cameraOn ? (
                  <Video className="size-5" aria-hidden="true" />
                ) : (
                  <VideoOff className="size-5" aria-hidden="true" />
                )}
                {call.cameraOn ? "Caméra" : "Coupée"}
              </Button>
            )}
            {isVideo && call.cameraOn && (
              <Button
                size="icon"
                variant="outline"
                className="size-12 rounded-full"
                onClick={onFlip}
                aria-label="Pivoter la caméra (avant/arrière)"
                data-testid="call-flip"
              >
                <Camera className="size-5" aria-hidden="true" />
              </Button>
            )}
            <Button
              size="lg"
              variant="destructive"
              className="h-12 rounded-full px-6"
              onClick={onHangup}
              aria-label="Terminer l'appel"
              data-testid="call-hangup"
            >
              <PhoneOff className="size-5" aria-hidden="true" />
              Raccrocher
            </Button>
          </>
        )}
      </div>
      {(!isVideo || !expanded) && (
        <p className="mt-2 text-center text-[9px] text-muted-foreground">
          {isVideo
            ? "Vidéo chiffrée DTLS-SRTP de bout en bout — le serveur ne transporte que la signalisation."
            : "Audio chiffré DTLS-SRTP de bout en bout — le serveur ne transporte que la signalisation."}
        </p>
      )}
    </div>
  );
}

/** Petit bouton téléphone pour l'en-tête de conversation DM. */
export function CallButton({
  peer,
  peerLabel,
  disabled,
  mode = "audio",
}: {
  peer: string;
  peerLabel: string | null;
  disabled?: boolean;
  mode?: CallType;
}) {
  const call = useCall();
  const busy = call.state !== "idle";
  const onStart = useCallback(() => {
    callManager.setLabel(peer, peerLabel ?? "Contact");
    void callManager.startOutgoing(peer, peerLabel, mode);
  }, [peer, peerLabel, mode]);
  const isVideo = mode === "video";
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      disabled={disabled || busy}
      onClick={onStart}
      aria-label={
        isVideo
          ? `Appeler ${peerLabel ?? "ce contact"} en vidéo`
          : `Appeler ${peerLabel ?? "ce contact"} en audio`
      }
      data-testid={isVideo ? "call-button-video" : "call-button-audio"}
    >
      {isVideo ? (
        <Video className="size-4" aria-hidden="true" />
      ) : (
        <PhoneCall className="size-4" aria-hidden="true" />
      )}
    </Button>
  );
}
