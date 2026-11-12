/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C4-prerequisites — SONDE NAVIGATEUR : ts-mls 1.6.4 tourne-t-il dans le
 *  Chromium RÉEL (100 % WebCrypto natif — zéro node:crypto, zéro Buffer) ?
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le PoC bun (c4-mls-poc.ts) prouve la LOGIQUE adversariale ; cette sonde
 *  prouve le RUNTIME navigateur : groupe MLS 2 membres + message de groupe,
 *  bundle ESM browser-target, page réelle. Exit 1 si fail.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
if (!existsSync(CHROME)) {
  console.error("FAIL — Chromium introuvable");
  process.exit(1);
}

// Bundle ESM browser-target de l'entrée MLS (ts-mls + @hpke/core uniquement)
const BUNDLE_SRC = join(ROOT, ".tmp-c4-bundle", "c4-mls-bundle.mjs");
mkdirSync(join(ROOT, ".tmp-c4-bundle"), { recursive: true });
execSync(
  `bun build scripts/c4-mls-browser-entry.ts --target=browser --format=esm --outfile=${BUNDLE_SRC}`,
  { stdio: "pipe", cwd: ROOT }
);
const BUNDLE_CODE = (await import("node:fs")).readFileSync(BUNDLE_SRC, "utf8");

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

const verdict: Record<string, unknown> = {};

try {
  const page = await (await browser.newContext()).newPage();
  const PROBE_ORIGIN = "http://127.0.0.1:8126";
  await page.route(`${PROBE_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/c4-mls-bundle.mjs") {
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: BUNDLE_CODE,
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><head><title>c4 mls probe</title></head><body>probe</body></html>',
    });
  });
  await page.goto(`${PROBE_ORIGIN}/`, { waitUntil: "domcontentloaded" });

  const probe = await page.evaluate(async () => {
    try {
      const mod = (await import("/c4-mls-bundle.mjs")) as {
        runMlsBrowserProbe: () => Promise<{ ok: boolean; steps: Record<string, string>; error?: string }>;
      };
      const result = await mod.runMlsBrowserProbe();
      return result;
    } catch (e) {
      return { ok: false, steps: {}, error: String(e).slice(0, 300) };
    }
  });

  verdict.browserMls = probe;
  verdict.ok = probe.ok;
  writeFileSync(join(ASSETS, "c4-browser-probe.json"), JSON.stringify(verdict, null, 2) + "\n");
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) process.exit(1);
} finally {
  await browser.close();
}
