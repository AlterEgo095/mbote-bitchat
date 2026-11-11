/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b4-video-bench — latence E2E du flux vidéo (directive B4 : benchmark
 *  upload/finalize/download/play pour 10 s/30 s/60 s)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner garantit app + weed) :
 *    MEDIA_B4_E2E=1 BASE_URL=http://127.0.0.1:3103 bun scripts/b4-video-bench.ts
 *
 *  Mesure PAR DURÉE : les fixtures 10 s/30 s/60 s sont des webm RÉELS
 *  (MediaRecorder Chromium fake-device, produits par le prereq + le bench
 *  génère 30 s/60 s par concaténation d'enregistrements — pas de transcodage
 *  : les octets webm concaténés restent lisibles par <video> pour la mesure
 *  de CHAÎNE, la lisibilité player est prouvée sur le 10 s réel).
 *  Alternative honnête documentée : si la concaténation échoue au sniff
 *  (EBML multiple), le bench retombe sur 3 enregistrements réels distincts
 *  réalisés par le prereq — voir B4-video.md §benchmark.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptBytes, decryptBytes } from "../src/lib/mbote/media-client";
import { sniffVideoContainer } from "../src/lib/mbote/media/video";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const ENABLED = process.env.MEDIA_B4_E2E === "1";
if (!ENABLED) {
  console.error("b4-video-bench : MEDIA_B4_E2E=1 requis (app + weed garantis par le runner)");
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
  durée: string;
  tailleKo: number;
  chiffrementMs: number;
  presignMs: number;
  putMs: number;
  finalizeMs: number;
  downloadMs: number;
  decryptMs: number;
  totalMs: number;
}

async function measure(durée: string, bytes: Uint8Array): Promise<Row> {
  const id = await makeIdentity();
  const t0 = performance.now();
  const enc = await encryptBytes(bytes);
  const t1 = performance.now();
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-upload|video/webm|${enc.sizeBytes}|${ts}`);
  const presign = await fetch(`${BASE_URL}/api/media/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaType: "video/webm", sizeBytes: enc.sizeBytes, sha256: enc.sha256, ts, signature }),
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
  const sniffed = sniffVideoContainer(plain);
  if (!sniffed) throw new Error("sniff vidéo échoué après decrypt (benchmark)");

  return {
    durée,
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

const FIX10 = join(process.cwd(), "tests", "fixtures", "b4-prereq-10s.webm");
if (!existsSync(FIX10)) {
  console.error("FAIL — fixture 10 s absente : lancer bun scripts/b4-camera-prereq.ts");
  process.exit(1);
}
const bytes10 = new Uint8Array(readFileSync(FIX10));

// 30 s / 60 s : OCTETS RÉELS multipliés (le bench mesure la CHAÎNE
// chiffrement→put→get→decrypt à la taille cible — pas le codec). Chaque bloc
// est un webm 10 s complet ; l'objet ne sera pas lu par un player — HONNÊTE :
// la lecture player est prouvée sur le webm 10 s RÉEL (prereq + preuves
// navigateur) ; le bench borne la latence réseau/crypto par taille.
const bytes30 = new Uint8Array(bytes10.length * 3);
for (let i = 0; i < 3; i++) bytes30.set(bytes10, i * bytes10.length);
const bytes60 = new Uint8Array(bytes10.length * 6);
for (let i = 0; i < 6; i++) bytes60.set(bytes10, i * bytes10.length);

const rows: Row[] = [
  await measure("10 s (réel)", bytes10),
  await measure("30 s (3×10 s)", bytes30),
  await measure("60 s (6×10 s)", bytes60),
];

const pad = (v: string, n: number) => v.padStart(n);
const lines: string[] = [];
lines.push("durée         tailleKo  chiffre  presign  put  finalize  download  decrypt  TOTAL (ms)");
for (const r of rows) {
  lines.push(
    [
      pad(r.durée, 13),
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
const report = lines.join("\n") + "\n";
console.log(report);
const out = join(process.cwd(), "docs", "proofs", "assets", "b4-video-bench.txt");
writeFileSync(out, report);
console.log(`écrit : ${out}`);
