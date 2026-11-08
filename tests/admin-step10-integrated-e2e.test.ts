/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 10 — SUITE E2E INTÉGRÉE (parcours admin COMPLET, DB VIERGE)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : DATABASE_URL="file:$(pwd)/db/adm-step10-integrated-test.db" \
 *             bun test tests/admin-step10-integrated-e2e.test.ts
 *  (garde module-level → SKIP propre en suite globale — pattern Étapes 5-9)
 *
 *  DIRECTIVE (Étape 10) : prouver que TOUT le parcours admin s'enchaîne SANS
 *  régression sur une DB vierge, en UN SEUL flux :
 *    bootstrap (CLI RÉEL) → login (TOTP réel) → dashboard → queue → hide post
 *    → gestion user (warn → suspend) → audit viewer (+ filtres) → four-eyes
 *    ban (intention) → 2ᵉ approbation (AUTRE super-admin, login réel) →
 *    user banni (403 publication + posts masqués + 2 lignes audit).
 *  Les comptes admin passent par les CLI RÉELS d'exploitation
 *  (admin:bootstrap + admin:create — ce dernier comble l'écart code↔docs
 *  constaté en Étape 10 : ADMIN-RBAC §2.4 référençait un script inexistant).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { totpAt } from "../src/lib/mbote/totp";

const INTERNAL_TOKEN = "e2e-step10-token-0123456789abcdef0123456789abcdef";
const MAIN = "http://127.0.0.1:3141";
const PANEL = "http://127.0.0.1:3142";

const DB_PATH = join(process.cwd(), "db", "adm-step10-integrated-test.db");
const url = `file:${DB_PATH}`;

const GUARD_OK = process.env.DATABASE_URL === url;
if (!GUARD_OK) {
  console.warn(
    "admin-step10-integrated SKIPPÉ — DATABASE_URL n'est pas la DB du harness. Lancer :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-step10-integrated-test.db" bun test tests/admin-step10-integrated-e2e.test.ts'
  );
}

let db: PrismaClient;
let mainProc: ChildProcess | null = null;
let panelProc: ChildProcess | null = null;

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

// ── comptes (créés par les CLI RÉELS) ───────────────────────────────────────
const SA1 = { email: "operateur@step10.test", password: "Step10-Integr-Passw0rd!.a1", secret: "" };
const SA2 = { email: "super2@step10.test", password: "Step10-Integr-Passw0rd!.b2", secret: "" };
const MOD = { email: "moderateur@step10.test", password: "Step10-Integr-Passw0rd!.m3", secret: "" };

interface Session {
  token: string;
  csrf: string;
  email: string;
  actorId: string;
}
const sessions = new Map<string, Session>();

/** LOGIN RÉEL via l'endpoint interne (email + password + TOTP — pas de court-circuit). */
const loginWindows = new Map<string, number>(); // anti-rejeu : N-iᵉ login d'un MÊME admin → fenêtre suivante
async function realLogin(who: { email: string; password: string; secret: string }): Promise<Session> {
  const n = loginWindows.get(who.email) ?? 0;
  loginWindows.set(who.email, n + 1);
  // fenêtre ±1 (TOTP_WINDOW) : le N-iᵉ login du MÊME admin avance d'une fenêtre
  // (anti-rejeu É3) ; entre admins DIFFÉRENTS les compteurs sont indépendants.
  const code = totpAt(who.secret, Date.now() + n * 30_000).code;
  const res = await fetch(`${MAIN}/api/internal/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-internal": INTERNAL_TOKEN },
    body: JSON.stringify({ email: who.email, password: who.password, totp: code }),
  });
  const body = (await res.json()) as { sessionToken?: string; csrfToken?: string; adminUser?: { id: number } };
  expect(res.status).toBe(200);
  expect(body.sessionToken).toBeDefined();
  return {
    token: must(body.sessionToken, "sessionToken"),
    csrf: must(body.csrfToken, "csrfToken"),
    email: who.email,
    actorId: String(must(body.adminUser, "adminUser").id),
  };
}

const sess = (k: string): Session => must(sessions.get(k), `session ${k}`);

// ── helpers HTTP (main : endpoints internes ; panel : BFF + SSR) ────────────
async function mainFetch(
  method: "GET" | "POST",
  path: string,
  opts: { session?: Session | null; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-admin-internal": INTERNAL_TOKEN };
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
    headers["x-admin-actor"] = opts.session.actorId;
    if (method === "POST") headers["x-admin-csrf"] = opts.session.csrf;
  }
  const res = await fetch(`${MAIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function panelFetch(
  method: "GET" | "POST",
  path: string,
  opts: { session?: Session | null; body?: unknown; redirect?: RequestRedirect } = {}
): Promise<{ status: number; body: Record<string, unknown>; location?: string; text?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
    if (method === "POST") headers["x-admin-csrf"] = opts.session.csrf;
  }
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: opts.redirect ?? "manual",
  });
  const location = res.headers.get("location") ?? undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, location };
  }
  return { status: res.status, body: {}, location, text: await res.text().catch(() => "") };
}

