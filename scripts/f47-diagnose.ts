/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  f47-diagnose — DIAGNOSTIC #47 (vague F, Clarification 2) : « invitation MLS
 *  invisible chez l'invité » (UI-AUDIT.md #47 / §6.3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Trois questions de la directive :
 *   Q1. le serveur stocke-t-il le welcome / le membership quand A invite B ?
 *   Q2. B reçoit-il (poll) la listing qui contient le groupe ?
 *   Q3. l'UI de B affiche-t-elle le groupe ?
 *
 *  Méthode : DEUX identités réelles via l'UI (pattern c4-browser-proof),
 *  A crée un groupe en invitant B, capture réseau de TOUTES les requêtes
 *  /api/groups* de B (statut + corps), timeline UI de B (2 s × 15), puis
 *  vérité DB (Prisma) : Group, GroupMember(B), welcome envelopes.
 *
 *  Usage (harnais) : bun scripts/f47-diagnose.ts <APP_URL> <DB_PATH>
 *  Prérequis : app standalone buildée avec NEXT_PUBLIC_SOCKET_URL + hub relay
 *  démarré (même boot que c4-mls-groups-proof-run.sh — le hub n'est PAS requis
 *  pour le listing, seulement pour le réveil temps réel).
 *
 *  Sorties : docs/proofs/assets/f47-diagnose.json + f47-bob-liste.png
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3126";
const DB_PATH = process.argv[3] ?? join(process.cwd(), "db", "f47-diagnose.db");
const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

interface BobRequest {
  t: string;
  method: string;
  url: string;
  status: number | null;
  body?: string;
}

interface TimelineTick {
  tSec: number;
  bobSees: boolean;
}

const bobRequests: BobRequest[] = [];
const bobConsoleErrors: string[] = [];
const timeline: TimelineTick[] = [];
const allRequests: { who: string; t: string; url: string; status: number }[] = [];

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
if (!existsSync(CHROME)) {
  console.error("FAIL — Chromium introuvable");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

async function onboard(page: import("playwright-core").Page, name: string): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
  await page.getByLabel("Pseudo visible").fill(name);
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  // ⚠️ le menu identité s'affiche DÈS setIdentity (AVANT le PoW + POST
  // /api/identity) — attendre la FERMETURE du dialog : la publication serveur
  // (PoW 20 bits + POST) se termine avant setOnboardingOpen(false). Un
  // rechargement plus tôt tue le flux et l'identité n'est JAMAIS publiée
  // (artefact harnais — cf. diagnostic #47, capture E group-not-visible-bob).
  await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 90000 });
  await page.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
}

