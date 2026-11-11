"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C2 — CallView : overlay d'appel audio (dialing/ringing/active) + fallback
 * ─────────────────────────────────────────────────────────────────────────────
 *  Monté au niveau MboteApp (l'appel survit aux changements de vue). Tous les
 *  états viennent du callManager (useSyncExternalStore). Timer, mute, hangup,
 *  ringtone (géré par le manager), indication TURN (relay/direct/indispo) et
 *  notice de fallback notes vocales.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Mic, MicOff, PhoneCall, PhoneOff, Radio, Volume2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callManager, type CallSnapshot } from "@/lib/mbote/webrtc";

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

export function CallView() {
  const call = useCall();
  const elapsed = useElapsed(call.startedAt, call.state === "active");

  const onAccept = useCallback(() => void callManager.acceptIncoming(), []);
  const onReject = useCallback(() => void callManager.rejectIncoming(), []);
  const onHangup = useCallback(() => void callManager.end("user"), []);
  const onMute = useCallback(() => callManager.toggleMute(), []);

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

  return (
    <div
      role="dialog"
      aria-label={`Appel audio avec ${label}`}
      className="fixed inset-x-3 top-16 z-50 mx-auto max-w-md rounded-2xl border bg-background/95 p-4 shadow-2xl backdrop-blur md:top-20"
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex size-11 shrink-0 items-center justify-center rounded-full ${
            isRingingIncoming ? "animate-pulse bg-primary/15" : "bg-primary/10"
          }`}
        >
          <PhoneCall className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{label}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {call.state === "dialing" && "Sonnerie…"}
            {isRingingIncoming && "Appel entrant"}
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
      </div>

      {/* état TURN — transparence réseau (directive : TURN 不可用提示) */}
      <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
        {TURN_LABEL[call.turnMode]}
      </p>
      {call.error && (
        <p role="alert" className="mt-1 text-[11px] text-destructive">
          {call.error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-center gap-3">
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
              aria-label="Répondre à l'appel"
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
              className="h-12 rounded-full px-6"
              onClick={onMute}
              aria-label={call.muted ? "Réactiver le micro" : "Couper le micro"}
              aria-pressed={call.muted}
            >
              {call.muted ? (
                <MicOff className="size-5" aria-hidden="true" />
              ) : (
                <Mic className="size-5" aria-hidden="true" />
              )}
              {call.muted ? "Muet" : "Micro"}
            </Button>
            <Button
              size="lg"
              variant="destructive"
              className="h-12 rounded-full px-6"
              onClick={onHangup}
              aria-label="Terminer l'appel"
            >
              <PhoneOff className="size-5" aria-hidden="true" />
              Raccrocher
            </Button>
          </>
        )}
      </div>
      <p className="mt-2 text-center text-[9px] text-muted-foreground">
        Audio chiffré DTLS-SRTP de bout en bout — le serveur ne transporte que
        la signalisation.
      </p>
    </div>
  );
}

/** Petit bouton téléphone pour l'en-tête de conversation DM. */
export function CallButton({ peer, peerLabel, disabled }: { peer: string; peerLabel: string | null; disabled?: boolean }) {
  const call = useCall();
  const busy = call.state !== "idle";
  const onStart = useCallback(() => {
    callManager.setLabel(peer, peerLabel ?? "Contact");
    void callManager.startOutgoing(peer, peerLabel);
  }, [peer, peerLabel]);
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      disabled={disabled || busy}
      onClick={onStart}
      aria-label={`Appeler ${peerLabel ?? "ce contact"} en audio`}
    >
      <PhoneCall className="size-4" aria-hidden="true" />
    </Button>
  );
}
