/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  c1-browser-proof — preuve navigateur du flux push (C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chromium réel (ms-playwright) pilote l'app STANDALONE (NODE_ENV=production
 *  → le service worker s'enregistre vraiment) :
 *    1. onboarding identité Alice ;
 *    2. profil → carte « Notifications push » (bouton Activer visible) ;
 *    3. PERMISSION GRANTÉE (playwright grantPermissions notifications) →
 *       clic « Activer » → pushManager.subscribe RÉEL (clé VAPID du serveur)
 *       → POST /api/push/subscribe signé → notice « Notifications activées »
 *       (invariant §1.8 : rien affiché avant le 2xx) ;
 *    4. rendu de notification via le canal DEBUG du SW (même fonction que le
 *       handler `push`) → getNotifications() → title/body KNOCK-ONLY.
 *
 *  Sorties : docs/proofs/assets/c1-*.png + c1-browser.txt (JSON).
 *  Usage : bun scripts/c1-browser-proof.ts <BASE_URL>
 */

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3103";
const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

// ⚠️ le headless_shell ne peut PAS souscrire (permission denied au
// pushManager.subscribe même avec grantPermissions — incident run 11) : le
// chrome COMPLET en --headless=new est OBLIGATOIRE pour le push réel.
const CHROME_CANDIDATES = [
  `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`,
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("FAIL — Chromium complet requis (pas le headless_shell : push impossible)");
  process.exit(1);
}

const results: Record<string, string | number | boolean | object | null> = {};
const shot = async (page: import("playwright-core").Page, name: string) => {
  await page.screenshot({ path: join(ASSETS, name) });
  console.log(`[c1-browser] capture ${name}`);
};

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--headless=new", "--autoplay-policy=no-user-gesture-required"],
});

/** Onboarding + retour de la page (un contexte par scénario de permission). */
async function onboard(name: string, grant: boolean) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (grant) await ctx.grantPermissions(["notifications"], { origin: BASE_URL });
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 20000 });
  await page.getByLabel("Pseudo visible").fill(name);
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  await page.getByText("Le fil global attend").first().waitFor({ timeout: 20000 });
  return { ctx, page };
}

try {
  // ── CONTEXTE A : permission REFUSÉE (headless : le prompt est auto-refusé)
  //    — la directive exige « Si refusée, message explicite » ──
  console.log("[c1-browser] contexte A — permission refusée (message explicite)");
  const a = await onboard("Alice-Push-Browser", false);
  await a.page.goto(`${BASE_URL}/?view=profile`, { waitUntil: "domcontentloaded" });
  await a.page.getByText("Notifications push").first().waitFor({ timeout: 20000 });
  await a.page.getByTestId("btn-push-enable").waitFor({ timeout: 20000 });
  await shot(a.page, "c1-profile-card.png");
  console.log("[c1-browser] carte Notifications visible (bouton Activer — config VAPID OK)");
  await a.page.getByTestId("btn-push-enable").click();
  await a.page.getByTestId("push-notice").waitFor({ timeout: 20000 });
  const noticeA = (await a.page.getByTestId("push-notice").textContent()) ?? "";
  results.noticeDenied = noticeA;
  if (!noticeA.includes("bloquées") && !noticeA.includes("refusée")) {
    console.error("FAIL — message explicite attendu pour un refus, obtenu : " + noticeA);
    await shot(a.page, "c1-debug-denied.png");
    process.exit(1);
  }
  await shot(a.page, "c1-push-denied.png");
  console.log(`[c1-browser] refus → message explicite : ${noticeA}`);
  await a.ctx.close();

  // ── CONTEXTE B : permission GRANTÉE → subscribe navigateur RÉEL ──
  console.log("[c1-browser] contexte B — permission grantée, flux Activer (résultat = réel)");
  const b = await onboard("Alice-Push-Browser", true);
  await b.page.goto(`${BASE_URL}/?view=profile`, { waitUntil: "domcontentloaded" });
  await b.page.getByText("Notifications push").first().waitFor({ timeout: 20000 });

  // ── service worker prêt (production standalone → enregistré par PwaRegister)
  const swState = await b.page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      const reg = await navigator.serviceWorker.getRegistration("/");
      if (reg?.active) return { active: true, scope: reg.scope };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { active: false };
  });
  results.serviceWorker = swState;
  if (!swState.active) {
    console.error("FAIL — service worker non actif (prod requis)");
    process.exit(1);
  }
  console.log(`[c1-browser] SW actif — scope ${swState.scope}`);

  // ── ACTIVER : le flux UI complet (le bouton attend la SUBSCRIPTION —
  //    l'état opératoire — pas la permission seule) ──
  // ⚠️ INCIDENT DOCUMENTÉ (runs 11-12) : le Chromium OSS de Playwright n'a
  // PAS les Google API keys → son push service INTERNE (FCM) refuse le
  // subscribe (« Registration failed - permission denied ») quelle que soit
  // la permission du site — le subscribe FCM RÉEL est NON TESTABLE en
  // sandbox (classe « dépendance externe », NON TESTÉ du rapport). La preuve
  // navigateur valide : le flux UI complet + l'état qui suit le RÉEL
  // (invariant §1.8) + le rendu SW via le canal DEBUG (indépendant).
  await b.page.getByTestId("btn-push-enable").waitFor({ timeout: 20000 });
  await b.page.getByTestId("btn-push-enable").click();
  await b.page.getByTestId("push-notice").waitFor({ timeout: 20000 });
  const notice = (await b.page.getByTestId("push-notice").textContent()) ?? "";
  results.notice = notice;
  results.subscribeOutcome = notice.includes("activées")
    ? "subscribed (push service interne disponible)"
    : "refused (push service interne du Chromium OSS sans Google API keys — NON TESTÉ, see proofs)";
  if (notice.length === 0) {
    console.error("FAIL — aucune notice après le clic (invariant §1.8 violé)");
    await shot(b.page, "c1-debug-enable.png");
    process.exit(1);
  }
  await shot(b.page, "c1-push-enabled.png");
  console.log(`[c1-browser] flux Activer complet — notice réelle : ${notice}`);

  // ── subscription du SW (état réel post-clic) ──
  const endpoint = await b.page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  });
  results.endpointPrefix = endpoint ? (endpoint as string).slice(0, 40) + "…" : "(aucun — push service interne indisponible en sandbox)";
  console.log(`[c1-browser] subscription pushManager : ${results.endpointPrefix}`);

  // ── rendu de notification via le canal DEBUG (même code que handler push) ──
  const rendered = await b.page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({
      type: "PUSH_TEST",
      knock: { type: "new_message", fromLabel: "Bob (preuve navigateur)" },
    });
    await new Promise((r) => setTimeout(r, 1200));
    const notifs = await reg.getNotifications();
    return notifs.map((n) => ({ title: n.title, body: n.body, data: n.data }));
  });
  results.renderedNotification = rendered;
  const n = (rendered as Array<{ title: string; body: string }>).find((x) => x.title === "Mbote");
  if (!n || !n.body.includes("Bob (preuve navigateur)")) {
    console.error("FAIL — notification non rendue : " + JSON.stringify(rendered));
    process.exit(1);
  }
  console.log(`[c1-browser] notification rendue : "${n.title}" / "${n.body}"`);
  await shot(b.page, "c1-notification-rendered.png");

  writeFileSync(join(ASSETS, "c1-browser.txt"), JSON.stringify(results, null, 2));
  console.log("[c1-browser] TERMINÉ — preuves dans docs/proofs/assets/c1-*");
} finally {
  await browser.close();
}
