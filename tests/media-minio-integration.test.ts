/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-minio-integration — upload → check → delete (directive B1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prérequis : docker + `docker compose -f deploy/docker-compose.minio.yml up -d`
 *  (le test crée le bucket via `mc mb --ignore-existing`).
 *
 *  SANDBOX DE DEV : docker ABSENT → le test est SKIPPÉ avec un message
 *  explicite (NON TESTÉ, documenté dans docs/proofs/B1-media-foundation.md).
 *  Le flux est néanmoins codé et rejouable tel quel sur VPS/dev local : il
 *  exerce la vraie chaîne presign PUT → HTTP PUT → presign GET → HTTP GET →
 *  delete (mc rm) sur des octets RÉELS, chiffrement compris.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import { decryptMedia, generateCek, encryptMedia } from "../src/lib/mbote/media/crypto";
import { stripExif } from "../src/lib/mbote/media/exif";
import {
  generatePresignedUrl,
  newObjectKey,
  assertMediaLimit,
  type MediaStorageConfig,
} from "../src/lib/mbote/media/storage";

const COMPOSE = "deploy/docker-compose.minio.yml";
const CFG: MediaStorageConfig = {
  driver: "minio",
  endpoint: process.env.MEDIA_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: process.env.MEDIA_S3_BUCKET ?? "mbote-media-test",
  accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID ?? "mbote-media-test",
  secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY ?? "mbote-media-test-secret",
};

let dockerOk = false;
try {
  execSync("docker version", { stdio: "pipe" });
  dockerOk = true;
} catch {
  dockerOk = false;
}

if (!dockerOk) {
  console.warn(
    "media-minio-integration SKIPPÉ — docker absent du sandbox (NON TESTÉ, B1). " +
      "Rejouable : docker compose -f deploy/docker-compose.minio.yml up -d puis bun test tests/media-minio-integration.test.ts"
  );
}

describe.skipIf(!dockerOk)("B1 · G — intégration MinIO locale (upload → check → delete)", () => {
  beforeAll(() => {
    // s'assurer que le service est up (le compose doit avoir été lancé)
    execSync(`docker compose -f ${COMPOSE} up -d`, { stdio: "pipe" });
    execSync("sleep 5", { stdio: "pipe" });
    execSync(
      `docker compose -f ${COMPOSE} exec -T minio sh -c "mc alias set local http://127.0.0.1:9000 ${CFG.accessKeyId} ${CFG.secretAccessKey} && mc mb --ignore-existing local/${CFG.bucket}"`,
      { stdio: "pipe", shell: "/bin/bash" }
    );
  });

  test("upload (presign PUT) → download (presign GET) → bytes identiques → delete (mc)", async () => {
    // chaîne RÉELLE : image → stripExif → encryptMedia → PUT → GET → déchiffrer
    const photoJpeg = Buffer.from(
      await Bun.file("tests/fixtures/media-gps-sample.jpg").arrayBuffer()
    );
    const stripped = await stripExif(photoJpeg);
    assertMediaLimit("image/jpeg", stripped.bytes.length);

    const cek = generateCek();
    const { envelope } = encryptMedia(new Uint8Array(stripped.bytes), cek);
    const objectKey = newObjectKey();

    // 1. PUT présigné + fetch réel
    const put = generatePresignedUrl(CFG, objectKey, {
      method: "PUT",
      contentLength: stripped.bytes.length,
      ttlSec: 900,
    });
    const putRes = await fetch(put.url, { method: "PUT", body: Buffer.from(stripped.bytes) });
    expect(putRes.status).toBe(200);

    // 2. GET présigné + fetch réel → octets chiffrés identiques
    const get = generatePresignedUrl(CFG, objectKey, { method: "GET", ttlSec: 900 });
    const getRes = await fetch(get.url);
    expect(getRes.status).toBe(200);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(downloaded.length).toBe(stripped.bytes.length);

    // 3. déchiffrement côté destinataire → octets stripped identiques
    const decrypted = decryptMedia(envelope, cek);
    expect(Buffer.from(decrypted).equals(stripped.bytes)).toBeTrue();

    // 4. delete (mc — l'application utiliserait DeleteObject présigné en B2)
    execSync(
      `docker compose -f ${COMPOSE} exec -T minio sh -c "mc rm local/${CFG.bucket}/${objectKey}"`,
      { stdio: "pipe", shell: "/bin/bash" }
    );
    // 5. check : l'objet n'existe plus (GET 404)
    const gone = await fetch(get.url);
    expect(gone.status).toBe(404);
  }, 60_000);
});
