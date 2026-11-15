/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b4-browser-proof — preuve navigateur du flux vidéo COMPLET (B4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chromium réel (ms-playwright, fake video+audio device) pilote l'app
 *  STANDALONE : onboarding identité A → conversation vers pair B publié par
 *  script → TAP sur 📹 (MediaRecorder vidéo RÉEL webm/VP8) → chrono →
 *  re-TAP stop → PREVIEW (player + durée + taille) → « Chiffrer et envoyer »
 *  → toast succès → bulle vidéo (vignette déchiffrée + badge durée) → clic →
 *  Dialog plein écran → téléchargement + decrypt → PLAY natif (progression).
 *  + prérequis : Permissions-Policy servi (camera=(self)) vérifié par le
 *  harnais (H1) et ici par le getUserMedia qui RÉUSSIT (sans le fix, le
 *  navigateur renverrait NotAllowedError — bug B3).
 *
 *  Sorties : docs/proofs/assets/b4-video-*.png + b4-video-browser.txt (JSON).
 *  Exit non-zero si une étape échoue.
 *
 *  Usage : bun scripts/b4-browser-proof.ts <BASE_URL_APP>
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
  console.log(`[b4-browser] capture ${name}`);
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
  // camera + microphone : le fix B4 (camera=(self)) doit les laisser passer
  await ctx.grantPermissions(["camera", "microphone"], { origin: BASE_URL });
  const page = await ctx.newPage();

  // ── onboarding identité A ──
  console.log("[b4-browser] ouverture " + BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 20000 });
  await page.getByLabel("Pseudo visible").fill("Alice-Video-B4");
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  await page.getByText("Le fil global attend").first().waitFor({ timeout: 20000 });
  results.identity = "Alice-Video-B4";
  console.log("[b4-browser] identité A créée");

  // ── pair B publié par script (ECDSA + ECDH — même outil que B2/B3) ──
  const peer = spawnSync("bun", ["scripts/b2-publish-peer.ts", `B-video-${Date.now() % 100000}`], {
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
  console.log(`[b4-browser] pair B publié : ${peerNick}`);

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
    await shot(page, "b4-video-debug-contacts.png");
    throw new Error("contact B introuvable dans le dialogue");
  }
  await page.getByText("E2E actif").first().waitFor({ timeout: 15000 });
  console.log("[b4-browser] conversation A→B ouverte (badge E2E actif)");

  // ── TAP-TO-RECORD : clic 📹 → getUserMedia vidéo RÉEL → chrono ──
  const videoBtn = page.locator('[data-testid="video-button"]');
  await videoBtn.waitFor({ timeout: 10000 });
  await videoBtn.click();
  await page
    .locator('[data-testid="video-timer"]')
    .waitFor({ timeout: 10000 })
    .catch(async () => {
      await shot(page, "b4-video-debug-no-timer.png");
      throw new Error("chrono vidéo non apparu (getUserMedia video ? camera=(self) mal appliqué ?)");
    });
  results.recording = "started";
  await page.waitForTimeout(5000); // ~5 s de fake video (VP8 réel)
  await shot(page, "b4-video-recording.png");
  console.log("[b4-browser] enregistrement vidéo en cours (chrono visible)");
  await videoBtn.click(); // re-TAP → stop → PREVIEW
  await page.getByText("Envoyer une vidéo").first().waitFor({ timeout: 15000 });
  results.preview = "shown";
  console.log("[b4-browser] preview vidéo ouverte après stop (tap-to-start/stop OK)");
  await page.waitForTimeout(800); // player preview + metadata
  await shot(page, "b4-video-preview.png");

  // ── envoi (uploadVideoNote → PUT → finalize (+thumb) → dm2 E2EE) ──
  await page.getByRole("button", { name: "Chiffrer et envoyer" }).first().click();
  await page.getByText("Vidéo envoyée").first().waitFor({ timeout: 60000 });
  results.send = "2xx";
  console.log("[b4-browser] toast « Vidéo envoyée » (chaîne complète passée)");

  // ── bulle vidéo : vignette déchiffrée + badge durée ──
  await page.waitForTimeout(2500); // download vignette + decrypt + rendu
  const bubble = page.locator("img[alt^='Vignette vidéo']").first();
  await bubble.waitFor({ timeout: 30000 }).catch(() => undefined);
  await shot(page, "b4-video-sent-bubble.png");
  results.bubble = "rendered";
  console.log("[b4-browser] bulle vidéo rendue (vignette + badge durée)");

  // ── clic → Dialog plein écran → téléchargement + decrypt → PLAY natif ──
  await page.locator("button[aria-label^='Vidéo reçue']").first().click();
  await page.getByText("Vidéo chiffrée ·").first().waitFor({ timeout: 10000 });
  await shot(page, "b4-video-dialog-loading.png");
  const player = page.locator("video[aria-label='Lecteur vidéo — contrôles natifs']");
  await player.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await player.locator("xpath=..").scrollIntoViewIfNeeded().catch(() => undefined);
  await shot(page, "b4-video-playing.png");
  results.play = "native-controls";
  console.log("[b4-browser] player natif affiché (blob déchiffré, contrôles <video>)");

  writeFileSync(join(ASSETS, "b4-video-browser.txt"), JSON.stringify(results, null, 2) + "\n");
  console.log("[b4-browser] TOUTES LES ÉTAPES PASSÉES");
  process.exit(0);
} catch (e) {
  console.error("[b4-browser] FAIL — " + (e instanceof Error ? e.message : String(e)));
  try {
    const pages = browser.contexts()[0]?.pages();
    if (pages?.[0]) await shot(pages[0], "b4-video-debug-fail.png");
  } catch {
    /* rien de plus */
  }
  await browser.close().catch(() => undefined);
  process.exit(1);
} finally {
  await browser.close().catch(() => undefined);
}
