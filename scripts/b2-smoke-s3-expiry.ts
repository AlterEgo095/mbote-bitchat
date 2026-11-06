// Repro ciblée : PUT présigné expiré sur SeaweedFS
import { generatePresignedUrl, newObjectKey, type MediaStorageConfig } from "../src/lib/mbote/media/storage";

const CFG: MediaStorageConfig = {
  driver: "minio",
  endpoint: "http://127.0.0.1:9100",
  region: "us-east-1",
  bucket: "mbote-media-test",
  accessKeyId: "mbote-media-test",
  secretAccessKey: "mbote-media-test-secret",
};
const key = newObjectKey();
const put = generatePresignedUrl(CFG, key, { method: "PUT", contentLength: 4, ttlSec: 60 });
console.log("URL PUT:", put.url.slice(0, 120) + "…");
console.log("attente 61 s…");
await new Promise((r) => setTimeout(r, 61_000));
const r = await fetch(put.url, { method: "PUT", body: "abcd", headers: { "content-length": "4" } });
console.log("PUT expiré (repro):", r.status);
console.log("body:", (await r.text()).slice(0, 300));
// contrôle : GET du même objet avec URL fraîche → l'objet a-t-il été écrit ?
const get = generatePresignedUrl(CFG, key, { method: "GET" });
const r2 = await fetch(get.url);
console.log("GET (fraîche) de l'objet écrit par le PUT expiré:", r2.status, await r2.text());
