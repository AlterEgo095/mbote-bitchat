/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-real-s3 — SigV4 B1 contre un S3 RÉEL indépendant (directive B2 :
 *  « Les presigned URLs n'ont jamais parlé à un vrai S3 »)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Serveur : SeaweedFS 3.80 (weed) — implémentation S3 tierce avec validation
 *  SigV4 COMPLÈTE (weed/s3api/auth_signature_v4.go : signature re-calculée,
 *  expiration appliquée GET et PUT, access key vérifiée). Choix tranché
 *  (arbitrage B2 §1) : docker ABSENT du sandbox, dl.min.io bloqué (HTTP 410),
 *  aucun binaire MinIO sur GitHub releases, R2/B2 = credentials opérateur
 *  indisponibles. Le compose MinIO (deploy/docker-compose.minio.yml) reste la
 *  voie de rejeu sur VPS/dev local.
 *
 *  PRÉREQUIS (le runner scripts/b2-s3-real-proof-run.sh fait tout) :
 *    1. weed 3.80 en écoute sur MEDIA_S3_ENDPOINT (défaut 127.0.0.1:9100),
 *       auth activée par -s3.config (identities + credentials jetables) ;
 *    2. bucket MEDIA_S3_BUCKET déjà créé (phase anonyme du runner) ;
 *    3. MEDIA_REAL_S3=1 (sinon SKIP propre — jamais de faux rouge).
 *
 *  SCÉNARIOS (directive B2 — prérequis bloquant) :
 *    G1  PUT présigné via B1 → 200 sur le S3 réel
 *    G2  l'objet existe (GET 200, taille exacte ; clé absente → 404)
 *    G3  intégrité : SHA-256 téléchargé == original (2 Mio aléatoires)
 *    G4  signature FALSIFIÉE → 403 (prouve que le serveur valide VRAIMENT)
 *    G5  flux B1 complet : stripExif → chiffrement CEK → PUT → GET →
 *        décryptage → hash identique
 *    G6  expiration (MEDIA_S3_EXPIRY_TEST=1) : TTL 60 s + attente 61 s →
 *        GET ET PUT refusés 403 « Request has expired », objet NON écrit
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptMedia, generateCek, encryptMedia } from "../src/lib/mbote/media/crypto";
import { stripExif } from "../src/lib/mbote/media/exif";
import {
  generatePresignedUrl,
  newObjectKey,
  type MediaStorageConfig,
} from "../src/lib/mbote/media/storage";

const CFG: MediaStorageConfig = {
  driver: "minio",
  endpoint: process.env.MEDIA_S3_ENDPOINT ?? "http://127.0.0.1:9100",
  region: process.env.MEDIA_S3_REGION ?? "us-east-1",
  bucket: process.env.MEDIA_S3_BUCKET ?? "mbote-media-test",
  accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID ?? "mbote-media-test",
  secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY ?? "mbote-media-test-secret",
};

/** Gate MODULE-LEVEL (pattern B1 : describe.skipIf — jamais de faux rouge).
 *  MEDIA_REAL_S3=1 = le runner (scripts/b2-s3-real-proof-run.sh) garantit un
 *  serveur authentifié sur MEDIA_S3_ENDPOINT ; sinon tout est skippé. */
const ENABLED = process.env.MEDIA_REAL_S3 === "1";

beforeAll(async () => {
  if (!ENABLED) return;
  // contrôle ping : une requête NON signée doit être refusée 403 par un
  // serveur authentifié — 200 (anonyme ouvert) ferait échouer le prérequis
  const res = await fetch(`${CFG.endpoint}/${CFG.bucket}/`, { method: "GET" });
  if (res.status !== 403) {
    throw new Error(
      `S3 réel : ${CFG.endpoint} ne répond pas en mode authentifié (HTTP ${res.status} au lieu de 403). ` +
        "Lance scripts/b2-s3-real-proof-run.sh (weed + credentials + bucket)."
    );
  }
});

