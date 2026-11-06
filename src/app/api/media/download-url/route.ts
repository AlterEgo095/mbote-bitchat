/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/media/download-url — B2 (spec MEDIA-ENVELOPE-SPEC §7.1, §6.8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Entrée (query) : me, mediaId, ts, signature
 *            signature ECDSA sur `${me}|media-dl|${mediaId}|${ts}` (15 min).
 *  Sortie : { mediaId, objectKey, downloadUrl, expiresAt, mediaType, sizeBytes,
 *             plainBytes }
 *
 *  ACL : toute identité AUTHENTIFIÉE peut obtenir la presignature GET d'un
 *  média FINALISÉ (arbitrage §6.8) — le contenu est indéchiffrable sans le
 *  CEK, qui voyage uniquement dans le dm2 E2EE. Refus anonyme (anti-énumération
 *  du cuid). La confidentialité réelle reste de bout en bout.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  mediaDownloadProofMessage,
  verifySignedMessage,
  isValidPubkeyFormat,
  READ_MAX_AGE_MS,
  READ_FUTURE_TOLERANCE_MS,
} from "@/lib/mbote/proof";
import { proxyPresignedPath, publicStorageConfig, publicStorageOrigin, requireStorageConfig } from "@/lib/mbote/media-server";
import { generatePresignedUrl, PRESIGN_TTL_DEFAULT_S } from "@/lib/mbote/media/storage";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 0. stockage configuré ?
  let cfg;
  try {
    cfg = requireStorageConfig();
  } catch {
    return NextResponse.json(
      { error: "Stockage média non configuré (MEDIA_S3_* absent) — lecture indisponible" },
      { status: 503 }
    );
  }

  const sp = req.nextUrl.searchParams;
  const me = sp.get("me") ?? "";
  const mediaId = sp.get("mediaId") ?? "";
  const ts = Number(sp.get("ts"));

  // 1. preuve de possession (anti-énumération : aucun accès anonyme)
  const check = await verifySignedMessage({
    message: mediaDownloadProofMessage(me, mediaId, ts),
    pubkey: me,
    ts,
    signature: sp.get("signature"),
    maxAgeMs: READ_MAX_AGE_MS,
    futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
  });
  if (!check.valid || !isValidPubkeyFormat(me)) {
    return NextResponse.json(
      { error: `Preuve de lecture requise : ${check.reason ?? "clé invalide"}` },
      { status: 401 }
    );
  }

  // 2. média finalisé seulement
  const media = await db.media.findUnique({ where: { id: mediaId } });
  if (!media) {
    return NextResponse.json({ error: "Média inconnu" }, { status: 404 });
  }
  if (media.status !== "finalized") {
    return NextResponse.json({ error: "Média non finalisé (upload incomplet)" }, { status: 409 });
  }

  // 3. presigned GET (15 min) — origine publique (même origine via proxy)
  const download = generatePresignedUrl(
    publicStorageConfig(cfg, publicStorageOrigin(req)),
    media.objectKey,
    { method: "GET", ttlSec: PRESIGN_TTL_DEFAULT_S }
  );

  return NextResponse.json({
    mediaId: media.id,
    objectKey: media.objectKey,
    downloadUrl: proxyPresignedPath(download.url),
    expiresAt: download.expiresAt.toISOString(),
    mediaType: media.mediaType,
    sizeBytes: media.sizeBytes,
    plainBytes: media.plainBytes,
  });
}
