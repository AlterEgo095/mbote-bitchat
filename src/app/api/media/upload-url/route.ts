/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/media/upload-url — B2 (spec MEDIA-ENVELOPE-SPEC §7.1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Entrée  : { me, mediaType, sizeBytes, sha256?, ts, signature }
 *            signature ECDSA sur `${me}|media-upload|${mediaType}|${sizeBytes}|${ts}`
 *            (fenêtre courte 15 min — preuve couvre les paramètres).
 *  Sortie  : { mediaId, objectKey, uploadUrl, expiresAt, mediaType, sizeBytes }
 *
 *  Chaîne de refus (dans l'ordre, spec §7.1) :
 *    503 stockage non configuré → 400 corps illisible → 401 preuve invalide →
 *    429 rate limit (20/h) → 429 IP (120/h) → 400 type hors whitelist →
 *    400 taille (> 5 Mo) → 429 quota (> 500 Mo finalisés) → 201 presigned PUT.
 *
 *  La presignature lie contentLength EXACTement (signature S3) : tout PUT
 *  d'une autre taille est rejeté par le bucket lui-même. La ligne Media est
 *  créée en `pending` — elle ne compte PAS au quota tant qu'elle n'est pas
 *  finalisée (un orphelin n'a jamais prouvé qu'il occupe le bucket).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore } from "@/lib/mbote/state-store";
import {
  mediaUploadProofMessage,
  verifySignedMessage,
  isValidPubkeyFormat,
  READ_MAX_AGE_MS,
  READ_FUTURE_TOLERANCE_MS,
} from "@/lib/mbote/proof";
import {
  B2_IMAGE_MAX_BYTES,
  B2_QUOTA_BYTES,
  B2_RATE_WINDOW_MS,
  B2_UPLOAD_RATE_PER_HOUR,
  isB2UploadType,
  proxyPresignedPath,
  publicStorageConfig,
  publicStorageOrigin,
  requireStorageConfig,
} from "@/lib/mbote/media-server";
import { generatePresignedUrl, newObjectKey, PRESIGN_TTL_DEFAULT_S } from "@/lib/mbote/media/storage";

export const dynamic = "force-dynamic";

const MEDIA_UPLOAD_PER_HOUR_PER_IP = 120;

export async function POST(req: NextRequest) {
  // 0. stockage configuré ? (503 propre — pas de crash nu)
  let cfg;
  try {
    cfg = requireStorageConfig();
  } catch {
    return NextResponse.json(
      { error: "Stockage média non configuré (MEDIA_S3_* absent) — upload indisponible" },
      { status: 503 }
    );
  }

  // 1. corps
  let body: {
    me?: unknown;
    mediaType?: unknown;
    sizeBytes?: unknown;
    sha256?: unknown;
    ts?: unknown;
    signature?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps illisible (JSON attendu)" }, { status: 400 });
  }
  const me = typeof body.me === "string" ? body.me : "";
  const mediaType = typeof body.mediaType === "string" ? body.mediaType : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : NaN;
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : null;

  // 2. preuve de possession (paramètres couverts — anti-tamper)
  const check = await verifySignedMessage({
    message: mediaUploadProofMessage(me, mediaType, sizeBytes, body.ts as number),
    pubkey: me,
    ts: body.ts,
    signature: body.signature,
    maxAgeMs: READ_MAX_AGE_MS,
    futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
  });
  if (!check.valid || !isValidPubkeyFormat(me)) {
    return NextResponse.json(
      { error: `Preuve d'upload requise : ${check.reason ?? "clé invalide"}` },
      { status: 401 }
    );
  }

  // 3. rate limit (20/h/utilisateur + garde IP — directive B2)
  const rates = getRateStore();
  const byKey = rates.hit(`media-upload:${me}`, B2_UPLOAD_RATE_PER_HOUR, B2_RATE_WINDOW_MS);
  const byIp = rates.hit(
    `media-upload-ip:${clientIp(req.headers)}`,
    MEDIA_UPLOAD_PER_HOUR_PER_IP,
    B2_RATE_WINDOW_MS
  );
  if (!byKey.allowed || !byIp.allowed) {
    const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
    return NextResponse.json(
      { error: `Limite d'uploads atteinte (${B2_UPLOAD_RATE_PER_HOUR}/h) — réessayez dans ${retry} s` },
      { status: 429, headers: { "Retry-After": String(retry || 3600) } }
    );
  }

  // 4. whitelist type (directive : jpeg | png | webp)
  if (!isB2UploadType(mediaType)) {
    return NextResponse.json(
      { error: `Type ${mediaType || "absent"} hors whitelist (image/jpeg, image/png, image/webp)` },
      { status: 400 }
    );
  }

  // 5. taille : entier, > 0, ≤ 5 Mo
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > B2_IMAGE_MAX_BYTES) {
    return NextResponse.json(
      {
        error: `Taille invalide : ${Number.isNaN(sizeBytes) ? "absente" : sizeBytes} o (bornes 1…${B2_IMAGE_MAX_BYTES})`,
      },
      { status: 400 }
    );
  }

  // 6. quota : 500 Mo de médias FINALISÉS cumulés par compte
  const used = await db.media.aggregate({
    _sum: { sizeBytes: true },
    where: { ownerPubkey: me, status: "finalized" },
  });
  const usedBytes = used._sum.sizeBytes ?? 0;
  if (usedBytes + sizeBytes > B2_QUOTA_BYTES) {
    return NextResponse.json(
      {
        error: `Quota média dépassé : ${(usedBytes / 1048576).toFixed(1)} Mo utilisés sur 500 Mo — demande ${(sizeBytes / 1048576).toFixed(1)} Mo`,
        usedBytes,
        quotaBytes: B2_QUOTA_BYTES,
      },
      { status: 429 }
    );
  }

  // 7. ligne pending + presigned PUT (Content-Length lié par la signature).
  // URL signée pour l'ORIGINE PUBLIQUE (host navigateur) — MÊME ORIGINE via
  // /api/media/proxy (CSP connect-src 'self' ; pas de preflight CORS).
  const objectKey = newObjectKey();
  const presigned = generatePresignedUrl(publicStorageConfig(cfg, publicStorageOrigin(req)), objectKey, {
    method: "PUT",
    ttlSec: PRESIGN_TTL_DEFAULT_S,
    contentLength: sizeBytes,
  });
  const media = await db.media.create({
    data: {
      objectKey,
      ownerPubkey: me,
      mediaType,
      sizeBytes,
      plainBytes: 0, // le client l'annonce dans le dm2 — pas de confiance serveur
      sha256,
      status: "pending",
    },
  });

  return NextResponse.json(
    {
      mediaId: media.id,
      objectKey,
      // chemin relatif PROXY — le navigateur PUT même origine, la signature
      // couvre le chemin S3 canonique reconstruit par le relay
      uploadUrl: proxyPresignedPath(presigned.url),
      expiresAt: presigned.expiresAt.toISOString(),
      ttlSec: presigned.ttlSec,
      mediaType,
      sizeBytes,
    },
    { status: 201 }
  );
}
