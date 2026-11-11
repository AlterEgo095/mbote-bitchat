/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media/storage — URLs présignées S3 SigV4 (B1, spec §4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Abstraction R2/MinIO (les DEUX parlent S3 SigV4 — driver par env) :
 *   - generatePresignedUrl(objectKey, {ttlSec=900, method, contentLength}) :
 *     TTL par défaut 15 min (directive), méthode PUT/GET uniquement, taille
 *     imposée (Content-Length exact signé — tout autre upload est rejeté par
 *     la signature S3) ;
 *   - verifyPresignedUrl(url, expectedMethod, {now}) : vérificateur LOCAL
 *     (tests V1 + future route PUT B2) — re-calcul sigv4 + fenêtre
 *     d'expiration → erreurs typées (`expired` / `bad-signature` / …).
 *
 *  SigV4 écrit sur node:crypto — ZÉRO dépendance (arbitrage spec §6.2 : pas
 *  d'@aws-sdk/* pour ~80 lignes d'algorithme figé et testé).
 *  Clés d'objet sans identité (`media/<uuid>`) — stockage aveugle (spec §4.2).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export class MediaStorageError extends Error {
  constructor(
    public readonly code:
      | "not-configured"
      | "bad-object-key"
      | "bad-media-type"
      | "too-large"
      | "bad-ttl"
      | "bad-method"
      | "bad-url"
      | "expired"
      | "bad-signature",
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = "MediaStorageError";
  }
}

// ── limites (spec §2) ───────────────────────────────────────────────────────
export const MEDIA_LIMITS = {
  "image/jpeg": 5 * 1024 * 1024,
  "image/png": 5 * 1024 * 1024,
  "image/webp": 5 * 1024 * 1024,
  "audio/webm": 10 * 1024 * 1024,
  "audio/ogg": 10 * 1024 * 1024,
  "audio/mp4": 10 * 1024 * 1024,
  "video/mp4": 100 * 1024 * 1024,
  "video/webm": 100 * 1024 * 1024,
} as const;

export type MediaType = keyof typeof MEDIA_LIMITS;

/** Refus AVANT tout octet envoyé au stockage (erreurs typées). */
export function assertMediaLimit(mediaType: string, bytes: number): void {
  const max = MEDIA_LIMITS[mediaType as MediaType];
  if (max === undefined) {
    throw new MediaStorageError("bad-media-type", `type ${mediaType} hors whitelist (spec §2)`);
  }
  if (bytes > max) {
    throw new MediaStorageError("too-large", `${mediaType} ${bytes} o > limite ${max} o`);
  }
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new MediaStorageError("too-large", `taille invalide : ${bytes}`);
  }
}

/** Clés d'objet sans identité — whitelist stricte (spec §4.2). */
export function assertObjectKey(objectKey: string): void {
  if (!/^media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(objectKey)) {
    throw new MediaStorageError("bad-object-key", `clé refusée : ${objectKey.slice(0, 64)}`);
  }
}

/** Nouvelle clé d'objet (uuid v4, aucune identité utilisateur). */
export function newObjectKey(): string {
  return `media/${randomUUID()}`;
}

// ── config (par env — spec §4.1) ────────────────────────────────────────────
export interface MediaStorageConfig {
  driver: "minio" | "r2";
  endpoint: string; // ex. http://127.0.0.1:9000 (path-style)
  region: string; // us-east-1 (MinIO) | auto (R2)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorageConfig {
  const driver = env.MEDIA_STORAGE_DRIVER === "r2" ? "r2" : "minio";
  const required: Array<[string, string | undefined]> = [
    ["MEDIA_S3_ENDPOINT", env.MEDIA_S3_ENDPOINT],
    ["MEDIA_S3_BUCKET", env.MEDIA_S3_BUCKET],
    ["MEDIA_S3_ACCESS_KEY_ID", env.MEDIA_S3_ACCESS_KEY_ID],
    ["MEDIA_S3_SECRET_ACCESS_KEY", env.MEDIA_S3_SECRET_ACCESS_KEY],
  ];
  for (const [name, value] of required) {
    if (!value) {
      throw new MediaStorageError("not-configured", `${name} manquant (driver ${driver})`);
    }
  }
  return {
    driver,
    endpoint: env.MEDIA_S3_ENDPOINT as string,
    region: env.MEDIA_S3_REGION ?? (driver === "r2" ? "auto" : "us-east-1"),
    bucket: env.MEDIA_S3_BUCKET as string,
    accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY as string,
  };
}

