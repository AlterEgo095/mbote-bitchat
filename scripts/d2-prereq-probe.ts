/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D2 — SONDE PRÉREQUIS (BLOQUANTE) : WebCrypto SHA-256 itéré + Web Worker +
 *       benchmark PoW 20 bits (desktop, puis CPU throttled ×4 = mobile bas de
 *       gamme simulé via CDP Emulation.setCPUThrottlingRate).
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/d2-prereq-probe.ts
 *  Sortie : docs/proofs/assets/d2-prereq-probe.json — exit 1 si fail.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
if (!existsSync(CHROME)) {
  console.error("FAIL — Chromium introuvable");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

const verdict: Record<string, unknown> = {};

try {
  const page = await (await browser.newContext()).newPage();
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await page.context().addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  page.on("pageerror", (e) => console.error("[probe pageerror]", e.message.slice(0, 200)));
  // contexte sécurisé : page dummy servie sur http://127.0.0.1 (leçon C2)
  const PROBE_ORIGIN = "http://127.0.0.1:8124";
  await page.route(`${PROBE_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><title>d2 probe</title></head><body>
<script>
// worker PoW INLINE (blob) — même logique que public/pow-worker.js
function meetsDifficulty(bytes, bits) {
  if (bits <= 0) return true;
  let remaining = bits;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (remaining <= 0) return true;
    if (b === 0) { remaining -= 8; continue; }
    let zeros = 0;
    for (let bit = 7; bit >= 0; bit--) { if ((b >> bit) & 1) break; zeros++; }
    return zeros >= remaining;
  }
  return remaining <= 0;
}
function solveInWorker(challenge, bits) {
  return new Promise((resolve, reject) => {
    const src = \`self.onmessage = async (e) => {
      const { challenge, difficultyBits } = e.data;
      const enc = new TextEncoder();
      const prefix = challenge + ':';
      for (let n = 0; ; n++) {
        const buf = await crypto.subtle.digest('SHA-256', enc.encode(prefix + n));
        const bytes = new Uint8Array(buf);
        if (meetsDifficulty(bytes, difficultyBits)) { self.postMessage({ nonce: String(n) }); return; }
      }
    };
    function meetsDifficulty(bytes, bits) {
      if (bits <= 0) return true;
      let remaining = bits;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (remaining <= 0) return true;
        if (b === 0) { remaining -= 8; continue; }
        let zeros = 0;
        for (let bit = 7; bit >= 0; bit--) { if ((b >> bit) & 1) break; zeros++; }
        return zeros >= remaining;
      }
      return remaining <= 0;
    }\`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const t0 = performance.now();
    w.onmessage = (ev) => { w.terminate(); resolve({ nonce: ev.data.nonce, ms: performance.now() - t0 }); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "worker error")); };
    w.postMessage({ challenge, difficultyBits: bits });
  });
}
window.__solveInWorker = solveInWorker;
</script>
<body></body></html>`,
    })
  );
  await page.goto(`${PROBE_ORIGIN}/`, { waitUntil: "domcontentloaded" });

  const bench = await page.evaluate(async () => {
    const solve = (window as unknown as {
      __solveInWorker: (c: string, b: number) => Promise<{ nonce: string; ms: number }>;
    }).__solveInWorker;
    const challenge = "probe-pubkey|pow|1700000000000";
    // 20 bits — difficulté D2 exacte
    const full = await solve(challenge, 20);
    return { ...full, bits: 20 };
  });
  verdict.workerOk = true;
  verdict.powDesktop = bench;

  // Throttling CPU ×4 — simulation mobile bas de gamme (directive D2 :
  // « ~2-5 s CPU mobile bas de gamme » pour 20 bits)
  const cdp = await ctx2cdp(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const benchThrottled = await page.evaluate(async () => {
    const solve = (window as unknown as {
      __solveInWorker: (c: string, b: number) => Promise<{ nonce: string; ms: number }>;
    }).__solveInWorker;
    const challenge = "probe-pubkey|pow|1700000001000";
    const full = await solve(challenge, 20);
    return { ...full, bits: 20 };
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  verdict.powThrottled4x = benchThrottled;

  verdict.pass = bench.nonce.length > 0 && benchThrottled.nonce.length > 0;

  writeFileSync(join(ASSETS, "d2-prereq-probe.json"), JSON.stringify(verdict, null, 2));
  console.log(
    `[d2-probe] PoW 20 bits — desktop ${bench.ms.toFixed(0)} ms · throttled ×4 ${benchThrottled.ms.toFixed(0)} ms · nonce=${benchThrottled.nonce}`
  );
  if (!verdict.pass) {
    console.error("FAIL — sonde D2 KO");
    process.exitCode = 1;
  }
} catch (e) {
  console.error("FAIL — sonde D2 exception :", e);
  writeFileSync(join(ASSETS, "d2-prereq-probe.json"), JSON.stringify({ error: String(e) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function ctx2cdp(page: import("playwright-core").Page) {
  return page.context().newCDPSession(page);
}
