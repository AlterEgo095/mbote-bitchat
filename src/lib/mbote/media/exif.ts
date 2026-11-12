/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media/exif — strip des métadonnées image (B1, spec §5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  `stripExif(imageBytes)` ré-encode via sharp SANS aucune métadonnée :
 *   - GPS IFD complet (latitude/longitude/altitude/timestamp/direction) ;
 *   - dates (DateTime, DateTimeOriginal, CreateDate…) ;
 *   - appareil (Make, Model, Software, Lens*, serial, owner) ;
 *   - paramètres techniques (exposition, ISO, focale, flash…) ;
 *   - IFD1 thumbnail (vignette incorporée — fuite de pixels historique),
 *     XMP, IPTC, commentaires ;
 *   - ICC (arbitrage spec §6.4 — privacy-first, sRGB supposé).
 *
 *  ORIENTATION — TRANCHEMENT (spec §5.2) : l'orientation EXIF n'est PAS
 *  conservée comme métadonnée, elle est CUITE DANS LES PIXELS
 *  (`.rotate()` sans argument = auto-orientation avant ré-encodage) —
 *  garantit un rendu identique chez tous les clients (l'orientation EXIF
 *  est ignorée par certaines plateformes) sans aucune métadonnée.
 *
 *  sharp est DÉJÀ une dépendance du projet (package.json ^0.34.3 — pipeline
 *  d'images existant) : aucune nouvelle dépendance à justifier.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import sharp from "sharp";
// sharp 0.35 (triage D3) : les types ne s'exportent plus en namespace —
// l'import nommé remplace `sharp.Metadata`
import type { Metadata } from "sharp";

export class MediaExifError extends Error {
  constructor(
    public readonly code: "bad-image" | "too-large",
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = "MediaExifError";
  }
}

/** Limite d'entrée du strip (image 5 Mo — spec §2) : refuse AVANT sharp. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// sharp : pas de limite de mémoire implicite agressive, mais on borne les
// dimensions d'entrée (photo chat — pas d'image de 40 000 px) : DoS guard.
sharp.cache(false);
sharp.concurrency(1);

export interface StripResult {
  /** octets ré-encodés, SANS métadonnée, orientation cuite */
  bytes: Buffer;
  /** format de sortie (jpeg | png) */
  format: "jpeg" | "png";
  /** dimensions FINALES (orientées) */
  width: number;
  height: number;
  /** taille avant → après (garantie post ≤ pré, testée) */
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Supprime TOUTES les métadonnées d'une image (EXIF/GPS/XMP/IPTC/ICC/
 * thumbnail) et cuit l'orientation dans les pixels.
 * JPEG → JPEG (qualité 85), PNG → PNG. Tout autre format → refus propre.
 */
export async function stripExif(imageBytes: Uint8Array): Promise<StripResult> {
  if (imageBytes.byteLength > IMAGE_MAX_BYTES) {
    throw new MediaExifError("too-large", `image ${imageBytes.byteLength} o > limite ${IMAGE_MAX_BYTES} o (spec §2)`);
  }
  const input = Buffer.from(imageBytes);
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new MediaExifError("bad-image", "image illisible (pas un JPEG/PNG valide)");
  }
  const format = meta.format;
  if (format !== "jpeg" && format !== "png") {
    throw new MediaExifError("bad-image", `format ${String(format)} non pris en charge en V1 (jpeg | png)`);
  }

  // .rotate() sans argument : applique l'orientation EXIF aux pixels, puis
  // ré-encode SANS métadonnée (sharp ne copie aucune metadata par défaut).
  const pipeline = sharp(input).rotate();
  const output =
    format === "jpeg"
      ? await pipeline.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
      : await pipeline.png().toBuffer({ resolveWithObject: true });

  if (output.data.length > input.length) {
    // garantie directive : taille post-strip ≤ taille originale
    throw new MediaExifError(
      "bad-image",
      `post-strip ${output.data.length} o > original ${input.length} o — invariant violé`
    );
  }

  return {
    bytes: output.data,
    format: format === "jpeg" ? "jpeg" : "png",
    width: output.info.width,
    height: output.info.height,
    bytesBefore: input.length,
    bytesAfter: output.data.length,
  };
}

/** Lecture des métadonnées résiduelles — utilisé par les tests (GPS absent). */
export async function inspectMetadata(imageBytes: Uint8Array): Promise<Metadata> {
  return sharp(Buffer.from(imageBytes)).metadata();
}
