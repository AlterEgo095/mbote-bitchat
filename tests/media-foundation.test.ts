/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS B1 — socle média (crypto enveloppe v1 + strip EXIF + présignature)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/media-foundation.test.ts
 *  (unitaires purs — AUCUN serveur, AUCUNE DB ; MinIO = test dédié skippé
 *   sans docker : tests/media-minio-integration.test.ts)
 *
 *  Directive B1 :
 *   A. round-trip encrypt/decrypt (10 Ko, 1 Mo, 5 Mo)
 *   B. altération du ciphertext → décryptage échoue PROPREMENT (pas de crash)
 *   C. IV réutilisé → refus explicite
 *   D. strip EXIF : image avec GPS → GPS absent, taille post-strip ≤ originale,
 *      orientation CUITE dans les pixels (tranchage spec §5.2)
 *   E. Presigned URL : TTL respecté (15 min défaut), méthode respectée,
 *      URL expirée → refus
 *   F. limites par type + whitelist clés d'objet
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  MediaCryptoError,
  CEK_BYTES,
  IV_BYTES,
  TAG_BYTES,
  generateCek,
  encryptMedia,
  decryptMedia,
  __testing,
} from "../src/lib/mbote/media/crypto";
import {
  MediaExifError,
  IMAGE_MAX_BYTES,
  stripExif,
  inspectMetadata,
} from "../src/lib/mbote/media/exif";
import {
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
} from "../src/lib/mbote/media/storage";

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

const FIXTURE_GPS = join(process.cwd(), "tests", "fixtures", "media-gps-sample.jpg");
const CFG: MediaStorageConfig = {
  driver: "minio",
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "mbote-media-test",
  accessKeyId: "minio-test-key",
  secretAccessKey: "minio-test-secret-0123456789abcdef",
};

/** Image « photo-like » déterministe (bruit structuré — difficile à compresser). */
async function makePhotoLikeJpeg(width = 1200, height = 800): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[i] = (seed >>> 24) & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

// ═════════════════════════════════════════════════════════════════════════════
describe("B1 · A — enveloppe v1 : round-trip (directive : 10 Ko, 1 Mo, 5 Mo)", () => {
  const sizes: Array<[string, number]> = [
    ["10 Ko", 10 * 1024],
    ["1 Mo", 1024 * 1024],
    ["5 Mo", 5 * 1024 * 1024],
  ];
  for (const [label, size] of sizes) {
    test(`round-trip ${label} → octets identiques`, () => {
      const cek = generateCek();
      const plaintext = new Uint8Array(size);
      // remplissage déterministe (bruit, pas des zéros — attrape les accidents)
      let seed = 0x12345678;
      for (let i = 0; i < size; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        plaintext[i] = seed & 0xff;
      }
      const { envelope, iv } = encryptMedia(plaintext, cek);
      expect(iv.length).toBe(IV_BYTES);
      const decrypted = decryptMedia(envelope, cek);
      expect(decrypted.length).toBe(size);
      let diff = 0;
      for (let i = 0; i < size; i++) if (decrypted[i] !== plaintext[i]) diff++;
      expect(diff).toBe(0);
    });
  }

  test("format v1:iv:ciphertext:tag — 4 segments, IV 12 o, tag 16 o, base64url", () => {
    const cek = generateCek();
    const { envelope } = encryptMedia(new Uint8Array(1024), cek);
    const parts = envelope.split(":");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64url").length).toBe(IV_BYTES);
    expect(Buffer.from(parts[2], "base64url").length).toBe(1024);
    expect(Buffer.from(parts[3], "base64url").length).toBe(TAG_BYTES);
    // base64url : pas de +, /, =
    expect(envelope).not.toMatch(/[+/=]/);
  });

  test("generateCek : 32 octets, deux appels distincts", () => {
    const a = generateCek();
    const b = generateCek();
    expect(a.length).toBe(CEK_BYTES);
    expect(b.length).toBe(CEK_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBeFalse();
  });

  test("mauvais CEK au déchiffrement → auth-failed (échec propre)", () => {
    const { envelope } = encryptMedia(new Uint8Array(256), generateCek());
    expect(() => decryptMedia(envelope, generateCek())).toThrow(MediaCryptoError);
    try {
      decryptMedia(envelope, generateCek());
    } catch (e) {
      expect((e as MediaCryptoError).code).toBe("auth-failed");
    }
  });
});

describe("B1 · B — altération → échec PROPRE (jamais de crash)", () => {
  const cek = generateCek();
  const plaintext = new Uint8Array(4096).fill(0x5a);
  const { envelope } = encryptMedia(plaintext, cek);
  const parts = envelope.split(":");

  const tamper = (index: number, flip: number): string => {
    const p = [...parts];
    const buf = Buffer.from(p[index], "base64url");
    buf[0] ^= flip;
    p[index] = buf.toString("base64url");
    return p.join(":");
  };

  test("ciphertext altéré → MediaCryptoError auth-failed", () => {
    const bad = tamper(2, 0x01);
    let thrown: unknown;
    try {
      decryptMedia(bad, cek);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaCryptoError);
    expect((thrown as MediaCryptoError).code).toBe("auth-failed");
  });

  test("tag altéré → MediaCryptoError auth-failed", () => {
    let thrown: unknown;
    try {
      decryptMedia(tamper(3, 0xff), cek);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as MediaCryptoError).code).toBe("auth-failed");
  });

  test("IV altéré → échec propre (auth-failed)", () => {
    let thrown: unknown;
    try {
      decryptMedia(tamper(1, 0x10), cek);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaCryptoError);
  });

  test("enveloppes malformées → bad-envelope (préfixe, segments, longueurs, vide)", () => {
    const cases = [
      "v2:aaaa:bbbb:cccc",
      "v1:only:two",
      "v1:aaaa:bbbb:cccc:extra",
      `v1:${Buffer.alloc(8).toString("base64url")}:bbbb:cccc`, // IV 8 o
      `v1:${Buffer.alloc(12).toString("base64url")}:YWFh:${Buffer.alloc(8).toString("base64url")}`, // tag 8 o
      `v1:${Buffer.alloc(12).toString("base64url")}:${Buffer.alloc(0).toString("base64url")}:${Buffer.alloc(16).toString("base64url")}`, // vide
      "pas-une-enveloppe",
      "",
    ];
    for (const env of cases) {
      let thrown: unknown;
      try {
        decryptMedia(env, cek);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `cas ${env.slice(0, 30)}`).toBeInstanceOf(MediaCryptoError);
      expect((thrown as MediaCryptoError).code).toBe("bad-envelope");
    }
  });

  test("CEK de mauvaise taille → bad-cek (chiffrement et déchiffrement)", () => {
    const short = new Uint8Array(16);
    expect(() => encryptMedia(new Uint8Array(16), short)).toThrow(MediaCryptoError);
    expect(() => decryptMedia(envelope, short)).toThrow(MediaCryptoError);
  });
});

