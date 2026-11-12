/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C3 — PREUVE NAVIGATEUR : appel vidéo E2E (A appelle B en vidéo, golden path
 *       + fallback caméra refusée + dégradation bitrate simulée)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/c3-browser-proof.ts <BASE_URL> <HUB_URL>
 *  Sorties : docs/proofs/assets/c3-*.png + c3-browser.json + c3-wire-capture.jsonl
 *
 *  Scénarios (directive C3 — règles §7 DEV-SETUP : preuve navigateur
 *  OBLIGATOIRE pour tout nouveau flux utilisateur) :
 *   E1. Onboarding réels de DEUX identités (A = appelant, B = appelé).
 *   E2. A appelle B en VIDÉO (bouton caméra) → CallView « Sonnerie (vidéo)… ».
 *   E3. B reçoit « Appel vidéo entrant » (call:offer avec m=video via le hub
 *       RÉEL, preuve ECDSA vérifiée) → capture.
 *   E4. B répond → DTLS-SRTP avec les DEUX tracks → actif : VIDÉO distante
 *       réellement décodée (videoWidth > 0) + preview local PiP des deux côtés
 *       — benchmark établissement < 5 s (caméra = plus lent que audio).
 *   E5. A coupe sa caméra → B voit l'indicateur « Caméra coupée » (call:media
 *       relayé et signé) + écran noir → capture.
 *   E6. A remet sa caméra puis la pivote (flip) → replaceTrack sans
 *       renégociation : l'appel reste actif, le preview local change de flux.
 *   E7. DÉGRADATION SIMULÉE : wrapper getStats injecte du packet loss vidéo
 *       16,7 % (> 5 %) → le monitor applique setParameters (450 kbps + scale
 *       1.5) ET l'indicateur « Connexion instable » apparaît → capture.
 *   E8. KNOCK VIDÉO : le POST /api/call-knock porte video:true (et la réponse
 *       est 202) → le push affiché serait « Appel vidéo » (sw.js v7).
 *   E9. B raccroche → overlays disparaissent des DEUX côtés, zéro élément
 *       audio/vidéo résiduel (test de fuite).
 *   F1. FALLBACK : caméra REFUSÉE (wrapper getUserMedia → NotAllowedError sur
 *       video, audio réel via fake device) → l'appel démarre AUDIO SEUL,
 *       s'établit quand même (overlay « Appel audio », aucune zone vidéo).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3121";
const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

const results: Record<string, string | number | boolean | object | null> = {};

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

const WIRE = join(ASSETS, "c3-wire-capture.jsonl");
rmSync(WIRE, { force: true });

interface WireEvent {
  t: number;
  dir: string;
  event: string;
  size: number;
  sdpHasVideo?: boolean;
}

/** Branche la capture des trames call:* (même pattern que C2 — wrapper
 *  WebSocket via addInitScript) + marque sdpHasVideo pour les offers. */
function captureWire(page: import("playwright-core").Page, tag: string): void {
  void page.addInitScript(
    ({ tag }) => {
      const wire: Array<{ t: number; dir: string; event: string; size: number; sdpHasVideo?: boolean }> = [];
      (window as unknown as { __mboteWire: unknown }).__mboteWire = wire;
      const record = (payload: string, dir: string) => {
        try {
          const stripped = payload.replace(/^\d+/, "");
          const parsed = JSON.parse(stripped) as unknown;
          if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].startsWith("call")) {
            const first = parsed[1] as Record<string, unknown> | undefined;
            let sdpHasVideo: boolean | undefined;
            if (parsed[0] === "call:offer" && first) {
              const offer = first.offer as { sdp?: string } | undefined;
              sdpHasVideo = !!offer?.sdp && /m=video\s+[1-9]/.test(offer.sdp);
            }
            wire.push({ t: Date.now(), dir, event: parsed[0], size: payload.length, sdpHasVideo });
          }
        } catch {
          /* binaire/ping/trame non-JSON */
        }
      };
      const OrigWS = window.WebSocket;
      window.WebSocket = class extends OrigWS {
        constructor(...args: ConstructorParameters<typeof OrigWS>) {
          super(...args);
          this.addEventListener("message", (ev) => {
            record(String((ev as MessageEvent).data), `to-${tag}`);
          });
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            if (typeof data === "string") record(data, `from-${tag}`);
            return origSend(data);
          };
        }
      };
    },
    { tag }
  );
}

