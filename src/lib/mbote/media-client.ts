"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-client — B2 upload/download images (spec MEDIA-ENVELOPE-SPEC §7.2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Module TS pur (WebCrypto globalThis + fetch) : testable sous bun, RN-compatible
 *  (polyfill WebCrypto) à l'exception du strip EXIF canvas (web only, injectable
 *  pour les tests — arbitrage spec §6.9).
 *
 *  Chaîne upload (chaque étape est observable via onProgress) :
 *    strip → chiffrement (CEK/IV uniques, garde de session) → upload-url
 *    → PUT présigné (Content-Length = octets de l'enveloppe) → finalize.
 *  Le CEK est gardé en MÉMOIRE DE SESSION (jamais persisté) pour relire ses
 *  propres médias ; pour les destinataires il voyage dans le dm2 E2EE (§7.3).
 *
 *  Chaîne download : download-url → GET → decrypt → SNIFF MAGIC BYTES du
 *  plaintext contre le type déclaré (arbitrage §6.7-iii : un PDF déguisé en
 *  jpeg n'est JAMAIS rendu) → Blob typé.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── base64url pur JS (isomorphe — miroir de proof.ts) ────────────────────

import {
  VOICE_MAX_BYTES,
  assertPlayableVoice,
  decodeAndMeasure,
  validateVoiceForSend,
  type SniffedOpusContainer,
} from "./media/opus";
import {
  VIDEO_MAX_BYTES,
  assertPlayableVideo,
  validateVideoForSend,
  type SniffedVideoContainer,
} from "./media/video";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── erreurs typées ───────────────────────────────────────────────────────────

export class MediaClientError extends Error {
  constructor(
    public readonly code:
      | "bad-type" // type hors whitelist client
      | "too-large" // > 5 Mo
      | "strip-failed" // ré-encodage impossible (PDF renommé .jpg → ici)
      | "encrypt-failed"
      | "presign-failed"
      | "put-failed"
      | "finalize-failed"
      | "download-failed"
      | "decrypt-failed"
      | "magic-bytes-mismatch" // §6.7-iii — rendu REFUSÉ
      | "offline", // réseau indisponible (queue)
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = "MediaClientError";
  }
}

// ── chiffrement (WebCrypto — format v1 IDENTIQUE au socle B1 serveur) ───────

const SUBTLE = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new MediaClientError("encrypt-failed", "WebCrypto indisponible");
  return subtle;
};

/** CEK 32 o — CÔTÉ CLIENT (spec §1.2) : le serveur ne le voit jamais. */
export function generateCekBytes(): Uint8Array {
  return new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// garde de SESSION (miroir client de la garde serveur §1.3) : refus explicite
// de toute réutilisation d'IV — GCM casse si (clé, nonce) se répète.
const sessionIvs = new Set<string>();

export interface EncryptedEnvelope {
  /** enveloppe `v1:iv:ciphertext:tag` (base64url, sans padding) — même format B1 */
  envelope: string;
  /** CEK base64url — à mettre dans le dm2 (E2EE) pour les destinataires */
  cekB64: string;
  /** taille CIPHERTEXT = octets de l'enveloppe (ASCII pur) = Content-Length */
  sizeBytes: number;
  /** empreinte SHA-256 du CIPHERTEXT (hex) — contrôle/dédup */
  sha256: string;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await SUBTLE().digest("SHA-256", data as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Chiffre les octets du média : CEK + IV uniques, AES-256-GCM, enveloppe v1.
 * Interopérabilité testée : `decryptMedia` du socle B1 (node:crypto) lit
 * exactement ce format.
 */
export async function encryptBytes(plain: Uint8Array): Promise<EncryptedEnvelope> {
  if (plain.length === 0) {
    throw new MediaClientError("encrypt-failed", "octets vides");
  }
  const cek = generateCekBytes();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ivKey = bytesToB64url(iv);
  if (sessionIvs.has(ivKey)) {
    throw new MediaClientError("encrypt-failed", "IV déjà vu en session (garde) — GCM interdit");
  }
  sessionIvs.add(ivKey);

  const key = await SUBTLE().importKey("raw", cek as unknown as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(
    await SUBTLE().encrypt({ name: "AES-GCM", iv }, key, plain as unknown as BufferSource)
  );
  const tag = ct.slice(ct.length - 16);
  const ciphertext = ct.slice(0, ct.length - 16);
  const envelope = [
    "v1",
    bytesToB64url(iv),
    bytesToB64url(ciphertext),
    bytesToB64url(tag),
  ].join(":");
  const envelopeBytes = new TextEncoder().encode(envelope);
  return {
    envelope,
    cekB64: bytesToB64url(cek),
    sizeBytes: envelopeBytes.length,
    sha256: await sha256Hex(envelopeBytes),
  };
}

/**
 * Déchiffre une enveloppe v1 (échec PROPRE — auth-failed sur altération).
 * Retourne les octets du PLAINTEXT.
 */
export async function decryptBytes(envelope: string, cekB64: string): Promise<Uint8Array> {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new MediaClientError("decrypt-failed", "enveloppe malformée");
  }
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  let tag: Uint8Array;
  let cek: Uint8Array;
  try {
    iv = b64urlToBytes(parts[1]);
    ciphertext = b64urlToBytes(parts[2]);
    tag = b64urlToBytes(parts[3]);
    cek = b64urlToBytes(cekB64);
  } catch {
    throw new MediaClientError("decrypt-failed", "encodage base64url invalide");
  }
  if (iv.length !== 12 || tag.length !== 16 || cek.length !== 32 || ciphertext.length === 0) {
    throw new MediaClientError("decrypt-failed", "longueurs d'enveloppe invalides");
  }
  try {
    const key = await SUBTLE().importKey("raw", cek as unknown as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
    // WebCrypto : decrypt attend ciphertext||tag CONCATÉNÉS (l'encrypt les
    // renvoie concaténés ; l'enveloppe v1 les sépare — on réassemble AVANT).
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);
    const plain = await SUBTLE().decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      combined as unknown as BufferSource
    );
    return new Uint8Array(plain);
  } catch {
    throw new MediaClientError("decrypt-failed", "vérification GCM échouée (altéré ou mauvais CEK)");
  }
}

// ── magic bytes (arbitrage §6.7-iii — barrière au RENDU) ─────────────────────

export type SniffedImageType = "image/jpeg" | "image/png" | "image/webp";

/** Sniff pur JS : FFD8 → jpeg, 89504E47 → png, RIFF….WEBP → webp. */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Vérifie que le plaintext déchiffré EST l'image annoncée. Un média dont les
 * magic bytes contredisent le type déclaré (PDF renommé .jpg) est REFUSÉ —
 * jamais rendu, même si l'uploader est malveillant.
 */
export function assertRenderableImage(bytes: Uint8Array, declaredType?: string): SniffedImageType {
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    throw new MediaClientError("magic-bytes-mismatch", `pas une image (sniff null, ${bytes.length} o)`);
  }
  if (declaredType && declaredType !== sniffed) {
    throw new MediaClientError(
      "magic-bytes-mismatch",
      `type déclaré ${declaredType} ≠ magic bytes ${sniffed} — MIME spoofing suspecté`
    );
  }
  return sniffed;
}

// ── strip EXIF (canvas — web ; injectable pour tests/RN) ─────────────────────

/** Strip par DÉFAUT hors navigateur (harness/RN) — injecté via setDefaultStrip. */
let defaultStrip: ((b: Uint8Array) => Promise<Uint8Array>) | null = null;
export function setDefaultStrip(fn: (b: Uint8Array) => Promise<Uint8Array>): void {
  defaultStrip = fn;
}

export interface StripClientResult {
  bytes: Uint8Array;
  /** type de SORTIE (post-réencodage) : jpeg (sans alpha) ou png (avec alpha) */
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/**
 * Ré-encode via canvas SANS AUCUNE métadonnée (GPS/dates/appareil/XMP/
 * thumbnail) et CUIT l'orientation dans les pixels — équivalent web exact de
 * `stripExif` (sharp, socle B1). Un PDF renommé .jpg échoue ICI (decode fail).
 * Type de sortie : jpeg si l'image n'a pas d'alpha, png sinon (un jpeg a un
 * fond opaque ; le PNG préserve la transparence).
 */
export async function stripExifClient(bytes: Uint8Array): Promise<StripClientResult> {
  if (typeof document === "undefined") {
    throw new MediaClientError("strip-failed", "canvas indisponible (hors navigateur)");
  }
  let bitmap: ImageBitmap;
  try {
    // imageOrientation from-image : l'orientation EXIF est CUITE dans les
    // pixels (tranchement spec §5.2) — jamais conservée comme métadonnée.
    bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart]), { imageOrientation: "from-image" });
  } catch {
    throw new MediaClientError("strip-failed", "image illisible (PDF renommé .jpg ? format non supporté ?)");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new MediaClientError("strip-failed", "contexte canvas indisponible");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // alpha ? : si tout le pixel data est opaque (a=255 partout) → jpeg (léger)
  const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let hasAlpha = false;
  for (let i = 3; i < sample.length; i += 4 * 17) { // échantillon 1/17 px
    if (sample[i] !== 255) {
      hasAlpha = true;
      break;
    }
  }

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob null"))),
      hasAlpha ? "image/png" : "image/jpeg",
      hasAlpha ? undefined : 0.85
    );
  });
  // invariant « post-strip ≤ original » (socle B1) — appliqué aux VRAIES
  // photos (≥ 32 Ko). Arbitrage B2 : le ré-encodage canvas peut légèrement
  // AGRANDIR les micro-images (un JPEG 4×3 px de 517 o ré-encodé → ~760 o :
  // headers + tables Huffman recalculés) — l'invariant strict y est
  // mathématiquement irréalisable sans encoder à l'aveugle. La garantie
  // privacy (aucune métadonnée) reste intégrale ; le serveur borne la taille
  // du ciphertext de toute façon (Content-Length signé ≤ 5 Mo).
  if (bytes.length >= 32 * 1024 && blob.size > bytes.length) {
    throw new MediaClientError(
      "strip-failed",
      `post-strip ${blob.size} o > original ${bytes.length} o — invariant violé`
    );
  }
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mediaType: hasAlpha ? "image/png" : "image/jpeg",
    width: canvas.width,
    height: canvas.height,
  };
}

