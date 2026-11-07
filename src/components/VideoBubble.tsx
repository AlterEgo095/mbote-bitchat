"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  VideoBubble — bulle vidéo B4 (spec MEDIA-ENVELOPE-SPEC §9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - vignette (image B2 déchiffrée) cliquable → Dialog plein écran avec
 *    contrôles natifs (directive : « thumbnail cliquable → plein écran ») ;
 *  - la vidéo elle-même est téléchargée + déchiffrée À LA DEMANDE (clic) —
 *    TRANCHÉ §9.4 : pas de lecture progressive d'un objet E2EE en V1 (le
 *    <video src=presignedUrl> de la directive donnerait le CIPHERTEXT au
 *    player) — téléchargement intégral → blob → player natif. 60 s @ 480p
 *    ≈ 5–15 Mo : charge quelques secondes, états visibles ;
 *  - SNIFF à la réception : magic bytes MP4 ftyp / webm V_* (un webm AUDIO
 *    ou un MP3 déguisé est REFUSÉ — miroir §6.7-iii) ;
 *  - preload="metadata" sur le player local (la directive ; sur un blob il
 *    ne coûte rien et affiche la durée immédiatement).
 */

import { useEffect, useState } from "react";
import { Film, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadImage, downloadVideoNote, sessionCekFor, MediaClientError } from "@/lib/mbote/media-client";
import { signPayload } from "@/lib/mbote/crypto";

/** Référence de la vignette dans le dm2 E2EE (image B2 complète). */
export interface VideoThumbRef {
  mediaId: string;
  cek: string;
  mediaType: string;
  bytes: number;
  objectKey: string;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1048576).toFixed(1)} Mo`;
}

export interface VideoBubbleProps {
  /** vidéo : { mediaId, cek, mediaType, bytes } */
  media: { mediaId: string; cek: string; mediaType: string; bytes: number };
  /** vignette image B2 (peut être absente — retombe sur le player direct) */
  thumb?: VideoThumbRef | null;
  durationMs?: number;
  mine: boolean;
  me: string;
  signPriv: CryptoKey;
}

export function VideoBubble({ media, thumb, durationMs, mine, me, signPriv }: VideoBubbleProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. vignette : download image B2 (lazy — même chemin que les bulles image)
  useEffect(() => {
    if (!thumb) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const session = sessionCekFor(thumb.mediaId);
        const img = await downloadImage({
          mediaId: thumb.mediaId,
          cekB64: thumb.cek || session?.cekB64 || "",
          declaredType: thumb.mediaType,
          me,
          sign: (p) => signPayload(signPriv, p),
        });
        if (!cancelled) {
          objectUrl = URL.createObjectURL(img.blob);
          setThumbUrl(objectUrl);
        }
      } catch {
        // pas de vignette — la bulle retombe sur le placeholder player
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [thumb, me, signPriv]);

  // 2. vidéo : téléchargée UNE SEULE fois (au clic) → blob local déchiffré
  async function openPlayer() {
    setOpen(true);
    if (videoUrl) return;
    setLoadingVideo(true);
    setError(null);
    try {
      const session = sessionCekFor(media.mediaId);
      const v = await downloadVideoNote({
        mediaId: media.mediaId,
        cekB64: media.cek || session?.cekB64 || "",
        declaredType: media.mediaType,
        me,
        sign: (p) => signPayload(signPriv, p),
      });
      setVideoUrl(URL.createObjectURL(v.blob));
    } catch (e) {
      setError(
        e instanceof MediaClientError && e.code === "download-failed" && e.message.includes("magic-bytes")
          ? "Vidéo refusée — le contenu ne correspond pas au type annoncé (protection MIME spoofing)."
          : e instanceof Error && e.message.includes("magic-bytes")
            ? "Vidéo refusée — le contenu ne correspond pas au type annoncé (protection MIME spoofing)."
            : "Vidéo indéchiffrable ou indisponible (CEK absent, objet altéré, réseau)."
      );
    } finally {
      setLoadingVideo(false);
    }
  }

  useEffect(() => {
    // révoque le blob vidéo à la fermeture définitive du composant
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const secs = durationMs ? Math.round(durationMs / 1000) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => void openPlayer()}
        className="relative block overflow-hidden rounded-lg"
        aria-label={`Vidéo reçue${secs ? ` — ${secs} s` : ""} — ${humanBytes(media.bytes)} (${media.mediaType}). Lire`}
      >
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob local déchiffré client, pas d'optimisation possible
          <img
            src={thumbUrl}
            alt={`Vignette vidéo (${humanBytes(media.bytes)})`}
            className="max-h-44 w-auto max-w-[280px] rounded-lg object-cover"
            loading="lazy"
          />
        ) : (
          <span
            className={`flex h-32 w-44 items-center justify-center rounded-lg ${mine ? "bg-primary-foreground/15" : "bg-background/60"}`}
          >
            <Film className="size-6 opacity-60" aria-hidden="true" />
          </span>
        )}
        {/* badge lecture + durée — pattern WhatsApp */}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white">
            {loadingVideo ? (
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </span>
        </span>
        {secs !== null && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums">
            {secs} s
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Film className="size-4 text-primary" aria-hidden="true" />
              Vidéo chiffrée · {humanBytes(media.bytes)} · {media.mediaType}
              {secs !== null ? ` · ${secs} s` : ""}
            </DialogTitle>
            <DialogDescription>
              Déchiffrée localement (AES-256-GCM) — magic bytes vidéo vérifiés avant rendu.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : videoUrl ? (
            <video
              src={videoUrl}
              controls
              preload="metadata"
              className="max-h-[70vh] w-full rounded-lg bg-black"
              aria-label="Lecteur vidéo — contrôles natifs"
            />
          ) : (
            <div className="flex h-56 items-center justify-center gap-2 rounded-lg bg-muted text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Téléchargement + déchiffrement ({humanBytes(media.bytes)})…
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
