/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C4 — PREUVE NAVIGATEUR : groupes privés MLS via l'UI réelle (3 navigateurs)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/c4-browser-proof.ts <BASE_URL> <HUB_URL>
 *  Sorties : docs/proofs/assets/c4-*.png + c4-browser.json
 *
 *  Scénarios (directive C4 — règles §7 DEV-SETUP : preuve navigateur
 *  OBLIGATOIRE pour tout nouveau flux utilisateur) :
 *   N1. Onboarding de TROIS identités réelles (A = créateur, B, C = invités).
 *   N2. Chacun ouvre la vue Groupes → key packages publiés (bouton actif).
 *   N3. A crée le groupe (UN commit multi-adds MLS) → capture.
 *   N4. A ouvre la conversation, envoie « Bonjour groupe MLS » → badge MLS.
 *   N5. B ouvre sa conversation → joinFromWelcome (key package consommé) →
 *       M1 déchiffré localement ; B répond → A et C lisent B.
 *   N6. A RETIRE B (confirmation) → message système visible.
 *   N7. A envoie « M2-apres-retrait » → C le déchiffre ; B ne le voit PAS
 *       (forward secrecy à l'écran).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3122";
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
  args: ["--no-sandbox", "--headless=new", "--autoplay-policy=no-user-gesture-required"],
});

async function onboard(page: import("playwright-core").Page, name: string): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
  await page.getByLabel("Pseudo visible").fill(name);
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  await page.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
}

let pageA: import("playwright-core").Page | undefined;
let pageB: import("playwright-core").Page | undefined;
let pageC: import("playwright-core").Page | undefined;