// ── SigV4 (spécification AWS — presign query style) ─────────────────────────
const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** TTL 15 min par défaut (directive) ; borné 1 min…1 h. */
export const PRESIGN_TTL_DEFAULT_S = 900;
const TTL_MIN_S = 60;
const TTL_MAX_S = 3600;

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** RFC 3986 strict (AWS SigV4) — plus permissif que encodeURIComponent. */
function awsUriEncode(s: string, encodeSlash = true): string {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else {
      const bytes = Buffer.from(ch, "utf8");
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

interface AmzDates {
  amzDate: string; // 20261106T063608Z
  dateStamp: string; // 20261106
}

function amzDates(now: Date): AmzDates {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export type PresignMethod = "PUT" | "GET";

export interface PresignOptions {
  ttlSec?: number;
  method?: PresignMethod;
  /** PUT uniquement : taille EXACTE de l'objet (liée par la signature). */
  contentLength?: number;
  now?: Date;
}

export interface PresignedUrl {
  url: string;
  method: PresignMethod;
  objectKey: string;
  expiresAt: Date;
  ttlSec: number;
}

/**
 * Présigne une URL S3 SigV4. PUT exige `contentLength` (taille exacte liée —
 * spec §4.3 « taille max imposée » : un upload d'une autre taille est rejeté
 * par la signature S3 elle-même).
 */
export function generatePresignedUrl(
  cfg: MediaStorageConfig,
  objectKey: string,
  opts: PresignOptions = {}
): PresignedUrl {
  assertObjectKey(objectKey);
  const method = opts.method ?? "PUT";
  if (method !== "PUT" && method !== "GET") {
    throw new MediaStorageError("bad-method", `méthode ${method} non présignable (PUT | GET)`);
  }
  const ttlSec = Math.floor(opts.ttlSec ?? PRESIGN_TTL_DEFAULT_S);
  if (!Number.isInteger(ttlSec) || ttlSec < TTL_MIN_S || ttlSec > TTL_MAX_S) {
    throw new MediaStorageError("bad-ttl", `ttl ${ttlSec} s hors bornes ${TTL_MIN_S}…${TTL_MAX_S} s`);
  }
  if (method === "PUT") {
    if (typeof opts.contentLength !== "number" || !Number.isInteger(opts.contentLength) || opts.contentLength <= 0) {
      throw new MediaStorageError("too-large", "PUT exige contentLength (taille exacte liée par la signature)");
    }
    // la limite par type est vérifiée par l'appelant via assertMediaLimit ;
    // ici on refuse les tailles non entières/nulles (ci-dessus) — la borne
    // par TYPE est de la responsabilité de la couche métier (B2).
  }
  const now = opts.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const endpoint = new URL(cfg.endpoint);
  const host = endpoint.host; // inclut :port si présent
  const canonicalUri = `/${cfg.bucket}/${objectKey.split("/").map((s) => awsUriEncode(s)).join("/")}`;

  // headers signés : host (+ content-length en PUT) — chaque header signé
  // (hors host) apparaît aussi en query (règle presign AWS).
  const signedHeaders = method === "PUT" ? "content-length;host" : "host";
  const query = new Map<string, string>([
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${cfg.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(ttlSec)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]);
  if (method === "PUT") query.set("content-length", String(opts.contentLength));

  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalHeaders = method === "PUT" ? `content-length:${String(opts.contentLength)}\nhost:${host}\n` : `host:${host}\n`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(Buffer.from(`AWS4${cfg.secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const url = `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { url, method, objectKey, expiresAt: new Date(now.getTime() + ttlSec * 1000), ttlSec };
}

export interface VerifyResult {
  ok: true;
  objectKey: string;
  method: PresignMethod;
}

/**
 * Vérification LOCALE d'une URL présignée (tests + future route B2) :
 * re-calcul sigv4 (timing-safe) + fenêtre d'expiration. Toute divergence →
 * MediaStorageError typée (expired | bad-signature | bad-method | bad-url).
 */
export function verifyPresignedUrl(
  cfg: MediaStorageConfig,
  url: string,
  expectedMethod: PresignMethod,
  opts: { now?: Date } = {}
): VerifyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaStorageError("bad-url", "URL illisible");
  }
  const get = (k: string): string => {
    const v = parsed.searchParams.get(k);
    if (v === null) throw new MediaStorageError("bad-url", `paramètre ${k} absent`);
    return v;
  };
  if (get("X-Amz-Algorithm") !== ALGORITHM) throw new MediaStorageError("bad-url", "algorithme inattendu");

  const method = expectedMethod;
  const amzDate = get("X-Amz-Date");
  const ttlSec = Number(get("X-Amz-Expires"));
  const signedHeaders = get("X-Amz-SignedHeaders");
  const signature = get("X-Amz-Signature");

  // expiration : amzDate + ttl
  const m = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) throw new MediaStorageError("bad-url", "X-Amz-Date mal formé");
  const signedAtMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const nowMs = (opts.now ?? new Date()).getTime();
  if (!Number.isInteger(ttlSec) || ttlSec < 0) throw new MediaStorageError("bad-url", "X-Amz-Expires mal formé");
  if (nowMs > signedAtMs + ttlSec * 1000) {
    throw new MediaStorageError("expired", `URL expirée depuis ${Math.round((nowMs - signedAtMs - ttlSec * 1000) / 1000)} s`);
  }

  // re-calcul : même construction que generatePresignedUrl, à partir des
  // paramètres LUS dans l'URL (pas des options) — anti-oubli.
  const host = parsed.host;
  const canonicalUri = parsed.pathname;
  const expectedSignedHeaders = method === "PUT" ? "content-length;host" : "host";
  if (signedHeaders !== expectedSignedHeaders) {
    throw new MediaStorageError("bad-url", `signed headers ${signedHeaders} ≠ attendu ${expectedSignedHeaders}`);
  }
  const query = new Map<string, string>();
  for (const [k, v] of parsed.searchParams.entries()) {
    if (k === "X-Amz-Signature") continue;
    query.set(k, v);
  }
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const contentLength = method === "PUT" ? String(Number(get("content-length"))) : null;
  const canonicalHeaders =
    method === "PUT" ? `content-length:${contentLength}\nhost:${host}\n` : `host:${host}\n`;
  const credential = get("X-Amz-Credential");
  const scope = credential.split("/").slice(1).join("/");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const dateStamp = scope.split("/")[0];
  const region = scope.split("/")[1];
  const kDate = hmac(Buffer.from(`AWS4${cfg.secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const expected = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new MediaStorageError("bad-signature", "signature recomputée ≠ signature URL");
  }
  const objectKey = decodeURIComponent(parsed.pathname).replace(`/${cfg.bucket}/`, "");
  return { ok: true, objectKey, method };
}
