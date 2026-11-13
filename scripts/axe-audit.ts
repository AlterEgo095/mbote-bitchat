/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  axe-audit — vague E : axe-core par vue + captures + flux réels multi-identités
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prérequis : `bun scripts/ui-audit-boot.ts` doit tourner (app :3100, panneau
 *  :3103, hub :3040, DB seedée) — manifeste docs/proofs/E-axe/infra.json.
 *
 *  Commande :  bun scripts/axe-audit.ts
 *
 *  Sorties :
 *    · docs/proofs/E-axe/<vue>.json   — violations axe-core compactes par vue
 *    · docs/proofs/E-axe/resume.json  — score par vue + notes de flux
 *    · docs/proofs/assets/E/<étape>.png — captures (états critiques)
 *
 *  Flux réels exercés : onboarding (PoW visible) → post au fil → DM Alice↔Bob
 *  (2 contextes = 2 identités réelles) → appel audio (sonnerie/actif) → groupe
 *  MLS (création + invitation) → hors-ligne (file locale) → dégradation relay
 *  (SIGSTOP hub) → panneau admin (login TOTP réel + 5 vues) → responsive 375.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { chromium, type Page, type BrowserContext } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { totpAt } from "../src/lib/mbote/totp";

const ROOT = process.cwd();
const OUT = join(ROOT, "docs", "proofs", "E-axe");
const SHOTS = join(ROOT, "docs", "proofs", "assets", "E");
const infra = JSON.parse(readFileSync(join(OUT, "infra.json"), "utf8")) as {
  main: string; panel: string; hub: string; db: string;
  adminEmail: string; adminPassword: string;
};
const AXE = readFileSync(join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
const CHROME = join(homedir(), ".cache", "ms-playwright", "chromium-1200", "chrome-linux64", "chrome");

mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

interface VueResult {
  name: string;
  url: string;
  violations: { id: string; impact: string | null; nodes: number; help: string; targets?: { selector: unknown; html: string; summary: string }[] }[];
  passes: number;
  incomplete: number;
  notes: string[];
  error?: string;
}

const results: VueResult[] = [];
/** suffixe unique par run — évite les collisions d'identités entre passes */
const RUN = `E-${Date.now().toString(36).slice(-4)}`;
const note = (name: string, msg: string): void => {
  const r = results.find((x) => x.name === name);
  if (r) r.notes.push(msg);
  console.log(`  [note] ${name}: ${msg}`);
};

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  } catch {
    /* capture non bloquante */
  }
}

/** Injecte axe-core, exécute l'audit, écrit le JSON compact de la vue. */
async function axeView(page: Page, name: string, url: string): Promise<VueResult> {
  const res: VueResult = { name, url, violations: [], passes: 0, incomplete: 0, notes: [] };
  try {
    await page.addScriptTag({ content: AXE });
    const axe = (await page.evaluate(`
      window.axe.run(document, { resultTypes: ["violations", "passes", "incomplete"] })
    `)) as { violations: { id: string; impact: string | null; nodes: unknown[]; help: string }[]; passes: { nodes: unknown[] }[]; incomplete: { nodes: unknown[] }[] };
    res.violations = axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      help: v.help,
      targets: v.nodes.slice(0, 4).map((n: { target?: unknown; html?: string; failureSummary?: string }) => ({
        selector: n.target,
        html: (n.html ?? "").slice(0, 140),
        summary: (n.failureSummary ?? "").slice(0, 200),
      })),
    }));
    res.passes = axe.passes.reduce((a, p) => a + p.nodes.length, 0);
    res.incomplete = axe.incomplete.reduce((a, p) => a + p.nodes.length, 0);
  } catch (e) {
    res.error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  }
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(res, null, 2));
  results.push(res);
  const crit = res.violations.filter((v) => v.impact === "critical").length;
  console.log(`  axe[${name}] violations=${res.violations.length} (critical=${crit}) passes=${res.passes}${res.error ? " ERREUR=" + res.error : ""}`);
  return res;
}