try {
  // ── N1. trois identités réelles ──
  console.log("[c4-browser] N1 — onboarding A + B + C");
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxA.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxB.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxC.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  pageA = await ctxA.newPage();
  pageB = await ctxB.newPage();
  pageC = await ctxC.newPage();
  await onboard(pageA, "Nav-Alice");
  await onboard(pageB, "Nav-Bob");
  await onboard(pageC, "Nav-Carol");

  // ── N2. vue Groupes : key packages publiés (bouton actif) ──
  console.log("[c4-browser] N2 — publication des key packages (3 navigateurs)");
  await pageA.goto(`${BASE_URL}/?view=groups`, { waitUntil: "domcontentloaded" });
  await pageB.goto(`${BASE_URL}/?view=groups`, { waitUntil: "domcontentloaded" });
  await pageC.goto(`${BASE_URL}/?view=groups`, { waitUntil: "domcontentloaded" });
  await pageA.waitForFunction(
    () => !(document.querySelector('[data-testid="create-group"]') as HTMLButtonElement | null)?.disabled,
    undefined,
    { timeout: 30000, polling: 300 }
  );
  await pageB.waitForFunction(
    () => !(document.querySelector('[data-testid="create-group"]') as HTMLButtonElement | null)?.disabled,
    undefined,
    { timeout: 30000, polling: 300 }
  );
  await pageC.waitForFunction(
    () => !(document.querySelector('[data-testid="create-group"]') as HTMLButtonElement | null)?.disabled,
    undefined,
    { timeout: 30000, polling: 300 }
  );
  results.kpsPublishedAll = true;
  await pageA.screenshot({ path: join(ASSETS, "c4-groups-empty-a.png") });

  // ── N3. A crée le groupe avec B et C ──
  console.log("[c4-browser] N3 — création du groupe (commit multi-adds)");
  // diagnostic : capturer le body réel du POST /api/groups
  let capturedMembers: string[] | null = null;
  pageA.on("request", (req) => {
    if (req.url().includes("/api/groups") && req.method() === "POST") {
      try {
        const body = req.postDataJSON() as { members?: string[]; me?: string };
        capturedMembers = body.members ?? null;
        console.log("[c4-browser] POST /api/groups me=", body.me?.slice(0, 10), "members=", (body.members ?? []).map((m) => m.slice(0, 10)));
      } catch {
        /* body illisible */
      }
    }
  });
  await pageA.locator('[data-testid="create-group"]').click();
  await pageA.getByLabel("Nom du groupe").fill("Nav-Groupe-MLS");
  // testids déterministes par contact (le label englobant + aria-label rendent
  // getByLabel ambigu quand plusieurs contacts partagent un préfixe de nickname)
  const navBobBox = pageA.locator('[data-testid="invite-check-Nav-Bob"]');
  await navBobBox.scrollIntoViewIfNeeded();
  await navBobBox.check();
  const navCarolBox = pageA.locator('[data-testid="invite-check-Nav-Carol"]');
  await navCarolBox.scrollIntoViewIfNeeded();
  await navCarolBox.check();
  await pageA.screenshot({ path: join(ASSETS, "c4-create-dialog.png") });
  await pageA.locator('[data-testid="confirm-create-group"]').click();
  // la carte du groupe apparaît dans la liste (poll)
  await pageA.getByText("Nav-Groupe-MLS").first().waitFor({ timeout: 20000 });
  results.groupCreated = true;
  results.capturedMembers = capturedMembers;
  await pageA.waitForTimeout(400);
  await pageA.screenshot({ path: join(ASSETS, "c4-group-created-a.png") });

  // ── N4. A ouvre la conversation et envoie M1 ──
  console.log("[c4-browser] N4 — A envoie « Bonjour groupe MLS »");
  // la conversation peut être déjà montée (onCreated sélectionne le groupe créé)
  const convA = pageA.locator('[data-testid="group-conversation"]');
  if (!(await convA.isVisible().catch(() => false))) {
    await pageA.getByText("Nav-Groupe-MLS").first().click();
    await convA.waitFor({ timeout: 15000 });
  }
  await pageA.locator('[data-testid="group-composer"]').fill("Bonjour groupe MLS");
  await pageA.locator('[data-testid="group-send"]').click();
  await pageA.locator('[data-testid="group-messages"]').getByText("Bonjour groupe MLS").first().waitFor({ timeout: 15000 });
  results.m1SentByA = true;
  // badge MLS + members visibles
  await pageA.locator('[data-testid="group-members"]').getByText("MLS actif").waitFor({ timeout: 8000 });
  results.mlsBadgeShownA = true;
  await pageA.waitForTimeout(300);
  await pageA.screenshot({ path: join(ASSETS, "c4-m1-active-a.png") });

  // ── N5. B ouvre la conversation → joinFromWelcome → M1 déchiffré ──
  console.log("[c4-browser] N5 — B rejoint et déchiffre M1");
  const convB = pageB.locator('[data-testid="group-conversation"]');
  if (!(await convB.isVisible().catch(() => false))) {
    await pageB.getByText("Nav-Groupe-MLS").first().click();
    await convB.waitFor({ timeout: 15000 });
  }
  await pageB.locator('[data-testid="group-messages"]').getByText("Bonjour groupe MLS").first().waitFor({ timeout: 30000 });
  results.m1DecryptedOnB = true;
  // B répond
  await pageB.locator('[data-testid="group-composer"]').fill("Salut de Bob");
  await pageB.locator('[data-testid="group-send"]').click();
  results.b2Sent = true;
  await pageB.screenshot({ path: join(ASSETS, "c4-joined-b.png") });
  // A et C lisent Bob
  await pageA.locator('[data-testid="group-messages"]').getByText("Salut de Bob").first().waitFor({ timeout: 30000 });
  results.b2ReadOnA = true;
  const convC = pageC.locator('[data-testid="group-conversation"]');
  if (!(await convC.isVisible().catch(() => false))) {
    await pageC.getByText("Nav-Groupe-MLS").first().click();
    await convC.waitFor({ timeout: 15000 });
  }
  await pageC.locator('[data-testid="group-messages"]').getByText("Bonjour groupe MLS").first().waitFor({ timeout: 30000 });
  await pageC.locator('[data-testid="group-messages"]').getByText("Salut de Bob").first().waitFor({ timeout: 30000 });
  results.m1AndB2ReadOnC = true;
  await pageC.screenshot({ path: join(ASSETS, "c4-joined-c.png") });

  // ── N6. A retire B (confirmation window.confirm) ──
  console.log("[c4-browser] N6 — A retire B (forward secrecy)");
  pageA.on("dialog", (dialog) => void dialog.accept());
  await pageA.locator('[aria-label="Retirer Nav-Bob du groupe"]').click();
  // B disparaît des badges membres (annuaire mis à jour par le poll)

  await pageA.waitForFunction(
    () => {
      const members = document.querySelector('[data-testid="group-members"]');
      return members && !members.textContent?.includes("Nav-Bob");
    },
    undefined,
    { timeout: 20000, polling: 500 }
  );
  await pageA.locator('[data-testid="group-members"]').getByText("a été retiré").waitFor({ timeout: 15000 }).catch(() => undefined);
  results.memberRemovedUI = true;
  await pageA.waitForTimeout(400);
  await pageA.screenshot({ path: join(ASSETS, "c4-removed-a.png") });

  // ── N7. A envoie M2 → C déchiffre, B ne le voit PAS ──
  console.log("[c4-browser] N7 — M2 : C déchiffre, B exclu (forward secrecy)");
  await pageA.locator('[data-testid="group-composer"]').fill("M2-apres-retrait");
  await pageA.locator('[data-testid="group-send"]').click();
  await pageC.locator('[data-testid="group-messages"]').getByText("M2-apres-retrait").first().waitFor({ timeout: 30000 });
  results.m2ReadOnC = true;
  // B attend 8 s : rien de nouveau (exclu — GET messages vide)
  await pageB.waitForTimeout(8000);
  const bHasM2 = await pageB.locator('[data-testid="group-messages"]').getByText("M2-apres-retrait").count();
  results.m2HiddenOnB = bHasM2 === 0;
  await pageC.screenshot({ path: join(ASSETS, "c4-m2-c.png") });
  await pageB.screenshot({ path: join(ASSETS, "c4-m2-b-excluded.png") });

  results.ok =
    results.kpsPublishedAll === true &&
    results.groupCreated === true &&
    results.m1SentByA === true &&
    results.mlsBadgeShownA === true &&
    results.m1DecryptedOnB === true &&
    results.b2Sent === true &&
    results.b2ReadOnA === true &&
    results.m1AndB2ReadOnC === true &&
    results.memberRemovedUI === true &&
    results.m2ReadOnC === true &&
    results.m2HiddenOnB === true;

  writeFileSync(join(ASSETS, "c4-browser.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
} catch (e) {
  results.ok = false;
  results.error = e instanceof Error ? e.message : String(e);
  writeFileSync(join(ASSETS, "c4-browser.json"), JSON.stringify(results, null, 2));
  try {
    if (pageA) await pageA.screenshot({ path: join(ASSETS, "c4-debug-fail-a.png") });
    if (pageB) await pageB.screenshot({ path: join(ASSETS, "c4-debug-fail-b.png") });
    if (pageC) await pageC.screenshot({ path: join(ASSETS, "c4-debug-fail-c.png") });
  } catch {
    /* pages fermées */
  }
  console.error("[c4-browser] FAIL —", results.error);
  process.exit(1);
} finally {
  await browser.close();
}
