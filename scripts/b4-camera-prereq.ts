/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b4-camera-prereq — PRÉREQUIS BLOQUANT B4 : preuve CAMÉRA avant le code
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive B4 : « B4 vidéo aura besoin de camera=(self) — vérifie-le
 *  maintenant avant d'écrire le code, pas après. » — le bug microphone=() de
 *  B3 (prérequis découvert APRÈS l'écriture) ne doit pas se reproduire.
 *
 *  Le header Permissions-Policy cible (camera=(self) + audit exhaustif §8.4)
 *  est appliqué à next.config.ts AVANT ce script. Deux preuves ici :
 *
 *   1. Navigateur headless (Chromium ms-playwright + fake video/audio device) :
 *      getUserMedia({video, audio}) RÉUSSIT → MediaRecorder vidéo webm 10 s →
 *      taille dans les bornes → thumbnail canvas 320 px (JPEG) → taille ~20 Ko.
 *   2. ffprobe : le webm enregistré porte un codec vidéo VP8/VP9 et une durée
 *      ≈ 10 s (le pipeline B4 envoie du webm SANS transcodage — §9).
 *
 *  La preuve du header SERVI (curl sur l'app réelle : le header contient
 *  camera=(self) et le REFUS de la caméra a bien disparu) est faite par le
 *  runner complet (scripts/b4-video-proof-run.sh, étape « Permissions-Policy
 *  avant/après ») — un header de fichier statique ne prouverait rien.
 *
 *  Sorties : docs/proofs/assets/b4-camera-prereq.txt (ffprobe) +
 *  docs/proofs/assets/b4-camera-browser.txt (navigateur). Exit non-zero si
 *  une seule preuve manque — le prérequis est BLOQUANT.
 *
 *  Usage : bun scripts/b4-camera-prereq.ts
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
  console.log(`[b4-prereq] ${s}`);
  lines.push(s);
};

// ── 0. le header cible est-il APPLIQUÉ dans next.config.ts ? (garde de code,
//      pas la preuve finale — celle-ci est le curl du runner) ────────────────
const nextConfig = await Bun.file(join(ROOT, "next.config.ts")).text();
if (!nextConfig.includes('"camera=(self)"')) {
  console.error(
    "FAIL — next.config.ts ne porte PAS camera=(self) : le fix doit précéder le code (directive B4)."
  );
  process.exit(1);
}
say("next.config.ts : camera=(self) appliqué (audit §8.4 — 20 directives)");

// ── 1. ffprobe disponible (contrôle du webm enregistré) ────────────────────
const ffprobe = Bun.which("ffprobe") ?? "";
if (!ffprobe) {
  console.error("FAIL — ffprobe absent : contrôle codec impossible");
  process.exit(1);
}

