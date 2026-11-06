/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 5 — dashboard (4 métriques), contre les DEUX serveurs
 *  RÉELS (app principale :3105 + panneau admin :3106)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : DATABASE_URL="file:$(pwd)/db/adm-dashboard-e2e-test.db" \
 *             bun test tests/admin-dashboard-e2e.test.ts
 *  (auto-hébergé : les deux serveurs dev sont démarrés par le harness sur une
 *   DB de migrations 0001→0005 + un fichier backup-status piloté par le test)
 *
 *  Scénarios (directive Étape 5) :
 *   A. endpoint interne /api/internal/admin/stats :
 *      token SEUL → 401 · session sans token interne → 401 · actor mismatch
 *      → 401 · token+session+acteur (support) → 200 avec les 4 clés ;
 *      VALEURS conforme aux fixtures (h24=2, d7=4, reports=2) ;
 *      auditor → 403 (lecture limitée à l'audit — directive) ;
 *      ANTI-FUITE : aucun email/IP/contenu DM/pubkey dans la réponse.
 *   B. /api/internal/admin/backup-status (fs.readFile, PAS de cache —
 *      directive) : ok frais → vert · ancien (> 24 h) → stale orange ·
 *      failed → rouge · fichier supprimé → not-configured orange.
 *   C. BFF /api/dashboard : sans cookie → 401 · support → 200 (4 clés) ·
 *      moderator → 200 · auditor → 403 · 401/403 message UNIFORME.
 *   D. page UI /dashboard : anonyme → redirection / · support → 200 avec les
 *      cartes · auditor → carte « Accès refusé » (rendu serveur).
 *   E. DÉGRADATION (dernier groupe) : kill app principale → BFF 502
 *      { error: "backend-unreachable" } (ni 500 brut, ni 401 mensonger) →
 *      respawn → 200 à nouveau.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { hash as argon2Hash } from "@node-rs/argon2";
import { rmSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";
import { generateTotpSecret, totpAt } from "../src/lib/mbote/totp";

// ── environnement du harness ────────────────────────────────────────────────
const INTERNAL_TOKEN = "e2e-admin-internal-token-dashboard0123456789abcdef01234567";
const MAIN = "http://127.0.0.1:3105";
const PANEL = "http://127.0.0.1:3106";
const PASSWORD = "E2e-Passw0rd-strong!";
const BACKUP_FILE = join(process.cwd(), "db", "adm-dashboard-backup-status.json");

let db: PrismaClient;
let mainProc: ChildProcess | null = null;
let adminProc: ChildProcess | null = null;

const DB_PATH = join(process.cwd(), "db", "adm-dashboard-e2e-test.db");
const url = `file:${DB_PATH}`;

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

// IP unique par login (isolation des buckets rate-limit)
let ipCounter = 300;
const freshIp = (): string => `10.78.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

function writeBackupFile(state: "ok" | "failed", ageHours: number): void {
  writeFileSync(
    BACKUP_FILE,
    JSON.stringify({ state, at: new Date(Date.now() - ageHours * 3600e3).toISOString() })
  );
}

// ── helpers HTTP ────────────────────────────────────────────────────────────
interface RoleSession {
  token: string;
  csrf: string;
  actorId: string;
}

function extractCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(/mbote_admin_session=([^;]+)/);
  return m ? m[1] : null;
}

async function panelLogin(
  email: string,
  password: string,
  totp: string,
  ip: string
): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }> {
  const res = await fetch(`${PANEL}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password, totp }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const cookie = extractCookie(res.headers.get("set-cookie"));
  return { status: res.status, body, cookie };
}

