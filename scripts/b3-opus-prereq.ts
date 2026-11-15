/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b3-opus-prereq — PRÉREQUIS BLOQUANT B3 : preuve Opus encode/decode
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive B3 : « Avant d'écrire l'UI, valide que tu peux encoder/décoder
 *  Opus en test (navigateur headless ou ffmpeg serveur). Sans cette preuve,
 *  B3 ne démarre pas. » — LES DEUX voies sont prouvées ici :
 *
 *   1. ffmpeg serveur : WAV 30 s → encodage 6/8/12 kbps (ogg/opus) → tailles
 *      attendues (20–40 Ko à 8 kbps pour 30 s) → décodage → durée ≈ 30 s.
 *   2. Navigateur headless (Chromium 1200 en cache ms-playwright, driver
 *      playwright-core + --use-fake-device-for-media-stream) :
 *      MediaRecorder.isTypeSupported(webm;opus) → enregistrement RÉEL 5 s
 *      @ 8 kbps → taille → decodeAudioData → durée + 100 peaks.
 *
 *  Sorties : docs/proofs/assets/b3-opus-prereq.txt (ffmpeg) +
 *  docs/proofs/assets/b3-opus-browser.txt (navigateur). Exit non-zero si une
 *  seule preuve manque — le prérequis est BLOQUANT.
 *
 *  Usage : bun scripts/b3-opus-prereq.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });
mkdirSync(join(ROOT, "tests", "fixtures"), { recursive: true });

const lines: string[] = [];
const say = (s: string) => {
  console.log(`[b3-prereq] ${s}`);
  lines.push(s);
};

// ── 1. ffmpeg — encodage/décodage 6/8/12 kbps ───────────────────────────────
const ffmpeg = Bun.which("ffmpeg") ?? "";
const ffprobe = Bun.which("ffprobe") ?? "";
if (!ffmpeg || !ffprobe) {
  console.error("FAIL — ffmpeg/ffprobe absents : prérequis non prouvable");
  process.exit(1);
}
say(`ffmpeg : ${spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0]}`);

const wav = "/tmp/b3-tone-30s.wav";
const tone = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-ar", "48000", "-ac", "1", wav], { encoding: "utf8" });
if (tone.status !== 0) {
  console.error("FAIL — génération WAV : " + (tone.stderr ?? "").slice(-300));
  process.exit(1);
}

function ffprobeDuration(path: string): number {
  const r = spawnSync(
    ffprobe,
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { encoding: "utf8" }
  );
  return Number(r.stdout.trim());
}