const JUST = { category: "HARASSMENT", justification: "Étape 10 — parcours intégré de bout en bout" };

// ── fixtures (contenu public — les comptes admin viennent des CLI) ──────────
const subtle = globalThis.crypto.subtle;
function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}
async function makeUserKeys(nickname: string): Promise<{ pubkey: string; signPriv: CryptoKey; id: string }> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const u = await db.user.create({ data: { pubkey, nickname } });
  return { pubkey, signPriv: pair.privateKey, id: u.id };
}
async function sign(signPriv: CryptoKey, payload: string): Promise<string> {
  const sig = await subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, signPriv, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}
let authorA: { pubkey: string; signPriv: CryptoKey; id: string };
let reporterB: { pubkey: string; signPriv: CryptoKey; id: string };
let postIdA = "";

async function seedFixtures(): Promise<void> {
  authorA = await makeUserKeys("auteur-a");
  reporterB = await makeUserKeys("reporter-b");
  const p = await db.post.create({ data: { authorId: authorA.id, content: "post signalé — parcours Étape 10" } });
  postIdA = p.id;
  await db.report.create({
    data: { targetKind: "post", targetId: postIdA, reason: "parcours intégré", reporterKey: reporterB.pubkey },
  });
}

// ── démarrage (DB vierge + CLI réels + serveurs) ────────────────────────────
async function waitFor(u: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 503) return;
    } catch {
      /* pas prêt */
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`serveur non prêt : ${u}`);
}

