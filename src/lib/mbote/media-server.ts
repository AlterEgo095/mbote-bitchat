/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-server — règles métier B2 côté serveur (spec MEDIA-ENVELOPE-SPEC §7.1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - whitelist d'UPLOAD B2 : image/jpeg | image/png | image/webp (directive) ;
 *  - limite image : 5 Mo (MEDIA_LIMITS du socle B1) ;
 *  - quota : 500 Mo cumulés par compte (SUM sizeBytes des médias finalisés) ;
 *  - rate limit : 20 uploads/h/utilisateur (RateStore existant) ;
 *  - TTL presign : 900 s (défaut B1) ; fenêtre de finalisation : 20 min.
 *
 *  Le serveur reste AVEUGLE (arbitrage §6.7) : il n'aucun accès au plaintext,
 *  jamais au CEK. Il ne tient que la table Media (mediaId ↔ objectKey) et le
 *  décompte de quota.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  MEDIA_LIMITS,
  MediaStorageError,
  storageConfigFromEnv,
  type MediaStorageConfig,
} from "./media/storage";

/** Whitelist d'upload B2/B3/B4 (directives B2 images + B3 « contentType:
 *  'audio/opus' » + B4 « contentType: 'video/mp4' et 'video/webm' »).
 *  Le socle B1 porte aussi webm/ogg/mp4 (conteneurs bruts) — la surface API
 *  expose les types CANONIQUES vidéo (conteneur RÉEL sniffré : la lecture
 *  <video> dépend du conteneur, contrairement à l'opus qui déclarait un type
 *  unique). Rejet explicite des autres formats (avi/mov/mkv → 400, message
 *  clair — arbitrage §9.5). */
export const B2_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/opus",
  "video/mp4",
  "video/webm",
] as const;
export type B2UploadType = (typeof B2_UPLOAD_TYPES)[number];

export function isB2UploadType(mediaType: string): mediaType is B2UploadType {
  return (B2_UPLOAD_TYPES as readonly string[]).includes(mediaType);
}

/** Limite d'upload PAR TYPE (spec §2) : image 5 Mo, audio/opus 10 Mo (B3 —
 *  permet ~5 min à 12 kbps ; l'UI borne la voix à 60 s de toute façon),
 *  vidéo 100 Mo (B4 — 60 s @ 480p ≈ 5–15 Mo, la marge absorbe la 720p). */
export const B2_UPLOAD_LIMITS: Record<B2UploadType, number> = {
  "image/jpeg": 5 * 1024 * 1024,
  "image/png": 5 * 1024 * 1024,
  "image/webp": 5 * 1024 * 1024,
  "audio/opus": 10 * 1024 * 1024,
  "video/mp4": 100 * 1024 * 1024,
  "video/webm": 100 * 1024 * 1024,
};

/** Limite d'upload image — 5 Mo (spec §2, conservé pour compat B2). */
export const B2_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Limite applicable à un type (0 si type inconnu — l'appelant renvoie 400). */
export function b2UploadLimitFor(mediaType: string): number {
  return (B2_UPLOAD_LIMITS as Record<string, number>)[mediaType] ?? 0;
}

/** Quota par compte — 500 Mo de médias FINALISÉS cumulés (spec §2). */
export const B2_QUOTA_BYTES = 500 * 1024 * 1024;

/** Rate limit uploads — 20/h/utilisateur (directive B2). */
export const B2_UPLOAD_RATE_PER_HOUR = 20;
export const B2_RATE_WINDOW_MS = 3_600_000;

/** Fenêtre de finalisation : une ligne `pending` créée il y a plus longtemps
 *  que le TTL presign + marge n'est plus finalisable (l'objet n'a pas pu
 *  être écrit : URL expirée). 20 min = 15 min TTL + 5 min de marge. */
export const B2_FINALIZE_WINDOW_MS = 20 * 60_000;

/** TTL presign de LECTURE vidéo — 1 h (directive B4 : « durée plus longue —
 *  1h au lieu de 15 min, pour permettre la lecture » — le blob déchiffré
 *  est re-téléchargeable pendant la session sans re-signer à chaque
 *  seek). Les images/audio gardent 15 min. */
export const B2_VIDEO_DOWNLOAD_TTL_S = 3600;

/**
 * Config storage B1 — erreur typée → la route répond 503 « média non
 * configuré » (déploiement sans bucket : le reste de l'app vit normalement).
 */
export function requireStorageConfig(): MediaStorageConfig {
  return storageConfigFromEnv();
}

/** Le stockage est-il configuré ? (sans throw — pour les réponses 503 propres) */
export function storageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    storageConfigFromEnv(env);
    return true;
  } catch (e) {
    return e instanceof MediaStorageError && e.code !== "not-configured";
  }
}

/**
 * Origine PUBLIQUE à signer dans les presigned URLs données au navigateur.
 *  - prod R2 : MEDIA_S3_PUBLIC_ENDPOINT fixé → URLs signées pour le host R2
 *    (CORS configuré sur le bucket — runbook de déploiement).
 *  - dev/sandbox (défaut) : l'origine de la requête courante (host header —
 *    Caddy le préserve) → URLs MÊME ORIGINE relayées par /api/media/proxy
 *    (route relay + rewrite beforeFiles dans next.config.ts).
 */
export function publicStorageOrigin(req: { headers: Headers }): string {
  const envPublic = process.env.MEDIA_S3_PUBLIC_ENDPOINT;
  if (envPublic) return envPublic.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto")?.split(",")[0] ?? "http").trim();
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

/** Config dérivée : même credentials, endpoint PUBLIC (host signé = host navigateur). */
export function publicStorageConfig(cfg: MediaStorageConfig, publicOrigin: string): MediaStorageConfig {
  return { ...cfg, endpoint: publicOrigin };
}

/**
 * Presigned URL → chemin RELATIF de PROXY (le navigateur ne parle jamais au
 * S3 direct : CSP connect-src 'self', pas de preflight CORS). La signature
 * SigV4 couvre le CHEMIN S3 CANONIQUE (/<bucket>/media/<uuid>) — le proxy
 * reconstruit exactement ce chemin depuis ses segments [...path] et transmet
 * la query intacte, donc la validation du bucket reste inchangée.
 *   http://host/mbote-media-test/media/<uuid>?X-Amz-…
 *   → /media-proxy/mbote-media-test/media/<uuid>?X-Amz-…
 */
export function proxyPresignedPath(presignedUrl: string): string {
  const u = new URL(presignedUrl);
  return `/media-proxy${u.pathname}${u.search}`;
}

export { MEDIA_LIMITS, MediaStorageError };
