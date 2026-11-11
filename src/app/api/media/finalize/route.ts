/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/media/finalize — B2 (spec MEDIA-ENVELOPE-SPEC §7.1, arbitrage §6.7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Entrée  : { me, mediaId, plainBytes, ts, signature }
 *            signature ECDSA sur `${me}|media-finalize|${mediaId}|${ts}`.
 *  Sortie  : { mediaId, objectKey, downloadUrl, expiresAt, mediaType, sizeBytes }
 *
 *  Vérifications (serveur AVEUGLE — il ne voit que le ciphertext) :
 *    503 stockage non configuré → 400 corps → 401 preuve → 404 média absent /
 *    403 non-propriétaire → 409 déjà finalisé → 410 fenêtre de finalisation
 *    dépassée → 400 objet ABSENT du bucket → 422 taille ≠ Content-Length
 *    signé → 422 enveloppe malformée (inspectEnvelope) → 200 finalized.
 *
 *  L'objet est lu via une presigned GET générée PAR le serveur pour lui-même
 *  (credentials S3 jamais exposés). Une enveloppe de garbage passe — assumé
 *  (E2EE) : elle ne pourra jamais être RENDUE (magic bytes à la lecture,
 *  arbitrage §6.7-iii) et occupe le quota de son auteur.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  mediaFinalizeProofMessage,
  verifySignedMessage,
  READ_MAX_AGE_MS,
  READ_FUTURE_TOLERANCE_MS,
} from "@/lib/mbote/proof";
import { B2_FINALIZE_WINDOW_MS, proxyPresignedPath, publicStorageConfig, publicStorageOrigin, requireStorageConfig } from "@/lib/mbote/media-server";
import { generatePresignedUrl, PRESIGN_TTL_DEFAULT_S } from "@/lib/mbote/media/storage";
import { inspectEnvelope } from "@/lib/mbote/media/crypto";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 0. stockage configuré ?
  let cfg;
  try {
    cfg = requireStorageConfig();
  } catch {
    return NextResponse.json(
      { error: "Stockage média non configuré (MEDIA_S3_* absent) — finalize indisponible" },
      { status: 503 }
    );
  }

  // 1. corps
  let body: { me?: unknown; mediaId?: unknown; plainBytes?: unknown; ts?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps illisible (JSON attendu)" }, { status: 400 });
  }
  const me = typeof body.me === "string" ? body.me : "";
  const mediaId = typeof body.mediaId === "string" ? body.mediaId : "";
  const plainBytes = typeof body.plainBytes === "number" && Number.isInteger(body.plainBytes) && body.plainBytes > 0
    ? body.plainBytes
    : null;

  // 2. preuve de possession
  const check = await verifySignedMessage({
    message: mediaFinalizeProofMessage(me, mediaId, body.ts as number),
    pubkey: me,
    ts: body.ts,
    signature: body.signature,
    maxAgeMs: READ_MAX_AGE_MS,
    futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
  });
  if (!check.valid) {
    return NextResponse.json(
      { error: `Preuve de finalisation requise : ${check.reason ?? "invalide"}` },
      { status: 401 }
    );
  }

  // 3. média : existe, à moi, pending, dans la fenêtre
  const media = await db.media.findUnique({ where: { id: mediaId } });
  if (!media) {
    return NextResponse.json({ error: "Média inconnu" }, { status: 404 });
  }
  if (media.ownerPubkey !== me) {
    return NextResponse.json({ error: "Ce média n'est pas le vôtre" }, { status: 403 });
  }
  if (media.status === "finalized") {
    return NextResponse.json({ error: "Média déjà finalisé (idempotent)" }, { status: 409 });
  }
  if (Date.now() - media.createdAt.getTime() > B2_FINALIZE_WINDOW_MS) {
    // fenêtre dépassée : la presigned PUT est expirée depuis longtemps —
    // ligne orpheline (jamais comptée au quota), upload à recommencer.
    return NextResponse.json(
      { error: "Fenêtre de finalisation dépassée (> 20 min) — recommencez l'upload" },
      { status: 410 }
    );
  }

  // 4. l'objet est-il vraiment dans le bucket ? (presigned GET serveur → serveur)
  const getUrl = generatePresignedUrl(cfg, media.objectKey, {
    method: "GET",
    ttlSec: 60,
  });
  let fetched: Response;
  try {
    fetched = await fetch(getUrl.url, { method: "GET" });
  } catch {
    return NextResponse.json(
      { error: "Bucket injoignable — réessayez" },
      { status: 502 }
    );
  }
  if (!fetched.ok) {
    return NextResponse.json(
      { error: `Objet absent du bucket (S3 ${fetched.status}) — le PUT n'a pas abouti` },
      { status: 400 }
    );
  }

  // 5. taille réelle = Content-Length signé (anti- divergence)
  const ciphertext = await fetched.text();
  if (ciphertext.length !== media.sizeBytes) {
    return NextResponse.json(
      {
        error: `Taille de l'objet (${ciphertext.length} o) ≠ taille liée par la signature (${media.sizeBytes} o)`,
      },
      { status: 422 }
    );
  }

  // 6. enveloppe structurellement valide (v1, IV 12 o, tag 16 o, ct non vide)
  try {
    inspectEnvelope(ciphertext);
  } catch {
    return NextResponse.json(
      { error: "Objet non conforme — enveloppe v1 attendue (v1:iv:ciphertext:tag)" },
      { status: 422 }
    );
  }

  // 7. finalized (+ plainBytes déclaré par le client pour le destinataire)
  const updated = await db.media.update({
    where: { id: media.id },
    data: { status: "finalized", finalizedAt: new Date(), plainBytes: plainBytes ?? media.sizeBytes },
  });

  // presigned GET pour le NAVIGATEUR (origine publique — même origine via proxy)
  const download = generatePresignedUrl(
    publicStorageConfig(cfg, publicStorageOrigin(req)),
    media.objectKey,
    { method: "GET", ttlSec: PRESIGN_TTL_DEFAULT_S }
  );

  return NextResponse.json(
    {
      mediaId: updated.id,
      objectKey: updated.objectKey,
      downloadUrl: proxyPresignedPath(download.url),
      expiresAt: download.expiresAt.toISOString(),
      mediaType: updated.mediaType,
      sizeBytes: updated.sizeBytes,
    },
    { status: 200 }
  );
}
