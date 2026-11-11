/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b3-voice-bench — latence E2E du flux voix (directive B3 : benchmark
 *  upload/finalize/download/decrypt pour 6/8/12 kbps)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner garantit app + weed) :
 *    MEDIA_B3_E2E=1 BASE_URL=http://127.0.0.1:3103 bun scripts/b3-voice-bench.ts
 *
 *  Mesure PAR BITRATE (fixtures 30 s du prereq) : chiffrement client
 *  (WebCrypto) + upload-url + PUT (proxy) + finalize + download-url + GET +
 *  decrypt + sniff conteneur — la chaîne COMPLÈTE, comme dans l'app. La voix
 *  n'a PAS d'étape strip (arbitrage §8.2-3).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encryptBytes, decryptBytes } from "../src/lib/mbote/media-client";
import { sniffOpusContainer } from "../src/lib/mbote/media/opus";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const ENABLED = process.env.MEDIA_B3_E2E === "1";
if (!ENABLED) {
  console.error("b3-voice-bench : MEDIA_B3_E2E=1 requis (app + weed garantis par le runner)");
  process.exit(1);
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pub = b64url(new Uint8Array(pubRaw));
  const sign = async (payload: string): Promise<string> => {
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      pair.privateKey,
      new TextEncoder().encode(payload)
    );
    return b64url(new Uint8Array(sig));
  };
  return { pub, sign };
}

interface Row {
  bitrate: string;
  tailleKo: number;
  chiffrementMs: number;
  presignMs: number;
  putMs: number;
  finalizeMs: number;
  downloadMs: number;
  decryptMs: number;
  totalMs: number;
}

async function measure(bitrate: string, file: string): Promise<Row> {
  const id = await makeIdentity();
  const bytes = new Uint8Array(readFileSync(file));
  const t0 = performance.now();
  const enc = await encryptBytes(bytes);
  const t1 = performance.now();
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-upload|audio/opus|${enc.sizeBytes}|${ts}`);
  const presign = await fetch(`${BASE_URL}/api/media/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaType: "audio/opus", sizeBytes: enc.sizeBytes, sha256: enc.sha256, ts, signature }),
  });
  if (!presign.ok) throw new Error(`presign HTTP ${presign.status} : ${await presign.text()}`);
  const t2 = performance.now();
  const { mediaId, uploadUrl } = (await presign.json()) as { mediaId: string; uploadUrl: string };
  const u = new URL(uploadUrl, BASE_URL);
  const put = await fetch(`${BASE_URL}${u.pathname}${u.search}`, { method: "PUT", body: enc.envelope });
  if (!put.ok) throw new Error(`PUT HTTP ${put.status}`);
  const t3 = performance.now();
  const fts = Date.now();
  const fsig = await id.sign(`${id.pub}|media-finalize|${mediaId}|${fts}`);
  const fin = await fetch(`${BASE_URL}/api/media/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaId, plainBytes: bytes.length, ts: fts, signature: fsig }),
  });
  if (!fin.ok) throw new Error(`finalize HTTP ${fin.status}`);
  const t4 = performance.now();
  const dts = Date.now();
  const dsig = await id.sign(`${id.pub}|media-dl|${mediaId}|${dts}`);
  const dl = await fetch(`${BASE_URL}/api/media/download-url?${new URLSearchParams({ me: id.pub, mediaId, ts: String(dts), signature: dsig })}`);
  if (!dl.ok) throw new Error(`download-url HTTP ${dl.status}`);
  const info = (await dl.json()) as { downloadUrl: string };
  const du = new URL(info.downloadUrl, BASE_URL);
  const get = await fetch(`${BASE_URL}${du.pathname}${du.search}`);
  if (!get.ok) throw new Error(`GET HTTP ${get.status}`);
  const t5 = performance.now();
  const envelope = await get.text();
  const plain = await decryptBytes(envelope, enc.cekB64);
  const t6 = performance.now();
  const sniffed = sniffOpusContainer(plain);
  if (!sniffed) throw new Error("sniff conteneur échoué après decrypt (benchmark)");

  return {
    bitrate,
    tailleKo: Math.round(bytes.length / 1024),
    chiffrementMs: Math.round(t1 - t0),
    presignMs: Math.round(t2 - t1),
    putMs: Math.round(t3 - t2),
    finalizeMs: Math.round(t4 - t3),
    downloadMs: Math.round(t5 - t4),
    decryptMs: Math.round(t6 - t5),
    totalMs: Math.round(t6 - t0),
  };
}

const rows: Row[] = [];
for (const [bitrate, file] of [
  ["6 kbps", "tests/fixtures/voice-30s-6k.ogg"],
  ["8 kbps", "tests/fixtures/voice-30s-8k.ogg"],
  ["12 kbps", "tests/fixtures/voice-30s-12k.ogg"],
] as const) {
  rows.push(await measure(bitrate, join(process.cwd(), file)));
}

const pad = (v: string, n: number) => v.padStart(n);
console.log("bitrate  tailleKo  chiffre  presign  put  finalize  download  decrypt  TOTAL (ms)");
for (const r of rows) {
  console.log(
    [
      pad(r.bitrate, 7),
      pad(String(r.tailleKo), 8),
      pad(String(r.chiffrementMs), 8),
      pad(String(r.presignMs), 8),
      pad(String(r.putMs), 4),
      pad(String(r.finalizeMs), 9),
      pad(String(r.downloadMs), 9),
      pad(String(r.decryptMs), 8),
      pad(String(r.totalMs), 6),
    ].join("  ")
  );
}
console.log("TOTAL — bench voix terminé (chaîne complète par bitrate)");
