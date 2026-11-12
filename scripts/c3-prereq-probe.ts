/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C3 — SONDE PRÉREQUIS (BLOQUANTE — leçon C2 : les prérequis sont prouvés
 *       AVANT le code) : caméra fake 640×480@24, contrôles encodeur
 *       (setParameters maxBitrate/scale), offre SDP avec m=video.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/c3-prereq-probe.ts
 *  Sortie : docs/proofs/assets/c3-prereq-probe.json — exit 1 si fail.
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
  args: [
    "--no-sandbox",
    "--headless=new",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const verdict: Record<string, unknown> = {};

try {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => console.error("[probe pageerror]", e.message.slice(0, 200)));
  // navigator.mediaDevices n'existe QUE dans un contexte sécurisé (leçon C2) —
  // sert une page dummy sur http://127.0.0.1 (localhost = contexte sécurisé natif)
  const PROBE_ORIGIN = "http://127.0.0.1:8124";
  await page.route(`${PROBE_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><head><title>c3 probe</title></head><body>probe</body></html>",
    })
  );
  await page.goto(`${PROBE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
  const probe = await page.evaluate(async () => {
    // P1 — caméra fake 640×480@24 (contraintes C3 exactes)
    let camOk = false;
    let camSettings: Record<string, unknown> = {};
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, facingMode: "user" },
      });
      const vt = stream.getVideoTracks()[0];
      const at = stream.getAudioTracks()[0];
      const s = vt?.getSettings() ?? {};
      camSettings = {
        videoTrack: vt?.readyState ?? "none",
        audioTrack: at?.readyState ?? "none",
        width: s.width,
        height: s.height,
        frameRate: s.frameRate ? Math.round(s.frameRate) : null,
      };
      camOk = vt?.readyState === "live" && at?.readyState === "live";
      for (const t of stream.getTracks()) t.stop();
    } catch (e) {
      camSettings = { error: e instanceof Error ? e.message : String(e) };
    }

    // P2 — contrôles encodeur : setParameters maxBitrate + scaleResolutionDownBy
    let encOk = false;
    let encResult: Record<string, unknown> = {};
    try {
      const [a, v] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        navigator.mediaDevices.getUserMedia({ video: true }),
      ]);
      const pc = new RTCPeerConnection();
      const sender = pc.addTrack(v.getVideoTracks()[0], v);
      pc.addTrack(a.getAudioTracks()[0], a);
      const params = sender.getParameters();
      const encodings = params.encodings?.length ? params.encodings : [{} as RTCRtpEncodingParameters];
      encodings[0] = { ...encodings[0], maxBitrate: 450_000, scaleResolutionDownBy: 1.5 };
      params.encodings = encodings;
      await sender.setParameters(params);
      const back = sender.getParameters();
      encResult = {
        maxBitrate: back.encodings?.[0]?.maxBitrate ?? null,
        scaleResolutionDownBy: back.encodings?.[0]?.scaleResolutionDownBy ?? null,
      };
      encOk = back.encodings?.[0]?.maxBitrate === 450_000 && back.encodings?.[0]?.scaleResolutionDownBy === 1.5;
      pc.close();
      for (const t of [...a.getTracks(), ...v.getTracks()]) t.stop();
    } catch (e) {
      encResult = { error: e instanceof Error ? e.message : String(e) };
    }

    // P3 — offre SDP contient une m-line vidéo ACTIVE
    let sdpOk = false;
    let sdpHasVideo = false;
    try {
      const v = await navigator.mediaDevices.getUserMedia({ video: true });
      const pc = new RTCPeerConnection();
      pc.addTrack(v.getVideoTracks()[0], v);
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      sdpHasVideo = /m=video\s+[1-9]/.test(offer.sdp ?? "");
      sdpOk = sdpHasVideo;
      pc.close();
      for (const t of v.getTracks()) t.stop();
    } catch {
      sdpOk = false;
    }

    return { camOk, camSettings, encOk, encResult, sdpOk, sdpHasVideo };
  });

  verdict.p1FakeCam640x480 = probe.camOk;
  verdict.p1Settings = probe.camSettings;
  verdict.p2EncoderControls = probe.encOk;
  verdict.p2Result = probe.encResult;
  verdict.p3OfferHasVideoMline = probe.sdpOk;
  verdict.ok = probe.camOk && probe.encOk && probe.sdpOk;

  writeFileSync(join(ASSETS, "c3-prereq-probe.json"), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) process.exit(1);
} catch (e) {
  verdict.ok = false;
  verdict.error = e instanceof Error ? e.message : String(e);
  writeFileSync(join(ASSETS, "c3-prereq-probe.json"), JSON.stringify(verdict, null, 2));
  console.error("FAIL —", String(verdict.error));
  process.exit(1);
} finally {
  await browser.close();
}
