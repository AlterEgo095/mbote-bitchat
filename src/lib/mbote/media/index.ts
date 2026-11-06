/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media — socle média B1 (barrel). AUCUNE route API activée (directive B1).
 * ─────────────────────────────────────────────────────────────────────────────
 *  - crypto  : enveloppe v1 (CEK par objet, IV unique, AES-256-GCM) — spec §1
 *  - exif    : stripExif (GPS/dates/appareil supprimés, orientation cuite) — §5
 *  - storage : présignature S3 SigV4 (R2/MinIO, TTL 15 min, PUT borné) — §4
 *  Spec complète : docs/MEDIA-ENVELOPE-SPEC.md
 * ─────────────────────────────────────────────────────────────────────────────
 */

export {
  ENVELOPE_VERSION,
  IV_BYTES,
  CEK_BYTES,
  TAG_BYTES,
  MediaCryptoError,
  generateCek,
  encryptMedia,
  decryptMedia,
  envelopesEqual,
  type EncryptedMedia,
} from "./crypto";
export {
  MediaExifError,
  IMAGE_MAX_BYTES,
  stripExif,
  inspectMetadata,
  type StripResult,
} from "./exif";
export {
  MediaStorageError,
  MEDIA_LIMITS,
  PRESIGN_TTL_DEFAULT_S,
  assertMediaLimit,
  assertObjectKey,
  newObjectKey,
  storageConfigFromEnv,
  generatePresignedUrl,
  verifyPresignedUrl,
  type MediaStorageConfig,
  type MediaType,
  type PresignMethod,
  type PresignOptions,
  type PresignedUrl,
  type VerifyResult,
} from "./storage";