const FIXTURES: Array<{ name: string; args: string[]; expectKB: [number, number] }> = [
  { name: "voice-30s-6k.ogg", args: ["-c:a", "libopus", "-b:a", "6k"], expectKB: [15, 30] },
  { name: "voice-30s-8k.ogg", args: ["-c:a", "libopus", "-b:a", "8k"], expectKB: [20, 40] },
  { name: "voice-30s-12k.ogg", args: ["-c:a", "libopus", "-b:a", "12k"], expectKB: [30, 60] },
  // conteneur webm (celui de MediaRecorder Chromium) + fixture de rejet MP3
  { name: "voice-30s-8k.webm", args: ["-c:a", "libopus", "-b:a", "8k", "-f", "webm"], expectKB: [20, 40] },
];
say("encodage ffmpeg (WAV 30 s, 440 Hz, mono 48 kHz) :");
for (const f of FIXTURES) {
  const out = join(ROOT, "tests", "fixtures", f.name);
  const r = spawnSync(ffmpeg, ["-y", "-i", wav, ...f.args, out], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`FAIL — encodage ${f.name} : ${(r.stderr ?? "").slice(-300)}`);
    process.exit(1);
  }
  const size = Bun.file(out).size;
  const dur = ffprobeDuration(out);
  const kb = Math.round(size / 1024);
  const ok = kb >= f.expectKB[0] && kb <= f.expectKB[1];
  say(
    `  ${f.name.padEnd(20)} ${String(size).padStart(7)} o (${kb} Ko) · durée décodée ${dur.toFixed(2)} s ${ok ? "OK" : `HORS BORNE [${f.expectKB[0]},${f.expectKB[1]}]`}`
  );
  if (!ok) process.exit(1);
  if (!Number.isFinite(dur) || dur < 28 || dur > 32) {
    console.error(`FAIL — durée décodée ${f.name} incohérente : ${dur}`);
    process.exit(1);
  }
}
// fixture de REJET : un vrai MP3 (le sniff doit le refuser au rendu)
spawnSync(ffmpeg, ["-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "64k", join(ROOT, "tests", "fixtures", "voice-reject.mp3")], { encoding: "utf8" });
if (!existsSync(join(ROOT, "tests", "fixtures", "voice-reject.mp3"))) {
  console.error("FAIL — fixture MP3 non générée (libmp3lame absent ?) — le test de rejet en a besoin");
  process.exit(1);
}
say("  voice-reject.mp3       (fixture de rejet MIME — sniff doit refuser)");

// ── 2. navigateur — MediaRecorder natif opus (fake device) ──────────────────
const CHROME_CANDIDATES = [
  `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux64/headless_shell`,
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error(`FAIL — aucun Chromium ms-playwright trouvé (${CHROME_CANDIDATES.join(", ")})`);
  process.exit(1);
}
say(`chromium : ${chrome}`);

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
  executablePath: chrome,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
  ],
});
try {
  const HTML = `<!doctype html><html><body><script>
  window.probe = async () => {
    const supported = MediaRecorder.isTypeSupported("audio/webm;codecs=opus");
    if (!supported) throw new Error("webm;opus non supporté");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 8000 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, 5000));
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "audio/webm" });
    const buf = await blob.arrayBuffer();
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    ctx.close();
    const ch = audio.getChannelData(0);
    const peaks = [];
    for (let i = 0; i < 100; i++) {
      const a = Math.floor((i * ch.length) / 100), b = Math.floor(((i + 1) * ch.length) / 100);
      let m = 0;
      for (let j = a; j < b; j++) m = Math.max(m, Math.abs(ch[j]));
      peaks.push(Math.round(m * 100) / 100);
    }
    return JSON.stringify({ supported, bytes: buf.byteLength, type: blob.type, duration: audio.duration, sampleRate: audio.sampleRate, peaksLen: peaks.length });
  };
  </script></body></html>`;
  const server = Bun.serve({
    port: 3199,
    fetch: () => new Response(HTML, { headers: { "Content-Type": "text/html" } }),
  });
  const page = await browser.newPage();
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await page.context().addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  await page.goto("http://127.0.0.1:3199/");
  const raw = (await page.evaluate("window.probe()")) as string;
  await browser.close();
  server.stop(true);

  const r = JSON.parse(raw) as { supported: boolean; bytes: number; duration: number; sampleRate: number; peaksLen: number };
  say(`navigateur : MediaRecorder webm;opus=${r.supported} · 5 s @ 8 kbps → ${r.bytes} o`);
  say(`navigateur : decodeAudioData → ${r.duration.toFixed(2)} s @ ${r.sampleRate} Hz · ${r.peaksLen} peaks`);
  if (!r.supported || r.bytes < 1500 || r.bytes > 15000) {
    console.error(`FAIL — enregistrement navigateur hors bornes : ${r.bytes} o`);
    process.exit(1);
  }
  if (r.duration < 4 || r.duration > 7 || r.peaksLen !== 100) {
    console.error(`FAIL — décodage navigateur incohérent : ${r.duration} s, ${r.peaksLen} peaks`);
    process.exit(1);
  }
  writeFileSync(join(ASSETS, "b3-opus-browser.txt"), raw + "\n");
} catch (e) {
  await browser.close().catch(() => undefined);
  console.error("FAIL — preuve navigateur : " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

writeFileSync(join(ASSETS, "b3-opus-prereq.txt"), lines.join("\n") + "\n");
say("PRÉREQUIS OPUS PROUVÉ (ffmpeg + navigateur) — B3 peut démarrer");