// ── orchestration upload ─────────────────────────────────────────────────────

export type UploadStage = "strip" | "encrypt" | "presign" | "put" | "finalize" | "done";

export interface UploadedMedia {
  mediaId: string;
  objectKey: string;
  /** CEK base64url — DANS le dm2 E2EE pour les destinataires (§7.3) */
  cekB64: string;
  /** type du PLAINTEXT post-strip (ce qui est réellement stocké) */
  mediaType: string;
  plainBytes: number;
  sizeBytes: number;
  sha256: string;
  /** vignette locale (data URL) — affichage immédiat avant envoi du dm2 */
  previewDataUrl?: string;
}

export interface UploadImageOptions {
  /** octets du fichier image ORIGINAL (avant strip) */
  bytes: Uint8Array;
  /** type déclaré d'ENTRÉE (image/jpeg | image/png | image/webp) */
  mediaType: string;
  /** strip injectable — défaut : canvas web ; tests/RN : sharp ou autre */
  strip?: (b: Uint8Array) => Promise<Uint8Array>;
  /** preuve : signe la chaîne canonique avec la clé ECDSA (identity.signPriv) */
  sign: (payload: string) => Promise<string>;
  me: string;
  onProgress?: (stage: UploadStage, info?: { fraction?: number; message?: string }) => void;
}