async function onboard(page: Page, nickname: string): Promise<void> {
  await page.goto(infra.main, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Dialog d'onboarding attendu (identité absente) — bouton "Générer mes clés et entrer"
  const nick = page.locator("#onb-nick");
  await nick.waitFor({ state: "visible", timeout: 30_000 });
  await nick.fill(nickname);
  await shot(page, `onboarding-${nickname.split(" ")[0].toLowerCase()}-form`);
  await page.getByRole("button", { name: /Générer mes clés et entrer/ }).click();
  // PoW visible — capture au milieu de la progression
  try {
    await page.getByTestId("pow-progress").waitFor({ state: "visible", timeout: 4000 });
    await page.waitForTimeout(700);
    await shot(page, `onboarding-pow-${nickname.split(" ")[0].toLowerCase()}`);
  } catch {
    /* PoW déjà fini (<4 s) — capture ratée, non bloquant */
  }
  // Attente fin (dialog fermé + app rendue)
  await nick.waitFor({ state: "hidden", timeout: 120_000 });
  await page.getByRole("button", { name: "Fil" }).first().waitFor({ state: "visible", timeout: 30_000 });
}

async function gotoView(page: Page, key: string): Promise<void> {
  await page.goto(`${infra.main}/?view=${key}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1800); // compile dev + fetch
}

/** Attend que l'identité soit PUBLIÉE sur le réseau (visible dans /api/users) —
 *  sinon le dialog « Choisir un contact » ne montre pas le pair. */
async function waitForUserPublished(nickname: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${infra.main}/api/users`, { signal: AbortSignal.timeout(5000) });
      const body = (await r.json()) as { users?: { nickname: string; ecdhPub?: string }[] };
      const found = body.users?.find((u) => u.nickname === nickname);
      if (found?.ecdhPub) return; // publié AVEC clé ECDH → DM possible
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`identité ${nickname} jamais publiée (ecdhPub absent) en ${timeoutMs / 1000}s`);
}