describe.skipIf(!ENABLED)("B2 · prérequis — SigV4 B1 contre S3 réel indépendant (SeaweedFS)", () => {
  test(
    "G1+G2+G3 — PUT présigné → objet existe → GET intégrité SHA-256",
    async () => {
      const objectKey = newObjectKey();
      const payload = Buffer.from(
        Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251)
      );
      const expectedSha = createHash("sha256").update(payload).digest("hex");

      // G1 — PUT présigné (content-length exact lié par la signature)
      const put = generatePresignedUrl(CFG, objectKey, {
        method: "PUT",
        contentLength: payload.length,
      });
      const rPut = await fetch(put.url, {
        method: "PUT",
        body: payload,
        headers: { "content-length": String(payload.length) },
      });
      expect(rPut.status).toBe(200);

      // G2 — l'objet existe (GET 200 taille exacte ; clé absente → 404)
      const get = generatePresignedUrl(CFG, objectKey, { method: "GET" });
      const rGet = await fetch(get.url);
      expect(rGet.status).toBe(200);
      const missing = generatePresignedUrl(CFG, newObjectKey(), { method: "GET" });
      expect((await fetch(missing.url)).status).toBe(404);

      // G3 — intégrité
      const body = Buffer.from(await rGet.arrayBuffer());
      expect(body.length).toBe(payload.length);
      expect(createHash("sha256").update(body).digest("hex")).toBe(expectedSha);
    }
  );

  test("G4 — signature falsifiée → 403 (le serveur S3 valide VRAIMENT SigV4)", async () => {
    const objectKey = newObjectKey();
    const get = generatePresignedUrl(CFG, objectKey, { method: "GET" });
    const tampered = new URL(get.url);
    tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
    const res = await fetch(tampered.toString());
    expect(res.status).toBe(403);
  });

  test(
    "G5 — flux B1 complet : stripExif → CEK → PUT → GET → décryptage → hash",
    async () => {
      // Fixture JPEG réelle avec EXIF GPS (tests/fixtures — créée par
      // scripts/b1-make-gps-fixture.ts, même fixture que le test B1 GPS)
      const jpeg = readFileSync(join(import.meta.dir, "fixtures", "media-gps-sample.jpg"));
      expect(jpeg.length).toBeGreaterThan(100);
      const stripped = await stripExif(jpeg);
      expect(stripped.bytes.length).toBeLessThan(jpeg.length); // l'EXIF a été retiré

      const cek = generateCek();
      const { envelope } = encryptMedia(stripped.bytes, cek);
      const objectKey = newObjectKey();

      const put = generatePresignedUrl(CFG, objectKey, {
        method: "PUT",
        contentLength: Buffer.byteLength(envelope),
      });
      const rPut = await fetch(put.url, {
        method: "PUT",
        body: Buffer.from(envelope, "utf8"),
        headers: { "content-length": String(Buffer.byteLength(envelope)) },
      });
      expect(rPut.status).toBe(200);

      const get = generatePresignedUrl(CFG, objectKey, { method: "GET" });
      const rGet = await fetch(get.url);
      expect(rGet.status).toBe(200);
      const downloaded = Buffer.from(await rGet.arrayBuffer());
      const plain = decryptMedia(downloaded.toString("utf8"), cek);
      const shaStripped = createHash("sha256").update(stripped.bytes).digest("hex");
      const shaPlain = createHash("sha256").update(plain).digest("hex");
      expect(shaPlain).toBe(shaStripped);
    }
  );

  test(
    "G6 — expiration : TTL 60 s + 61 s → GET et PUT refusés 403, objet non écrit",
    { timeout: 120_000 },
    async () => {
      const expKey = newObjectKey();
      const putExpired = generatePresignedUrl(CFG, expKey, {
        method: "PUT",
        contentLength: 4,
        ttlSec: 60, // TTL minimum (TTL_MIN_S) — attente réelle 61 s
      });
      const getExpired = generatePresignedUrl(CFG, expKey, { method: "GET", ttlSec: 60 });
      await new Promise((r) => setTimeout(r, 61_000));

      const rGet = await fetch(getExpired.url);
      expect(rGet.status).toBe(403);
      expect(await rGet.text()).toContain("Request has expired");

      const rPut = await fetch(putExpired.url, {
        method: "PUT",
        body: "abcd",
        headers: { "content-length": "4" },
      });
      expect(rPut.status).toBe(403);
      expect(await rPut.text()).toContain("Request has expired");

      // l'objet n'a PAS été écrit par le PUT expiré (URL fraîche → 404)
      const getFresh = generatePresignedUrl(CFG, expKey, { method: "GET" });
      expect((await fetch(getFresh.url)).status).toBe(404);
    }
  );
});