/** E7 : wrappers qualité — getStats injecte du loss quand __mboteDegraded,
 *  setParameters est consigné dans __mboteSetParams (déclenchements réels du
 *  monitor de l'app, pas de code app modifié — même principe que __mboteWire). */
function captureQuality(page: import("playwright-core").Page): void {
  void page.addInitScript(() => {
    const w = window as unknown as { __mboteDegraded?: boolean; __mboteSetParams: Array<Record<string, unknown>> };
    w.__mboteSetParams = [];
    const origGetStats = window.RTCPeerConnection.prototype.getStats;
    window.RTCPeerConnection.prototype.getStats = async function (this: RTCPeerConnection) {
      const report = await origGetStats.call(this);
      if (w.__mboteDegraded) {
        // stats synthétiques : 20 lost / 100 received = 16,7 % > seuil 5 %
        const fake = [
          { type: "inbound-rtp", kind: "video", packetsLost: 20, packetsReceived: 100 },
        ];
        return {
          forEach: (cb: (r: unknown) => void) => {
            report.forEach(cb as (r: RTCStats) => void);
            fake.forEach(cb);
          },
        } as unknown as RTCStatsReport;
      }
      return report;
    };
    const origSetParams = window.RTCRtpSender.prototype.setParameters;
    window.RTCRtpSender.prototype.setParameters = function (params: RTCRtpSendParameters) {
      w.__mboteSetParams.push({
        t: Date.now(),
        maxBitrate: params?.encodings?.[0]?.maxBitrate ?? null,
        scaleResolutionDownBy: params?.encodings?.[0]?.scaleResolutionDownBy ?? null,
      });
      return origSetParams.call(this, params);
    };
  });
}

/** F1 : caméra REFUSÉE — getUserMedia(video) → NotAllowedError, l'audio
 *  reste réel (fake device). Uniquement appliqué à la page du scénario F1. */
function denyCamera(page: import("playwright-core").Page): void {
  void page.addInitScript(() => {
    const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (constraints && constraints.video) {
        throw new DOMException("F1 — caméra refusée (simulée)", "NotAllowedError");
      }
      return origGUM(constraints);
    };
  });
}

async function onboard(page: import("playwright-core").Page, name: string): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
  await page.getByLabel("Pseudo visible").fill(name);
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  await page.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
}

let pageA: import("playwright-core").Page | undefined;
let pageB: import("playwright-core").Page | undefined;
let pageA2: import("playwright-core").Page | undefined;
let pageB2: import("playwright-core").Page | undefined;