beforeAll(async () => {
  if (!GUARD_OK) return;
  rmSync(DB_PATH, { force: true });
  // ⚠️ side-cars WAL : un -wal/-shm STALE contre une DB fraîche corrompt la
  // visibilité du schéma (P2021 « table does not exist » — constat Étape 10)
  rmSync(DB_PATH + "-wal", { force: true });
  rmSync(DB_PATH + "-shm", { force: true });
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });

  // CLI RÉELS d'exploitation — le parcours commence exactement comme en prod
  execFileSync("bun", ["run", "admin:bootstrap", "--", `--email=${SA1.email}`, `--password=${SA1.password}`], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  const sa1 = await db.adminUser.findUnique({ where: { email: SA1.email }, select: { totpSecret: true } });
  SA1.secret = must(sa1, "secret TOTP sa1 (bootstrap)").totpSecret ?? "";
  for (const [who, role] of [
    [SA2, "super-admin"],
    [MOD, "moderator"],
  ] as const) {
    execFileSync(
      "bun",
      ["run", "admin:create", "--", `--email=${who.email}`, `--role=${role}`, `--password=${who.password}`],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" }
    );
    const row = await db.adminUser.findUnique({ where: { email: who.email }, select: { totpSecret: true } });
    who.secret = must(row, `secret TOTP ${who.email}`).totpSecret ?? "";
  }

  const rootEnv = {
    ...process.env,
    DATABASE_URL: url,
    ADMIN_INTERNAL_TOKEN: INTERNAL_TOKEN,
    NEXT_TELEMETRY_DISABLED: "1",
    MBOTE_EMBED_RELAY: "0",
  };
  mainProc = spawn("bunx", ["next", "dev", "-p", "3141"], { cwd: process.cwd(), env: rootEnv, stdio: "ignore", detached: true });
  panelProc = spawn("bunx", ["next", "dev", "-p", "3142"], {
    cwd: join(process.cwd(), "admin"),
    env: { ...rootEnv, BACKEND_INTERNAL_URL: "http://127.0.0.1:3141" },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(`${MAIN}/api/stats`, 120_000);
  await waitFor(`${PANEL}/api/health`, 120_000);

  await seedFixtures();

  // échauffement (Turbo compile à la demande — timeout bun 5 s sinon)
  await panelFetch("GET", "/api/health", { session: null });
  await mainFetch("GET", "/api/internal/admin/queue", { session: null }); // 401 attendu
}, 300_000);

afterAll(async () => {
  for (const p of [mainProc, panelProc]) {
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
  rmSync(DB_PATH + "-wal", { force: true });
  rmSync(DB_PATH + "-shm", { force: true });
});

// ── L1. BOOTSTRAP + LOGIN ───────────────────────────────────────────────────
describe("L1. bootstrap (CLI réels) → login TOTP réel", () => {
  test("bootstrap + 2× admin:create → 3 comptes + 3 lignes d'audit", async () => {
    if (!GUARD_OK) return;
    const users = await db.adminUser.findMany({ where: { role: { not: "system" } }, select: { email: true, role: true } });
    expect(users).toHaveLength(3);
    const audits = await db.adminAudit.findMany({
      where: { action: { in: ["bootstrap", "admin_created"] } },
      select: { action: true },
    });
    expect(audits.map((a) => a.action).sort()).toEqual(["admin_created", "admin_created", "bootstrap"]);
  });

  test("login super-admin #1 (email+password+TOTP) → session + panneau SSR 200", async () => {
    if (!GUARD_OK) return;
    sessions.set("sa1", await realLogin(SA1));
    const page = await panelFetch("GET", "/", { session: sess("sa1") });
    expect(page.status).toBe(200);
  });

  test("login moderator (rôle inférieur) → session valide", async () => {
    if (!GUARD_OK) return;
    sessions.set("mod", await realLogin(MOD));
    const queue = await panelFetch("GET", "/api/queue", { session: sess("mod") });
    expect(queue.status).toBe(200);
  });
});

// ── L2. DASHBOARD ───────────────────────────────────────────────────────────
describe("L2. dashboard — 4 métriques", () => {
  test("BFF /api/dashboard → 200, les 4 métriques présentes", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/dashboard", { session: sess("sa1") });
    expect(r.status).toBe(200);
    const d = r.body as { generatedAt?: string; activeUsers?: { h24: number; d7: number }; openReports?: unknown; uptime?: unknown; backup?: unknown };
    expect(d.generatedAt).toBeDefined();
    expect(d.activeUsers?.h24).toBeTypeOf("number");
    expect(d.activeUsers?.d7).toBeTypeOf("number");
    expect(d.openReports).toBeDefined();
    expect(d.uptime).toBeDefined();
    expect(d.backup).toBeDefined();
  });
});

// ── L3. QUEUE → HIDE ────────────────────────────────────────────────────────
describe("L3. queue → hide post → feed", () => {
  test("queue contient le post signalé (poids ≥ 1)", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/queue", { session: sess("mod") });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain(postIdA);
  });

  test("moderator hide le post → 200 · reports clos · absent du feed", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: sess("mod"),
      body: { targetKind: "post", targetId: postIdA, action: "hide", ...JUST },
    });
    expect(r.status).toBe(200);
    const report = await db.report.findFirst({ where: { targetId: postIdA } });
    expect(report?.status).toBe("actioned");
    const feed = await fetch(`${MAIN}/api/posts?limit=50`);
    const feedBody = (await feed.json()) as { posts?: Array<{ id: string }> };
    const ids = (feedBody.posts ?? []).map((p) => p.id);
    expect(ids).not.toContain(postIdA);
  });
});

