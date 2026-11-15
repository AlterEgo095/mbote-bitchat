/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  g-i18n-proof — PREUVES NAVIGATEUR de la vague G (C1 reload post-MLS +
 *  i18n FR/EN + détection navigateur + pluriels + axe-core EN ≥ 90)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage :
 *    bun scripts/g-i18n-proof.ts <MAIN_URL>
 *
 *  Prérequis (g-i18n-proof-run.sh) : app principale standalone MAIN_URL
 *  (SYBIL_BYPASS=1 : le harnais crée 4 identités > plafond D2 3/h/IP — le
 *  bypass ne touche QUE ce plafond, jamais PoW ni preuve ECDSA) + hub relay.
 *
 *  SCÉNARIOS :
 *   C1 — non-régression reload post-MLS (F §9, corrigé vague G) : onboarding
 *        A + B → groupe MLS créé par A (B invité) → RELOAD → identité
 *        présente (aucun dialog), create-group ≥ 1, groupe listé, envoi d'un
 *        message MLS APRÈS reload (prouve loadGroupState IDB v2 + ratchet).
 *   FR — détection navigateur locale:fr-FR (aucun LS) → UI FR ; dates
 *        fmtDate (« 15 novembre 2026 ») prouvées DOM-vs-Intl dans la page ;
 *        pluriels tp() via aria-label des badges de recherche.
 *   SWITCH — sélecteur Profil → EN : html lang, nav EN, LS mbote_locale=en,
 *        préférence serveur persistée (/api/preferences), reload → EN
 *        (LS), effacement LS → EN par ADOPTION SERVEUR (contexte fr-FR :
 *        la détection ne peut pas expliquer l'EN) → retour FR.
 *   EN — détection locale:en-US → onboarding EN ; axe-core ≥ 90 sur
 *        feed/messages/profile EN ; pluriels EN (« 2 results »).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAIN = process.argv[2] ?? "http://127.0.0.1:3130";
const ROOT = process.cwd();
const SHOTS = join(ROOT, "docs", "proofs", "assets", "G");
const AXE_SRC = readFileSync(join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
mkdirSync(join(SHOTS, "fr"), { recursive: true });
mkdirSync(join(SHOTS, "en"), { recursive: true });

const results: Record<string, unknown> = {
  main: MAIN,
  startedAt: new Date().toISOString(),
  checks: {} as Record<string, boolean>,
};
const checks = results.checks as Record<string, boolean>;
let allOk = true;
function check(name: string, ok: boolean, detail?: string): void {
  checks[name] = ok;
  if (ok) console.log(`  [ok] ${name}`);
  else {
    allOk = false;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

if (!readFileSync(join(ROOT, "locales", "fr.json"), "utf8")) {
  console.error("FAIL — catalogues absents");
  process.exit(1);
}

if (!existsChromium()) {
  console.error("FAIL — Chromium introuvable (~/.cache/ms-playwright/chromium-1200)");
  process.exit(1);
}
function existsChromium(): boolean {
  try {
    return readFileSync(`${homedir()}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`).length > 0;
  } catch {
    return false;
  }
}

const browser = await chromium.launch({
  executablePath: `${homedir()}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

type Page = import("playwright-core").Page;
type BrowserContext = import("playwright-core").BrowserContext;

/** Tampon de console + réponses API par page — dumpé sur échec (jamais silencieux). */
const diag = new WeakMap<Page, { logs: string[]; responses: string[] }>();
function watch(page: Page): void {
  const d: { logs: string[]; responses: string[] } = { logs: [], responses: [] };
  diag.set(page, d);
  page.on("console", (msg) => {
    const cap = msg.type() === "error" ? 4000 : 300;
    d.logs.push(`[${msg.type()}] ${msg.text().slice(0, cap)}`);
    if (d.logs.length > 200) d.logs.shift();
  });
  page.on("pageerror", (err) => {
    d.logs.push(`[pageerror] ${String(err).slice(0, 300)}`);
  });
  page.on("response", (res) => {
    const u = res.url();
    if (u.includes("/api/")) {
      d.responses.push(`${res.status()} ${res.request().method()} ${u.replace(MAIN, "").slice(0, 120)}`);
      if (d.responses.length > 60) d.responses.shift();
    }
  });
  page.on("requestfailed", (req) => {
    d.responses.push(`FAILED ${req.method()} ${req.url().replace(MAIN, "").slice(0, 120)} — ${req.failure()?.errorText ?? "?"}`);
  });
}

async function dumpDiag(page: Page, name: string): Promise<void> {
  const d = diag.get(page);
  const toasts = await page
    .locator("[data-sonner-toast], [role=status]")
    .allInnerTexts()
    .catch(() => []);
  console.error(`  [diag:${name}] toasts=${JSON.stringify(toasts).slice(0, 600)}`);
  if (d) {
    console.error(`  [diag:${name}] console(récent)=\n    ${d.logs.slice(-15).join("\n    ")}`);
    console.error(`  [diag:${name}] api(récent)=\n    ${d.responses.slice(-12).join("\n    ")}`);
  }
  // filet indépendant des listeners : ressources réseau vues par la page
  const perf = (await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((e) => (e as PerformanceResourceTiming).name)
      .filter((u) => u.includes("/api/"))
      .slice(-14)
  ).catch(() => [])) as string[];
  console.error(`  [diag:${name}] perf(récent)=\n    ${perf.join("\n    ")}`);
  await page.screenshot({ path: join(SHOTS, `debug-${name}.png`) });
  console.error(`  [diag:${name}] capture debug-${name}.png`);
}

/** Pin locale fr — pour les contextes C1 (sélecteurs FR garantis). */
function pinFr(ctx: BrowserContext): void {
  void ctx.addInitScript(() => {
    try {
      localStorage.setItem("mbote_locale", "fr");
    } catch {
      /* ignore */
    }
  });
}

const ONB = {
  fr: { title: "Crée ton identité locale", nick: "Pseudo visible", cta: "Générer mes clés et entrer", menu: "Menu de mon identité" },
  en: { title: "Create your local identity", nick: "Visible nickname", cta: "Generate my keys and enter", menu: "My identity menu" },
} as const;

async function onboard(page: Page, lang: "fr" | "en", name: string): Promise<void> {
  const s = ONB[lang];
  await page.goto(`${MAIN}/`, { waitUntil: "domcontentloaded" });
  await page.getByText(s.title).first().waitFor({ timeout: 60000 });
  await page.getByLabel(s.nick).fill(name);
  await page.getByRole("button", { name: s.cta }).first().click();
  await page.locator('[role="dialog"]').first().waitFor({ state: "detached", timeout: 90000 });
  await page.locator(`[aria-label^="${s.menu}"]`).waitFor({ timeout: 30000 });
}

async function publish(page: Page, lang: "fr" | "en", text: string): Promise<void> {
  await page.goto(`${MAIN}/?view=feed`, { waitUntil: "domcontentloaded" });
  const ta = lang === "fr" ? "Message à publier" : "Message to post";
  const btn = lang === "fr" ? "Publier" : "Publish";
  await page.locator(`[aria-label="${ta}"]`).first().waitFor({ timeout: 20000 });
  await page.locator(`[aria-label="${ta}"]`).fill(text);
  await page.getByRole("button", { name: btn }).first().click();
  await page.getByText(text).first().waitFor({ timeout: 20000 });
}

async function gotoView(page: Page, view: string): Promise<void> {
  await page.goto(`${MAIN}/?view=${view}`, { waitUntil: "domcontentloaded" });
}

async function snap(page: Page, name: string, shots: string[]): Promise<void> {
  const p = join(SHOTS, name);
  await page.screenshot({ path: p });
  shots.push(name);
  console.log(`  [g-proof] capture ${name}`);
}

interface AxeViol {
  id: string;
  impact: string | null;
  nodes: number;
  targets?: string[];
}
interface ViewAxe {
  view: string;
  violations: AxeViol[];
  score: number;
  ok: boolean;
}
const axeViews: ViewAxe[] = [];

async function audit(page: Page, view: string): Promise<number> {
  await page.evaluate((src: string) => {
    const w = window as unknown as { axe?: unknown };
    if (!w.axe) {
      const s = document.createElement("script");
      s.textContent = src;
      document.head.appendChild(s);
    }
  }, AXE_SRC);
  const res = (await page.evaluate(() => {
    const w = window as unknown as {
      axe: { run: (sel?: string) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[] }> };
    };
    return w.axe.run();
  })) as { violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[] };
  const violations: AxeViol[] = res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    targets: v.nodes.map((n) => n.target.join(" > ")).slice(0, 5),
  }));
  const score =
    100 -
    violations.reduce(
      (acc, v) => acc + (v.impact === "serious" || v.impact === "critical" ? 10 : v.impact === "moderate" ? 4 : 1) * v.nodes,
      0
    );
  axeViews.push({ view, violations, score, ok: score >= 90 });
  console.log(`  [axe] ${view} : score ${score} (${violations.length} types de violation)`);
  return score;
}

/** Vérifie le tooltip fmtDate d'un PostCard contenant `text` : DOM vs Intl
 *  calculé DANS la page (même moteur → comparaison au bit près). */
async function checkPostDate(page: Page, text: string, lang: "fr" | "en", label: string): Promise<void> {
  const found = (await page.evaluate((needle: string) => {
    const holders = [...document.querySelectorAll("*")].filter((el) =>
      [...(el.childNodes ?? [])].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").includes(needle)
      )
    );
    // Montée plafonnée à 4 niveaux : la CARTE du post seulement — au-delà,
    // le conteneur du fil contient TOUS les textes (faux positif de voisin).
    for (const el of holders) {
      let p: HTMLElement | null = el as HTMLElement;
      for (let i = 0; i < 4 && p; i++) {
        const t = p.querySelector?.("time[title][dateTime]");
        if (t) return { title: t.getAttribute("title"), iso: t.getAttribute("dateTime") };
        p = p.parentElement;
      }
    }
    return null;
  }, text)) as { title: string; iso: string } | null;
  if (!found) {
    check(label, false, "time[title] introuvable pour « " + text + " »");
    return;
  }
  const expected = (await page.evaluate(
    ({ iso, lang }: { iso: string; lang: string }) =>
      new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(iso)),
    { iso: found.iso, lang }
  )) as string;
  check(label, found.title === expected, `title="${found.title}" attendu="${expected}"`);
}

/** Pluriel : ouvre la recherche, requête `q`, lit l'aria-label du badge du
 *  fil public (surface tp() — CLDR) et le compare à l'attendu. */
async function checkSearchPlural(
  page: Page,
  lang: "fr" | "en",
  q: string,
  expected: string,
  label: string,
  waitText: string
): Promise<void> {
  const triggerAria =
    lang === "fr"
      ? "Rechercher dans les fils publics et mes messages privés"
      : "Search public feeds and my private messages";
  const inputAria = lang === "fr" ? "Terme de recherche" : "Search term";
  const sectionAria = lang === "fr" ? "Résultats du fil public" : "Public feed results";
  await page.locator(`[aria-label="${triggerAria}"]`).first().click();
  const input = page.getByLabel(inputAria);
  await input.waitFor({ timeout: 10000 });
  await input.fill(q);
  const section = page.locator(`section[aria-label="${sectionAria}"]`);
  await section.waitFor({ timeout: 15000 });
  // Le résultat ATTENDU doit être visible avant de lire le badge — sinon on
  // lit les résultats de la requête précédente (course du debounce 250 ms).
  await section.getByText(waitText).first().waitFor({ timeout: 15000 });
  const badgeAria = await section.locator("[aria-label]").first().getAttribute("aria-label");
  check(label, badgeAria === expected, `aria="${badgeAria}" attendu="${expected}"`);
  await page.keyboard.press("Escape");
}

async function snapProfile(page: Page, nickname: string, name: string, shots: string[]): Promise<void> {
  // La carte identité attend la requête « me » — on capture APRÈS son rendu
  // (sinon la preuve visuelle montre des skeletons, détailhonnête mais
  // inutilisable pour comparer FR/EN).
  await page.getByText(nickname).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400); // settle des requêtes secondaires (posts, warnings)
  await snap(page, name, shots);
}

async function main(): Promise<number> {
  const shots: string[] = [];

  // ══ C1 — non-régression reload post-MLS (bug F §9 corrigé vague G) ═════════
  console.log("[g-proof] C1 — reload post-MLS garde l'identité");
  {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    pinFr(ctxA);
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    pinFr(ctxB);
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    watch(pageA);
    watch(pageB);
    await onboard(pageA, "fr", "G-Alice");
    await onboard(pageB, "fr", "G-Bob");
    await gotoView(pageA, "groups");
    await gotoView(pageB, "groups");
    await pageA.locator('[data-testid="create-group"]').waitFor({ timeout: 20000 });
    await pageA.locator('[data-testid="create-group"]').click();
    await pageA.getByLabel("Nom du groupe").fill("G-Groupe-C1");
    const box = pageA.locator('[data-testid="invite-check-G-Bob"]');
    await box.scrollIntoViewIfNeeded();
    await box.check();
    await pageA.locator('[data-testid="confirm-create-group"]').click();
    await pageA.getByText("G-Groupe-C1").first().waitFor({ timeout: 20000 });
    console.log("  groupe créé par A (commit + welcome MLS)");

    // B rejoint (sync enveloppes, soft — pas bloquant : la cible C1 est
    // l'identité locale, pas la propagation MLS déjà prouvée par C4).
    try {
      await pageB.getByText("G-Groupe-C1").first().waitFor({ timeout: 30000 });
      checks.c1_bobSeesGroup = true;
    } catch {
      checks.c1_bobSeesGroup = false;
      console.log("  (soft) B n'a pas (encore) le groupe côté liste");
    }

    // RELOAD A — le scénario exact de F §9 : dialog d'onboarding au reload,
    // createGroupCount 0 AVANT le fix.
    await pageA.reload({ waitUntil: "domcontentloaded" });
    let okA = true;
    try {
      await pageA.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
    } catch {
      okA = false;
    }
    const onbCount = await pageA.getByText("Crée ton identité locale").count();
    const lsIdentity = await pageA.evaluate(() => localStorage.getItem("mbote_identity_v1"));
    check("c1_reloadKeepsIdentityAlice", okA && onbCount === 0 && !!lsIdentity, `onboarding visible=${onbCount}, ls=${!!lsIdentity}`);
    await gotoView(pageA, "groups");
    await pageA.locator('[data-testid="create-group"]').waitFor({ timeout: 20000 });
    const createGroupCount = await pageA.locator('[data-testid="create-group"]').count();
    results.c1_createGroupCount = createGroupCount;
    check("c1_createGroupCountAtLeastOne", createGroupCount >= 1, `count=${createGroupCount}`);
    const listed = await pageA
      .getByText("G-Groupe-C1")
      .first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("c1_groupListedAfterReload", listed);
    await snap(pageA, "c1-reload-alice.png", shots);

    // Envoi MLS APRÈS reload — prouve que l'état scellé (IDB v2) est rechargé
    // et que le ratchet avance (le fix secure-db est exercé en conditions réelles).
    await pageA.getByText("G-Groupe-C1").first().click();
    try {
      await pageA.locator('[aria-label="Message de groupe"]').waitFor({ timeout: 20000 });
      await pageA.locator('[aria-label="Message de groupe"]').fill("Msg après reload C1");
      await pageA.getByRole("button", { name: "Envoyer le message de groupe" }).click();
      await pageA.getByText("Msg après reload C1").first().waitFor({ timeout: 30000 });
      check("c1_mlsSendAfterReload", true);
    } catch (e) {
      check("c1_mlsSendAfterReload", false, String(e).slice(0, 160));
      // Le toast d'erreur sonner (4 s par défaut) — re-tenter UN envoi et
      // capturer le toast IMMÉDIATEMENT pour l'erreur réelle (jamais silencieux).
      try {
        await pageA.getByRole("button", { name: "Envoyer le message de groupe" }).click();
        await pageA.waitForTimeout(2000);
        const toasts = await pageA.locator("[data-sonner-toast]").allInnerTexts();
        console.error(`  [c1] toasts après re-envoi : ${JSON.stringify(toasts)}`);
      } catch {
        /* le bouton n'existe plus : dumpDiag suffit */
      }
      await dumpDiag(pageA, "c1-mls-send");
    }

    // RELOAD B — même exigence.
    await pageB.reload({ waitUntil: "domcontentloaded" });
    let okB = true;
    try {
      await pageB.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
    } catch {
      okB = false;
    }
    const onbCountB = await pageB.getByText("Crée ton identité locale").count();
    const lsB = await pageB.evaluate(() => localStorage.getItem("mbote_identity_v1"));
    check("c1_reloadKeepsIdentityBob", okB && onbCountB === 0 && !!lsB, `onboarding visible=${onbCountB}, ls=${!!lsB}`);
    await snap(pageB, "c1-reload-bob.png", shots);
    await ctxA.close();
    await ctxB.close();
  }

  // ══ FR — détection navigateur fr-FR (aucun LS) + dates + pluriels ══════════
  let pageFr: Page | null = null;
  {
    console.log("[g-proof] FR — détection + dates + pluriels");
    const ctxFr = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      locale: "fr-FR", // détection navigateur : la locale vient d'ICI, pas du LS
    });
    pageFr = await ctxFr.newPage();
    watch(pageFr);
    await pageFr.goto(`${MAIN}/`, { waitUntil: "domcontentloaded" });
    await pageFr.getByText("Crée ton identité locale").first().waitFor({ timeout: 60000 });
    check("detectionFrOnboarding", true);
    check(
      "detectionFrHtmlLang",
      (await pageFr.evaluate(() => document.documentElement.lang)) === "fr"
    );
    await snap(pageFr, "fr/onboarding-fr.png", shots);
    await onboard(pageFr, "fr", "G-Fr");
    await publish(pageFr, "fr", "Post date GFR");
    await publish(pageFr, "fr", "ZqpunaiseA rouge");
    await publish(pageFr, "fr", "ZqpunaiseA bleue");
    await publish(pageFr, "fr", "ZqpunaiseB verte");
    await gotoView(pageFr, "feed");
    await pageFr.locator('[aria-label="Message à publier"]').first().waitFor({ timeout: 20000 });
    await pageFr.getByText("Post date GFR").first().waitFor({ timeout: 20000 });
    await checkPostDate(pageFr, "Post date GFR", "fr", "dateFmtFrLongForm");
    const relFr = (await pageFr.evaluate((needle: string) => {
      const times = [...document.querySelectorAll("time")];
      for (const t of times) {
        let p: HTMLElement | null = t as HTMLElement;
        for (let i = 0; i < 4 && p; i++) {
          if ((p.textContent ?? "").includes(needle)) return t.textContent ?? "";
          p = p.parentElement;
        }
      }
      return "";
    }, "Post date GFR")) as string;
    check("relativeFmtFr", /il y a|à l'instant|maintenant/.test(relFr), `texte="${relFr}"`);
    await snap(pageFr, "fr/feed-fr.png", shots);

    await gotoView(pageFr, "messages");
    await pageFr.getByText("Nouvelle conversation").first().waitFor({ timeout: 20000 });
    check("messagesViewFr", true);
    await snap(pageFr, "fr/messages-fr.png", shots);

    await gotoView(pageFr, "profile");
    await pageFr.locator('[data-testid="lang-select"]').waitFor({ timeout: 20000 });
    const prefsFr = await pageFr.getByText("Préférences").count();
    check("prefsCardFr", prefsFr >= 1);
    await snapProfile(pageFr, "G-Fr", "fr/profile-fr.png", shots);

    await checkSearchPlural(pageFr, "fr", "ZqpunaiseA", "2 résultats", "pluralFrTwo", "rouge");
    await checkSearchPlural(pageFr, "fr", "ZqpunaiseB", "1 résultat", "pluralFrOne", "verte");
  }

  // ══ SWITCH FR→EN (sélecteur Profil) + persistance LS + serveur + roaming ═══
  if (pageFr) {
    console.log("[g-proof] SWITCH FR→EN + persistance");
    await gotoView(pageFr, "profile");
    await pageFr.locator('[data-testid="lang-select"]').waitFor({ timeout: 20000 });
    await pageFr.locator('[data-testid="lang-select"]').click();
    await pageFr.getByRole("option", { name: "English" }).click();
    await pageFr.waitForFunction(() => document.documentElement.lang === "en", undefined, { timeout: 10000 });
    check("switchEnHtmlLang", true);
    await pageFr.getByRole("button", { name: "Feed", exact: true }).first().waitFor({ timeout: 10000 });
    check("switchEnNavText", true);
    await gotoView(pageFr, "profile");
    await pageFr.getByText("Preferences").first().waitFor({ timeout: 10000 });
    check("switchEnPrefsCard", true);
    const lsLocale = await pageFr.evaluate(() => localStorage.getItem("mbote_locale"));
    check("lsPersistedEn", lsLocale === "en", `ls=${lsLocale}`);

    const pubkey = (await pageFr.evaluate(() => {
      try {
        return (JSON.parse(localStorage.getItem("mbote_identity_v1") ?? "{}") as { pubkey?: string }).pubkey ?? null;
      } catch {
        return null;
      }
    })) as string | null;
    if (pubkey) {
      const res = await fetch(`${MAIN}/api/preferences?pubkey=${encodeURIComponent(pubkey)}`);
      const json = (await res.json()) as { locale?: string | null };
      check("serverPrefEn", json.locale === "en", `GET=${JSON.stringify(json)}`);
    } else {
      check("serverPrefEn", false, "pubkey illisible");
    }

    // Dates EN sur le MÊME post publié côté FR — la locale change le rendu.
    await gotoView(pageFr, "feed");
    await pageFr.getByText("Post date GFR").first().waitFor({ timeout: 20000 });
    await checkPostDate(pageFr, "Post date GFR", "en", "dateFmtEnLongForm");
    const relEn = (await pageFr.evaluate((needle: string) => {
      const times = [...document.querySelectorAll("time")];
      for (const t of times) {
        let p: HTMLElement | null = t as HTMLElement;
        for (let i = 0; i < 4 && p; i++) {
          if ((p.textContent ?? "").includes(needle)) return t.textContent ?? "";
          p = p.parentElement;
        }
      }
      return "";
    }, "Post date GFR")) as string;
    check("relativeFmtEn", /ago|just now|now/.test(relEn), `texte="${relEn}"`);
    await snap(pageFr, "en/feed-en.png", shots);
    await gotoView(pageFr, "messages");
    await pageFr.getByText("New conversation").first().waitFor({ timeout: 20000 });
    await snap(pageFr, "en/messages-en.png", shots);
    await gotoView(pageFr, "profile");
    await pageFr.locator('[data-testid="lang-select"]').waitFor({ timeout: 20000 });
    await snapProfile(pageFr, "G-Fr", "en/profile-en.png", shots);

    // Reload → LS garde EN.
    await pageFr.reload({ waitUntil: "domcontentloaded" });
    await pageFr.waitForFunction(() => document.documentElement.lang === "en", undefined, { timeout: 15000 });
    await pageFr.getByText("Preferences").first().waitFor({ timeout: 15000 });
    check("localePersistedAfterReload", true);

    // Effacement LS → ADOPTION SERVEUR : ce contexte est locale:fr-FR, la
    // détection ne peut PAS produire l'EN — seule la préférence du compte le peut.
    await pageFr.evaluate(() => localStorage.removeItem("mbote_locale"));
    await pageFr.reload({ waitUntil: "domcontentloaded" });
    let adopted = true;
    try {
      await pageFr.waitForFunction(() => document.documentElement.lang === "en", undefined, { timeout: 15000 });
      await pageFr.getByText("Preferences").first().waitFor({ timeout: 10000 });
    } catch {
      adopted = false;
      await snap(pageFr, "debug-server-adoption.png", shots);
    }
    check("serverAdoptionRoaming", adopted);

    // Retour FR (les deux sens du sélecteur exercés).
    await gotoView(pageFr, "profile");
    await pageFr.locator('[data-testid="lang-select"]').waitFor({ timeout: 20000 });
    await pageFr.locator('[data-testid="lang-select"]').click();
    await pageFr.getByRole("option", { name: "Français" }).click();
    await pageFr.waitForFunction(() => document.documentElement.lang === "fr", undefined, { timeout: 10000 });
    check("switchBackFr", true);
    if (pubkey) {
      const res = await fetch(`${MAIN}/api/preferences?pubkey=${encodeURIComponent(pubkey)}`);
      const json = (await res.json()) as { locale?: string | null };
      check("serverPrefBackFr", json.locale === "fr", `GET=${JSON.stringify(json)}`);
    }
    void pageFr; // contexte conservé jusqu'à la fin (preuves rendues)
  }

  // ══ EN — détection en-US + axe EN ≥ 90 (feed/messages/profile) ═════════════
  {
    console.log("[g-proof] EN — détection + axe + pluriels");
    const ctxEn = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      locale: "en-US",
    });
    const pageEn = await ctxEn.newPage();
    watch(pageEn);
    await pageEn.goto(`${MAIN}/`, { waitUntil: "domcontentloaded" });
    await pageEn.getByText("Create your local identity").first().waitFor({ timeout: 60000 });
    check("detectionEnOnboarding", true);
    check("detectionEnHtmlLang", (await pageEn.evaluate(() => document.documentElement.lang)) === "en");
    await snap(pageEn, "en/onboarding-en.png", shots);
    await onboard(pageEn, "en", "G-En");

    await gotoView(pageEn, "feed");
    await pageEn.locator('[aria-label="Message to post"]').first().waitFor({ timeout: 20000 });
    check("feedViewEn", true);
    await snap(pageEn, "en/axe-feed-en.png", shots);
    const sFeed = await audit(pageEn, "feed-en");

    await gotoView(pageEn, "messages");
    try {
      await pageEn.getByText("New conversation").first().waitFor({ timeout: 20000 });
    } catch (e) {
      await dumpDiag(pageEn, "en-messages");
      throw e;
    }
    await snap(pageEn, "en/axe-messages-en.png", shots);
    const sMsg = await audit(pageEn, "messages-en");

    await gotoView(pageEn, "profile");
    await pageEn.locator('[data-testid="lang-select"]').waitFor({ timeout: 20000 });
    await snapProfile(pageEn, "G-En", "en/axe-profile-en.png", shots);
    const sProf = await audit(pageEn, "profile-en");

    check("axeEnFeed", sFeed >= 90, `score=${sFeed}`);
    check("axeEnMessages", sMsg >= 90, `score=${sMsg}`);
    check("axeEnProfile", sProf >= 90, `score=${sProf}`);

    await checkSearchPlural(pageEn, "en", "ZqpunaiseA", "2 results", "pluralEnTwo", "rouge");
    await checkSearchPlural(pageEn, "en", "ZqpunaiseB", "1 result", "pluralEnOne", "verte");
    await ctxEn.close();
  }

  results.finishedAt = new Date().toISOString();
  results.ok = allOk;
  writeFileSync(join(ROOT, "docs", "proofs", "assets", "G", "results-g.json"), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(ROOT, "docs", "proofs", "assets", "G", "axe-resume-g.json"), JSON.stringify(axeViews, null, 2) + "\n");
  console.log(`[g-proof] terminé — ok=${allOk}, ${shots.length} captures, ${axeViews.length} audits axe`);
  await browser.close();
  return allOk ? 0 : 1;
}

process.exit(await main());
