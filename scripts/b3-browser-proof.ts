/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b3-browser-proof — preuve navigateur du flux voix COMPLET (B3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chromium réel (ms-playwright, fake audio device) pilote l'app STANDALONE :
 *  onboarding identité A → conversation vers pair B publié par script →
 *  HOLD-TO-RECORD (pointer down 4 s sur le bouton micro — MediaRecorder opus
 *  RÉEL) → chrono visible → release → PREVIEW (lecture + durée + waveform) →
 *  « Chiffrer et envoyer » → toast succès → bulle voix avec waveform
 *  (download → decrypt → sniff) → PLAY (progression) → fallback TAP-TOGGLE.
 *
 *  Sorties : docs/proofs/assets/b3-voice-*.png + b3-voice-browser.txt (JSON).
 *  Exit non-zero si une étape échoue.
 *
 *  Usage : bun scripts/b3-browser-proof.ts <BASE_URL_APP>
 */

import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3103";
const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

const CHROME_CANDIDATES = [
  `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux64/headless_shell`,
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("FAIL — aucun Chromium ms-playwright en cache");
  process.exit(1);
}

const results: Record<string, string | number | boolean> = {};
const shot = async (page: import("playwright-core").Page, name: string) => {
  await page.screenshot({ path: join(ASSETS, name) });
  console.log(`[b3-browser] capture ${name}`);
};

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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctx.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  // ceinture-bretelles : le fake-ui flag auto-grante, on explicite le grant
  // (l'app autorise désormais microphone=(self) — next.config.ts, B3)
  await ctx.grantPermissions(["microphone"], { origin: BASE_URL });
  const page = await ctx.newPage();

  // ── onboarding identité A ──
  console.log("[b3-browser] ouverture " + BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 20000 });
  await page.getByLabel("Pseudo visible").fill("Alice-Voice-B3");
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  await page.getByText("Le fil global attend").first().waitFor({ timeout: 20000 });
  results.identity = "Alice-Voice-B3";
  console.log("[b3-browser] identité A créée");

  // ── pair B publié par script (ECDSA + ECDH — même outil que B2) ──
  const peer = spawnSync("bun", ["scripts/b2-publish-peer.ts", `B-voice-${Date.now() % 100000}`], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, BASE_URL },
  });
  if (peer.status !== 0) {
    console.error("FAIL — publish peer : " + peer.stderr);
    process.exit(1);
  }
  const peerNick = JSON.parse(peer.stdout.trim().split("\n").pop() ?? "{}").nickname as string;
  results.peer = peerNick;
  console.log(`[b3-browser] pair B publié : ${peerNick}`);

  // ── conversation A → B ──
  await page.getByRole("button", { name: "Messages" }).first().click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Nouvelle conversation" }).first().click();
  await page.getByText("Choisir un contact").first().waitFor({ timeout: 10000 });
  const clicked = await page.evaluate((nick) => {
    const b = Array.from(document.querySelectorAll("[role=dialog] button")).find(
      (x) => x.textContent && x.textContent.indexOf(nick) >= 0
    );
    if (b) {
      (b as HTMLElement).click();
      return true;
    }
    return false;
  }, peerNick);
  if (!clicked) {
    await shot(page, "b3-voice-debug-contacts.png");
    throw new Error("contact B introuvable dans le dialogue");
  }
  await page.getByText("E2E actif").first().waitFor({ timeout: 15000 });
  console.log("[b3-browser] conversation A→B ouverte (badge E2E actif)");

  // ── HOLD-TO-RECORD : pointer down 4 s sur le micro (MediaRecorder RÉEL) ──
  const mic = page.locator('[data-testid="mic-button"]');
  await mic.waitFor({ timeout: 10000 });
  await mic.hover();
  await page.mouse.down();
  await page
    .locator('[data-testid="voice-timer"]')
    .waitFor({ timeout: 10000 })
    .catch(async () => {
      await shot(page, "b3-voice-debug-no-timer.png");
      throw new Error("chrono d'enregistrement non apparu (getUserMedia ?)");
    });
  results.recording = "started";
  await page.waitForTimeout(4000); // hold ~4 s (fake tone → opus 8 kbps)
  await shot(page, "b3-voice-recording.png");
  await page.mouse.up(); // release → stop → PREVIEW
  await page.getByText("Envoyer une note vocale").first().waitFor({ timeout: 15000 });
  results.preview = "shown";
  console.log("[b3-browser] preview ouverte après release (hold-to-record OK)");
  await page.waitForTimeout(600); // laisse la waveform/métadonnées se charger
  await shot(page, "b3-voice-preview.png");

  // ── envoi (uploadVoiceNote → PUT → finalize → dm2 E2EE) ──
  await page.getByRole("button", { name: "Chiffrer et envoyer" }).first().click();
  await page.getByText("Note vocale envoyée").first().waitFor({ timeout: 30000 });
  results.send = "2xx";
  console.log("[b3-browser] toast « Note vocale envoyée » (chaîne complète passée)");

  // ── bulle voix avec waveform (download → decrypt → sniff → VoiceNote) ──
  await page.locator('[data-testid="voice-note"]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // lazy download + decrypt
  await shot(page, "b3-voice-sent-bubble.png");
  results.bubble = "rendered";
  console.log("[b3-browser] bulle voix rendue (waveform + durée)");

  // ── PLAY : progression visible (decodeAudioData + <audio> natif) ──
  await page.getByRole("button", { name: "Lecture" }).first().click();
  await page.waitForTimeout(2000);
  await shot(page, "b3-voice-playing.png");
  results.play = "started";
  await page.getByRole("button", { name: "Pause" }).first().click();
  console.log("[b3-browser] lecture démarrée puis mise en pause");

  // ── fallback TAP-TOGGLE (relâchement < 400 ms → toggle) ──
  await mic.click({ delay: 80 }); // tap court → enregistre TOUJOURS (tap mode)
  await page.locator('[data-testid="voice-timer"]').waitFor({ timeout: 8000 });
  await page.waitForTimeout(1200); // > 400 ms : le 2e tap STOPPE (pas un 2e toggle)
  await mic.click(); // 2e tap → stop → preview
  await page.getByText("Envoyer une note vocale").first().waitFor({ timeout: 15000 });
  results.tapToggle = "ok";
  console.log("[b3-browser] fallback tap-to-toggle OK");
  await page.getByRole("button", { name: "Annuler" }).first().click();
  await page.getByText("Envoyer une note vocale").first().waitFor({ state: "detached", timeout: 10000 });

  writeFileSync(join(ASSETS, "b3-voice-browser.txt"), JSON.stringify(results, null, 2) + "\n");
  console.log("[b3-browser] TOUTES LES ÉTAPES PASSÉES");
  process.exit(0);
} catch (e) {
  console.error("[b3-browser] FAIL — " + (e instanceof Error ? e.message : String(e)));
  try {
    const pages = browser.contexts()[0]?.pages();
    if (pages?.[0]) await shot(pages[0], "b3-voice-debug-fail.png");
  } catch {
    /* rien de plus */
  }
  await browser.close().catch(() => undefined);
  process.exit(1);
} finally {
  await browser.close().catch(() => undefined);
}