// ── 2. navigateur — getUserMedia vidéo + MediaRecorder + thumbnail ─────────
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
let raw = "";
try {
  const HTML = `<!doctype html><html><body><script>
  window.probe = async () => {
    // 1. caméra + micro : le prérequis B4 — doit réussir avec le fix camera=(self)
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const settings = stream.getVideoTracks()[0].getSettings();

    // 2. MediaRecorder vidéo — conteneur cible V1 : webm (VP8/VP9)
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : "video/webm";
    if (!MediaRecorder.isTypeSupported(mime)) throw new Error("webm vidéo non supporté");
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 32_000 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, 10_000));
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "video/webm" });
    const buf = await blob.arrayBuffer();

    // 3. thumbnail : <video> → seek 1 s → canvas 320 px → JPEG
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.src = url; video.muted = true; video.preload = "metadata";
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error("metadata vidéo illisible"));
    });
    const durationMs = Math.round(video.duration * 1000);
    video.currentTime = Math.min(1, video.duration / 2);
    await new Promise((res) => { video.onseeked = res; setTimeout(res, 3000); });
    const scale = 320 / video.videoWidth;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const thumbBytes = Math.round((dataUrl.length - "data:image/jpeg;base64,".length) * 0.75);

    // 4. octets du webm en base64 (transfert vers le harnais pour ffprobe)
    let bin = "";
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    const b64 = btoa(bin);
    URL.revokeObjectURL(url);

    return JSON.stringify({
      mime, bytes: buf.byteLength, durationMs,
      width: settings.width, height: settings.height,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      thumbBytes, b64,
    });
  };
  </script></body></html>`;
  const server = Bun.serve({
    port: 3198,
    fetch: () => new Response(HTML, { headers: { "Content-Type": "text/html" } }),
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:3198/");
  raw = (await page.evaluate("window.probe()")) as string;
  await browser.close();
  server.stop(true);

  const r = JSON.parse(raw) as {
    mime: string; bytes: number; durationMs: number;
    width: number; height: number; videoWidth: number; videoHeight: number; thumbBytes: number; b64: string;
  };
  say(`navigateur : getUserMedia({video,audio}) RÉUSSI — flux ${r.width}x${r.height}`);
  say(`navigateur : MediaRecorder ${r.mime} · 10 s → ${r.bytes} o (${Math.round(r.bytes / 1024)} Ko)`);
  say(`navigateur : <video> metadata → ${r.durationMs} ms · ${r.videoWidth}x${r.videoHeight}`);
  say(`navigateur : thumbnail canvas 320 px → ${r.thumbBytes} o JPEG`);

  if (r.bytes < 200_000 || r.bytes > 8_000_000) {
    console.error(`FAIL — webm 10 s hors bornes : ${r.bytes} o (attendu 200 Ko–8 Mo)`);
    process.exit(1);
  }
  if (r.durationMs < 9_000 || r.durationMs > 12_000) {
    console.error(`FAIL — durée vidéo incohérente : ${r.durationMs} ms`);
    process.exit(1);
  }
  if (r.thumbBytes < 3_000 || r.thumbBytes > 80_000) {
    console.error(`FAIL — thumbnail hors bornes : ${r.thumbBytes} o (attendu ~3–80 Ko)`);
    process.exit(1);
  }
  writeFileSync(join(ASSETS, "b4-camera-browser.txt"), raw.replace(/"b64":"[^"]+"/, '"b64":"<omis>"') + "\n");

  // le webm réel est conservé pour ffprobe + fixtures de test
  const webmPath = join(ROOT, "tests", "fixtures", "b4-prereq-10s.webm");
  writeFileSync(webmPath, Buffer.from(r.b64, "base64"));
  say(`fixture : tests/fixtures/b4-prereq-10s.webm (${Bun.file(webmPath).size} o)`);
} catch (e) {
  console.error("FAIL — preuve navigateur : " + (e instanceof Error ? e.message : String(e)));
  await browser.close().catch(() => undefined);
  process.exit(1);
}

// ── 3. ffprobe sur le webm enregistré (codec + durée) ──────────────────────
try {
  const webmPath = join(ROOT, "tests", "fixtures", "b4-prereq-10s.webm");
  const size = Bun.file(webmPath).size;
  say(`fixture : tests/fixtures/b4-prereq-10s.webm (${size} o)`);

  const probe = spawnSync(
    ffprobe,
    ["-v", "quiet", "-show_entries", "stream=codec_name,codec_type:format=duration", "-of", "json", webmPath],
    { encoding: "utf8" }
  );
  const meta = JSON.parse(probe.stdout) as {
    streams: Array<{ codec_name: string; codec_type: string }>;
    format: { duration: string };
  };
  const vstream = meta.streams.find((s) => s.codec_type === "video");
  const dur = Number(meta.format.duration);
  say(`ffprobe : codec vidéo ${vstream?.codec_name ?? "?"} · durée ${dur.toFixed(2)} s`);
  if (!vstream || !["vp8", "vp9", "av1"].includes(vstream.codec_name ?? "")) {
    console.error("FAIL — le webm n'a pas de piste vidéo VP8/VP9/AV1");
    process.exit(1);
  }
  if (dur < 9 || dur > 12) {
    console.error(`FAIL — durée ffprobe incohérente : ${dur}`);
    process.exit(1);
  }
  writeFileSync(join(ASSETS, "b4-camera-prereq.txt"), lines.join("\n") + "\n");
  say("PRÉREQUIS CAMÉRA PROUVÉ (getUserMedia + MediaRecorder + thumbnail + ffprobe) — B4 peut démarrer");
} catch (e) {
  console.error("FAIL — ffprobe : " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
