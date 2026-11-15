/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D1 — PREUVE NAVIGATEUR : recherche globale (fil public + DM local) + navigation
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/d1-browser-proof.ts <BASE_URL>
 *  Sorties : docs/proofs/assets/d1-browser.json + d1-*.png
 *
 *  Scénarios :
 *   B1. Onboarding réel (identité générée dans le navigateur).
 *   B2. Recherche « kinshasa » → section « Fil public » (FTS5 serveur).
 *   B3. Clic résultat public → feed + carte « Résultat de recherche »
 *       (le post seedé est hors page 1 : fetch isolé /api/posts/[id]).
 *   B4. DM réel E2EE envoyé à Bob (clé seedée) — « rencontre secrète au
 *       marché central ».
 *   B5. Recherche « secrete » (sans accent) → section « Messages privés »
 *       (index LOCAL IndexedDB) → clic → conversation ouverte + message
 *       flashé (ring) — navigation D1 complète.
 *   B6. FRONTIÈRE RÉSEAU : TOUTES les requêtes /api/search émises par la page
 *       sont type=posts (le client n'envoie JAMAIS une recherche DM au
 *       serveur) — collecte en direct via page.on('request').
 *   B7. Terme inexistant → état vide « Aucun résultat ».
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3163";
const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

const CHROME_CANDIDATES = [
  `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`,
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("FAIL — Chromium Playwright introuvable");
  process.exit(1);
}

const results: Record<string, string | number | boolean | object | null> = {};
const shot = async (page: import("playwright-core").Page, name: string) => {
  await page.screenshot({ path: join(ASSETS, name) });
  console.log(`[d1-browser] capture ${name}`);
};

const SEARCH_TRIGGER = '[aria-label="Rechercher dans les fils publics et mes messages privés"]';
const SEARCH_INPUT = '[aria-label="Terme de recherche"]';

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctx.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  const page = await ctx.newPage();

  // B6 : collecte réseau — TOUTES les requêtes /api/search de la page
  const searchRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/search")) searchRequests.push(req.url());
  });

  // ── B1. onboarding réel ──
  console.log("[d1-browser] B1 — onboarding");
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
  await page.getByLabel("Pseudo visible").fill("D1-Navigateur");
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  // la DB de preuve contient 10k posts → le fil n'est PAS vide : attendre une
  // carte post rendue (wrapper data-post-id) plutôt que l'état vide
  await page.locator("[data-post-id]").first().waitFor({ timeout: 30000 });
  results.onboarded = true;

  // ── B2. recherche publique ──
  console.log("[d1-browser] B2 — recherche « kinshasa » (fil public)");
  await page.locator(SEARCH_TRIGGER).first().click();
  await page.locator(SEARCH_INPUT).waitFor({ timeout: 10000 });
  await page.locator(SEARCH_INPUT).fill("kinshasa");
  // ⚠️ ne PAS attendre le texte « Fil public » (présent dans la ligne d'aide
  // statique) — attendre un bouton-résultat DANS la section dédiée
  const publicSection = page.locator('section[aria-label="Résultats du fil public"]');
  await publicSection.locator("button").first().waitFor({ timeout: 15000 });
  const publicHits = await publicSection.locator("button").count();
  results.publicHits = publicHits;
  if (publicHits < 1) {
    await shot(page, "d1-debug-no-public.png");
    throw new Error("aucun résultat fil public pour « kinshasa »");
  }
  await page.waitForTimeout(400); // laisse finir le fade-in du dialog (capture propre)
  await shot(page, "d1-search-public.png");

  // ── B3. navigation vers le post (hors page 1 → carte dédiée) ──
  console.log("[d1-browser] B3 — clic résultat public → feed + carte");
  await publicSection.locator("button").first().click();
  await page.getByText("Résultat de recherche").first().waitFor({ timeout: 15000 });
  results.publicNavigation = true;
  await shot(page, "d1-search-open-post.png");
  await page.keyboard.press("Escape");

  // ── B4. DM réel E2EE vers Bob ──
  console.log("[d1-browser] B4 — DM E2EE vers Bob");
  await page.goto(`${BASE_URL}/?view=messages`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Nouvelle conversation|Nouvelle/ }).first().click();
  await page.getByText("Choisir un contact").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Bob Recherche/ }).click();
  const composer = page.locator('[aria-label="Message privé"]');
  await composer.waitFor({ timeout: 15000 });
  await composer.fill("rencontre secrète au marché central");
  await page.locator('[aria-label="Envoyer le message chiffré"]').click();
  await page.getByText("rencontre secrète au marché central").first().waitFor({ timeout: 15000 });
  results.dmSent = true;
  await shot(page, "d1-dm-sent.png");

  // ── B5. recherche locale DM + navigation + flash ──
  console.log("[d1-browser] B5 — recherche locale « secrete » → navigation + flash");
  await page.locator(SEARCH_TRIGGER).first().click();
  await page.locator(SEARCH_INPUT).waitFor({ timeout: 10000 });
  await page.locator(SEARCH_INPUT).fill("secrete");
  const dmSection = page.locator(
    'section[aria-label="Résultats des messages privés (recherche locale)"]'
  );
  await dmSection.locator("button").first().waitFor({ timeout: 15000 });
  const dmHits = await dmSection.locator("button").count();
  results.dmHits = dmHits;
  if (dmHits < 1) {
    await shot(page, "d1-debug-no-dm.png");
    throw new Error("aucun résultat DM local pour « secrete »");
  }
  await page.waitForTimeout(400);
  await shot(page, "d1-search-dm.png");
  await dmSection.locator("button").first().click();
  // flash = ring-2 posé par l'effet focus D1 sur la bulle ciblée
  await page.locator("[data-message-id].ring-2").waitFor({ timeout: 8000 });
  results.dmNavigationFlash = true;
  await shot(page, "d1-search-dm-focus.png");

  // ── B6. frontière réseau : uniquement type=posts vers /api/search ──
  results.searchRequests = searchRequests.length;
  results.searchRequestUrls = searchRequests;
  const bad = searchRequests.filter((u) => !u.includes("type=posts"));
  results.boundaryViolations = bad.length;
  if (bad.length > 0) {
    console.error("FAIL — requêtes /api/search non conformes :", bad);
    process.exit(1);
  }
  console.log(
    `[d1-browser] B6 — frontière OK : ${searchRequests.length} requêtes /api/search, toutes type=posts (0 type=dms)`
  );

  // ── B7. état vide ──
  await page.locator(SEARCH_TRIGGER).first().click();
  await page.locator(SEARCH_INPUT).waitFor({ timeout: 10000 });
  await page.locator(SEARCH_INPUT).fill("zzzrienzzz");
  await page.getByText("Aucun résultat").waitFor({ timeout: 15000 });
  results.emptyState = true;
  await shot(page, "d1-search-empty.png");

  results.ok = true;
  writeFileSync(join(ASSETS, "d1-browser.json"), JSON.stringify(results, null, 2));
  console.log("[d1-browser] OK — preuves écrites (d1-browser.json)");
  await ctx.close();
} catch (e) {
  results.ok = false;
  results.error = e instanceof Error ? e.message : String(e);
  writeFileSync(join(ASSETS, "d1-browser.json"), JSON.stringify(results, null, 2));
  console.error("[d1-browser] FAIL —", results.error);
  process.exit(1);
} finally {
  await browser.close();
}