describe("B1 · C — IV réutilisé → REFUS EXPLICITE (garde process-wide)", () => {
  test("sealWithIv deux fois avec le MÊME IV → MediaCryptoError iv-reused", () => {
    const cek = generateCek();
    const iv = new Uint8Array(IV_BYTES).fill(0x42);
    const first = __testing.sealWithIv(new Uint8Array([1, 2, 3]), cek, iv);
    expect(first.startsWith("v1:")).toBeTrue();
    let thrown: unknown;
    try {
      __testing.sealWithIv(new Uint8Array([4, 5, 6]), cek, iv);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaCryptoError);
    expect((thrown as MediaCryptoError).code).toBe("iv-reused");
  });

  test("même IV + CEKs différents → refus aussi (la garde porte sur l'IV enregistré)", () => {
    const iv = new Uint8Array(IV_BYTES).fill(0x43);
    __testing.sealWithIv(new Uint8Array([1]), generateCek(), iv);
    expect(() => __testing.sealWithIv(new Uint8Array([1]), generateCek(), iv)).toThrow(MediaCryptoError);
  });

  test("1000 scellés aléatoires → 1000 IV distincts (jamais de collision)", () => {
    const cek = generateCek();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { iv } = encryptMedia(new Uint8Array(16), cek);
      const k = __testing.ivKey(iv);
      expect(seen.has(k)).toBeFalse(); // la garde refuse TOUTE collision
      seen.add(k);
    }
    expect(seen.size).toBe(1000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("B1 · D — strip EXIF (directive : GPS absent, taille ≤, orientation tranchée)", () => {
  test("fixture GPS (EXIF complet, orientation 6) → EXIF ABSENT après strip", async () => {
    const fixture = readFileSync(FIXTURE_GPS);
    // pré-condition : la fixture PORTE bien un EXIF (avec pointeur GPS 0x8825)
    const before = await inspectMetadata(fixture);
    expect(before.exif).toBeDefined();
    expect(Buffer.from(must(before.exif, "exif fixture")).includes(Buffer.from([0x25, 0x88]))).toBeTrue();
    expect(before.orientation).toBe(6);

    const result = await stripExif(fixture);
    const after = await inspectMetadata(result.bytes);
    // GPS absent : plus AUCUN exif du tout (le strip vire l'IFD complet)
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined(); // plus de métadonnée d'orientation
  });

  test("orientation CUITE dans les pixels : 4×3 stocké + orientation 6 → 3×4 en sortie", async () => {
    const fixture = readFileSync(FIXTURE_GPS);
    const result = await stripExif(fixture);
    expect(result.width).toBe(3); // dimensions FINALES = orientées (tranchage §5.2)
    expect(result.height).toBe(4);
  });

  test("taille post-strip ≤ taille originale (fixture GPS)", async () => {
    const fixture = readFileSync(FIXTURE_GPS);
    const result = await stripExif(fixture);
    expect(result.bytesAfter).toBeLessThanOrEqual(result.bytesBefore);
  });

  test("image photo-like 1200×800 → EXIF absent + taille post-strip ≤ originale", async () => {
    const photo = await makePhotoLikeJpeg();
    const result = await stripExif(photo);
    expect(result.format).toBe("jpeg");
    expect(result.width).toBe(1200);
    expect(result.height).toBe(800);
    const after = await inspectMetadata(result.bytes);
    expect(after.exif).toBeUndefined();
    expect(result.bytesAfter).toBeLessThanOrEqual(result.bytesBefore);
  });

  test("PNG → strip OK, EXIF absent, format conservé", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 30 } } }).png().toBuffer();
    const result = await stripExif(png);
    expect(result.format).toBe("png");
    const after = await inspectMetadata(result.bytes);
    expect(after.exif).toBeUndefined();
  });

  test("entrée non-image → MediaExifError bad-image (pas de crash)", async () => {
    let thrown: unknown;
    try {
      await stripExif(new Uint8Array(1024).fill(0x00));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaExifError);
    expect((thrown as MediaExifError).code).toBe("bad-image");
  });

  test("image > 5 Mo → MediaExifError too-large AVANT sharp (limite spec §2)", async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1).fill(0xff);
    let thrown: unknown;
    try {
      await stripExif(big);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaExifError);
    expect((thrown as MediaExifError).code).toBe("too-large");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("B1 · E — URLs présignées (TTL 15 min, méthode, expiration)", () => {
  test("PUT présigné — structure sigv4, TTL par défaut 900 s (15 min, directive)", () => {
    const key = newObjectKey();
    const p = generatePresignedUrl(CFG, key, { contentLength: 12345 });
    expect(p.ttlSec).toBe(PRESIGN_TTL_DEFAULT_S); // 900 = 15 min
    expect(p.method).toBe("PUT");
    const u = new URL(p.url);
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host"); // taille liée
    expect(u.searchParams.get("content-length")).toBe("12345");
    expect((u.searchParams.get("X-Amz-Signature") ?? "").length).toBe(64);
    expect(u.pathname).toBe(`/${CFG.bucket}/${key}`);
  });

  test("verifyPresignedUrl (fraîche) → ok + objectKey round-trip", () => {
    const key = newObjectKey();
    const p = generatePresignedUrl(CFG, key, { contentLength: 42, now: new Date("2026-11-06T10:00:00Z") });
    const r = verifyPresignedUrl(CFG, p.url, "PUT", { now: new Date("2026-11-06T10:05:00Z") });
    expect(r.ok).toBeTrue();
    expect(r.objectKey).toBe(key);
    expect(r.method).toBe("PUT");
  });

  test("URL expirée → REFUS (MediaStorageError expired)", () => {
    const p = generatePresignedUrl(CFG, newObjectKey(), { contentLength: 1, now: new Date("2026-11-06T10:00:00Z") });
    let thrown: unknown;
    try {
      verifyPresignedUrl(CFG, p.url, "PUT", { now: new Date("2026-11-06T10:15:01Z") }); // +900 s + 1
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaStorageError);
    expect((thrown as MediaStorageError).code).toBe("expired");
  });

  test("URL encore valide à la LIMITE (900 s exactement) → ok", () => {
    const p = generatePresignedUrl(CFG, newObjectKey(), { contentLength: 1, now: new Date("2026-11-06T10:00:00Z") });
    const r = verifyPresignedUrl(CFG, p.url, "PUT", { now: new Date("2026-11-06T10:15:00Z") });
    expect(r.ok).toBeTrue();
  });

  test("méthode respectée : URL PUT vérifiée en GET → refus (signed headers ≠)", () => {
    const p = generatePresignedUrl(CFG, newObjectKey(), { contentLength: 7 });
    let thrown: unknown;
    try {
      verifyPresignedUrl(CFG, p.url, "GET");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MediaStorageError);
  });

  test("signature altérée → bad-signature ; objectKey altéré → bad-signature", () => {
    const p = generatePresignedUrl(CFG, newObjectKey(), { contentLength: 7 });
    // flip DÉTERMINISTE du premier hex (0→1 sinon a→b — jamais un no-op)
    const evil1 = p.url.replace(/X-Amz-Signature=([0-9a-f])/, (m, c: string) =>
      m.replace(c, c === "a" ? "b" : "a")
    );
    expect(evil1).not.toBe(p.url); // garde : l'altération a bien eu lieu
    expect(() => verifyPresignedUrl(CFG, evil1, "PUT")).toThrow(MediaStorageError);
    // altérer le chemin (objectKey) : le canonical request change → signature ≠
    const evil2 = p.url.replace("/media/", "/mediX/");
    expect(evil2).not.toBe(p.url); // garde : l'altération a bien eu lieu
    expect(() => verifyPresignedUrl(CFG, evil2, "PUT")).toThrow(MediaStorageError);
  });

  test("TTL borné 60…3600 s (30 s et 4000 s → refus), GET sans contentLength OK", () => {
    expect(() => generatePresignedUrl(CFG, newObjectKey(), { contentLength: 1, ttlSec: 30 })).toThrow(MediaStorageError);
    expect(() => generatePresignedUrl(CFG, newObjectKey(), { contentLength: 1, ttlSec: 4000 })).toThrow(MediaStorageError);
    const g = generatePresignedUrl(CFG, newObjectKey(), { method: "GET", ttlSec: 300 });
    expect(g.method).toBe("GET");
    const r = verifyPresignedUrl(CFG, g.url, "GET");
    expect(r.ok).toBeTrue();
  });

  test("PUT sans contentLength → refus (taille imposée, spec §4.3)", () => {
    expect(() => generatePresignedUrl(CFG, newObjectKey(), { method: "PUT" })).toThrow(MediaStorageError);
  });

  test("driver r2 (région auto) → présignature + vérification OK", () => {
    const r2cfg: MediaStorageConfig = { ...CFG, driver: "r2", region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com" };
    const p = generatePresignedUrl(r2cfg, newObjectKey(), { contentLength: 9 });
    expect(verifyPresignedUrl(r2cfg, p.url, "PUT").ok).toBeTrue();
  });

  test("config depuis l'env : variable manquante → not-configured", () => {
    expect(() => storageConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(MediaStorageError);
    const cfg = storageConfigFromEnv({
      MEDIA_STORAGE_DRIVER: "minio",
      MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
      MEDIA_S3_BUCKET: "b",
      MEDIA_S3_ACCESS_KEY_ID: "k",
      MEDIA_S3_SECRET_ACCESS_KEY: "s",
    } as NodeJS.ProcessEnv);
    expect(cfg.region).toBe("us-east-1");
  });
});

describe("B1 · F — limites par type + whitelist clés (spec §2, §4.2)", () => {
  test("MEDIA_LIMITS : image 5 Mo, audio 10 Mo, vidéo 100 Mo (directive)", () => {
    expect(MEDIA_LIMITS["image/jpeg"]).toBe(5 * 1024 * 1024);
    expect(MEDIA_LIMITS["audio/webm"]).toBe(10 * 1024 * 1024);
    expect(MEDIA_LIMITS["video/mp4"]).toBe(100 * 1024 * 1024);
  });

  test("assertMediaLimit : dépassement → too-large, type hors whitelist → refus", () => {
    expect(() => assertMediaLimit("image/jpeg", 5 * 1024 * 1024 + 1)).toThrow(MediaStorageError);
    expect(() => assertMediaLimit("image/jpeg", 5 * 1024 * 1024)).not.toThrow();
    expect(() => assertMediaLimit("video/mp4", 100 * 1024 * 1024)).not.toThrow();
    expect(() => assertMediaLimit("image/gif", 10)).toThrow(MediaStorageError);
    let thrown: unknown;
    try {
      assertMediaLimit("image/gif", 10);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as MediaStorageError).code).toBe("bad-media-type");
    expect(() => assertMediaLimit("image/jpeg", 0)).toThrow(MediaStorageError);
  });

  test("assertObjectKey : uuid v4 OK — traversée de chemin / clé exotique → refus", () => {
    expect(() => assertObjectKey("media/123e4567-e89b-42d3-a456-426614174000")).not.toThrow();
    expect(() => assertObjectKey("media/../secret")).toThrow(MediaStorageError);
    expect(() => assertObjectKey("users/123e4567-e89b-42d3-a456-426614174000")).toThrow(MediaStorageError);
    expect(() => assertObjectKey("media/not-a-uuid")).toThrow(MediaStorageError);
    expect(() => assertObjectKey("")).toThrow(MediaStorageError);
  });

  test("newObjectKey : aucune identité utilisateur dans la clé", () => {
    const k = newObjectKey();
    expect(k.startsWith("media/")).toBeTrue();
    expect(() => assertObjectKey(k)).not.toThrow();
  });
});
