"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  VoiceNote — lecteur de note vocale Opus (B3, spec MEDIA-ENVELOPE-SPEC §8.2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - waveform 100 peaks (reçus du dm2 E2EE, sinon mesurés au téléchargement) ;
 *  - play/pause, seek PAR CLIC sur la waveform, progression visuelle ;
 *  - vitesse 1x / 1.5x / 2x (cycle au clic) ;
 *  - bouton téléchargement optionnel (Blob local déchiffré).
 *
 *  Le blob vient du décryptage client (E2EE) — jamais d'URL serveur. Le
 *  <audio> est re-créé au changement de blob (object URL révoquée au cleanup).
 *  Aucune donnée du message n'est affichée hors ce que l'expéditeur a déjà
 *  chiffré (pas d'extraction de métadonnées : Opus n'en a pas — arbitrage §8.3).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play } from "lucide-react";

const SPEEDS = [1, 1.5, 2] as const;

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface VoiceNoteProps {
  /** blob déchiffré (audio/webm | audio/ogg — opus) ; null = chargement */
  blob: Blob | null;
  error?: string | null;
  /** durée du dm2 (ms) — affichée avant même le décodage */
  durationMs: number;
  /** waveform du dm2 (100 peaks [0..1]) — sinon bars neutres */
  peaks?: number[] | null;
  mine: boolean;
  /** octets du plaintext (affichage) */
  bytes?: number;
  /** bouton téléchargement (défaut : false — MVP discret) */
  downloadable?: boolean;
}

export function VoiceNote({
  blob,
  error,
  durationMs,
  peaks,
  mine,
  bytes,
  downloadable = false,
}: VoiceNoteProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [nativeDurationMs, setNativeDurationMs] = useState<number | null>(null);

  // object URL : dérivée du blob (useMemo) — la révocation vit dans le cleanup
  // d'effet (aucun setState synchrone dans un effet : react-hooks strict).
  // StrictMode (dev) peut créer une URL fantôme par double-rendu : fuite
  // Bornée et sans effet sur le comportement.
  const objectUrl = useMemo(
    () => (blob ? URL.createObjectURL(blob) : null),
    [blob]
  );
  useEffect(() => {
    if (!objectUrl) return;
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  // NB : pas de « reset » d'état au changement de blob — chaque instance
  // VoiceNote est liée à UN média : le Dialog Radix démonte son contenu à la
  // fermeture (état frais à chaque preview) et les bulles reçues ont un
  // mediaId immuable (key React du message). Un setState en effet est
  // interdit (react-hooks/set-state-in-effect) et inutile ici.

  const totalMs = nativeDurationMs ?? durationMs;
  const progress = totalMs > 0 ? Math.min(1, positionMs / totalMs) : 0;

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !objectUrl) return;
    if (playing) {
      a.pause();
    } else {
      void a.play().catch(() => setPlaying(false));
    }
  }, [playing, objectUrl]);

  /** Seek par clic sur la waveform : ratio × durée (une seule surface). */
  const seekFromEvent = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const a = audioRef.current;
      if (!a || !objectUrl || totalMs <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      a.currentTime = (ratio * totalMs) / 1000;
      setPositionMs(ratio * totalMs);
    },
    [objectUrl, totalMs]
  );

  function cycleSpeed() {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  }

  function download() {
    if (!blob || !objectUrl) return;
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `note-vocale-${new Date().toISOString().slice(0, 16)}.webm`;
    a.click();
  }

  // waveform : peaks du dm2, sinon barres neutres (en attente de mesure)
  const wave = peaks && peaks.length > 0 ? peaks : null;

  return (
    <div
      className={`flex min-w-[220px] max-w-[280px] items-center gap-2 rounded-lg px-2.5 py-2 ${
        mine ? "bg-primary-foreground/10" : "bg-background/70"
      }`}
      data-testid="voice-note"
    >
      <button
        type="button"
        onClick={togglePlay}
        disabled={!objectUrl}
        aria-label={playing ? "Pause" : "Lecture"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
      >
        {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
      </button>

      <div className="min-w-0 flex-1">
        {/* waveform cliquable = seek (directive §8.2) */}
        <div
          className="flex h-8 cursor-pointer items-center gap-[1.5px]"
          onClick={seekFromEvent}
          role="slider"
          aria-label="Barre de progression (cliquer pour naviguer)"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
          onKeyDown={(e) => {
            const a = audioRef.current;
            if (!a || !objectUrl || totalMs <= 0) return;
            if (e.key === "ArrowRight") a.currentTime = Math.min(totalMs / 1000, a.currentTime + 2);
            if (e.key === "ArrowLeft") a.currentTime = Math.max(0, a.currentTime - 2);
          }}
          data-testid="voice-waveform"
        >
          {(wave ?? Array.from({ length: 100 }, () => 0.12)).map((p, i) => {
            const done = i / 100 <= progress;
            return (
              <span
                key={i}
                className={`w-full min-w-[1px] rounded-full transition-colors ${
                  done
                    ? mine
                      ? "bg-primary-foreground"
                      : "bg-primary"
                    : mine
                      ? "bg-primary-foreground/30"
                      : "bg-muted-foreground/30"
                }`}
                style={{ height: `${Math.max(12, Math.round(p * 100))}%` }}
                aria-hidden="true"
              />
            );
          })}
        </div>
        <div className={`mt-0.5 flex items-center gap-2 text-[10px] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
          <span className="tabular-nums">
            {fmtTime(positionMs)} / {fmtTime(totalMs)}
          </span>
          <button
            type="button"
            onClick={cycleSpeed}
            className="rounded border border-current px-1 font-semibold"
            aria-label={`Vitesse de lecture ${SPEEDS[speedIdx]}x — changer`}
          >
            {SPEEDS[speedIdx]}x
          </button>
          {typeof bytes === "number" && <span className="tabular-nums">{Math.max(1, Math.round(bytes / 1024))} Ko</span>}
          {downloadable && (
            <button
              type="button"
              onClick={download}
              disabled={!objectUrl}
              aria-label="Télécharger la note vocale"
              className="ml-auto disabled:opacity-40"
            >
              <Download className="size-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {error ? (
        <span className="text-[10px] text-red-400" role="alert">
          {error}
        </span>
      ) : null}

      {/* durée native : corrigée une fois les métadonnées chargées */}
      {objectUrl && (
        <audio
          ref={audioRef}
          src={objectUrl}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setNativeDurationMs(Math.round(d * 1000));
          }}
          onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPositionMs(0);
          }}
          className="hidden"
        />
      )}
    </div>
  );
}