/** Limite d'entrée client — 5 Mo (spec §2), alignée sur le serveur. */
export const CLIENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CLIENT_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * Base des appels API : relative dans le navigateur (règle du projet — jamais
 * d'URL absolue côté client) ; ABSOLUE sous bun/RN-harness (fetch y exige un
 * URL complète — BASE_URL fournie par le runner).
 */
function apiBase(): string {
  if (typeof window !== "undefined") return "";
  return process.env.BASE_URL ?? "http://127.0.0.1:3103";
}

/** Presigned path → URL fetchable (relatif web, absolu harness). */
function toFetchUrl(presignedPath: string): string {
  return `${apiBase()}${presignedPath}`;
}

async function mediaApi<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new MediaClientError(
      res.status === 502 || res.status === 503 ? "presign-failed" : "finalize-failed",
      body.error ?? `HTTP ${res.status}`
    );
  }
  return (await res.json()) as T;
}

/**
 * Upload image COMPLET : strip → chiffrement → upload-url → PUT → finalize.
 * Chaque étape reporte via onProgress. Échec réseau (PUT) → MediaClientError
 * "put-failed" — l'appelant peut enregistrer la pièce dans la MediaUploadQueue
 * (re-orchestration complète au retour du réseau).
 */
export async function uploadImage(opts: UploadImageOptions): Promise<UploadedMedia> {
  const { bytes, mediaType, me, sign, onProgress } = opts;

  // 0. gardes d'entrée (miroir serveur — refus AVANT tout octet envoyé)
  if (!(CLIENT_UPLOAD_TYPES as readonly string[]).includes(mediaType)) {
    throw new MediaClientError("bad-type", `type ${mediaType} hors whitelist (jpeg | png | webp)`);
  }
  if (bytes.length <= 0 || bytes.length > CLIENT_IMAGE_MAX_BYTES) {
    throw new MediaClientError("too-large", `${bytes.length} o hors bornes (1…${CLIENT_IMAGE_MAX_BYTES})`);
  }

  // 1. strip EXIF (privacy-by-default) — type de SORTIE = ce qui est stocké
  onProgress?.("strip", { message: "Nettoyage des métadonnées…" });
  const stripped =
    opts.strip ??
    defaultStrip ??
    (typeof document !== "undefined"
      ? async (b: Uint8Array) => (await stripExifClient(b)).bytes
      : undefined);
  if (!stripped) {
    throw new MediaClientError("strip-failed", "aucun strip disponible (canvas absent, strip non injecté)");
  }
  const clean = await stripped(bytes);
  const outType = sniffImageType(clean);
  if (!outType) {
    throw new MediaClientError("strip-failed", "sortie strip non reconnue comme image");
  }

  // 2. chiffrement client (CEK + IV uniques)
  onProgress?.("encrypt", { message: "Chiffrement de bout en bout…" });
  const enc = await encryptBytes(clean);

  // 3. upload-url (preuve couvre mediaType + sizeBytes)
  onProgress?.("presign", { message: "Demande d'URL d'upload…" });
  const ts = Date.now();
  const signature = await sign(`${me}|media-upload|${outType}|${enc.sizeBytes}|${ts}`);
  const presign = await mediaApi<{
    mediaId: string;
    objectKey: string;
    uploadUrl: string;
    expiresAt: string;
  }>("/api/media/upload-url", {
    method: "POST",
    body: JSON.stringify({ me, mediaType: outType, sizeBytes: enc.sizeBytes, sha256: enc.sha256, ts, signature }),
  });

  // 4. PUT présigné (même origine — proxy) ; Content-Length automatique du body
  onProgress?.("put", { fraction: 0 });
  const putRes = await fetch(toFetchUrl(presign.uploadUrl), {
    method: "PUT",
    body: enc.envelope,
  });
  if (!putRes.ok) {
    throw new MediaClientError("put-failed", `Bucket a refusé le PUT (HTTP ${putRes.status})`);
  }
  onProgress?.("put", { fraction: 1 });

  // 5. finalize (existence + taille + enveloppe vérifiés côté serveur)
  onProgress?.("finalize", { message: "Finalisation…" });
  const fts = Date.now();
  const fsig = await sign(`${me}|media-finalize|${presign.mediaId}|${fts}`);
  const finalized = await mediaApi<{ mediaId: string; objectKey: string; downloadUrl: string }>(
    "/api/media/finalize",
    {
      method: "POST",
      body: JSON.stringify({ me, mediaId: presign.mediaId, plainBytes: clean.length, ts: fts, signature: fsig }),
    }
  );

  // 6. CEK gardé en mémoire de session (relire ses propres images)
  sessionCeks.set(finalized.mediaId, { cekB64: enc.cekB64, mediaType: outType });

  onProgress?.("done");
  return {
    mediaId: finalized.mediaId,
    objectKey: finalized.objectKey,
    cekB64: enc.cekB64,
    mediaType: outType,
    plainBytes: clean.length,
    sizeBytes: enc.sizeBytes,
    sha256: enc.sha256,
    previewDataUrl: URL.createObjectURL(new Blob([clean as unknown as BlobPart], { type: outType })),
  };
}