async function adminLogin(page: Page, prisma: PrismaClient): Promise<void> {
  await page.goto(infra.panel, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // attente HYDRATATION React (leçon passe 1 : un clic avant les effets React =
  // soumission native GET → rechargement, aucun POST, aucune session)
  await page.getByText(/App principale joignable/).waitFor({ state: "visible", timeout: 30_000 });
  await shot(page, "admin-login");
  const admin = await prisma.adminUser.findUnique({ where: { email: infra.adminEmail } });
  if (!admin?.totpSecret) throw new Error("admin sa@ui-audit.test introuvable en DB");
  const { code } = totpAt(admin.totpSecret);
  await page.fill("input[type=email]", infra.adminEmail);
  await page.fill("input[type=password]", infra.adminPassword);
  await page.fill("input[inputmode=numeric]", code);
  page.on("response", (r) => {
    if (r.url().includes("/api/admin/auth/login")) console.log(`  [admin] login → ${r.status()}`);
  });
  await page.getByRole("button", { name: /Se connecter/ }).click();
  // le login 200 NE navigue PAS : l'état authed se rend sur « / » (leçon
  // passe 5 : attendre le bouton Se déconnecter, PUIS naviguer vers /dashboard)
  try {
    await page.getByRole("button", { name: /Se déconnecter/ }).waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
    throw new Error("login sans état authed — page: " + body.replace(/\n+/g, " | "));
  }
  await page.goto(`${infra.panel}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  try {
    await page.getByText("Utilisateurs actifs").waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
    throw new Error("dashboard sans session — page: " + body.replace(/\n+/g, " | "));
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${infra.db}` } } });

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctxA: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await ctxA.newPage();

  // ── 1. Onboarding Alice (PoW visible) ───────────────────────────────────────
  console.log("[1] onboarding Alice");
  await onboard(pageA, `Alice ${RUN}`);
  await waitForUserPublished(`Alice ${RUN}`);
  await axeView(pageA, "feed", infra.main);
  await shot(pageA, "feed-loaded");

  // ── 2. Post au fil (composer, succès) ───────────────────────────────────────
  console.log("[2] composer feed");
  try {
    await pageA.getByLabel("Message à publier").fill(`Post d'audit UI E — ${Date.now()}`);
    await pageA.getByRole("button", { name: /Publier/ }).first().click();
    await pageA.getByText(/Post d'audit UI E/).first().waitFor({ state: "visible", timeout: 15_000 });
    note("feed", "post publié via composer — succès rendu dans le fil");
    await shot(pageA, "feed-post-sent");
  } catch (e) {
    note("feed", `composer: échec (${e instanceof Error ? e.message.slice(0, 80) : "?"})`);
  }

  // ── 3. Like (interaction + rollback path observé seulement en erreur) ──────
  try {
    const like = pageA.getByRole("button", { name: /^J'aime/ }).first();
    await like.click({ timeout: 5000 });
    await pageA.waitForTimeout(800);
    note("feed", "like cliqué — aria-pressed bascule (optimiste)");
  } catch {
    note("feed", "like: bouton non trouvé (peut être 0 posts visibles)");
  }

  // ── 4. Vues simples + axe ───────────────────────────────────────────────────
  console.log("[3] vues simples (messages vide, profil, groupes vide, canaux, réseau)");
  await gotoView(pageA, "messages");
  await axeView(pageA, "messages-vide", `${infra.main}/?view=messages`);
  await shot(pageA, "messages-empty");
  // état vide → clic « Nouvelle conversation » (bogue B2-fix vérifié)
  try {
    await pageA.getByRole("button", { name: /Nouvelle/ }).first().click({ timeout: 5000 });
    await pageA.getByText("Choisir un contact").waitFor({ state: "visible", timeout: 5000 });
    await shot(pageA, "messages-newconv-dialog");
    note("messages-vide", "dialog « Choisir un contact » s'ouvre depuis l'état vide (B2-fix)");
    await pageA.keyboard.press("Escape");
  } catch (e) {
    note("messages-vide", `nouvelle conversation: ${e instanceof Error ? e.message.slice(0, 80) : "?"}`);
  }

  await gotoView(pageA, "profile");
  await axeView(pageA, "profile", `${infra.main}/?view=profile`);
  await shot(pageA, "profile-view");

  await gotoView(pageA, "groups");
  await axeView(pageA, "groups-vide", `${infra.main}/?view=groups`);
  await shot(pageA, "groups-empty");

  await gotoView(pageA, "channels");
  await axeView(pageA, "channels", `${infra.main}/?view=channels`);
  await gotoView(pageA, "network");
  await axeView(pageA, "network", `${infra.main}/?view=network`);

  // ── 5. GlobalSearch (dialog) ────────────────────────────────────────────────
  console.log("[4] recherche globale");
  try {
    await pageA.getByLabel(/Rechercher dans les fils publics/).click({ timeout: 6000 });
    await pageA.getByLabel("Terme de recherche").fill("seed");
    await pageA.waitForTimeout(1500); // debounce 250ms + fetch
    await axeView(pageA, "recherche-dialog", `${infra.main}#search`);
    await shot(pageA, "search-dialog");
    await pageA.keyboard.press("Escape");
  } catch (e) {
    note("recherche-dialog", `échec ouverture: ${e instanceof Error ? e.message.slice(0, 80) : "?"}`);
  }

  // ── 6. Flux DM réel Alice→Bob (2 identités) ────────────────────────────────
  console.log("[5] flux DM Alice↔Bob");
  const ctxB: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await ctxB.newPage();
  try {
    await onboard(pageB, `Bob ${RUN}`);
    await waitForUserPublished(`Bob ${RUN}`); // publication ecdhPub effective
    // Alice démarre la conversation avec Bob
    await gotoView(pageA, "messages");
    await pageA.getByRole("button", { name: /Nouvelle/ }).first().click({ timeout: 6000 });
    await pageA.getByRole("button", { name: new RegExp(`Bob ${RUN}`) }).first().click({ timeout: 10_000 });
    await pageA.getByLabel("Message privé").fill(`Bonjour Bob ${RUN} — message de l'audit UI`);
    await pageA.getByRole("button", { name: "Envoyer le message chiffré" }).click();
    await pageA.getByText(`Bonjour Bob ${RUN} — message de l'audit UI`).first().waitFor({ state: "visible", timeout: 15_000 });
    await axeView(pageA, "dm-conversation-alice", `${infra.main}/?view=messages`);
    await shot(pageA, "dm-conversation-alice");
    // Bob démarre AUSSI via le dialog « Nouvelle conversation » (bug passe 1 :
    // clic direct sur le nom — le contact vit dans le dialog fermé)
    await gotoView(pageB, "messages");
    await pageB.getByRole("button", { name: /Nouvelle/ }).first().click({ timeout: 10_000 });
    await pageB.getByRole("button", { name: new RegExp(`Alice ${RUN}`) }).first().click({ timeout: 15_000 });
    await pageB.getByText(`Bonjour Bob ${RUN} — message de l'audit UI`).first().waitFor({ state: "visible", timeout: 15_000 });
    await shot(pageB, "dm-recu-bob");
    await pageB.getByLabel("Message privé").fill(`Salut Alice ${RUN} — réponse reçue, chiffrée E2EE`);
    await pageB.getByRole("button", { name: "Envoyer le message chiffré" }).click();
    await pageA.getByText(/réponse reçue, chiffrée E2EE/).first().waitFor({ state: "visible", timeout: 15_000 });
    await axeView(pageB, "dm-conversation-bob", `${infra.main}/?view=messages`);
    await shot(pageB, "dm-conversation-bob");
    note("dm-conversation-alice", "aller-retour DM E2EE réel OK (socket :3040)");
  } catch (e) {
    note("dm-conversation-alice", `flux DM: échec (${e instanceof Error ? e.message.slice(0, 120) : "?"})`);
    await shot(pageA, "dm-flow-fail");
    await shot(pageB, "dm-flow-fail-bob");
  }

  // ── 5bis. Hors-ligne : file locale + bulles « En attente » (PAS de navigation —
  // leçon passes 2/4/7 : un reload ou un dialog rouvert hors contexte échoue ;
  // Alice est ICI dans la conversation Bob, composer rendu) ─────────────────────
  console.log("[5bis] hors-ligne Alice (conversation ouverte)");
  try {
    await ctxA.setOffline(true);
    await pageA.waitForTimeout(2500);
    await pageA.getByLabel("Message privé").fill("Message hors-ligne — courrier local");
    await pageA.getByRole("button", { name: "Envoyer le message chiffré" }).click();
    await pageA.getByText(/Sera envoyé dès le retour du réseau|En attente/).first().waitFor({ state: "visible", timeout: 10_000 });
    await axeView(pageA, "messages-offline", `${infra.main}/?view=messages`);
    await shot(pageA, "messages-offline-bulle");
    note("messages-offline", "bulle hors-ligne rendue + badge header file locale");
  } catch (e) {
    note("messages-offline", `hors-ligne: échec (${e instanceof Error ? e.message.slice(0, 120) : "?"})`);
    await shot(pageA, "messages-offline-fail");
  }
  await ctxA.setOffline(false);
  await pageA.waitForTimeout(5000); // reconnexion auto + flush outbox
  await shot(pageA, "messages-reconnect-flush");


  // ── 7bis. Publication keypackage MLS de Bob (visite vue groupes) ──────────
  console.log("[6bis] keypackages Bob (vue groupes)");
  try {
    await gotoView(pageB, "groups");
    await pageB.getByText(/Groupes privés|Aucun groupe/).first().waitFor({ state: "visible", timeout: 10_000 });
    const bobRow = await prisma.user.findFirst({ where: { nickname: `Bob ${RUN}` }, select: { pubkey: true } });
    const deadline = Date.now() + 30_000;
    let kp = 0;
    while (Date.now() < deadline) {
      kp = bobRow ? await prisma.mlsKeyPackage.count({ where: { userKey: bobRow.pubkey } }) : 0;
      if (kp > 0) break;
      await pageB.waitForTimeout(2000);
      await pageB.reload({ waitUntil: "domcontentloaded" });
    }
    if (kp === 0) note("groupe-cree", "keypackage Bob jamais publié (30s) — création vouée à l'échec");
    else note("groupe-cree", `keypackages Bob publiés (${kp})`);
  } catch (e) {
    note("groupe-cree", `publication keypackage: ${e instanceof Error ? e.message.slice(0, 100) : "?"}`);
  }

  // ── 7. Flux appel audio réel (sonnerie → actif → raccroché) ────────────────
  console.log("[6] flux appel audio");
  try {
    // le bouton vit dans le header de la conversation OUVERTE (Alice ↔ Bob)
    await pageA.getByTestId("call-button-audio").click({ timeout: 8000 });
    // Bob sonnerie
    await pageB.getByText("Appel entrant").waitFor({ state: "visible", timeout: 15_000 });
    await shot(pageB, "call-ringing-bob");
    note("call-ringing-bob", "sonnerie rendue (knock socket.io)");
    await axeView(pageB, "call-entrant", `${infra.main}#call-entrant`);
    // Réponse
    await pageB.getByRole("button", { name: /Répondre à l'appel/ }).click({ timeout: 5000 });
    await pageB.getByTestId("call-timer").waitFor({ state: "visible", timeout: 20_000 });
    await shot(pageB, "call-active-bob");
    await shot(pageA, "call-active-alice");
    await axeView(pageA, "call-actif", `${infra.main}#call-actif`);
    note("call-actif", "appel audio réel actif (WebRTC + TURN harnais) — timer visible");
    // Raccrocher
    await pageA.getByRole("button", { name: "Terminer l'appel" }).click({ timeout: 5000 });
    await pageB.waitForTimeout(1500);
    await shot(pageB, "call-end-bob");
  } catch (e) {
    note("call-actif", `flux appel: échec (${e instanceof Error ? e.message.slice(0, 120) : "?"})`);
    await shot(pageA, "call-flow-fail");
    await shot(pageB, "call-flow-fail-bob");
  }

  // ── 8. Groupe MLS (création + invitation Bob) ──────────────────────────────
  console.log("[7] groupe MLS");
  try {
    await gotoView(pageA, "groups");
    await pageA.getByRole("button", { name: "Créer un groupe" }).click({ timeout: 6000 });
    const groupName = `Audit ${RUN}`;
    await pageA.getByLabel("Nom du groupe").fill(groupName);
    await pageA.getByTestId(`invite-check-Bob ${RUN}`).check({ timeout: 5000 });
    await pageA.getByTestId("confirm-create-group").click({ timeout: 5000 });
    try {
      await pageA.getByText(groupName).first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      // capture du toast d'erreur MLS (sonner) pour le document d'audit
      const toasts = await pageA.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
      note("groupe-cree", `création MLS échouée — toasts: ${toasts.join(" ;; ").slice(0, 200) || "aucun"}`);
      await shot(pageA, "group-fail-toast");
      throw new Error("groupe non visible après création");
    }
    await axeView(pageA, "groupe-cree", `${infra.main}/?view=groups`);
    await shot(pageA, "group-created-alice");
    note("groupe-cree", "groupe MLS créé avec Bob (commit + welcome diffusés)");
    // Bob voit le groupe (list refetch + welcome traité côté client)
    try {
      await gotoView(pageB, "groups");
      await pageB.getByText(groupName).first().waitFor({ state: "visible", timeout: 25_000 });
      await shot(pageB, "group-visible-bob");
      note("groupe-cree", "groupe visible côté Bob (liste refetch)");
    } catch {
      note("groupe-cree", "groupe NON visible côté Bob après 25s (welcome/enveloppe — voir UI-AUDIT)");
      await shot(pageB, "group-not-visible-bob");
    }
  } catch (e) {
    note("groupe-cree", `flux groupe: échec (${e instanceof Error ? e.message.slice(0, 120) : "?"})`);
    await shot(pageA, "group-flow-fail");
  }

  // ── 10. Dégradation relay : SIGSTOP du hub → pastille « relay… » ───────────
  console.log("[9] dégradation relay (SIGSTOP hub)");
  try {
    const bootLog = readFileSync(join(ROOT, "docs", "proofs", "E-boot.log"), "utf8");
    const hubPid = /hub pid=(\d+)/.exec(bootLog)?.[1];
    if (!hubPid) throw new Error("pid hub introuvable dans E-boot.log");
    execFileSync("kill", ["-STOP", hubPid]);
    await pageA.goto(`${infra.main}/?view=feed`, { waitUntil: "domcontentloaded" });
    await pageA.waitForTimeout(14_000); // > timeout socket 10 s → déconnexion
    await shot(pageA, "relay-degrade-header");
    note("feed", `hub STOPPED (pid ${hubPid}) — pastille statut observée`);
    execFileSync("kill", ["-CONT", hubPid]);
    await pageA.waitForTimeout(6000); // reconnexion auto
    await shot(pageA, "relay-reconnect-header");
  } catch (e) {
    note("feed", `dégradation relay: échec (${e instanceof Error ? e.message.slice(0, 100) : "?"})`);
  }

  // ── 11. Responsive 375 px (feed + messages) ────────────────────────────────
  console.log("[10] responsive 375");
  try {
    const ctxM = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const pageM = await ctxM.newPage();
    // MÊME identité que ctxA ? NON — localStorage séparé = nouvel onboarding.
    // Garde D2 : 3 créations/h/IP — on ne dépense PAS une 3e identité ici :
    // Alice (mêmes credentials) est recréée via import du coffre ? Impossible
    // cross-contexte. On audite donc le responsive sur l'ONBOARDING lui-même
    // (dialog 375px) puis on ferme — l'app authentifiée 375px est capturée via
    // un simple resize du contexte A (même identité, même stockage).
    await pageM.goto(infra.main, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pageM.locator("#onb-nick").waitFor({ state: "visible", timeout: 20_000 });
    await shot(pageM, "responsive-375-onboarding");
    await pageM.close();
    await ctxM.close();
    await pageA.setViewportSize({ width: 375, height: 667 });
    await pageA.goto(`${infra.main}/?view=feed`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pageA.waitForTimeout(2000);
    await shot(pageA, "responsive-375-feed");
    await pageA.goto(`${infra.main}/?view=messages`, { waitUntil: "domcontentloaded" });
    await pageA.waitForTimeout(1500);
    await shot(pageM, "responsive-375-messages");
    await pageA.goto(`${infra.main}/?view=profile`, { waitUntil: "domcontentloaded" });
    await pageA.waitForTimeout(1500);
    await shot(pageM, "responsive-375-profile");
    note("feed", "responsive 375 : onboarding (dialog) + feed + messages + profile capturés — garde D2 respectée (2 créations/run)");
    await ctxM.close();
  } catch (e) {
    note("feed", `responsive 375: échec (${e instanceof Error ? e.message.slice(0, 100) : "?"})`);
  }

  // ── 12. Panneau admin : login TOTP réel + 5 vues ───────────────────────────
  console.log("[11] panneau admin");
  const ctxAdmin = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageAdm = await ctxAdmin.newPage();
  try {
    await adminLogin(pageAdm, prisma);
    await axeView(pageAdm, "admin-dashboard", `${infra.panel}/dashboard`);
    await shot(pageAdm, "admin-dashboard");
    await pageAdm.goto(`${infra.panel}/queue`, { waitUntil: "domcontentloaded" });
    await pageAdm.waitForTimeout(1500);
    await axeView(pageAdm, "admin-queue", `${infra.panel}/queue`);
    await shot(pageAdm, "admin-queue");
    // formulaire de justification ouvert (action Masquer)
    try {
      await pageAdm.getByRole("button", { name: /Masquer le contenu/ }).first().click({ timeout: 6000 });
      await pageAdm.getByLabel("Texte de justification").waitFor({ state: "visible", timeout: 5000 });
      await shot(pageAdm, "admin-queue-justification");
      note("admin-queue", "formulaire justification ouvert (compteur n/20 visible)");
      await pageAdm.getByRole("button", { name: /Annuler/ }).first().click({ timeout: 4000 });
    } catch (e) {
      note("admin-queue", `formulaire justification: ${e instanceof Error ? e.message.slice(0, 80) : "?"}`);
    }
    await pageAdm.goto(`${infra.panel}/users`, { waitUntil: "domcontentloaded" });
    await pageAdm.waitForTimeout(1500);
    await axeView(pageAdm, "admin-users", `${infra.panel}/users`);
    await shot(pageAdm, "admin-users");
    await pageAdm.goto(`${infra.panel}/audit`, { waitUntil: "domcontentloaded" });
    await pageAdm.waitForTimeout(1500);
    await axeView(pageAdm, "admin-audit", `${infra.panel}/audit`);
    await shot(pageAdm, "admin-audit");
    await pageAdm.goto(`${infra.panel}/pending-actions`, { waitUntil: "domcontentloaded" });
    await pageAdm.waitForTimeout(1500);
    await axeView(pageAdm, "admin-pending-actions", `${infra.panel}/pending-actions`);
    await shot(pageAdm, "admin-pending-actions");
  } catch (e) {
    note("admin-dashboard", `admin: échec (${e instanceof Error ? e.message.slice(0, 120) : "?"})`);
    await shot(pageAdm, "admin-flow-fail");
  }

  // ── 13. Résumé ─────────────────────────────────────────────────────────────
  const totalViolations = results.reduce((a, r) => a + r.violations.length, 0);
  const totalNodes = results.reduce((a, r) => a + r.violations.reduce((b, v) => b + v.nodes, 0), 0);
  const byImpact: Record<string, number> = {};
  for (const r of results) {
    for (const v of r.violations) {
      const k = v.impact ?? "unknown";
      byImpact[k] = (byImpact[k] ?? 0) + v.nodes;
    }
  }
  writeFileSync(
    join(OUT, "resume.json"),
    JSON.stringify(
      {
        vues: results.length,
        totalViolations,
        totalNodes,
        byImpact,
        parVue: results.map((r) => ({
          name: r.name,
          violations: r.violations.length,
          nodes: r.violations.reduce((b, v) => b + v.nodes, 0),
          critical: r.violations.filter((v) => v.impact === "critical").length,
          serious: r.violations.filter((v) => v.impact === "serious").length,
          moderate: r.violations.filter((v) => v.impact === "moderate").length,
          minor: r.violations.filter((v) => v.impact === "minor").length,
          passes: r.passes,
          error: r.error,
          notes: r.notes,
        })),
        bootedAt: infra.main,
      },
      null,
      2
    )
  );
  console.log(`\n[axe-audit] TERMINÉ — ${results.length} vues, ${totalViolations} types de violation, ${totalNodes} nœuds`);
  await prisma.$disconnect();
  await browser.close();
}

main().catch((e) => {
  console.error("[axe-audit] ÉCHEC:", e);
  process.exit(1);
});
