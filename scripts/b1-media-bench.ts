/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b1-media-bench — benchmark REEL du socle média (directive B1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun scripts/b1-media-bench.ts [sortie.json]
 *  Mesure encryptMedia + decryptMedia sur 1 Mo / 10 Mo / 100 Mo (octets
 *  pseudo-aléatoires — worst case crypto) : médiane + p95 (ms) + débit.
 *  Sortie JSON (preuve B1) — les chiffres sont RÉELS, jamais estimés.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateCek, encryptMedia, decryptMedia } from "../src/lib/mbote/media/crypto";

interface Sample { medianMs: number; p95Ms: number; minMs: number; maxMs: number; runs: number }
interface BenchRow { taille: string; octets: number; runs: number; encrypt: Sample & { debitMoS: number }; decrypt: Sample & { debitMoS: number } }

function stats(samplesMs: number[]): Sample {
  const s = [...samplesMs].sort((a, b) => a - b);
  const pick = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return {
    medianMs: Math.round(pick(0.5) * 100) / 100,
    p95Ms: Math.round(pick(0.95) * 100) / 100,
    minMs: Math.round(s[0] * 100) / 100,
    maxMs: Math.round(s[s.length - 1] * 100) / 100,
    runs: s.length,
  };
}

/** PRNG déterministe (LCG) — octets pseudo-aléatoires, reproductible. */
function makeNoise(bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes);
  let seed = 0x9e3779b9;
  for (let i = 0; i < bytes; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    buf[i] = seed & 0xff;
  }
  return buf;
}

async function bench(sizeBytes: number, runs: number): Promise<BenchRow> {
  const cek = generateCek();
  const plaintext = makeNoise(sizeBytes);
  const label = sizeBytes >= 1024 * 1024 ? `${sizeBytes / (1024 * 1024)} Mo` : `${Math.round(sizeBytes / 1024)} Ko`;

  // warmup (JIT + alloc) — pas compté
  for (let i = 0; i < 2; i++) {
    const { envelope } = encryptMedia(plaintext, cek);
    decryptMedia(envelope, cek);
  }

  const encSamples: number[] = [];
  const envelopes: string[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const { envelope } = encryptMedia(plaintext, cek);
    const t1 = performance.now();
    envelopes.push(envelope);
    encSamples.push(t1 - t0);
  }

  const decSamples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    decryptMedia(envelopes[i], cek);
    decSamples.push(performance.now() - t0);
  }

  // intégrité : le dernier round-trip a bien restitué l'entrée
  const last = decryptMedia(envelopes[envelopes.length - 1], cek);
  let diff = 0;
  for (let i = 0; i < sizeBytes; i++) if (last[i] !== plaintext[i]) diff++;
  if (diff !== 0) throw new Error(`round-trip invalide (${diff} octets différents)`);

  const enc = stats(encSamples);
  const dec = stats(decSamples);
  const mb = sizeBytes / (1024 * 1024);
  return {
    taille: label,
    octets: sizeBytes,
    runs,
    encrypt: { ...enc, debitMoS: Math.round((mb / (enc.medianMs / 1000)) * 10) / 10 },
    decrypt: { ...dec, debitMoS: Math.round((mb / (dec.medianMs / 1000)) * 10) / 10 },
  };
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? join(process.cwd(), "docs", "proofs", "assets", "b1-benchmark.json");
  console.log("== benchmark socle média B1 (AES-256-GCM, node:crypto) ==");
  const rows = [
    await bench(1024 * 1024, 30),        // 1 Mo — 30 runs
    await bench(10 * 1024 * 1024, 15),   // 10 Mo — 15 runs
    await bench(100 * 1024 * 1024, 5),   // 100 Mo — 5 runs
  ];
  for (const r of rows) {
    console.log(
      `${r.taille} · encrypt médiane ${r.encrypt.medianMs} ms (p95 ${r.encrypt.p95Ms}) · ` +
      `decrypt médiane ${r.decrypt.medianMs} ms (p95 ${r.decrypt.p95Ms}) · ` +
      `${r.encrypt.debitMoS} / ${r.decrypt.debitMoS} Mo/s`
    );
  }
  mkdirSync(join(process.cwd(), "docs", "proofs", "assets"), { recursive: true });
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), bench: rows }, null, 2));
  console.log(`écrit : ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
