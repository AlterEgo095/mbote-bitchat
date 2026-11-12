/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D2 — PREUVE NAVIGATEUR : PoW d'onboarding, réputation et plafonds
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/d2-browser-proof.ts <BASE_URL>
 *  Sorties : docs/proofs/assets/d2-browser.json + d2-*.png
 *
 *  Scénarios :
 *   E1. Onboarding réel : PoW VISIBLE (« Préparation du compte… X% ») pendant
 *       le calcul en Web Worker — capture AVANT la fin du calcul.
 *   E2. Benchmark PoW réel (window.__mbotePow : ms, itérations, bits).
 *   E3. Profil : badge de réputation + compteurs de quota (posts/DMs restants).
 *   E4. Publication réelle depuis l'UI (le compteur décrémente).
 *   E5. Plafond ATTEINT : compteur seedé à la limite via DB → toast serveur
 *       « Vous avez atteint votre limite de posts pour aujourd'hui… ».
 *   E6. DTO GET identity : quota complet (score, tier, posts, dms).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { utcDay } from "../src/lib/mbote/sybil";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3165";
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

const prisma = new PrismaClient();
const results: Record<string, string | number | boolean | object | null> = {};
const shot = async (page: import("playwright-core").Page, name: string) => {
  await page.screenshot({ path: join(ASSETS, name) });
  console.log(`[d2-browser] capture ${name}`);
};

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // ── E1. onboarding réel avec PoW visible ──
  console.log("[d2-browser] E1 — onboarding + PoW visible");
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
  await page.getByLabel("Pseudo visible").fill("D2-Navigateur");
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  // le bloc PoW apparaît dès le démarrage du worker — attendre puis CAPTURER
  // pendant le calcul (progression visible, directive D2)
  const powBlock = page.locator('[data-testid="pow-progress"]');
  await powBlock.waitFor({ timeout: 20000 });
  const label = page.locator('[data-testid="pow-progress-label"]');
  await label.waitFor({ timeout: 5000 });
  // attend une progression > 0 sans attendre la fin (le calcul dure ~0,5-5 s)
  await page.waitForTimeout(300);
  const progressText1 = (await label.textContent()) ?? "";
  results.powVisibleDuringCalc = progressText1.includes("Préparation du compte");
  results.powProgressText = progressText1.trim();
  await shot(page, "d2-pow-onboarding.png");

  // la création locale + publication serveur terminent le dialogue
  await powBlock.waitFor({ state: "detached", timeout: 60000 });
  // le feed est prêt quand le composer est rendu (identité active, vue feed)
  await page.locator('[aria-label="Composer une publication"]').waitFor({ timeout: 30000 });
  results.onboarded = true;

  // ── E2. benchmark PoW réel ──
  const powBench = await page.evaluate(() =>
    (window as unknown as { __mbotePow?: { ms: number; iterations: number; bits: number } }).__mbotePow ?? null
  );
  results.powBench = powBench;
  if (!powBench) throw new Error("benchmark PoW absent (window.__mbotePow)");
  console.log(`[d2-browser] PoW : ${powBench.ms.toFixed(0)} ms, ${powBench.iterations} itérations, ${powBench.bits} bits`);
  writeFileSync(
    join(ASSETS, "d2-pow-bench.json"),
    JSON.stringify(
      {
        measuredIn: "browser (Web Worker, WebCrypto SHA-256)",
        ...powBench,
        iterationsPerSecond: Math.round(powBench.iterations / (powBench.ms / 1000)),
      },
      null,
      2
    )
  );

  // ── E4. publication réelle depuis l'UI (compteur 0 → 1) ──
  console.log("[d2-browser] E4 — publication réelle depuis l'UI");
  const composer = page.locator('[aria-label="Message à publier"]');
  await composer.fill("Premier post de la preuve navigateur D2 — réputation en construction.");
  await page.getByRole("button", { name: "Publier" }).first().click();
  await page.getByText("Premier post de la preuve navigateur D2").first().waitFor({ timeout: 15000 });
  results.uiPublish = true;

  // ── E3. profil : badge réputation + compteurs ──
  console.log("[d2-browser] E3 — profil : badge réputation + compteurs");
  await page.goto(`${BASE_URL}/?view=profile`, { waitUntil: "domcontentloaded" });
  const badge = page.locator('[data-testid="reputation-badge"]');
  await badge.waitFor({ timeout: 15000 });
  results.reputationBadgeText = ((await badge.textContent()) ?? "").trim();
  const quotaPosts = page.locator('[data-testid="quota-posts"]');
  await quotaPosts.waitFor({ timeout: 15000 });
  results.quotaPostsText = ((await quotaPosts.textContent()) ?? "").trim();
  results.quotaDmsText = ((await page.locator('[data-testid="quota-dms"]').textContent()) ?? "").trim();
  await page.waitForTimeout(400);
  await shot(page, "d2-profile-reputation.png");
  console.log(`[d2-browser] badge: ${results.reputationBadgeText} · ${results.quotaPostsText}`);

  // ── E5. plafond atteint : compteur seedé à la limite (score 0 → 10/j) ──
  console.log("[d2-browser] E5 — plafond atteint (toast serveur)");
  const target = await prisma.user.findFirst({
    where: { nickname: "D2-Navigateur" },
    select: { id: true, pubkey: true },
  });
  if (!target) throw new Error("utilisateur navigateur introuvable en DB");
  results.myPub = target.pubkey;
  await prisma.user.update({
    where: { id: target.id },
    data: { reputationScore: 0, postsToday: 10, dmsToday: 0, usageDay: utcDay(new Date()) },
  });
  // recharge la vue profil puis tente un post → 429 → toast
  await page.goto(`${BASE_URL}/?view=feed`, { waitUntil: "domcontentloaded" });
  await composer.fill("Post au-delà du plafond — doit être refusé avec le message D2.");
  await page.getByRole("button", { name: "Publier" }).first().click();
  await page.getByText("Vous avez atteint votre limite de posts pour aujourd'hui").first().waitFor({ timeout: 15000 });
  results.quotaToastShown = true;
  await shot(page, "d2-quota-reached.png");

  // ── E6. DTO GET identity — quota complet ──
  const me = await page.evaluate(async (pub) => {
    const r = await fetch(`/api/identity?pubkey=${encodeURIComponent(pub)}`);
    const j = (await r.json()) as { user?: { quota?: unknown } };
    return j.user?.quota ?? null;
  }, target.pubkey);
  results.identityQuota = me;
  if (!me) throw new Error("quota absent du DTO GET /api/identity");

  writeFileSync(join(ASSETS, "d2-browser.json"), JSON.stringify(results, null, 2));
  console.log("[d2-browser] OK — tous les scénarios verts");
} finally {
  await browser.close();
  await prisma.$disconnect();
}