async function main(): Promise<number> {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxA.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // G : locale épinglée fr — l'app détecte sinon le navigateur (CI = en-US)
  await ctxB.addInitScript(() => { try { localStorage.setItem("mbote_locale", "fr"); } catch { /* ignore */ } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // instrumentation réseau de B : toute requête /api/groups* (listing, envelopes)
  const t0 = Date.now();
  const rel = (u: string) => u.replace(BASE_URL, "");
  for (const [who, page] of [["A", pageA], ["B", pageB]] as const) {
    page.on("response", async (res) => {
      const u = res.url();
      if (!u.includes("/api/")) return;
      allRequests.push({
        who,
        t: `+${((Date.now() - t0) / 1000).toFixed(1)}s`,
        url: rel(u).slice(0, 120),
        status: res.status(),
      });
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") bobConsoleErrors.push(`${who}: ${msg.text().slice(0, 200)}`);
    });
    page.on("pageerror", (err) => bobConsoleErrors.push(`${who}: PAGEERROR ${String(err).slice(0, 200)}`));
  }
  pageB.on("response", async (res) => {
    if (res.url().includes("/api/groups")) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 400);
      } catch {
        body = "(corps illisible)";
      }
      bobRequests.push({
        t: `+${((Date.now() - t0) / 1000).toFixed(1)}s`,
        method: res.request().method(),
        url: rel(res.url()),
        status: res.status(),
        body,
      });
    }
  });
  pageB.on("console", (msg) => {
    if (msg.type() === "error") bobConsoleErrors.push(msg.text().slice(0, 200));
  });
  pageB.on("pageerror", (err) => bobConsoleErrors.push(`PAGEERROR ${String(err).slice(0, 200)}`));

  // N1. onboarding A + B
  console.log("[f47] N1 — onboarding A (créateur) + B (invité)");
  await onboard(pageA, "F47-Alice");
  await onboard(pageB, "F47-Bob");

  // N2. les deux sur la vue groupes, key packages publiés (bouton actif)
  console.log("[f47] N2 — vue groupes + publication key packages");
  await pageA.goto(`${BASE_URL}/?view=groups`, { waitUntil: "domcontentloaded" });
  await pageB.goto(`${BASE_URL}/?view=groups`, { waitUntil: "domcontentloaded" });
  for (const p of [pageA, pageB]) {
    await p.waitForFunction(
      () => !(document.querySelector('[data-testid="create-group"]') as HTMLButtonElement | null)?.disabled,
      undefined,
      { timeout: 30000, polling: 300 }
    );
  }

  // N3. A crée « F47-Diag » en invitant B (dialog réel, même flux que C4)
  console.log("[f47] N3 — A crée le groupe F47-Diag en invitant B");
  await pageA.locator('[data-testid="create-group"]').click();
  await pageA.getByLabel("Nom du groupe").fill("F47-Diag");
  const box = pageA.locator('[data-testid="invite-check-F47-Bob"]');
  await box.scrollIntoViewIfNeeded();
  await box.check();
  await pageA.locator('[data-testid="confirm-create-group"]').click();
  await pageA.getByText("F47-Diag").first().waitFor({ timeout: 20000 });
  const createMs = Date.now() - t0;
  console.log(`[f47] groupe créé côté A à t=+${(createMs / 1000).toFixed(1)}s`);

  // N4. timeline UI de B : toutes les 2 s pendant 30 s
  console.log("[f47] N4 — timeline UI de B (30 s, tick 2 s)");
  let showedAtSec: number | null = null;
  for (let i = 1; i <= 15; i++) {
    await pageB.waitForTimeout(2000);
    const sees = (await pageB.getByText("F47-Diag").count()) > 0;
    timeline.push({ tSec: i * 2, bobSees: sees });
    if (sees && showedAtSec === null) {
      showedAtSec = i * 2;
      await pageB.screenshot({ path: join(ASSETS, "f47-bob-liste.png") });
      console.log(`[f47] VISIBLE chez B à t=+${showedAtSec}s (capture f47-bob-liste.png)`);
      break;
    }
  }
  if (showedAtSec === null) {
    await pageB.screenshot({ path: join(ASSETS, "f47-bob-invisible.png") });
    console.log("[f47] JAMAIS visible chez B en 30 s (capture f47-bob-invisible.png)");
  }

  // N5. vérité DB (Q1) : group + membership B + welcome envelopes
  console.log("[f47] N5 — vérité DB");
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
  let dbGroup: { id: string; creatorKey: string; memberCount: number; allActive: boolean } | null = null;
  let dbWelcomeCount = 0;
  try {
    const g = await db.group.findFirst({
      where: { name: "F47-Diag" },
      select: {
        id: true,
        creatorKey: true,
        members: { select: { userKey: true, leftAt: true } },
      },
    });
    dbGroup = g
      ? {
          id: g.id,
          creatorKey: g.creatorKey,
          memberCount: g.members.length,
          allActive: g.members.every((m) => m.leftAt === null),
        }
      : null;
    dbWelcomeCount = g
      ? await db.groupEnvelope.count({ where: { groupId: g.id, kind: "welcome" } })
      : 0;
  } finally {
    await db.$disconnect();
  }

  // verdict : les 3 questions
  const listings = bobRequests.filter((r) => r.url.includes("/api/groups?") && r.status === 200);
  const lastListing = listings[listings.length - 1];
  const serverListedContainsGroup = lastListing?.body?.includes("F47-Diag") ?? false;
  const serverStored = dbGroup !== null && dbGroup.memberCount >= 2 && dbGroup.allActive && dbWelcomeCount >= 1;

  const verdict = {
    q1_serveurStocke: serverStored,
    q2_listingContient: serverListedContainsGroup,
    q3_uiAffiche: showedAtSec !== null,
    uiShowedAtSec: showedAtSec,
    conclusion:
      showedAtSec !== null
        ? `NON REPRODUIT sur le build courant — le groupe est visible chez l'invité à t=+${showedAtSec}s (poll 4 s). L'observation E (#47) est un artefact harnais : la capture E group-not-visible-bob.png montre le DIALOG D'ONBOARDING (contexte navigateur frais — identité perdue), pas la vue groupes.`
        : "REPRODUIT — investiguer la chaîne listing/poll",
  };

  const ok = serverStored && serverListedContainsGroup && showedAtSec !== null;
  console.log(JSON.stringify(verdict, null, 2));
  writeFileSync(
    join(ASSETS, "f47-diagnose.json"),
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        createMs,
        kpsPublishedAll: true,
        serverStored,
        dbGroup,
        dbWelcomeCount,
        serverListedContainsGroup,
        uiShowedAtSec: showedAtSec,
        bobRequests,
        allRequests,
        bobConsoleErrors,
        timeline,
        verdict,
        ok,
        finishedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  await browser.close();
  return ok ? 0 : 1;
}

try {
  const code = await main();
  process.exit(code);
} catch (e) {
  console.error("[f47] ÉCHEC :", e instanceof Error ? e.message : String(e));
  try {
    writeFileSync(
      join(ASSETS, "f47-diagnose.json"),
      JSON.stringify(
        { ok: false, error: e instanceof Error ? e.message : String(e), allRequests, bobRequests, bobConsoleErrors, timeline },
        null,
        2
      )
    );
  } catch {
    /* asset dir absent */
  }
  await browser.close();
  process.exit(1);
}