// ── L4. GESTION USER (warn → suspend) ───────────────────────────────────────
describe("L4. gestion user — warn puis suspend", () => {
  test("annuaire trouve auteur-a", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", `/api/users?search=${encodeURIComponent("auteur-a")}`, { session: sess("sa1") });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("auteur-a");
  });

  test("warn par moderator → UserWarning + audit", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("POST", `/api/users/${authorA.pubkey}/warn`, { session: sess("mod"), body: JUST });
    expect(r.status).toBe(200);
    const w = await db.userWarning.findFirst({ where: { userId: authorA.id } });
    expect(w).not.toBeNull();
  });

  test("suspend 24h → suspendedAt posé · publication → 403", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("POST", `/api/users/${authorA.pubkey}/suspend`, {
      session: sess("mod"),
      body: { ...JUST, duration: "24h" },
    });
    expect(r.status).toBe(200);
    const u = await db.user.findUnique({ where: { id: authorA.id }, select: { suspendedAt: true, suspendedUntil: true } });
    expect(u?.suspendedAt).not.toBeNull();
    expect(u?.suspendedUntil).not.toBeNull();

    const ts = Date.now();
    const signature = await sign(authorA.signPriv, `${authorA.pubkey}|suspendu|${ts}`);
    const pub = await fetch(`${MAIN}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: authorA.pubkey, content: "suspendu", ts, signature }),
    });
    expect(pub.status).toBe(403);
  });
});

// ── L5. AUDIT VIEWER (+ filtres) ────────────────────────────────────────────
describe("L5. audit viewer — liste, filtre acteur, fiche", () => {
  test("liste 24h contient hide+warn+suspend", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/audit?since=24h&limit=50", { session: sess("sa1") });
    expect(r.status).toBe(200);
    const actions = ((r.body.items ?? []) as Array<{ action: string }>).map((e) => e.action);
    for (const a of ["hide", "warn", "suspend"]) expect(actions).toContain(a);
  });

  test("filtre acteur=moderator → uniquement ses lignes", async () => {
    if (!GUARD_OK) return;
    const modId = sess("mod").actorId;
    const r = await mainFetch("GET", `/api/internal/admin/audit?actor=${modId}&since=24h&limit=50`, { session: sess("sa1") });
    expect(r.status).toBe(200);
    const items = (r.body.items ?? []) as Array<{ action: string; actorId: number }>;
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) expect(e.actorId).toBe(Number(modId));
  });

  test("porte EXACTE : moderator → 403 sur l'audit (arbitrage §14.1)", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/audit", { session: sess("mod") });
    expect(r.status).toBe(403);
  });

  test("page panneau /audit SSR → 200", async () => {
    if (!GUARD_OK) return;
    const page = await panelFetch("GET", "/audit", { session: sess("sa1") });
    expect(page.status).toBe(200);
  });
});

// ── L6. FOUR-EYES BAN (intention → 2ᵉ approbation → banni) ──────────────────
describe("L6. four-eyes — ban définitif à deux super-admins", () => {
  test("sa1 crée l'intention ban_user (BFF) → 201 pending", async () => {
    if (!GUARD_OK) return;
    sessions.set("sa2", await realLogin(SA2));
    const r = await panelFetch("POST", "/api/pending-actions", {
      session: sess("sa1"),
      body: { actionType: "ban_user", targetId: authorA.pubkey, ...JUST },
    });
    expect(r.status).toBe(201);
    const pa = r.body.pendingAction as { id: number; status: string } | undefined;
    expect(pa?.status).toBe("pending");
  });

  test("auto-approbation (même session) → 403", async () => {
    if (!GUARD_OK) return;
    const list = await panelFetch("GET", "/api/pending-actions", { session: sess("sa1") });
    expect(list.status).toBe(200);
    const items = (list.body.items ?? []) as Array<{ id: number; status: string }>;
    const pending = items.find((i) => i.status === "pending");
    expect(pending).toBeDefined();
    const r = await panelFetch("POST", `/api/pending-actions/${must(pending, "pending").id}/approve`, { session: sess("sa1") });
    expect(r.status).toBe(403);
  });

  test("2ᵉ approbation sa2 (login réel) → 200 exécuté · user banni · 2 lignes audit", async () => {
    if (!GUARD_OK) return;
    const list = await panelFetch("GET", "/api/pending-actions", { session: sess("sa2") });
    const items = (list.body.items ?? []) as Array<{ id: number; status: string; canApprove?: boolean }>;
    const pending = items.find((i) => i.status === "pending");
    expect(pending).toBeDefined();
    const r = await panelFetch("POST", `/api/pending-actions/${must(pending, "pending").id}/approve`, { session: sess("sa2") });
    expect(r.status).toBe(200);

    const u = await db.user.findUnique({ where: { id: authorA.id }, select: { bannedAt: true, bannedById: true } });
    expect(u?.bannedAt).not.toBeNull();
    expect(u?.bannedById).toBe(Number(sess("sa2").actorId));

    const posts = await db.post.findMany({ where: { authorId: authorA.id }, select: { hiddenAt: true, hiddenById: true } });
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.hiddenAt).not.toBeNull();

    const cycle = await db.adminAudit.findMany({
      where: { action: { in: ["pendingaction_created", "ban"] }, targetType: "user", targetId: authorA.pubkey },
      select: { action: true },
    });
    expect(cycle.map((c) => c.action).sort()).toEqual(["ban", "pendingaction_created"]);

    const ts = Date.now();
    const signature = await sign(authorA.signPriv, `${authorA.pubkey}|banni|${ts}`);
    const pub = await fetch(`${MAIN}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: authorA.pubkey, content: "banni", ts, signature }),
    });
    expect(pub.status).toBe(403);
  });
});

// ── L7. SESSION RÉVOQUÉE ────────────────────────────────────────────────────
describe("L7. session révoquée → panneau refuse (redirect login)", () => {
  test("logout réel (endpoint interne) → BFF 401 · page → redirect /", async () => {
    if (!GUARD_OK) return;
    const out = await mainFetch("POST", "/api/internal/admin/logout", { session: sess("mod") });
    expect(out.status).toBe(200);
    const bff = await panelFetch("GET", "/api/queue", { session: sess("mod") });
    expect(bff.status).toBe(401);
    const page = await panelFetch("GET", "/queue", { session: sess("mod") });
    expect([302, 307]).toContain(page.status);
    expect(page.location ?? "").toMatch(/\/$/);
  });
});