// ── CEK de session (relire ses propres médias — jamais persisté) ─────────────

const sessionCeks = new Map<string, { cekB64: string; mediaType: string }>();

export function sessionCekFor(mediaId: string): { cekB64: string; mediaType: string } | null {
  return sessionCeks.get(mediaId) ?? null;
}

// ── download + decrypt + sniff ───────────────────────────────────────────────

export interface DownloadImageOptions {
  mediaId: string;
  /** CEK du média (session si À MOI, dm2 si reçu d'un pair) */
  cekB64: string;
  /** type déclaré dans le dm2 — contrôlé contre les magic bytes (§6.7-iii) */
  declaredType?: string;
  me: string;
  sign: (payload: string) => Promise<string>;
}

export interface DownloadedImage {
  blob: Blob;
  mediaType: string;
  /** taille du plaintext déchiffré */
  bytes: number;
}

export async function downloadImage(opts: DownloadImageOptions): Promise<DownloadedImage> {
  const { mediaId, cekB64, declaredType, me, sign } = opts;
  const ts = Date.now();
  const signature = await sign(`${me}|media-dl|${mediaId}|${ts}`);
  const res = await fetch(
    `${apiBase()}/api/media/download-url?${new URLSearchParams({ me, mediaId, ts: String(ts), signature })}`
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new MediaClientError("download-failed", body.error ?? `HTTP ${res.status}`);
  }
  const info = (await res.json()) as { downloadUrl: string; mediaType: string };

  const dl = await fetch(toFetchUrl(info.downloadUrl));
  if (!dl.ok) {
    throw new MediaClientError("download-failed", `Bucket a refusé la lecture (HTTP ${dl.status})`);
  }
  const envelope = await dl.text();
  const plain = await decryptBytes(envelope, cekB64);
  const sniffed = assertRenderableImage(plain, declaredType ?? info.mediaType);
  return {
    blob: new Blob([plain as unknown as BlobPart], { type: sniffed }),
    mediaType: sniffed,
    bytes: plain.length,
  };
}

// ── queue offline (mémoire de session — re-orchestration au retour réseau) ───

export interface QueuedUpload {
  ref: string;
  name: string;
  /** octets ORIGINAUX (en mémoire — jamais persistés) */
  bytes: Uint8Array;
  mediaType: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
  status: "queued" | "uploading" | "failed";
}

const uploadQueue: QueuedUpload[] = [];
const listeners = new Set<(queue: QueuedUpload[]) => void>();

function notifyQueue(): void {
  const snapshot = uploadQueue.map((q) => ({ ...q }));
  for (const l of listeners) l(snapshot);
}