/** Appel aux endpoints internes de l'app principale (chaîne Étape 4). */
async function mainFetch(
  path: string,
  opts: {
    session?: RoleSession | null;
    internalToken?: string | null; // absent → « token seul » / « session sans token »
    ip?: string;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.internalToken !== null) headers["x-admin-internal"] = opts.internalToken ?? INTERNAL_TOKEN;
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
    headers["x-admin-actor"] = opts.session.actorId;
  }
  const res = await fetch(`${MAIN}${path}`, { method: "GET", headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function panelFetch(
  path: string,
  opts: { cookie?: string | null; ip?: string; redirect?: RequestRedirect } = {}
): Promise<{ status: number; body: Record<string, unknown>; text: string; location: string | null }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["Cookie"] = `mbote_admin_session=${opts.cookie}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const res = await fetch(`${PANEL}${path}`, {
    method: "GET",
    headers,
    redirect: opts.redirect ?? "manual",
  });
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* HTML (pages) — body reste vide */
  }
  return { status: res.status, body, text, location: res.headers.get("location") };
}

// ── démarrage des serveurs ──────────────────────────────────────────────────
async function waitFor(url_: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url_, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* pas prêt */
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`serveur non prêt : ${url_}`);
}

function spawnMain(): void {
  mainProc = spawn("bunx", ["next", "dev", "-p", "3105"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: url,
      ADMIN_INTERNAL_TOKEN: INTERNAL_TOKEN,
      NEXT_TELEMETRY_DISABLED: "1",
      MBOTE_EMBED_RELAY: "0", // le :3000 du sandbox possède déjà le relay embarqué
      BACKUP_STATUS_PATH: BACKUP_FILE,
    },
    stdio: "ignore",
    detached: true,
  });
}

function spawnPanel(): void {
  adminProc = spawn("bunx", ["next", "dev", "-p", "3106"], {
    cwd: join(process.cwd(), "admin"),
    env: {
      ...process.env,
      DATABASE_URL: url,
      ADMIN_INTERNAL_TOKEN: INTERNAL_TOKEN,
      NEXT_TELEMETRY_DISABLED: "1",
      BACKEND_INTERNAL_URL: MAIN,
    },
    stdio: "ignore",
    detached: true,
  });
}

function killMain(): void {
  const p = mainProc;
  mainProc = null;
  if (p?.pid) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      try {
        p.kill("SIGKILL");
      } catch {
        /* déjà mort */
      }
    }
  }
}

// Garde DATABASE_URL au niveau MODULE : si la DB du harness n'est pas la
// nôtre, la suite est SKIPPÉE (pas « failed ») — `bun test` global reste vert
// et chaque harness garde sa DB dédiée (piège §2a, sans exception silencieuse :
// message console explicite). Le garde DUR reste dans beforeAll en défense.
const GUARD_OK = process.env.DATABASE_URL === url;
if (!GUARD_OK) {
  console.warn(
    "admin-dashboard-e2e SKIPPÉ — DATABASE_URL n'est pas la DB du harness. Lancer :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-dashboard-e2e-test.db" bun test tests/admin-dashboard-e2e.test.ts'
  );
}

describe.skipIf(!GUARD_OK)("ADM 5 — dashboard e2e (auto-hébergé, DB dédiée)", () => {
  beforeAll(async () => {
  if (process.env.DATABASE_URL !== url) {
    throw new Error(
      `DATABASE_URL doit pointer sur la DB du harness :\n` +
        `  DATABASE_URL="file:$(pwd)/db/adm-dashboard-e2e-test.db" bun test tests/admin-dashboard-e2e.test.ts\n` +
        ` (reçu : ${process.env.DATABASE_URL} — piège du DATABASE_URL global du sandbox, DEV-SETUP §2a)`
    );
  }
  rmSync(DB_PATH, { force: true });
  rmSync(BACKUP_FILE, { force: true });
  mkdirSync(join(process.cwd(), "db"), { recursive: true }); // worktree re-créé : db/ non commité
  writeBackupFile("ok", 1); // backup frais au démarrage → vert
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });

  spawnMain();
  spawnPanel();
  await waitFor(`${MAIN}/api/stats`, 120_000);
  await waitFor(`${PANEL}/api/health`, 120_000);

  await seedFixtures();
}, 200_000);

  afterAll(async () => {
  for (const p of [mainProc, adminProc]) {
    if (p?.pid) {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        try {
          p.kill("SIGKILL");
        } catch {
          /* déjà mort */
        }
      }
    }
  }
  await db?.$disconnect();
  rmSync(DB_PATH, { force: true });
  rmSync(BACKUP_FILE, { force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────
interface RoleFixture {
  id: number;
  email: string;
  password: string;
  totpSecret: string;
}

const fixturesByEmail = new Map<string, RoleFixture>();
const emailByRole = new Map<string, string>();

async function seedAdmin(email: string, role: string): Promise<RoleFixture> {
  const password = `${PASSWORD}.${role}`;
  const totpSecret = generateTotpSecret();
  const user = await db.adminUser.upsert({
    where: { email },
    create: {
      email,
      role,
      passwordHash: await argon2Hash(password),
      totpSecret,
      totpEnrolled: true,
    },
    update: {
      passwordHash: await argon2Hash(password),
      totpSecret,
      totpEnrolled: true,
      totpLastCounter: null,
      disabledAt: null,
    },
  });
  const fixture: RoleFixture = { id: user.id, email, password, totpSecret };
  fixturesByEmail.set(email, fixture);
  if (!emailByRole.has(role)) emailByRole.set(role, email);
  return fixture;
}

// identifiants anti-fuite — NE DOIVENT JAMAIS apparaître dans /stats
const DM_CIPHERTEXT = "e2e-dashboard-dm-ciphertext-SECRET-BASE64==";

let supportSession: RoleSession;
let auditorSession: RoleSession;
let supportCookie = "";
let moderatorCookie = "";
let auditorCookie = "";

async function seedFixtures(): Promise<void> {
  await seedAdmin("sa5@e2e.test", "super-admin");
  await seedAdmin("mod5@e2e.test", "moderator");
  await seedAdmin("sup5@e2e.test", "support");
  await seedAdmin("aud5@e2e.test", "auditor");

  // ── activité réseau : 2 actifs 24 h, 2 actifs 7 j seulement, 1 inactif ──
  const mkUser = async (pubkey: string, nickname: string) =>
    db.user.create({ data: { pubkey, nickname }, select: { id: true, pubkey: true } });
  const mkPost = async (authorId: string, ageMs: number) =>
    db.post.create({
      data: { authorId, content: `e2e-dashboard-post-${ageMs}`, createdAt: new Date(Date.now() - ageMs) },
      select: { id: true },
    });
  const mkDm = async (senderKey: string, recipientKey: string, ageMs: number) =>
    db.directMessage.create({
      data: {
        senderKey,
        recipientKey,
        iv: "e2e-iv==",
        ciphertext: DM_CIPHERTEXT,
        createdAt: new Date(Date.now() - ageMs),
      },
      select: { id: true },
    });

  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const u1 = await mkUser("e2e-dash-u1-pubkey", "Actif Post"); // actif 24 h (post 1 h)
  await mkPost(u1.id, 1 * HOUR);
  const u2 = await mkUser("e2e-dash-u2-pubkey", "Actif DM"); // actif 24 h (DM envoyée 2 h)
  await mkDm(u2.pubkey, "e2e-dash-peer-pubkey", 2 * HOUR);
  const u3 = await mkUser("e2e-dash-u3-pubkey", "Actif 7j Post"); // actif 7 j (post 3 j)
  await mkPost(u3.id, 3 * DAY);
  const u4 = await mkUser("e2e-dash-u4-pubkey", "Actif 7j DM"); // actif 7 j (DM reçue 5 j)
  await mkDm("e2e-dash-peer2-pubkey", u4.pubkey, 5 * DAY);
  const u5 = await mkUser("e2e-dash-u5-pubkey", "Inactif"); // post 10 j → aucune fenêtre
  await mkPost(u5.id, 10 * DAY);

  // ── reports : 2 ouverts (handledById IS NULL), 1 pris en charge ──
  const sa = must(fixturesByEmail.get("sa5@e2e.test"), "fixture sa");
  await db.report.create({
    data: { reporterKey: "e2e-dash-r1", targetKind: "post", targetId: "post-r1", reason: "spam" },
  });
  await db.report.create({
    data: { reporterKey: "e2e-dash-r2", targetKind: "post", targetId: "post-r2", reason: "harassment" },
  });
  await db.report.create({
    data: {
      reporterKey: "e2e-dash-r3",
      targetKind: "post",
      targetId: "post-r3",
      reason: "spam",
      status: "actioned",
      handledAt: new Date(),
      handledById: sa.id,
    },
  });

  // sessions lib (app principale) + logins panel (chaîne BFF complète)
  const mkLib = async (email: string): Promise<RoleSession> => {
    const f = must(fixturesByEmail.get(email), `fixture ${email}`);
    const s = await createAdminSession(f.id, { ip: "e2e-lib", userAgent: "admin-dash-e2e" });
    return { token: s.sessionToken, csrf: s.csrfToken, actorId: String(f.id) };
  };
  supportSession = await mkLib("sup5@e2e.test");
  auditorSession = await mkLib("aud5@e2e.test");

  const supF = must(fixturesByEmail.get("sup5@e2e.test"), "fixture sup");
  const modF = must(fixturesByEmail.get("mod5@e2e.test"), "fixture mod");
  const audF = must(fixturesByEmail.get("aud5@e2e.test"), "fixture aud");
  const supLogin = await panelLogin("sup5@e2e.test", supF.password, totpAt(supF.totpSecret).code, freshIp());
  expect(supLogin.status).toBe(200);
  supportCookie = must(supLogin.cookie, "cookie support");
  const modLogin = await panelLogin("mod5@e2e.test", modF.password, totpAt(modF.totpSecret).code, freshIp());
  expect(modLogin.status).toBe(200);
  moderatorCookie = must(modLogin.cookie, "cookie moderator");
  const audLogin = await panelLogin("aud5@e2e.test", audF.password, totpAt(audF.totpSecret).code, freshIp());
  expect(audLogin.status).toBe(200);
  auditorCookie = must(audLogin.cookie, "cookie auditor");
}

const FOUR_KEYS = ["activeUsers", "openReports", "uptime", "backup"] as const;

// ═════════════════════════════════════════════════════════════════════════════
describe("ADM 5 · A — endpoint interne /api/internal/admin/stats", () => {
  test("A1 · token SEUL (sans session) → 401 — le token interne ne peut rien faire", async () => {
    const r = await mainFetch("/api/internal/admin/stats", { session: null });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
  });

  test("A2 · session SANS token interne → 401 (double contrôle obligatoire)", async () => {
    const r = await mainFetch("/api/internal/admin/stats", { session: supportSession, internalToken: null });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
  });

  test("A3 · token + session + acteur (support) → 200 avec les 4 clés + generatedAt", async () => {
    const r = await mainFetch("/api/internal/admin/stats", { session: supportSession });
    expect(r.status).toBe(200);
    for (const k of FOUR_KEYS) expect(r.body[k], `clé ${k}`).toBeDefined();
    expect(typeof r.body.generatedAt).toBe("string");
  });

  test("A4 · VALEURS conformes aux fixtures : h24=2, d7=4, reports ouverts=2, backup ok", async () => {
    const r = await mainFetch("/api/internal/admin/stats", { session: supportSession });
    expect(r.status).toBe(200);
    const au = must(r.body.activeUsers as Record<string, unknown>, "activeUsers");
    expect(au.h24).toBe(2); // post 1 h + DM 2 h
    expect(au.d7).toBe(4); // + post 3 j + DM 5 j (le post 10 j est hors fenêtres)
    const orp = must(r.body.openReports as Record<string, unknown>, "openReports");
    expect(orp.value).toBe(2); // 2 handledById IS NULL sur 3
    const up = must(r.body.uptime as Record<string, unknown>, "uptime");
    expect(typeof up.seconds).toBe("number");
    expect((up.seconds as number)).toBeGreaterThanOrEqual(0);
    const bk = must(r.body.backup as Record<string, unknown>, "backup");
    expect(bk.state).toBe("ok");
    expect(bk.status).toBe("green");
    // couleurs déterministes pour ces fixtures
    expect(au.status).toBe("orange"); // 2 → 1–4
    expect(orp.status).toBe("green"); // 2 ≤ 10
    expect(up.status).toBe("red"); // serveur démarré depuis < 1 h
  });

  test("A5 · auditor → 403 (lecture limitée à l'audit — directive Étape 5)", async () => {
    const r = await mainFetch("/api/internal/admin/stats", { session: auditorSession });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("unauthorized"); // message UNIFORME 401/403
  });

  test("A6 · acteur mismatch (X-Admin-Actor ≠ session) → 401", async () => {
    const r = await mainFetch("/api/internal/admin/stats", {
      session: { ...supportSession, actorId: String(must(fixturesByEmail.get("sa5@e2e.test"), "sa").id) },
    });
    expect(r.status).toBe(401);
  });

  test("A7 · ANTI-FUITE : aucun email, ciphertext DM, pubkey, ni clé email/ip/password dans la réponse", async () => {
    const r = await mainFetch("/api/internal/admin/stats", { session: supportSession });
    expect(r.status).toBe(200);
    const s = JSON.stringify(r.body);
    expect(s).not.toContain("e2e.test"); // aucun email (domaine fixture)
    expect(s).not.toContain(DM_CIPHERTEXT); // aucun contenu DM
    expect(s).not.toContain("pubkey"); // aucune clé publique
    expect(s).not.toContain('"email"');
    expect(s).not.toContain('"password"');
    expect(s).not.toContain('"ip"');
    expect(s).not.toContain("10.78."); // aucune IP du harness
  });
});

describe("ADM 5 · B — backup-status (fs.readFile, pas de cache)", () => {
  test("B1 · backup frais (1 h) → state ok, vert", async () => {
    writeBackupFile("ok", 1);
    const r = await mainFetch("/api/internal/admin/backup-status", { session: supportSession });
    expect(r.status).toBe(200);
    const bk = must(r.body.backup as Record<string, unknown>, "backup");
    expect(bk.state).toBe("ok");
    expect(bk.status).toBe("green");
    expect(typeof bk.ageHours).toBe("number");
  });

  test("B2 · backup ancien (48 h > seuil 24 h) → stale orange — relit le FICHIER (pas de cache)", async () => {
    writeBackupFile("ok", 48);
    const r = await mainFetch("/api/internal/admin/backup-status", { session: supportSession });
    expect(r.status).toBe(200);
    const bk = must(r.body.backup as Record<string, unknown>, "backup");
    expect(bk.state).toBe("stale");
    expect(bk.status).toBe("orange");
  });

  test("B3 · backup failed → rouge", async () => {
    writeBackupFile("failed", 1);
    const r = await mainFetch("/api/internal/admin/backup-status", { session: supportSession });
    expect(r.status).toBe(200);
    const bk = must(r.body.backup as Record<string, unknown>, "backup");
    expect(bk.state).toBe("failed");
    expect(bk.status).toBe("red");
  });

  test("B4 · fichier absent → « not-configured » orange (fallback directive)", async () => {
    unlinkSync(BACKUP_FILE);
    const r = await mainFetch("/api/internal/admin/backup-status", { session: supportSession });
    expect(r.status).toBe(200);
    const bk = must(r.body.backup as Record<string, unknown>, "backup");
    expect(bk.state).toBe("not-configured");
    expect(bk.status).toBe("orange");
    // remettre un état propre pour la suite
    writeBackupFile("ok", 1);
  });
});

describe("ADM 5 · C — BFF /api/dashboard (panneau, chaîne complète)", () => {
  test("C1 · sans cookie → 401 uniforme", async () => {
    const r = await panelFetch("/api/dashboard");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
  });

  test("C2 · session support → 200 avec les 4 clés", async () => {
    const r = await panelFetch("/api/dashboard", { cookie: supportCookie });
    expect(r.status).toBe(200);
    for (const k of FOUR_KEYS) expect(r.body[k], `clé ${k}`).toBeDefined();
  });

  test("C3 · session moderator → 200 (≥ support)", async () => {
    const r = await panelFetch("/api/dashboard", { cookie: moderatorCookie });
    expect(r.status).toBe(200);
    for (const k of FOUR_KEYS) expect(r.body[k], `clé ${k}`).toBeDefined();
  });

  test("C4 · session auditor → 403 (propagé par l'app principale)", async () => {
    const r = await panelFetch("/api/dashboard", { cookie: auditorCookie });
    expect(r.status).toBe(403);
  });

  test("C5 · 401 et 403 → MÊME message « unauthorized » (aucune fuite sur la couche qui refuse)", async () => {
    const r401 = await panelFetch("/api/dashboard");
    const r403 = await panelFetch("/api/dashboard", { cookie: auditorCookie });
    expect(r401.body).toEqual({ error: "unauthorized" });
    expect(r403.body).toEqual({ error: "unauthorized" });
  });
});

describe("ADM 5 · D — page UI /dashboard (rendu serveur)", () => {
  test("D1 · anonyme → redirection vers / (pas de fuite de contenu)", async () => {
    const r = await panelFetch("/dashboard");
    expect([307, 302, 308]).toContain(r.status);
    expect(r.location).toBe("/");
    expect(r.text).not.toContain("Utilisateurs actifs");
  });

  test("D2 · session support → 200 HTML avec les 4 métriques SERVIES (valeurs SSR, sans attendre l'hydratation)", async () => {
    const r = await panelFetch("/dashboard", { cookie: supportCookie, redirect: "follow" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Tableau de bord");
    // les 4 cartes — libellés
    expect(r.text).toContain("Utilisateurs actifs");
    expect(r.text).toContain("Reports ouverts");
    expect(r.text).toContain("Uptime conteneur");
    expect(r.text).toContain("Dernier backup");
    // VALEURS fixtures rendues serveur (h24/d7 = 2/4 · reports = 2 · backup ok)
    expect(r.text).toContain("2 / 4");
    expect(r.text).toContain("backup récent");
    expect(r.text).toContain("Rafraîchir"); // rafraîchissement manuel
  });

  test("D3 · session auditor → carte « Accès refusé » rendue serveur (sans appel réseau)", async () => {
    const r = await panelFetch("/dashboard", { cookie: auditorCookie, redirect: "follow" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Accès refusé");
    expect(r.text).toContain("audit");
  });
});

// DERNIER groupe — il tue l'app principale puis la ressuscite.
describe("ADM 5 · E — dégradation (kill backend)", () => {
  test("E1 · app principale killée → BFF 502 { backend-unreachable } (ni 500, ni 401 mensonger)", async () => {
    killMain();
    // laisser le port se fermer
    await new Promise((r) => setTimeout(r, 1200));
    const r = await panelFetch("/api/dashboard", { cookie: supportCookie });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("backend-unreachable");
  });

  test("E1b · page /dashboard pendant la panne → reste sur place, bandeau « Backend injoignable » (PAS de redirection mensongère)", async () => {
    const r = await panelFetch("/dashboard", { cookie: supportCookie, redirect: "manual" });
    expect(r.status).toBe(200); // pas de 307 vers / — la page assume la panne
    expect(r.location).toBeNull();
    expect(r.text).toContain("Backend injoignable");
    expect(r.text).toContain("Tableau de bord");
  });

  test("E2 · respawn de l'app principale → dashboard de nouveau 200 (résilience)", async () => {
    spawnMain();
    await waitFor(`${MAIN}/api/stats`, 120_000);
    const r = await panelFetch("/api/dashboard", { cookie: supportCookie });
    expect(r.status).toBe(200);
    for (const k of FOUR_KEYS) expect(r.body[k], `clé ${k}`).toBeDefined();
  }, 150_000);
});
});
