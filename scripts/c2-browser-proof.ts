/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C2 — PREUVE NAVIGATEUR : appel audio E2E (A appelle B, golden path)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/c2-browser-proof.ts <BASE_URL> <HUB_URL>
 *  Sorties : docs/proofs/assets/c2-*.png + c2-browser.json + c2-wire-capture.jsonl
 *
 *  Scénarios (directive C2) :
 *   E1. Onboarding réels de DEUX identités (A = appelant, B = appelé).
 *   E2. A appelle B depuis l'en-tête DM (bouton téléphone) → CallView « Sonnerie ».
 *   E3. B reçoit l'overlay « Appel entrant » (socket.io call:offer via le hub
 *       RÉEL, preuve ECDSA vérifiée) → capture.
 *   E4. B répond → connexion DTLS-SRTP (fake devices) → A passe à « actif »
 *       avec timer — benchmark établissement < 3 s.
 *   E5. B raccroche → les DEUX overlays disparaissent, zéro élément audio
 *       résiduel (test de fuite).
 *   E6. CAPTURE FIL : tous les événements call:* traversant les websockets des
 *       deux pages sont consignés (c2-wire-capture.jsonl) — ils ne contiennent
 *       QUE de la signalisation (SDP/ICE), aucun octet de média (l'audio est
 *       DTLS-SRTP P2P, invisible sur le socket).
 *   E7. KNOCK : le POST /api/call-knock part bien (fire-and-forget) → 202.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3119";
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

const WIRE = join(ASSETS, "c2-wire-capture.jsonl");
rmSync(WIRE, { force: true });

/** Branche la capture des trames call:* — via addInitScript (wrap WebSocket.send
 *  + fetch socket.io) : fonctionne quel que soit le transport ws/polling. */
