// Smoke test manuel — SigV4 B1 contre SeaweedFS (S3 réel indépendant)
import { generatePresignedUrl, newObjectKey, type MediaStorageConfig } from "../src/lib/mbote/media/storage";
import { createHash } from "node:crypto";

const CFG: MediaStorageConfig = {
  driver: "minio",
  endpoint: "http://127.0.0.1:9100",
  region: "us-east-1",
  bucket: "mbote-media-test",
  accessKeyId: "mbote-media-test",
  secretAccessKey: "mbote-media-test-secret",
};

const objectKey = newObjectKey();
const payload = Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251));
const sha = createHash("sha256").update(payload).digest("hex");
console.log("objectKey:", objectKey, "size:", payload.length, "sha256:", sha.slice(0, 16) + "…");

// 1. PUT présigné
const put = generatePresignedUrl(CFG, objectKey, { method: "PUT", contentLength: payload.length });
const r1 = await fetch(put.url, { method: "PUT", body: payload, headers: { "content-length": String(payload.length) } });
console.log("PUT présigné:", r1.status, r1.status === 200 ? "OK" : await r1.text());

// 2. GET présigné + intégrité
const get = generatePresignedUrl(CFG, objectKey, { method: "GET" });
const r2 = await fetch(get.url);
const buf = Buffer.from(await r2.arrayBuffer());
const sha2 = createHash("sha256").update(buf).digest("hex");
console.log("GET présigné:", r2.status, "bytes:", buf.length, "sha256 match:", sha === sha2);

// 3. Signature falsifiée → le serveur DOIT refuser
const url3 = new URL(get.url);
url3.searchParams.set("X-Amz-Signature", "0".repeat(64));
const r3 = await fetch(url3.toString());
console.log("GET signature falsifiée:", r3.status, r3.status === 403 ? "REFUSÉ (validation réelle)" : "⚠️ ACCEPTÉ — pas de validation !");

// 4. URL expirée (TTL 60s, attente 61s) — activé par MEDIA_S3_EXPIRY_TEST=1
if (process.env.MEDIA_S3_EXPIRY_TEST === "1") {
  const expKey = newObjectKey();
  const getExp = generatePresignedUrl(CFG, expKey, { method: "GET", ttlSec: 60 });
  const putExp = generatePresignedUrl(CFG, expKey, { method: "PUT", contentLength: 4, ttlSec: 60 });
  console.log("attente 61 s pour expiration…");
  await new Promise((r) => setTimeout(r, 61_000));
  const r4 = await fetch(getExp.url);
  const r5 = await fetch(putExp.url, { method: "PUT", body: "abcd", headers: { "content-length": "4" } });
  console.log("GET expiré:", r4.status, r4.status === 403 ? "REFUSÉ" : "⚠️ ACCEPTÉ");
  console.log("PUT expiré:", r5.status, r5.status === 403 ? "REFUSÉ" : "⚠️ ACCEPTÉ");
  const t4 = await r4.text(); console.log("  body GET expiré:", t4.slice(0, 200));
} else {
  console.log("(expiration non testée — MEDIA_S3_EXPIRY_TEST != 1)");
}
