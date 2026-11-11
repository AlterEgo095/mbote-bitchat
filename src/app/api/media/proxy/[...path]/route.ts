/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  /api/media/proxy/[...path] — relay AVEUGLE vers le bucket S3 (B2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Pourquoi : les presigned URLs pointent vers le bucket, mais le navigateur
 *  ne peut pas parler DIRECTEMENT à un S3 sur un autre port (preflight CORS
 *  non négocié par MinIO/SeaweedFS et CSP `connect-src 'self'`). Le proxy
 *  rend l'upload/read MÊME ORIGINE :
 *    navigateur → /<bucket>/media/<uuid>?X-Amz-… (rewrite beforeFiles)
 *    → cette route → S3 interne (MEDIA_S3_ENDPOINT) avec le HEADER HOST
 *      D'ORIGINE (la signature SigV4 couvre ce host — SeaweedFS/MinIO
 *      re-calculent avec le host reçu → match).
 *
 *  HARDENING (anti open-proxy) :
 *    - chemin whitelisté : /<MEDIA_S3_BUCKET>/media/<uuid v4> — tout autre
 *      chemin → 404 ;
 *    - méthodes whitelistées : PUT (upload présigné) et GET (lecture
 *      présignée) — rien d'autre ;
 *    - la VALIDATION reste celle de SigV4 : sans signature valide dans la
 *      query, le bucket refuse (403) — le proxy n'ajoute aucun credential,
 *      il ne fait que relayer ;
 *    - body borné : ≤ limite image + 1 KiB (au-delà → 413, jamais bufferisé).
 *
 *  En prod R2 : MEDIA_S3_PUBLIC_ENDPOINT fixé → URLs signées pour le host R2
 *  direct (CORS configuré sur le bucket, runbook) — ce proxy reste un choix
 *  dev/sandbox et un fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  B2_IMAGE_MAX_BYTES,
  MEDIA_LIMITS,
  requireStorageConfig,
} from "@/lib/mbote/media-server";

export const dynamic = "force-dynamic";

/** Garde mémoire du relay : image ≤ 5 Mo (+1 KiB de tolérance protocole). */
const PROXY_MAX_BODY = Math.max(B2_IMAGE_MAX_BYTES, ...Object.values(MEDIA_LIMITS)) + 1024;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface RelayResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Relay bas niveau (node:http) — le header Host DOIT être contrôlé. */
function relay(url: URL, method: "GET" | "PUT", hostHeader: string, body: Buffer | null, contentLength: string | null): Promise<RelayResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { host: hostHeader };
    if (contentLength !== null) headers["content-length"] = contentLength;
    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: 30_000,
      } satisfies RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > PROXY_MAX_BODY) {
            res.destroy();
            reject(new Error("réponse S3 trop volumineuse"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const out: Record<string, string> = {};
          for (const h of ["content-type", "content-length", "etag", "x-amz-request-id"]) {
            const v = res.headers[h];
            if (typeof v === "string") out[h] = v;
          }
          resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("délai dépassé vers le bucket"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function handle(req: NextRequest, pathSegs: string[]): Promise<NextResponse> {
  let cfg;
  try {
    cfg = requireStorageConfig();
  } catch {
    return NextResponse.json(
      { error: "Stockage média non configuré (MEDIA_S3_* absent)" },
      { status: 503 }
    );
  }

  // whitelist stricte du chemin : /<bucket>/media/<uuid v4>
  const [bucket, kind, key] = pathSegs;
  if (bucket !== cfg.bucket || kind !== "media" || !key || !UUID_V4.test(key)) {
    return NextResponse.json({ error: "Chemin média invalide" }, { status: 404 });
  }
  const objectPath = `/${cfg.bucket}/media/${key}`;

  const method = req.method.toUpperCase();
  if (method !== "PUT" && method !== "GET") {
    return NextResponse.json({ error: "Méthode non relayée (PUT | GET)" }, { status: 405 });
  }

  // host vu du navigateur (Caddy préserve) = host COUVERT PAR LA SIGNATURE
  const hostHeader = req.headers.get("host") ?? new URL(cfg.endpoint).host;
  const internal = new URL(cfg.endpoint);
  const target = new URL(objectPath + (internal.search || ""), internal.origin);
  // préserve EXACTEMENT la query présignée (X-Amz-*), rien d'autre
  target.search = new URL(req.url, "http://x").search;

  let body: Buffer | null = null;
  let contentLength: string | null = null;
  if (method === "PUT") {
    const raw = await req.arrayBuffer();
    if (raw.byteLength > PROXY_MAX_BODY) {
      return NextResponse.json({ error: "Objet trop volumineux pour le relay" }, { status: 413 });
    }
    body = Buffer.from(raw);
    contentLength = String(body.length);
  }

  try {
    const res = await relay(target, method as "GET" | "PUT", hostHeader, body, contentLength);
    // copie typée ArrayBuffer (Buffer → Uint8Array<ArrayBuffer> pour BodyInit)
    return new NextResponse(new Uint8Array(res.body), {
      status: res.status,
      headers: res.headers,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Bucket injoignable : ${e instanceof Error ? e.message : "inconnu"}` },
      { status: 502 }
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return handle(req, (await ctx.params).path);
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return handle(req, (await ctx.params).path);
}