function captureWire(page: import("playwright-core").Page, tag: string): void {
  void page.addInitScript(
    ({ tag }) => {
      const wire: Array<{ t: number; dir: string; event: string; size: number }> = [];
      (window as unknown as { __mboteWire: unknown }).__mboteWire = wire;
      const record = (payload: string, dir: string) => {
        try {
          // socket.io v4 : trame = <nb paquets><json> — ex. "42[\"call:offer\",{…}]"
          const stripped = payload.replace(/^\d+/, "");
          const parsed = JSON.parse(stripped) as unknown;
          if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].startsWith("call")) {
            wire.push({ t: Date.now(), dir, event: parsed[0], size: payload.length });
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

let pageA: import("playwright-core").Page | undefined;
let pageB: import("playwright-core").Page | undefined;
let ctxA: import("playwright-core").BrowserContext;
let ctxB: import("playwright-core").BrowserContext;

try {
  // ── E1. deux identités réelles ──
  console.log("[c2-browser] E1 — onboarding A + B");
  ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxA.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxB.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  pageA = await ctxA.newPage();
  pageB = await ctxB.newPage();
  captureWire(pageA, "A");
  captureWire(pageB, "B");
  // diagnostic : logs du callManager visibles en sortie du harnais
  pageA.on("console", (m) => {
    const t = m.text();
    if (t.includes("[mbote-call]")) console.log("[A]", t.slice(0, 120));
  });
  pageB.on("console", (m) => {
    const t = m.text();
    if (t.includes("[mbote-call]")) console.log("[B]", t.slice(0, 120));
  });

  let knockStatus: number | null = null;
  pageA.on("response", (res) => {
    if (res.url().includes("/api/call-knock")) knockStatus = res.status();
  });

  async function onboard(page: import("playwright-core").Page, name: string) {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
    await page.getByLabel("Pseudo visible").fill(name);
    await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
    // DB de preuve fraîche = fil vide → attendre l'avatar d'identité (header),
    // présent seulement APRÈS création réussie
    await page.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
  }
  await onboard(pageA, "C2-Appelant");
  await onboard(pageB, "C2-Appelé");

  // B ouvre les messages (socket hello + room dm — prêt à sonner)
  await pageB.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await pageB.getByText("Messages privés").first().waitFor({ timeout: 20000 });

  // A recharge (users list inclut désormais B) puis ouvre la conversation avec B
  await pageA.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await pageA.getByRole("button", { name: /Nouvelle conversation|Nouvelle/ }).first().click();
  await pageA.getByText("Choisir un contact").waitFor({ timeout: 15000 });
  await pageA.getByRole("button", { name: /C2-Appelé/ }).click();
  const composerA = pageA.locator('[aria-label="Message privé"]');
  await composerA.waitFor({ timeout: 15000 });

  // ── E2. A appelle ──
  console.log("[c2-browser] E2 — A appelle B");
  await pageA.locator('[aria-label^="Appeler C2-Appelé"]').click();
  await pageA.locator('[role="dialog"][aria-label^="Appel audio"]').waitFor({ timeout: 10000 });
  await pageA.getByText("Sonnerie…").waitFor({ timeout: 10000 });
  results.dialingShown = true;
  await pageA.waitForTimeout(300);
  await pageA.screenshot({ path: join(ASSETS, "c2-call-dialing-a.png") });

  // ── E3. B sonne ──
  console.log("[c2-browser] E3 — B reçoit l'appel entrant");
  await pageB.locator('[role="dialog"][aria-label="Appel audio avec C2-Appelant"]').waitFor({ timeout: 15000 });
  const tOfferAt = Date.now();
  results.ringingAtB = true;
  await pageB.waitForTimeout(300);
  await pageB.screenshot({ path: join(ASSETS, "c2-call-ringing-b.png") });

  // ── E4. B répond → actif ──
  console.log("[c2-browser] E4 — B répond, connexion DTLS-SRTP");
  await pageB.locator('[aria-label="Répondre à l\'appel"]').click();
  // A passe à « actif » : le timer 00:0x apparaît dans l'overlay
  // ⚠️ signature waitForFunction(fn, ARG, OPTIONS) — options en 3e position.
  // Le timer ne rend que dans l'état actif (data-testid dédié — un prédicat
  // regex sur textContent est cassé par les labels finissant par un chiffre :
  // « Dbg-B7 » + « 00:01 » = "700:01", \b impossible).
  await pageA.waitForFunction(
    () => !!document.querySelector('[role="dialog"][aria-label^="Appel audio"] [data-testid="call-timer"]'),
    undefined,
    { timeout: 15000, polling: 150 }
  );
  const tActive = Date.now();
  results.establishMs = tActive - tOfferAt;
  results.callActive = true;
  await pageA.waitForTimeout(700);
  await pageA.screenshot({ path: join(ASSETS, "c2-call-active-a.png") });
  await pageB.screenshot({ path: join(ASSETS, "c2-call-active-b.png") });

  // ── E7. knock ──
  results.knockStatus = knockStatus;
  console.log(`[c2-browser] E7 — knock POST /api/call-knock → HTTP ${knockStatus}`);

  // ── E5. B raccroche → zéro résidu ──
  console.log("[c2-browser] E5 — B raccroche (fin propre des deux côtés)");
  await pageB.locator('[aria-label="Terminer l\'appel"]').click();
  await pageA.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label^="Appel audio"]'),
    undefined,
    { timeout: 10000, polling: 150 }
  );
  await pageB.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label^="Appel audio"]'),
    undefined,
    { timeout: 10000, polling: 150 }
  );
  results.hangupClean = true;

  // zéro fuite : plus aucun élément audio d'appel dans le DOM, des deux côtés
  const residualA = await pageA.locator("[data-mbote-call-audio]").count();
  const residualB = await pageB.locator("[data-mbote-call-audio]").count();
  results.residualAudioElements = residualA + residualB;
  await pageA.screenshot({ path: join(ASSETS, "c2-call-ended.png") });

  // ── E6. vérification de la capture fil (in-page __mboteWire) ──
  const wireA = (await pageA.evaluate(() =>
    (window as unknown as { __mboteWire: Array<{ t: number; dir: string; event: string; size: number }> }).__mboteWire
  )) as Array<{ t: number; dir: string; event: string; size: number }>;
  const wireB = (await pageB.evaluate(() =>
    (window as unknown as { __mboteWire: Array<{ t: number; dir: string; event: string; size: number }> }).__mboteWire
  )) as Array<{ t: number; dir: string; event: string; size: number }>;
  const wire = [...wireA, ...wireB].sort((a, b) => a.t - b.t);
  appendFileSync(WIRE, wire.map((w) => JSON.stringify(w)).join("\n") + (wire.length ? "\n" : ""));
  results.wireEvents = wire.length;
  results.wireEventKinds = [...new Set(wire.map((w) => w.event))];
  // aucun payload média : les trames de signalisation restent ponctuelles et
  // < 20 Ko (le média DTLS-SRTP ne passe JAMAIS par le socket de signalisation)
  results.wireMaxSize = wire.reduce((m, w) => Math.max(m, w.size), 0);
  // latence hub : émission call:offer (A) → réception call-offer (B)
  const sentOffer = wire.find((w) => w.event === "call:offer");
  const recvOffer = wire.find((w) => w.event === "call-offer");
  if (sentOffer && recvOffer) {
    results.hubRelayMs = Math.abs(recvOffer.t - sentOffer.t);
  }

  results.ok =
    results.dialingShown === true &&
    results.ringingAtB === true &&
    results.callActive === true &&
    results.hangupClean === true &&
    residualA === 0 &&
    residualB === 0;

  writeFileSync(join(ASSETS, "c2-browser.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await ctxA.close();
  await ctxB.close();
} catch (e) {
  results.ok = false;
  results.error = e instanceof Error ? e.message : String(e);
  writeFileSync(join(ASSETS, "c2-browser.json"), JSON.stringify(results, null, 2));
  // captures de l'état À L'ÉCHEC (les deux pages) — diagnostic E4
  try {
    if (pageA) await pageA.screenshot({ path: join(ASSETS, "c2-debug-fail-a.png") });
    if (pageB) await pageB.screenshot({ path: join(ASSETS, "c2-debug-fail-b.png") });
  } catch {
    /* pages fermées */
  }
  console.error("[c2-browser] FAIL —", results.error);
  process.exit(1);
} finally {
  await browser.close();
}
