/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b2-images-bench — latence E2E du flux B2 (directive : benchmark 100 Ko /
 *  1 Mo / 5 Mo upload + finalize + download)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner garantit app + weed) :
 *    MEDIA_B2_E2E=1 BASE_URL=http://127.0.0.1:3103 bun scripts/b2-images-bench.ts
 *
 *  Mesure PAR TAILLE : strip (sharp) + chiffrement client (WebCrypto) +
 *  upload-url + PUT (proxy) + finalize + download-url + GET + decrypt +
 *  sniff magic bytes — la chaîne COMPLÈTE, comme dans l'app.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { stripExif } from "../src/lib/mbote/media/exif";
import { encryptBytes, decryptBytes, sniffImageType } from "../src/lib/mbote/media-client";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const ENABLED = process.env.MEDIA_B2_E2E === "1";

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

interface Timing {
  taille: string;
  stripMs: number;
  chiffrementMs: number;
  presignMs: number;
  putMs: number;
  finalizeMs: number;
  lectureMs: number;
  decryptMs: number;
  totalMs: number;
}

async function benchOne(id: { pub: string; sign: (p: string) => Promise<string> }, bytes: Uint8Array, label: string): Promise<Timing> {
  const t0 = performance.now();

  const t1 = performance.now();
  const stripped = await stripExif(bytes);

  const t2 = performance.now();
  const enc = await encryptBytes(stripped.bytes);

  const t3 = performance.now();
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-upload|image/jpeg|${enc.sizeBytes}|${ts}`);
  const presign = await fetch(`${BASE_URL}/api/media/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaType: "image/jpeg", sizeBytes: enc.sizeBytes, sha256: enc.sha256, ts, signature }),
  });
  if (!presign.ok) throw new Error(`presign ${presign.status}`);
  const pres = (await presign.json()) as { mediaId: string; uploadUrl: string };

  const t4 = performance.now();
  const u = new URL(pres.uploadUrl, BASE_URL);
  const put = await fetch(`${BASE_URL}${u.pathname}${u.search}`, { method: "PUT", body: enc.envelope });
  if (!put.ok) throw new Error(`PUT ${put.status}`);

  const t5 = performance.now();
  const fts = Date.now();
  const fsig = await id.sign(`${id.pub}|media-finalize|${pres.mediaId}|${fts}`);
  const fin = await fetch(`${BASE_URL}/api/media/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaId: pres.mediaId, plainBytes: stripped.bytes.length, ts: fts, signature: fsig }),
  });
  if (!fin.ok) throw new Error(`finalize ${fin.status}`);

  const t6 = performance.now();
  const dts = Date.now();
  const dsig = await id.sign(`${id.pub}|media-dl|${pres.mediaId}|${dts}`);
  const dl = await fetch(`${BASE_URL}/api/media/download-url?${new URLSearchParams({ me: id.pub, mediaId: pres.mediaId, ts: String(dts), signature: dsig })}`);
  if (!dl.ok) throw new Error(`download-url ${dl.status}`);
  const dlBody = (await dl.json()) as { downloadUrl: string };
  const du = new URL(dlBody.downloadUrl, BASE_URL);
  const get = await fetch(`${BASE_URL}${du.pathname}${du.search}`);
  if (!get.ok) throw new Error(`GET ${get.status}`);
  const envelope = await get.text();

  const t7 = performance.now();
  const plain = await decryptBytes(envelope, enc.cekB64);
  if (sniffImageType(plain) === null) throw new Error("decrypt sniff null");

  const t8 = performance.now();
  return {
    taille: label,
    stripMs: +(t1 - t0).toFixed(0),
    chiffrementMs: +(t2 - t1).toFixed(0),
    presignMs: +(t3 - t2).toFixed(0),
    putMs: +(t4 - t3).toFixed(0),
    finalizeMs: +(t5 - t4).toFixed(0),
    lectureMs: +(t6 - t5).toFixed(0),
    decryptMs: +(t7 - t6).toFixed(0),
    totalMs: +(t8 - t0).toFixed(0),
  };
}

if (!ENABLED) {
  console.log("[b2-bench] SKIP — MEDIA_B2_E2E=1 requis (le runner garantit app + weed)");
  process.exit(0);
}

const id = await makeIdentity();

// Images BRUITÉES de résolutions calibrées (le bruit gaussien compresse mal en
// jpeg → taille contrôlée) — les tailles RÉELLES obtenues sont affichées.
const sharp = (await import("sharp")).default;
async function makeNoisyJpeg(side: number, quality: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: side,
      height: side,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .jpeg({ quality })
    .toBuffer();
  return new Uint8Array(buf);
}
const targets: Array<[string, number, number, number]> = [
  // [label, côté px, qualité jpeg, taille visée (contrôle affiché)]
  ["100 Ko", 500, 90, 100 * 1024],
  ["1 Mo", 1600, 92, 1024 * 1024],
  ["5 Mo", 2900, 95, 5 * 1024 * 1024],
];

const rows: Timing[] = [];
for (const [label, side, quality, target] of targets) {
  let input: Uint8Array;
  try {
    input = await makeNoisyJpeg(side, quality);
    // garde : la limite du strip est 5 Mo — on réduit le côté jusqu'à passer
    let shrink = side;
    while (input.length > 5 * 1024 * 1024 && shrink > 100) {
      shrink = Math.floor(shrink * 0.85);
      input = await makeNoisyJpeg(shrink, quality);
    }
    // si trop petit : qualité max sur côté +50 % (une passe, taille réelle affichée)
    if (input.length < target * 0.5) {
      input = await makeNoisyJpeg(Math.floor(shrink * 1.3), 100);
      while (input.length > 5 * 1024 * 1024 && shrink > 100) {
        shrink = Math.floor(shrink * 0.85);
        input = await makeNoisyJpeg(shrink, 100);
      }
    }
  } catch (e) {
    console.error(`[b2-bench] échec fabrication ${label} : ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  try {
    const row = await benchOne(id, input, `${label} (réel : ${(input.length / 1024).toFixed(0)} Ko)`);
    rows.push(row);
  } catch (e) {
    console.error(`[b2-bench] échec ${label} : ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

console.log("\n[b2-bench] Latence du flux B2 complet (moyennes d'un run — sandbox) :");
console.log(
  "| taille | strip | chiffr. | presign | PUT | finalize | lecture | decrypt | TOTAL |"
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.taille} | ${r.stripMs} ms | ${r.chiffrementMs} ms | ${r.presignMs} ms | ${r.putMs} ms | ${r.finalizeMs} ms | ${r.lectureMs} ms | ${r.decryptMs} ms | ${r.totalMs} ms |`
  );
}
console.log("\n[b2-bench] OK");
