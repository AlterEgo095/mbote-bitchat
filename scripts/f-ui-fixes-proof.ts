/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  f-ui-fixes-proof — PREUVES NAVIGATEUR de la vague F (Critiques #1 #2 #15
 *  #39 #47 #72 + axe-core des vues critiques) — §7 DEV-SETUP : preuve
 *  navigateur OBLIGATOIRE pour chaque Critique.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage :
 *    bun scripts/f-ui-fixes-proof.ts <avant|apres> <MAIN_URL> <PANEL_URL>
 *
 *  · « avant » : exécuté AVANT les fixes — documente les défauts (captures
 *    docs/proofs/assets/F/avant/). Les assertions « défaut présent » doivent
 *    passer ; #47 (non-défaut) doit passer aussi (garde anti-régression).
 *  · « apres » : exécuté APRÈS les fixes — toutes les assertions « fix »
 *    doivent passer + axe-core ≥ 90 sur les vues critiques (proxy :
 *    score = 100 − 10×serious − 4×moderate − 1×rest).
 *
 *  Prérequis (f-ui-fixes-proof-run.sh) : app principale standalone MAIN_URL +
 *  panneau admin PANEL_URL + hub relay, DB seedée par scripts/f-seed.ts
 *  (3 admins TOTP + intention four-eyes de session « f-seed-session-1 »).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { totpAt } from "../src/lib/mbote/totp";

const PHASE = process.argv[2] ?? "apres";
const MAIN = process.argv[3] ?? "http://127.0.0.1:3128";
const PANEL = process.argv[4] ?? "http://127.0.0.1:3129";
const ROOT = process.cwd();
const SHOTS = join(ROOT, "docs", "proofs", "assets", "F", PHASE);
const AXE_SRC = readFileSync(join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
mkdirSync(SHOTS, { recursive: true });

interface AxeViol {
  id: string;
  impact: string | null;
  nodes: number;
}
interface ViewAxe {
  view: string;
  violations: AxeViol[];
  score: number;
  ok: boolean;
}

const results: Record<string, unknown> = {
  phase: PHASE,
  main: MAIN,
  panel: PANEL,
  startedAt: new Date().toISOString(),
};

if (!existsSync(`${homedir()}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`)) {
  console.error("FAIL — Chromium introuvable");
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: `${homedir()}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`,
  headless: true,
  args: ["--no-sandbox", "--headless=new"],
});

type Page = import("playwright-core").Page;

/** Onboarding ROBUSTE : attend la FERMETURE du dialog (publication PoW+POST
 *  terminée avant setOnboardingOpen(false)) — cf. diagnostic #47 : le menu
 *  identité s'affiche dès setIdentity, AVANT la fin du flux. */
async function onboard(page: Page, name: string): Promise<void> {
  await page.goto(`${MAIN}/`, { waitUntil: "domcontentloaded" });
  await page.getByText("Crée ton identité locale").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Pseudo visible").fill(name);
  await page.getByRole("button", { name: "Générer mes clés et entrer" }).first().click();
  await page.locator('[role="dialog"]').first().waitFor({ state: "detached", timeout: 90000 });
  await page.locator('[aria-label^="Menu de mon identité"]').waitFor({ timeout: 30000 });
}

/** Login panneau admin (TOTP réel). offsetWindows : +1 = fenêtre suivante
 *  (anti-rejeu — deux logins rapprochés). */
async function adminLogin(page: Page, email: string, password: string, secret: string, offsetWindows = 0): Promise<void> {
  await page.goto(`${PANEL}/`, { waitUntil: "domcontentloaded" });
  await page.getByText("Se connecter").first().waitFor({ timeout: 30000 });
  const code = totpAt(secret, Date.now() + offsetWindows * 30000).code;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByLabel("Code TOTP (6 chiffres)").fill(code);
  await page.getByRole("button", { name: "Se connecter" }).click();
  try {
    await page.getByText(email).first().waitFor({ timeout: 15000 });
  } catch {
    // diagnostic : ce que la page affiche à la place de la session active
    const err = await page.locator('[role="alert"], .text-red-700, .text-red-800').allInnerTexts().catch(() => []);
    await page.screenshot({ path: join(SHOTS, `debug-login-${email.split("@")[0]}.png`) });
    throw new Error(`login ${email} échoué — alerts visibles : ${JSON.stringify(err).slice(0, 400)}`);
  }
}

/** Crée un groupe via l'UI réelle (flux f47). Retourne le nom. */
async function createGroupWith(page: Page, name: string, inviteNickname: string): Promise<void> {
  await page.locator('[data-testid="create-group"]').click();
  await page.getByLabel("Nom du groupe").fill(name);
  const box = page.locator(`[data-testid="invite-check-${inviteNickname}"]`);
  await box.scrollIntoViewIfNeeded();
  await box.check();
  await page.locator('[data-testid="confirm-create-group"]').click();
  await page.getByText(name).first().waitFor({ timeout: 20000 });
}

async function main(): Promise<number> {
  const shots: string[] = [];
  const snap = async (page: Page, name: string): Promise<void> => {
    const p = join(SHOTS, name);
    await page.screenshot({ path: p });
    shots.push(name);
    console.log(`[f-proof] capture ${PHASE}/${name}`);
  };

  // ── identités réelles (A créateur, B invité — réutilisées par P4/P6/axe) ──
  console.log("[f-proof] N1 — onboarding A + B (identités réelles)");
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await onboard(pageA, "F-Alice");
  await onboard(pageB, "F-Bob");

  // ══ P1 — Critique #1 : panic wipe SANS confirmation (header) ══════════════
  console.log("[f-proof] P1 — panic wipe (#1) — contexte JETABLE (le wipe détruit");
  console.log("[f-proof]       l'identité du contexte : pageA la garde pour la suite)");
  {
    const ctxW = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const pageW = await ctxW.newPage();
    await onboard(pageW, "F-Ephemere");
    await pageW.locator('[aria-label^="Menu de mon identité"]').click();
    await pageW.getByText("Panic wipe").first().waitFor({ timeout: 5000 });
    await snap(pageW, "p1-menu-ouvert.png");
    await pageW.getByText("Panic wipe").first().click();
    await pageW.waitForTimeout(1200);
    const dialog = await pageW.locator('[role="alertdialog"]').count();
    const backToOnboarding = (await pageW.getByText("Crée ton identité locale").count()) > 0;
    const menuStill = (await pageW.locator('[aria-label^="Menu de mon identité"]').count()) > 0;
    if (PHASE === "apres") {
      results.p1_dialogShown = dialog > 0;
      if (dialog > 0) {
        await snap(pageW, "p1-dialog-confirmation.png");
        // annuler → identité intacte
        await pageW.getByRole("button", { name: "Annuler" }).click();
        await pageW.waitForTimeout(400);
        results.p1_cancelKeepsIdentity =
          (await pageW.locator('[aria-label^="Menu de mon identité"]').count()) > 0 &&
          (await pageW.getByText("Crée ton identité locale").count()) === 0;
        await snap(pageW, "p1-apres-annuler.png");
        // confirmer → wipe réel
        await pageW.locator('[aria-label^="Menu de mon identité"]').click();
        await pageW.getByText("Panic wipe").first().click();
        await pageW.locator('[role="alertdialog"]').waitFor({ timeout: 5000 });
        await pageW.getByRole("button", { name: "Effacer définitivement" }).click();
        await pageW.getByText("Crée ton identité locale").first().waitFor({ timeout: 15000 });
        results.p1_confirmWipes = true;
        await snap(pageW, "p1-wipe-execute.png");
      }
    } else {
      // avant : le wipe s'exécute SANS aucune confirmation
      results.p1_wipeImmediate = backToOnboarding && !menuStill && dialog === 0;
      await snap(pageW, "p1-wipe-immediat-sans-confirmation.png");
    }
    await ctxW.close();
  }

  // ══ P2 — Critique #2 : échec de publication d'identité invisible (429) ════
  console.log("[f-proof] P2 — publication identité 429 (#2)");
  {
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page2 = await ctx2.newPage();
    const identityPosts: number[] = [];
    // avant la publication : chaque POST /api/identity → 429 (même corps que le serveur D2)
    let identityUnblocked = false;
    await page2.route("**/api/identity", async (route) => {
      if (route.request().method() === "POST") {
        // NB : le garde D2 réel (3/h/IP) saturerait le retry (l'onboarding A
        // du harnais consomme des créations) — le succès du retry est MOCKÉ
        // (réponse 200 même forme que le serveur) pour rester déterministe.
        if (identityUnblocked) {
          identityPosts.push(200);
          const body = route.request().postDataJSON() as { pubkey: string; nickname: string; ecdhPub?: string };
          await route.fulfill({
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user: {
                id: "f-proof-user-mock",
                pubkey: body.pubkey,
                nickname: body.nickname,
                bio: null,
                ecdhPub: body.ecdhPub ?? null,
                isBot: false,
                createdAt: new Date().toISOString(),
              },
            }),
          });
          return;
        }
        identityPosts.push(429);
        await route.fulfill({
          status: 429,
          headers: { "Retry-After": "3600", "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Trop de créations de comptes depuis cette adresse — réessayez plus tard (3 comptes par heure).",
            code: "identity_create_rate_limited",
          }),
        });
      } else {
        await route.continue();
      }
    });
    await onboard(page2, "F-Carol");
    await page2.waitForTimeout(600);
    const banner = await page2.locator('[data-testid="identity-publish-error"]').count();
    results.p2_identityPosts = identityPosts.length;
    if (PHASE === "apres") {
      results.p2_persistentBanner = banner > 0;
      if (banner > 0) {
        const txt = await page2.locator('[data-testid="identity-publish-error"]').innerText();
        results.p2_bannerMentionsRetry = /réessaie|Réessaie|Trop de créations/.test(txt);
        await snap(page2, "p2-banniere-persistante-429.png");
        // retry : bascule la route vers un succès mocké (200) → POST réel du
        // point de vue du client → bannière disparaît
        identityUnblocked = true;
        await page2.getByRole("button", { name: /Réessayer la publication/ }).click();
        await page2.locator('[data-testid="identity-publish-error"]').waitFor({ state: "detached", timeout: 20000 });
        results.p2_retryWorks = true;
        await snap(page2, "p2-retry-ok.png");
      }
    } else {
      // avant : aucune bannière persistante (seul un toast fugace)
      results.p2_persistentBanner = banner > 0;
      await snap(page2, "p2-echec-publication-invisible.png");
    }
    await ctx2.close();
  }

  // ══ P3 — Critique #15 : FeedView sans état d'erreur ═══════════════════════
  console.log("[f-proof] P3 — feed état d'erreur (#15)");
  {
    await pageA.route("**/api/posts**", (route) => void route.abort());
    await pageA.goto(`${MAIN}/?view=feed`, { waitUntil: "domcontentloaded" });
    await pageA.waitForTimeout(2500);
    const lieVide = (await pageA.getByText("Le fil global attend ton premier message").count()) > 0;
    const errState = (await pageA.locator('[data-testid="feed-error"]').count()) > 0;
    results.p3_lieVideMensonger = lieVide;
    results.p3_errorState = errState;
    if (PHASE === "apres") {
      results.p3_fixOk = errState && !lieVide;
      if (errState) {
        await snap(pageA, "p3-etat-erreur-feed.png");
        await pageA.unroute("**/api/posts**");
        await pageA.getByRole("button", { name: "Réessayer" }).click();
        await pageA.locator('[data-testid="feed-error"]').waitFor({ state: "detached", timeout: 20000 });
        results.p3_recoverWorks = true;
        await snap(pageA, "p3-feed-recupere.png");
      }
    } else {
      results.p3_defaut = lieVide && !errState;
      await snap(pageA, "p3-fil-vide-mensonger.png");
      await pageA.unroute("**/api/posts**");
    }
  }

  // ══ P4/P6 — Critique #39 (clavier) + #47 (garde invitation MLS) ═══════════
  console.log("[f-proof] P4 — groupes : publication key packages");
  await pageA.goto(`${MAIN}/?view=groups`, { waitUntil: "domcontentloaded" });
  await pageB.goto(`${MAIN}/?view=groups`, { waitUntil: "domcontentloaded" });
  for (const p of [pageA, pageB]) {
    await p.waitForFunction(
      () => !(document.querySelector('[data-testid="create-group"]') as HTMLButtonElement | null)?.disabled,
      undefined,
      { timeout: 30000, polling: 300 }
    );
  }
  console.log("[f-proof] P4 — A crée « F-Groupe » en invitant B");
  await createGroupWith(pageA, "F-Groupe", "F-Bob");

  console.log("[f-proof] P6 — garde anti-régression #47 : le groupe est visible chez B");
  {
    let bobSeesAtSec: number | null = null;
    for (let i = 1; i <= 7; i++) {
      await pageB.waitForTimeout(2000);
      if ((await pageB.getByText("F-Groupe").count()) > 0) {
        bobSeesAtSec = i * 2;
        break;
      }
    }
    results.p47_bobSeesAtSec = bobSeesAtSec;
    results.p47_ok = bobSeesAtSec !== null;
    if (bobSeesAtSec !== null) await snap(pageB, "p47-groupe-visible-chez-bob.png");
  }

  console.log("[f-proof] P4 — #39 : sélection de groupe au clavier");
  {
    // focus « Nouveau groupe » puis TABS jusqu'à la carte : la carte doit être
    // atteignable au clavier (fix #39) — boucle bornée (le DOM contient d'autres
    // focusables entre le header et la liste : nav, composer, recherche…).
    await pageB.getByRole("button", { name: /Nouveau groupe|Créer un groupe/ }).click();
    await pageB.waitForTimeout(300);
    await pageB.keyboard.press("Escape");
    await pageB.waitForTimeout(300);
    let active: { testid: string; role: string; text: string } | null = null;
    let tabs = 0;
    for (let i = 0; i < 80; i++) {
      await pageB.keyboard.press("Tab");
      tabs++;
      active = await pageB.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el
          ? { testid: el.getAttribute("data-testid") ?? "", role: el.getAttribute("role") ?? "", text: (el.textContent ?? "").slice(0, 40) }
          : null;
      });
      if (active && (active.testid.startsWith("group-card") || (active.role === "button" && active.text.includes("F-Groupe")))) {
        break;
      }
    }
    const cardRoleButtons = await pageB.getByRole("button", { name: /F-Groupe/ }).count();
    results.p39_activeAfterTab = active;
    results.p39_tabsToCard = tabs;
    results.p39_cardRoleButtons = cardRoleButtons;
    if (PHASE === "apres") {
      results.p39_cardFocusable =
        cardRoleButtons > 0 && active !== null && (active.testid.startsWith("group-card") || active.role === "button");
      if (results.p39_cardFocusable) {
        await pageB.keyboard.press("Enter");
        await pageB.waitForTimeout(600);
        const convOpen = (await pageB.locator('[data-testid="group-conversation"]').count()) > 0;
        results.p39_enterOpens = convOpen;
        await snap(pageB, "p39-carte-focus-clavier-conversation.png");
      }
    } else {
      results.p39_defaut = cardRoleButtons === 0 && (active === null || !active.testid.startsWith("group-card"));
      await snap(pageB, "p39-carte-inaccessible-clavier.png");
    }
  }

  // ══ P5 — Critique #72 : pending-actions email === rôle ════════════════════
  console.log("[f-proof] P5 — pending-actions (#72) : mod puis sa");
  {
    const secrets = JSON.parse(readFileSync(join(ROOT, "db", "f-secrets.json"), "utf8")) as Record<
      string,
      { email: string; password: string; totpSecret: string; role: string }
    >;
    const ctxM = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const pageM = await ctxM.newPage();
    await adminLogin(pageM, secrets["mod@f-proof.test"].email, secrets["mod@f-proof.test"].password, secrets["mod@f-proof.test"].totpSecret);
    await pageM.goto(`${PANEL}/pending-actions`, { waitUntil: "domcontentloaded" });
    await pageM.getByText("PURGE DE POST").first().waitFor({ timeout: 15000 });
    const noteLoc = pageM.getByText(/En attente|Vous êtes le demandeur/).first();
    results.p72_modNote = (await noteLoc.count()) > 0 ? await noteLoc.innerText() : null;
    results.p72_modNoteTestid = (await pageM.locator('[data-testid="four-eyes-note"]').count()) > 0;
    await snap(pageM, "p72-vue-moderateur.png");
    await ctxM.close();

    const ctxS = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const pageS = await ctxS.newPage();
    await adminLogin(pageS, secrets["sa@f-proof.test"].email, secrets["sa@f-proof.test"].password, secrets["sa@f-proof.test"].totpSecret, 1);
    await pageS.goto(`${PANEL}/pending-actions`, { waitUntil: "domcontentloaded" });
    await pageS.getByText("PURGE DE POST").first().waitFor({ timeout: 15000 });
    const noteLocS = pageS.getByText(/En attente|Vous êtes le demandeur/).first();
    results.p72_saNote = (await noteLocS.count()) > 0 ? await noteLocS.innerText() : null;
    await snap(pageS, "p72-vue-super-admin.png");
    if (PHASE === "apres") {
      results.p72_saIsRequester = results.p72_saNote !== null && /Vous êtes le demandeur/.test(results.p72_saNote as string);
      results.p72_modFourEyes = results.p72_modNote !== null && /super-admins \(four-eyes\)/.test(results.p72_modNote as string);
      results.p72_noteTestid = results.p72_modNoteTestid === true;
    } else {
      // avant : sa (demandeur, nouvelle session) reçoit le diagnostic FAUX
      results.p72_saMessageFaux =
        results.p72_saNote !== null && /vous n'êtes pas l'acteur/.test(results.p72_saNote as string);
    }
    await ctxS.close();
  }

  // ══ axe-core (phase apres) — vues critiques ═══════════════════════════════
  if (PHASE === "apres") {
    console.log("[f-proof] axe-core sur les vues critiques");
    const axeViews: ViewAxe[] = [];
    const scoreOf = (vs: AxeViol[]): number =>
      100 - vs.reduce((acc, v) => acc + (v.impact === "serious" || v.impact === "critical" ? 10 : v.impact === "moderate" ? 4 : 1) * v.nodes, 0);

    const audit = async (page: Page, view: string): Promise<void> => {
      await page.evaluate((src: string) => {
        const w = window as unknown as { axe?: unknown };
        if (!w.axe) {
          const s = document.createElement("script");
          s.textContent = src;
          document.head.appendChild(s);
        }
      }, AXE_SRC);
      const res = (await page.evaluate(() => {
        const w = window as unknown as { axe: { run: (sel?: string) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: string[]; html: string }[] }[] }> } };
        return w.axe.run();
      })) as { violations: { id: string; impact: string | null; nodes: { target: string[]; html: string }[] }[] };
      const violations = res.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        targets: v.nodes.map((n) => n.target.join(" > ")).slice(0, 5),
        html: v.nodes.map((n) => n.html.slice(0, 200)).slice(0, 5),
      }));
      const score = scoreOf(violations);
      axeViews.push({ view, violations, score, ok: score >= 90 });
      console.log(`  [axe] ${view} : score ${score} (${violations.length} types de violation)`);
    };

    // navigation véridique : pageA sur le FEED (le harnais la laisse sur
    // groups après P4 — le label « feed » d'axe doit auditer le feed réel)
    await pageA.goto(`${MAIN}/?view=feed`, { waitUntil: "domcontentloaded" });
    await pageA.waitForTimeout(1500);
    await audit(pageA, "feed");
    await audit(pageB, "groups");
    // onboarding dialog (contexte frais)
    const ctxO = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const pageO = await ctxO.newPage();
    await pageO.goto(`${MAIN}/`, { waitUntil: "domcontentloaded" });
    await pageO.getByText("Crée ton identité locale").first().waitFor({ timeout: 30000 });
    await audit(pageO, "onboarding");
    await ctxO.close();

    // messages hors-ligne (#31 — contraste de la bulle file locale) :
    // C1 (Clarification 1, artefact harnais famille #47) : le bloc est désormais
    // AUTO-CONTENU dans un contexte JETABLE avec sa propre identité — l'ancienne
    // version réutilisait pageA (contexte partagé par toute la suite) : après le
    // cycle P1-wipe + reloads, l'identité pouvait manquer → re-onboard de
    // secours → POST réel sous le garde D2 (3/h/IP : 4ᵉ création) → 429 →
    // dialog bloqué → audit sauté (et pire : dans le run « passant » f258a25,
    // l'audit a tourné sur le DIALOG d'onboarding au-dessus du feed, pas sur la
    // vue Messages — capture axe-messages-offline.png de l'époque comme preuve).
    // Flux déterministe : identité fraîche (SYBIL_BYPASS=1 côté serveur), DM à
    // F-Bob via le picker, mode mesh activé sur place (sans reload), envoi
    // hors-ligne → bulle « En attente » GARANTIE dans le DOM avant l'audit.
    {
      const ctxMsg = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
      const pageM = await ctxMsg.newPage();
      await onboard(pageM, "F-Offline");
      await pageM.goto(`${MAIN}/?view=messages`, { waitUntil: "domcontentloaded" });
      await pageM.getByRole("button", { name: "Nouvelle conversation" }).waitFor({ timeout: 20000 });
      await pageM.getByRole("button", { name: "Nouvelle conversation" }).click();
      const picker = pageM.locator('[role="dialog"]');
      await picker.getByRole("button", { name: /F-Bob/ }).first().waitFor({ timeout: 10000 });
      await picker.getByRole("button", { name: /F-Bob/ }).first().click();
      // NB : le composer ne matche PAS par placeholder (« Message chiffré
      // (ECDH + AES-GCM)… » en ligne, « Hors-ligne — … » en mesh) — l'Input
      // porte aria-label="Message privé" (l'ancien sélecteur placeholder du
      // harnais était faux : le send pouvait silencieusement ne jamais partir)
      const composer = pageM.locator('[aria-label="Message privé"]').first();
      await composer.waitFor({ timeout: 15000 });
      // mode mesh sur place (menu identité → pas de reload → la sélection et
      // l'identité restent montées — plus aucun cycle destructif)
      await pageM.locator('[aria-label^="Menu de mon identité"]').click();
      await pageM.getByText("Activer le mode mesh").click();
      await pageM.locator('[aria-label^="Menu de mon identité"]').waitFor({ state: "visible", timeout: 10000 });
      await composer.fill("Message hors-ligne preuve F");
      await pageM.keyboard.press("Enter");
      // la cible du contrat #31 EST dans le DOM : jamais d'audit sur un état vide
      await pageM.getByText("En attente").first().waitFor({ timeout: 15000 });
      // C1 — DOM propre avant audit : pointer ailleurs (un tooltip Radix peut
      // rester ouvert sous le curseur après le clic menu) + Escape (ferme tout
      // overlay restant) + attente bornée de détachement des wrappers popper.
      // Diagnostic à chaque étape : jamais silencieux.
      await pageM.mouse.move(400, 400);
      await pageM.keyboard.press("Escape");
      await pageM.waitForTimeout(400);
      const lingering = await pageM.evaluate(() => {
        const poppers = Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"));
        const hidden = Array.from(document.querySelectorAll('[aria-hidden="true"]'))
          .map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").slice(0, 60)}`);
        return {
          poppers: poppers.map((p) => (p.textContent ?? "").slice(0, 80)),
          ariaHidden: hidden,
        };
      });
      console.log(`  [axe] messages-offline : état overlays avant audit = ${JSON.stringify(lingering)}`);
      try {
        await pageM.locator("[data-radix-popper-content-wrapper]").first().waitFor({ state: "detached", timeout: 3000 });
      } catch {
        const stuck = await pageM.evaluate(() =>
          Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]")).map((p) => (p.outerHTML ?? "").slice(0, 300))
        );
        console.log(`  [axe] messages-offline : popper ENCORE PRÉSENT après 3 s : ${JSON.stringify(stuck)}`);
        throw new Error(`popper Radix persistant avant audit messages-offline : ${JSON.stringify(lingering.poppers)}`);
      }
      await audit(pageM, "messages-offline");
      await snap(pageM, "axe-messages-offline.png");
      await ctxMsg.close();
    }

    // écriture incrémentale — les scores déjà mesurés survivent à un échec
    // ultérieur (jamais silencieux)
    writeFileSync(join(ROOT, "docs", "proofs", "assets", "F", "axe-resume.json"), JSON.stringify(axeViews, null, 2));

    // pending-actions admin (mod) — contraste #73
    const secrets = JSON.parse(readFileSync(join(ROOT, "db", "f-secrets.json"), "utf8")) as Record<
      string,
      { email: string; password: string; totpSecret: string; role: string }
    >;
    const ctxM2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const pageM2 = await ctxM2.newPage();
    // offsetWindows=1 : le login P5 de mod a consommé le compteur TOTP courant
    // (anti-rejeu §É3 — un même compteur ≤ est un rejeu) ; la fenêtre suivante
    // reste dans la tolérance ±1 de verifyTotp.
    await adminLogin(pageM2, secrets["mod@f-proof.test"].email, secrets["mod@f-proof.test"].password, secrets["mod@f-proof.test"].totpSecret, 1);
    await pageM2.goto(`${PANEL}/pending-actions`, { waitUntil: "domcontentloaded" });
    await pageM2.waitForTimeout(1500);
    await audit(pageM2, "admin-pending-actions");
    await snap(pageM2, "axe-admin-pending-actions.png");
    await ctxM2.close();

    results.axeViews = axeViews;
    // C1 — skip NON silencieux : les 5 vues attendues doivent TOUTES être
    // présentes et vertes. Une vue manquante (saut, artefact harnais) = verdict
    // ÉCHEC — « si un skip persiste, ne pas clore » (Clarification 1 post-F).
    const EXPECTED_AXE_VIEWS = ["feed", "groups", "onboarding", "messages-offline", "admin-pending-actions"];
    const missingViews = EXPECTED_AXE_VIEWS.filter((v) => !axeViews.some((x) => x.view === v));
    results.axeMissingViews = missingViews;
    results.axeAllOk = missingViews.length === 0 && axeViews.every((v) => v.ok);
    if (missingViews.length > 0) {
      console.log(`[f-proof] axe : VUES MANQUANTES = ${missingViews.join(", ")} — verdict ÉCHEC (skip non toléré)`);
    }
    writeFileSync(join(ROOT, "docs", "proofs", "assets", "F", "axe-resume.json"), JSON.stringify(axeViews, null, 2));
  }

  // verdict AVANT l'écriture : le champ ok doit être dans le JSON (jamais
  // silencieux — l'exit code seul ne se lit pas a posteriori)
  let ok: boolean;
  if (PHASE === "apres") {
    ok =
      results.p1_dialogShown === true &&
      results.p1_cancelKeepsIdentity === true &&
      results.p1_confirmWipes === true &&
      results.p2_persistentBanner === true &&
      results.p2_retryWorks === true &&
      results.p3_fixOk === true &&
      results.p3_recoverWorks === true &&
      results.p39_cardFocusable === true &&
      results.p39_enterOpens === true &&
      results.p47_ok === true &&
      results.p72_saIsRequester === true &&
      results.p72_modFourEyes === true &&
      results.p72_noteTestid === true &&
      results.axeAllOk === true;
  } else {
    ok =
      results.p1_wipeImmediate === true &&
      results.p2_persistentBanner === false &&
      results.p3_defaut === true &&
      results.p39_defaut === true &&
      results.p47_ok === true &&
      results.p72_saMessageFaux === true;
  }
  results.ok = ok;
  results.shots = shots;
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(SHOTS, "..", `results-${PHASE}.json`), JSON.stringify(results, null, 2));

  console.log(`[f-proof] VERDICT phase ${PHASE} : ${ok ? "TOUTES PREUVES OK" : "ÉCHEC — voir results json"}`);
  console.log(JSON.stringify(results, (k, v) => (k === "axeViews" || k === "axe-resume" ? undefined : v), 1).slice(0, 2400));
  await browser.close();
  return ok ? 0 : 1;
}

try {
  const code = await main();
  process.exit(code);
} catch (e) {
  console.error("[f-proof] ÉCHEC :", e instanceof Error ? e.message : String(e));
  try {
    // résultats PARTIELS conservés (jamais silencieux — leçon f47)
    writeFileSync(
      join(ROOT, "docs", "proofs", "assets", "F", `results-${PHASE}.json`),
      JSON.stringify({ ...results, ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2)
    );
  } catch {
    /* asset dir absent */
  }
  await browser.close();
  process.exit(1);
}