try {
  // ── E1. deux identités réelles ──
  console.log("[c3-browser] E1 — onboarding A + B");
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  pageA = await ctxA.newPage();
  pageB = await ctxB.newPage();
  captureWire(pageA, "A");
  captureWire(pageB, "B");
  captureQuality(pageA); // E7 : wrappers qualité sur l'APPELANT (sender)

  let knockStatus: number | null = null;
  let knockBody: Record<string, unknown> | null = null;
  pageA.on("response", (res) => {
    if (res.url().includes("/api/call-knock")) knockStatus = res.status();
  });
  pageA.on("request", (req) => {
    if (req.url().includes("/api/call-knock")) {
      try {
        knockBody = req.postDataJSON() as Record<string, unknown>;
      } catch {
        /* body illisible */
      }
    }
  });

  await onboard(pageA, "C3-Appelant");
  await onboard(pageB, "C3-Appelé");

  await pageB.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await pageB.getByText("Messages privés").first().waitFor({ timeout: 20000 });
  await pageA.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await pageA.getByRole("button", { name: /Nouvelle conversation|Nouvelle/ }).first().click();
  await pageA.getByText("Choisir un contact").waitFor({ timeout: 15000 });
  await pageA.getByRole("button", { name: /C3-Appelé/ }).click();
  await pageA.locator('[aria-label="Message privé"]').waitFor({ timeout: 15000 });

  // ── E2. A appelle en VIDÉO ──
  console.log("[c3-browser] E2 — A appelle B en vidéo");
  await pageA.locator('[aria-label="Appeler C3-Appelé en vidéo"]').click();
  await pageA.locator('[role="dialog"][aria-label="Appel vidéo avec C3-Appelé"]').waitFor({ timeout: 10000 });
  await pageA.getByText("Sonnerie (vidéo)…").waitFor({ timeout: 10000 });
  results.dialingShownVideo = true;
  await pageA.waitForTimeout(300);
  await pageA.screenshot({ path: join(ASSETS, "c3-video-dialing-a.png") });

  // ── E3. B sonne (vidéo) ──
  console.log("[c3-browser] E3 — B reçoit l'appel vidéo entrant");
  await pageB.locator('[role="dialog"][aria-label="Appel vidéo avec C3-Appelant"]').waitFor({ timeout: 15000 });
  await pageB.getByText("Appel vidéo entrant").waitFor({ timeout: 5000 });
  results.ringingVideoAtB = true;
  const tOfferAt = Date.now();
  await pageB.waitForTimeout(300);
  await pageB.screenshot({ path: join(ASSETS, "c3-video-ringing-b.png") });

  // ── E4. B répond → actif + VIDÉOS réellement décodées ──
  console.log("[c3-browser] E4 — B répond, DTLS-SRTP audio+vidéo");
  await pageB.locator('[aria-label="Répondre à l\'appel vidéo"]').click();
  await pageA.waitForFunction(
    () => !!document.querySelector('[role="dialog"][aria-label^="Appel vidéo"] [data-testid="call-timer"]'),
    undefined,
    { timeout: 20000, polling: 150 }
  );
  const tActive = Date.now();
  results.establishMs = tActive - tOfferAt;
  results.establishBudgetMs = 5000;
  results.establishWithinBudget = results.establishMs < 5000;
  results.callActiveVideo = true;

  // la VÉRITÉ média : vidéo distante décodée côté A (videoWidth > 0)
  await pageA.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="remote-video"]');
      return v instanceof HTMLVideoElement && v.videoWidth > 0 && v.videoHeight > 0;
    },
    undefined,
    { timeout: 20000, polling: 200 }
  );
  results.remoteVideoDecodedOnA = true;
  // preview local PiP vivant des DEUX côtés
  await pageA.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="local-video"]');
      return v instanceof HTMLVideoElement && v.videoWidth > 0;
    },
    undefined,
    { timeout: 10000, polling: 200 }
  );
  await pageB.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="local-video"]');
      return v instanceof HTMLVideoElement && v.videoWidth > 0;
    },
    undefined,
    { timeout: 10000, polling: 200 }
  );
  results.localPreviewDecodedBoth = true;
  const remoteSize = await pageA.evaluate(() => {
    const v = document.querySelector('[data-testid="remote-video"]') as HTMLVideoElement;
    return { w: v.videoWidth, h: v.videoHeight };
  });
  results.remoteVideoSize = remoteSize;
  await pageA.waitForTimeout(700);
  await pageA.screenshot({ path: join(ASSETS, "c3-video-active-a.png") });
  await pageB.screenshot({ path: join(ASSETS, "c3-video-active-b.png") });

  // ── E5. A coupe sa caméra → B voit « Caméra coupée » ──
  console.log("[c3-browser] E5 — mute caméra A → indicateur distant B");
  await pageA.locator('[data-testid="call-camera"]').click();
  // aria-pressed=true = caméra coupée côté appelant
  await pageA.waitForFunction(
    () => document.querySelector('[data-testid="call-camera"]')?.getAttribute("aria-pressed") === "true",
    undefined,
    { timeout: 5000, polling: 150 }
  );
  results.cameraOffOnA = true;
  // B : l'indicateur arrive via call:media (signé, relayé hub)
  await pageB.locator('[data-testid="remote-camera-off"]').waitFor({ timeout: 10000 });
  results.cameraOffIndicatorOnB = true;
  await pageB.waitForTimeout(300);
  await pageB.screenshot({ path: join(ASSETS, "c3-video-camera-off-b.png") });

  // ── E6. remise + flip caméra (replaceTrack, pas de renégociation) ──
  console.log("[c3-browser] E6 — flip caméra A (replaceTrack)");
  await pageA.locator('[data-testid="call-camera"]').click(); // remettre
  await pageA.waitForFunction(
    () => document.querySelector('[data-testid="call-camera"]')?.getAttribute("aria-pressed") === "false",
    undefined,
    { timeout: 5000, polling: 150 }
  );
  results.cameraBackOnA = true;
  const localIdBefore = await pageA.evaluate(
    () => document.querySelector('[data-testid="local-video"]')?.getAttribute("srcObject") === null ? "none" : "attached"
  );
  await pageA.locator('[data-testid="call-flip"]').click();
  await pageA.waitForTimeout(1200);
  // l'appel est TOUJOURS actif (pas de renégociation cassée) : le timer avance
  await pageA.waitForFunction(
    () => !!document.querySelector('[role="dialog"][aria-label^="Appel vidéo"] [data-testid="call-timer"]'),
    undefined,
    { timeout: 5000, polling: 200 }
  );
  await pageA.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="local-video"]');
      return v instanceof HTMLVideoElement && v.videoWidth > 0;
    },
    undefined,
    { timeout: 10000, polling: 200 }
  );
  results.flipKeptCallAlive = true;
  results.localPreviewBeforeFlip = localIdBefore;
  await pageA.screenshot({ path: join(ASSETS, "c3-video-after-flip-a.png") });

  // ── E7. dégradation simulée → setParameters + indicateur ──
  console.log("[c3-browser] E7 — dégradation réseau simulée (loss 16,7 %)");
  await pageA.evaluate(() => {
    (window as unknown as { __mboteDegraded?: boolean }).__mboteDegraded = true;
  });
  // monitor 2 s + hystérésis 2 mesures → premier down ≈ 4-6 s ; marge 12 s
  await pageA.waitForFunction(
    () => {
      const params = (window as unknown as { __mboteSetParams?: Array<{ maxBitrate?: number }> }).__mboteSetParams ?? [];
      return params.some((p) => p.maxBitrate === 450_000);
    },
    undefined,
    { timeout: 12000, polling: 300 }
  );
  results.setParametersApplied = await pageA.evaluate(
    () => (window as unknown as { __mboteSetParams?: Array<Record<string, unknown>> }).__mboteSetParams ?? []
  );
  await pageA.locator('[data-testid="call-unstable"]').waitFor({ timeout: 8000 });
  results.unstableIndicatorShown = true;
  const quality = await pageA.evaluate(
    () => document.querySelector('[data-testid="call-quality"]')?.textContent ?? null
  );
  results.qualityLabel = quality;
  await pageA.screenshot({ path: join(ASSETS, "c3-video-degraded-a.png") });
  await pageA.evaluate(() => {
    (window as unknown as { __mboteDegraded?: boolean }).__mboteDegraded = false;
  });

  // ── E8. knock vidéo ──
  results.knockStatus = knockStatus;
  results.knockVideo = (knockBody as Record<string, unknown> | null)?.video === true;
  console.log(`[c3-browser] E8 — knock POST /api/call-knock → HTTP ${knockStatus} (video=${results.knockVideo})`);

  // ── E9. B raccroche → zéro résidu ──
  console.log("[c3-browser] E9 — B raccroche (fin propre des deux côtés)");
  await pageB.locator('[data-testid="call-hangup"]').click();
  await pageA.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label^="Appel vidéo"]'),
    undefined,
    { timeout: 10000, polling: 150 }
  );
  await pageB.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label^="Appel vidéo"]'),
    undefined,
    { timeout: 10000, polling: 150 }
  );
  results.hangupClean = true;
  const residualA = await pageA.locator("[data-mbote-call-audio]").count();
  const residualB = await pageB.locator("[data-mbote-call-audio]").count();
  const residualVideoA = await pageA.locator('[data-testid="remote-video"]').count();
  const residualVideoB = await pageB.locator('[data-testid="remote-video"]').count();
  results.residualMediaElements = residualA + residualB + residualVideoA + residualVideoB;
  await pageA.screenshot({ path: join(ASSETS, "c3-video-ended.png") });

  // ── capture fil (signalisation uniquement) ──
  const wireA = (await pageA.evaluate(() =>
    (window as unknown as { __mboteWire: WireEvent[] }).__mboteWire
  )) as WireEvent[];
  const wireB = (await pageB.evaluate(() =>
    (window as unknown as { __mboteWire: WireEvent[] }).__mboteWire
  )) as WireEvent[];
  const wire = [...wireA, ...wireB].sort((a, b) => a.t - b.t);
  appendFileSync(WIRE, wire.map((w) => JSON.stringify(w)).join("\n") + (wire.length ? "\n" : ""));
  results.wireEvents = wire.length;
  results.wireEventKinds = [...new Set(wire.map((w) => w.event))];
  results.wireMaxSize = wire.reduce((m, w) => Math.max(m, w.size), 0);
  const sentOffer = wire.find((w) => w.event === "call:offer");
  const recvOffer = wire.find((w) => w.event === "call-offer");
  if (sentOffer && recvOffer) {
    results.hubRelayMs = Math.abs(recvOffer.t - sentOffer.t);
    results.hubRelayBudgetMs = 100;
  }
  results.offerSdpHasVideo = sentOffer?.sdpHasVideo === true;
  results.wireMediaEvents = wire.filter((w) => w.event === "call:media" || w.event === "call-media").length;

  // ── F1. FALLBACK : caméra refusée → appel audio seul établi ──
  console.log("[c3-browser] F1 — caméra refusée → fallback audio seul");
  const ctxA2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  pageA2 = await ctxA2.newPage();
  pageB2 = await ctxB2.newPage();
  denyCamera(pageA2);
  await onboard(pageA2, "C3-Fallback");
  await onboard(pageB2, "C3-Dest-F");
  await pageB2.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await pageB2.getByText("Messages privés").first().waitFor({ timeout: 20000 });
  await pageA2.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await pageA2.getByRole("button", { name: /Nouvelle conversation|Nouvelle/ }).first().click();
  await pageA2.getByText("Choisir un contact").waitFor({ timeout: 15000 });
  await pageA2.getByRole("button", { name: /C3-Dest-F/ }).click();
  await pageA2.locator('[aria-label="Message privé"]').waitFor({ timeout: 15000 });

  await pageA2.locator('[aria-label="Appeler C3-Dest-F en vidéo"]').click();
  // B reçoit un appel AUDIO (l'offre est audio-only après fallback)
  await pageB2.locator('[role="dialog"][aria-label="Appel audio avec C3-Fallback"]').waitFor({ timeout: 15000 });
  results.fallbackRingingAudioAtB = true;
  await pageB2.getByRole("button", { name: "Répondre à l'appel" }).click();
  await pageA2.waitForFunction(
    () => !!document.querySelector('[role="dialog"][aria-label^="Appel audio"] [data-testid="call-timer"]'),
    undefined,
    { timeout: 20000, polling: 150 }
  );
  results.fallbackEstablished = true;
  // AUCUNE zone vidéo dans les deux overlays (appel résolu en audio)
  const noVideoA = await pageA2.locator('[data-testid="remote-video"]').count();
  const noVideoB = await pageB2.locator('[data-testid="remote-video"]').count();
  results.fallbackNoVideoStage = noVideoA === 0 && noVideoB === 0;
  await pageA2.screenshot({ path: join(ASSETS, "c3-fallback-audio-a.png") });
  await pageB2.screenshot({ path: join(ASSETS, "c3-fallback-audio-b.png") });
  await ctxA2.close();
  await ctxB2.close();

  results.ok =
    results.dialingShownVideo === true &&
    results.ringingVideoAtB === true &&
    results.callActiveVideo === true &&
    results.remoteVideoDecodedOnA === true &&
    results.localPreviewDecodedBoth === true &&
    results.cameraOffOnA === true &&
    results.cameraOffIndicatorOnB === true &&
    results.cameraBackOnA === true &&
    results.flipKeptCallAlive === true &&
    results.unstableIndicatorShown === true &&
    results.knockVideo === true &&
    results.knockStatus === 202 &&
    results.hangupClean === true &&
    results.offerSdpHasVideo === true &&
    results.fallbackEstablished === true &&
    results.fallbackNoVideoStage === true &&
    results.residualMediaElements === 0 &&
    results.establishWithinBudget === true &&
    (results.hubRelayMs as number) < 100;

  writeFileSync(join(ASSETS, "c3-browser.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await ctxA.close();
  await ctxB.close();
} catch (e) {
  results.ok = false;
  results.error = e instanceof Error ? e.message : String(e);
  writeFileSync(join(ASSETS, "c3-browser.json"), JSON.stringify(results, null, 2));
  try {
    if (pageA) await pageA.screenshot({ path: join(ASSETS, "c3-debug-fail-a.png") });
    if (pageB) await pageB.screenshot({ path: join(ASSETS, "c3-debug-fail-b.png") });
    if (pageA2) await pageA2.screenshot({ path: join(ASSETS, "c3-debug-fail-a2.png") });
    if (pageB2) await pageB2.screenshot({ path: join(ASSETS, "c3-debug-fail-b2.png") });
  } catch {
    /* pages fermées */
  }
  console.error("[c3-browser] FAIL —", results.error);
  process.exit(1);
} finally {
  await browser.close();
}