/** S'abonne aux changements de la file (UI : compteur « N médias en attente »). */
export function onUploadQueueChange(listener: (queue: QueuedUpload[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** File actuelle (snapshot). */
export function uploadQueueSnapshot(): QueuedUpload[] {
  return uploadQueue.map((q) => ({ ...q }));
}

/** Ajoute un upload en attente de réseau (octets en mémoire). */
export function enqueueOfflineUpload(name: string, bytes: Uint8Array, mediaType: string): QueuedUpload {
  const item: QueuedUpload = {
    ref: `media-queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    bytes,
    mediaType,
    queuedAt: Date.now(),
    attempts: 0,
    status: "queued",
  };
  uploadQueue.push(item);
  notifyQueue();
  return item;
}

/** Retire un item de la file (après succès définitif ou abandon utilisateur). */
export function dequeueOfflineUpload(ref: string): void {
  const i = uploadQueue.findIndex((q) => q.ref === ref);
  if (i >= 0) {
    uploadQueue.splice(i, 1);
    notifyQueue();
  }
}

/**
 * Tente la re-orchestration de TOUS les uploads en file (appelé au retour du
 * réseau — événement `online` — et manuellement). Signe à CHAQUE tentative
 * (les preuves ne sont jamais stockées — fenêtre courte §7.2).
 * Retourne les refs réussis.
 */
export async function flushUploadQueue(
  me: string,
  sign: (payload: string) => Promise<string>,
  onUploaded?: (item: QueuedUpload, media: UploadedMedia) => void,
  onProgress?: (ref: string, stage: UploadStage, info?: { fraction?: number }) => void
): Promise<string[]> {
  const done: string[] = [];
  for (const item of [...uploadQueue]) {
    if (item.status === "uploading") continue;
    item.status = "uploading";
    item.attempts += 1;
    notifyQueue();
    try {
      const media = await uploadImage({
        bytes: item.bytes,
        mediaType: item.mediaType,
        me,
        sign,
        onProgress: (stage, info) => onProgress?.(item.ref, stage, info),
      });
      dequeueOfflineUpload(item.ref);
      done.push(item.ref);
      onUploaded?.(item, media);
    } catch (e) {
      const snapshot = uploadQueue.find((q) => q.ref === item.ref);
      if (snapshot) {
        snapshot.status = "failed";
        snapshot.lastError = e instanceof Error ? e.message : String(e);
        notifyQueue();
      }
    }
  }
  return done;
}

/** Branchement auto : au retour du réseau, la file se rejoue. */
export function attachUploadQueueFlusher(
  me: string,
  sign: (payload: string) => Promise<string>,
  onUploaded?: (item: QueuedUpload, media: UploadedMedia) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const flush = () => {
    void flushUploadQueue(me, sign, onUploaded);
  };
  window.addEventListener("online", flush);
  return () => window.removeEventListener("online", flush);
}

// ── B3 — voice notes (pipeline B2 identique, SANS strip) ────────────────────
// Arbitrages spec §8 : Opus n'a PAS d'EXIF (conteneur audio — rien à striper,
// documenté §8.3) ; le type CANONIQUE déclaré à l'API est « audio/opus » quel
// que soit le conteneur réel (webm/ogg), sniffré côté destinataire (§8.4) ;
// le pipeline chiffrement → presign → PUT → finalize est EXACTEMENT celui de
// B2 (même enveloppe v1, même CEK session, même preuve ECDSA).

export interface UploadedVoice extends Omit<UploadedMedia, "previewDataUrl"> {
  /** durée mesurée (ms) — voyage dans le dm2 */
  durationMs: number;
  /** waveform 100 peaks — voyage dans le dm2 E2EE (affichage sans re-décode) */
  peaks: number[];
  /** conteneur réel détecté (webm | ogg) — diagnostic uniquement */
  container: SniffedOpusContainer;
}

export interface UploadVoiceOptions {
  bytes: Uint8Array;
  /** durée mesurée à l'enregistrement (garde 60 s — arbitrage §8.3) */
  durationMs: number;
  /** waveform calculée à l'enregistrement (100 peaks) */
  peaks?: number[];
  me: string;
  sign: (payload: string) => Promise<string>;
  onProgress?: (stage: Exclude<UploadStage, "strip">, info?: { fraction?: number; message?: string }) => void;
}

/** Garde d'envoi 61 s / 10 Mo / conteneur — REFUS AVANT tout octet envoyé. */
export function assertVoiceSendable(bytes: Uint8Array, durationMs: number): void {
  const v = validateVoiceForSend({ bytes, durationMs });
  if (!v.ok) throw new MediaClientError("bad-type", v.reason);
}

/**
 * Upload note vocale COMPLET : validation → chiffrement → upload-url
 * (audio/opus) → PUT présigné → finalize. Pipeline B2 sans l'étape strip.
 */
export async function uploadVoiceNote(opts: UploadVoiceOptions): Promise<UploadedVoice> {
  const { bytes, durationMs, peaks = [], me, sign, onProgress } = opts;

  // 0. garde d'entrée (61 s → refus ICI, jamais un upload de 11 Mo)
  assertVoiceSendable(bytes, durationMs);

  // 1. chiffrement client (CEK + IV uniques — enveloppe v1 identique B1/B2)
  onProgress?.("encrypt", { message: "Chiffrement de bout en bout…" });
  const enc = await encryptBytes(bytes);
  if (enc.sizeBytes > VOICE_MAX_BYTES) {
    throw new MediaClientError("too-large", `enveloppe ${enc.sizeBytes} o > ${VOICE_MAX_BYTES}`);
  }

  // 2. upload-url (type canonique audio/opus — preuve couvre type + taille)
  onProgress?.("presign", { message: "Demande d'URL d'upload…" });
  const ts = Date.now();
  const signature = await sign(`${me}|media-upload|audio/opus|${enc.sizeBytes}|${ts}`);
  const presign = await mediaApi<{
    mediaId: string;
    objectKey: string;
    uploadUrl: string;
    expiresAt: string;
  }>("/api/media/upload-url", {
    method: "POST",
    body: JSON.stringify({ me, mediaType: "audio/opus", sizeBytes: enc.sizeBytes, sha256: enc.sha256, ts, signature }),
  });

  // 3. PUT présigné (même origine — proxy) ; Content-Length automatique
  onProgress?.("put", { fraction: 0 });
  const putRes = await fetch(toFetchUrl(presign.uploadUrl), {
    method: "PUT",
    body: enc.envelope,
  });
  if (!putRes.ok) {
    throw new MediaClientError("put-failed", `Bucket a refusé le PUT (HTTP ${putRes.status})`);
  }
  onProgress?.("put", { fraction: 1 });

  // 4. finalize (existence + taille + enveloppe vérifiés côté serveur)
  onProgress?.("finalize", { message: "Finalisation…" });
  const fts = Date.now();
  const fsig = await sign(`${me}|media-finalize|${presign.mediaId}|${fts}`);
  const finalized = await mediaApi<{ mediaId: string; objectKey: string; downloadUrl: string }>(
    "/api/media/finalize",
    {
      method: "POST",
      body: JSON.stringify({ me, mediaId: presign.mediaId, plainBytes: bytes.length, ts: fts, signature: fsig }),
    }
  );

  // 5. CEK gardé en mémoire de session (relire ses propres notes vocales)
  sessionCeks.set(finalized.mediaId, { cekB64: enc.cekB64, mediaType: "audio/opus" });

  onProgress?.("done");
  return {
    mediaId: finalized.mediaId,
    objectKey: finalized.objectKey,
    cekB64: enc.cekB64,
    mediaType: "audio/opus",
    plainBytes: bytes.length,
    sizeBytes: enc.sizeBytes,
    sha256: enc.sha256,
    durationMs,
    peaks,
    container: assertPlayableVoice(bytes), // déjà validé en tête — réflexe barrière
  };
}

export interface DownloadedVoice {
  blob: Blob;
  /** conteneur sniffré (audio/webm | audio/ogg) — type réel du Blob */
  container: SniffedOpusContainer;
  bytes: number;
  /** durée mesurée au décodage (fallback si le dm2 n'en portait pas) */
  durationMs: number | null;
  /** peaks re-décodés (fallback si le dm2 n'en portait pas) */
  peaks: number[] | null;
}

/**
 * Download note vocale : download-url → GET → decrypt → SNIFF conteneur
 * (barrière de rendu — un MP3 déguisé en opus est REFUSÉ) → Blob typé.
 * `wantMeasure` : re-décoder pour durée/peaks (si le dm2 ne les portait pas).
 */
export async function downloadVoiceNote(opts: {
  mediaId: string;
  cekB64: string;
  declaredType?: string;
  me: string;
  sign: (payload: string) => Promise<string>;
  wantMeasure?: boolean;
}): Promise<DownloadedVoice> {
  const { mediaId, cekB64, declaredType, me, sign, wantMeasure } = opts;
  const ts = Date.now();
  const signature = await sign(`${me}|media-dl|${mediaId}|${ts}`);
  const res = await fetch(
    `${apiBase()}/api/media/download-url?${new URLSearchParams({ me, mediaId, ts: String(ts), signature })}`
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new MediaClientError("download-failed", body.error ?? `HTTP ${res.status}`);
  }
  const info = (await res.json()) as { downloadUrl: string; mediaType: string };

  const dl = await fetch(toFetchUrl(info.downloadUrl));
  if (!dl.ok) {
    throw new MediaClientError("download-failed", `Bucket a refusé la lecture (HTTP ${dl.status})`);
  }
  const envelope = await dl.text();
  const plain = await decryptBytes(envelope, cekB64);
  const container = assertPlayableVoice(plain, declaredType ?? info.mediaType);
  let durationMs: number | null = null;
  let peaks: number[] | null = null;
  if (wantMeasure) {
    try {
      const m = await decodeAndMeasure(plain);
      durationMs = m.durationMs;
      peaks = m.peaks;
    } catch {
      // pas de AudioContext (harness) — la voix reste jouable via <audio>
    }
  }
  return {
    blob: new Blob([plain as unknown as BlobPart], { type: container }),
    container,
    bytes: plain.length,
    durationMs,
    peaks,
  };
}

// ── B4 — vidéo (pipeline B2 identique, SANS strip sur la vidéo) ─────────────
// Arbitrages spec §9 : la vidéo n'a PAS de strip EXIF V1 (les conteneurs
// webm/mp4 n'ont pas d'EXIF GPS à striper — les métadonnées exotiques restent
// de toute façon chiffrées et invisibles au serveur ; documenté §9.3) ; le
// type déclaré à l'API est le CONTENEUR RÉEL sniffré (video/webm | video/mp4
// — la lecture <video> en dépend) ; la THUMBNAIL, elle, est une image JPEG
// régénérée localement : elle suit le chemin image B2 COMPLET (strip canvas
// + chiffrement + presign + finalize).

export interface UploadedVideoThumb {
  mediaId: string;
  cekB64: string;
  mediaType: "image/jpeg";
  bytes: number;
  objectKey: string;
}

export interface UploadedVideo extends Omit<UploadedMedia, "previewDataUrl"> {
  durationMs: number;
  container: SniffedVideoContainer;
  width: number;
  height: number;
  /** vignette uploadée (image B2 complète) — null si la capture a échoué */
  thumb: UploadedVideoThumb | null;
}

export interface UploadVideoOptions {
  bytes: Uint8Array;
  /** durée mesurée à l'enregistrement (garde 60 s — arbitrage §9.2) */
  durationMs: number;
  width?: number;
  height?: number;
  /** vignette JPEG (captureVideoThumbnail) — uploadée comme image B2 si fournie */
  thumb?: { bytes: Uint8Array; width: number; height: number } | null;
  me: string;
  sign: (payload: string) => Promise<string>;
  onProgress?: (stage: UploadStage, info?: { fraction?: number; message?: string }) => void;
}

/** Garde d'envoi 61 s / 100 Mo / conteneur vidéo — REFUS AVANT tout octet. */
export function assertVideoSendable(bytes: Uint8Array, durationMs: number): SniffedVideoContainer {
  const v = validateVideoForSend({ bytes, durationMs });
  if (!v.ok) throw new MediaClientError("bad-type", v.reason);
  return v.container;
}

/**
 * Upload vidéo COMPLET (directive B4 : « Pipeline B2 réutilisé ») :
 * validation → chiffrement → upload-url (conteneur réel) → PUT présigné →
 * finalize → (thumbnail : chemin image B2 COMPLET avec strip canvas).
 * Pas de compression V1 — on envoie tel quel (60 s @ 480p ≈ 5–15 Mo).
 */
export async function uploadVideoNote(opts: UploadVideoOptions): Promise<UploadedVideo> {
  const { bytes, durationMs, width = 0, height = 0, thumb = null, me, sign, onProgress } = opts;

  // 0. garde d'entrée (61 s → refus ICI, jamais un upload de 110 Mo)
  const container = assertVideoSendable(bytes, durationMs);

  // 1. chiffrement client (CEK + IV uniques — enveloppe v1 identique B1/B2/B3)
  onProgress?.("encrypt", { message: "Chiffrement de bout en bout…" });
  const enc = await encryptBytes(bytes);
  if (enc.sizeBytes > VIDEO_MAX_BYTES) {
    throw new MediaClientError("too-large", `enveloppe ${enc.sizeBytes} o > ${VIDEO_MAX_BYTES}`);
  }

  // 2. upload-url (conteneur réel — preuve couvre type + taille)
  onProgress?.("presign", { message: "Demande d'URL d'upload…" });
  const ts = Date.now();
  const signature = await sign(`${me}|media-upload|${container}|${enc.sizeBytes}|${ts}`);
  const presign = await mediaApi<{
    mediaId: string;
    objectKey: string;
    uploadUrl: string;
    expiresAt: string;
  }>("/api/media/upload-url", {
    method: "POST",
    body: JSON.stringify({ me, mediaType: container, sizeBytes: enc.sizeBytes, sha256: enc.sha256, ts, signature }),
  });

  // 3. PUT présigné (même origine — proxy) ; Content-Length automatique
  onProgress?.("put", { fraction: 0, message: "Envoi de la vidéo…" });
  const putRes = await fetch(toFetchUrl(presign.uploadUrl), {
    method: "PUT",
    body: enc.envelope,
  });
  if (!putRes.ok) {
    throw new MediaClientError("put-failed", `Bucket a refusé le PUT (HTTP ${putRes.status})`);
  }
  onProgress?.("put", { fraction: 1 });

  // 4. finalize (existence + taille + enveloppe vérifiés côté serveur)
  onProgress?.("finalize", { message: "Finalisation…" });
  const fts = Date.now();
  const fsig = await sign(`${me}|media-finalize|${presign.mediaId}|${fts}`);
  const finalized = await mediaApi<{ mediaId: string; objectKey: string; downloadUrl: string }>(
    "/api/media/finalize",
    {
      method: "POST",
      body: JSON.stringify({ me, mediaId: presign.mediaId, plainBytes: bytes.length, ts: fts, signature: fsig }),
    }
  );

  // 5. CEK vidéo gardé en mémoire de session (relire ses propres vidéos)
  sessionCeks.set(finalized.mediaId, { cekB64: enc.cekB64, mediaType: container });

  // 6. thumbnail — chemin image B2 COMPLET (strip canvas régénéré localement
  //    sans métadonnée + chiffrement + presign + finalize). Sa perte n'empêche
  //    PAS l'envoi de la vidéo (la bulle retombe sur le player natif).
  let uploadedThumb: UploadedVideoThumb | null = null;
  if (thumb && thumb.bytes.length > 0) {
    try {
      onProgress?.("strip", { message: "Vignette…" });
      const stripThumb =
        defaultStrip ??
        (typeof document !== "undefined"
          ? async (b: Uint8Array) => (await stripExifClient(b)).bytes
          : undefined);
      // hors navigateur ET sans strip injecté : la vignette régénérée par
      // canvas ne porte de toute façon aucune métadonnée — envoi direct.
      const cleanThumb = stripThumb ? await stripThumb(thumb.bytes) : thumb.bytes;
      const tEnc = await encryptBytes(cleanThumb);
      const tts = Date.now();
      const tsig = await sign(`${me}|media-upload|image/jpeg|${tEnc.sizeBytes}|${tts}`);
      const tPresign = await mediaApi<{
        mediaId: string;
        objectKey: string;
        uploadUrl: string;
      }>("/api/media/upload-url", {
        method: "POST",
        body: JSON.stringify({ me, mediaType: "image/jpeg", sizeBytes: tEnc.sizeBytes, sha256: tEnc.sha256, ts: tts, signature: tsig }),
      });
      const tPut = await fetch(toFetchUrl(tPresign.uploadUrl), { method: "PUT", body: tEnc.envelope });
      if (!tPut.ok) throw new Error(`PUT vignette HTTP ${tPut.status}`);
      const tfts = Date.now();
      const tfsig = await sign(`${me}|media-finalize|${tPresign.mediaId}|${tfts}`);
      const tFinal = await mediaApi<{ mediaId: string; objectKey: string }>(
        "/api/media/finalize",
        {
          method: "POST",
          body: JSON.stringify({ me, mediaId: tPresign.mediaId, plainBytes: cleanThumb.length, ts: tfts, signature: tfsig }),
        }
      );
      sessionCeks.set(tFinal.mediaId, { cekB64: tEnc.cekB64, mediaType: "image/jpeg" });
      uploadedThumb = {
        mediaId: tFinal.mediaId,
        cekB64: tEnc.cekB64,
        mediaType: "image/jpeg",
        bytes: cleanThumb.length,
        objectKey: tFinal.objectKey,
      };
    } catch {
      uploadedThumb = null; // la vidéo reste envoyable sans vignette
    }
  }

  onProgress?.("done");
  return {
    mediaId: finalized.mediaId,
    objectKey: finalized.objectKey,
    cekB64: enc.cekB64,
    mediaType: container,
    plainBytes: bytes.length,
    sizeBytes: enc.sizeBytes,
    sha256: enc.sha256,
    durationMs,
    container, // déjà validé en tête — réflexe barrière
    width,
    height,
    thumb: uploadedThumb,
  };
}

export interface DownloadedVideo {
  blob: Blob;
  /** conteneur sniffré (video/webm | video/mp4) — type réel du Blob */
  container: SniffedVideoContainer;
  bytes: number;
}

/**
 * Download vidéo : download-url (TTL 1 h pour video/*) → GET → decrypt →
 * SNIFF conteneur VIDÉO (barrière de rendu — un webm AUDIO / un MP3 déguisé
 * est REFUSÉ) → Blob typé.
 */
export async function downloadVideoNote(opts: {
  mediaId: string;
  cekB64: string;
  declaredType?: string;
  me: string;
  sign: (payload: string) => Promise<string>;
}): Promise<DownloadedVideo> {
  const { mediaId, cekB64, declaredType, me, sign } = opts;
  const ts = Date.now();
  const signature = await sign(`${me}|media-dl|${mediaId}|${ts}`);
  const res = await fetch(
    `${apiBase()}/api/media/download-url?${new URLSearchParams({ me, mediaId, ts: String(ts), signature })}`
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new MediaClientError("download-failed", body.error ?? `HTTP ${res.status}`);
  }
  const info = (await res.json()) as { downloadUrl: string; mediaType: string };

  const dl = await fetch(toFetchUrl(info.downloadUrl));
  if (!dl.ok) {
    throw new MediaClientError("download-failed", `Bucket a refusé la lecture (HTTP ${dl.status})`);
  }
  const envelope = await dl.text();
  const plain = await decryptBytes(envelope, cekB64);
  const container = assertPlayableVideo(plain, declaredType ?? info.mediaType);
  return {
    blob: new Blob([plain as unknown as BlobPart], { type: container }),
    container,
    bytes: plain.length,
  };
}
