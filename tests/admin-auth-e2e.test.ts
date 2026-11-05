/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étapes 3+4 — auth (login+TOTP+break-glass) + RBAC, contre les
 *  DEUX serveurs RÉELS (app principale :3101 + panneau admin :3102)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/admin-auth-e2e.test.ts   (auto-hébergé : les deux
 *  serveurs dev sont démarrés par le harness sur une DB de migrations 0001→0005)
 *
 *  Scénarios (directive Étape 3+4) :
 *   A. login : valide → 200 + cookie + csrf · email faux / password faux /
 *      TOTP faux / TOTP expiré (−90 s) / TOTP rejoué / admin désactivé →
 *      401 UNIFORMES (« invalid credentials ») ; premier login → totp_enrolled.
 *   B. rate limit : 6ᵉ tentative en 5 min (même IP) → 429.
 *   C. sessions : cookie absent/inconnu, idle 30 min (backdaté), absolu 8 h
 *      (backdaté), révoqué (logout) → 401 ; DB : tokenHash ≠ token,
 *      revokedReason tracé ; flags cookie HttpOnly/SameSite=Strict/Path=/.
 *   D. CSRF : mutation sans header / mauvais token → 403 uniforme (même
 *      message que 401) ; logout BFF sans CSRF → 403.
 *   E. break-glass : code valide → bypass TOTP + nouveau secret + sessions
 *      révoquées + code brûlé + audit ; rejeu du code → 401 ; ré-enrôlement →
 *      ancien secret mort ; code invalide → 401.
 *   F. token interne : seul → 401 · cookie seul → 401 · mauvais token → 401 ·
 *      sans X-Admin-Actor → 401 · actor mismatch → 401 · complet → 200 ·
 *      chaîne BFF complète (proxy queue) → 200.
 *   G. sessions indépendantes : 2 admins simultanés, csrf distincts, actions
 *      tracées séparément (AdminAudit.actorId).
 *   H. MATRICE RBAC : 11 actions × 5 rôles = 55 cellules (rôles : super-admin,
 *      moderator, support, auditor, anonymous). ORDRE VOLONTAIRE : les actions
 *      qui RÉVOQUENT des sessions (logout, break-glass) passent en DERNIER.
 *   I. preuve anti-fuite : aucun password / secret TOTP / code de secours /
 *      token de session dans les réponses (hors break-glass, par conception).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { hash as argon2Hash } from "@node-rs/argon2";
import { rmSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";
import { generateTotpSecret, totpAt } from "../src/lib/mbote/totp";

// ── environnement du harness ────────────────────────────────────────────────
const INTERNAL_TOKEN = "e2e-admin-internal-token-0123456789abcdef0123456789abcdef";
const MAIN = "http://127.0.0.1:3101";
const PANEL = "http://127.0.0.1:3102";
const PASSWORD = "E2e-Passw0rd-strong!";
const CODE_A = "E2EETESTCODEAAAA0"; // 1er code de secours de CHAQUE compte seedé
const CODE_B = "E2EETESTCODEBBBB1"; // 2e code

let db: PrismaClient;
let mainProc: ChildProcess | null = null;
let adminProc: ChildProcess | null = null;

// DB à CHEMIN FIXE (pattern moderation-e2e) : le processus de test, les libs
// partagées (@/lib/db — createAdminSession) et les DEUX serveurs doivent tous
// voir la MÊME base. Lancer avec :
//   DATABASE_URL="file:$(pwd)/db/adm-e2e-test.db" bun test tests/admin-auth-e2e.test.ts
// (le garde beforeAll refuse sinon — piège du DATABASE_URL global, DEV-SETUP §2a)
const DB_PATH = join(process.cwd(), "db", "adm-e2e-test.db");
const url = `file:${DB_PATH}`;

const sha256hex = (v: string): string => createHash("sha256").update(v).digest("hex");

/** Garde de test : échoue (throw) si null/undefined — remplace les `!` interdits. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

// journal anti-fuite (scénario I) — rempli par les helpers
interface LeakRecord {
  label: string;
  body: unknown;
  allowTotpSecret?: boolean; // break-glass : nouveau secret par conception
}
const leakLog: LeakRecord[] = [];
const issuedTokens = new Set<string>();
const recoveryPlaintexts = new Set<string>([CODE_A, CODE_B]);
const passwords = new Set<string>();
const totpSecretsByAccount = new Map<string, string>();

function record(label: string, body: unknown, allowTotpSecret = false): void {
  leakLog.push({ label, body, allowTotpSecret });
}

function noteToken(token: string | undefined | null): void {
  if (token) issuedTokens.add(token);
}

// IP unique par appel (isolation des buckets rate-limit entre tests)
let ipCounter = 100;
const freshIp = (): string => `10.77.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

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
): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null; rawSetCookie: string }> {
  const res = await fetch(`${PANEL}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password, totp }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const rawSetCookie = res.headers.get("set-cookie") ?? "";
  record(`login ${email}`, body);
  const cookie = extractCookie(rawSetCookie);
  if (res.status === 200) noteToken(cookie);
  return { status: res.status, body, cookie, rawSetCookie };
}

/**
 * Login « frais » : remet l'anti-rejeu TOTP du compte à zéro (action de
 * HARNESS sur la DB de test) pour que plusieurs tests puissent se connecter
 * au même compte dans la même période de 30 s sans heurter la garde anti-rejeu
 * (qui reste elle-même testée explicitement en A6 et dans admin-totp.test.ts).
 */
async function freshLogin(email: string, password: string, ip: string) {
  await db.adminUser.update({ where: { email }, data: { totpLastCounter: null } });
  const secret = must(totpSecretsByAccount.get(email), `secret ${email}`);
  return panelLogin(email, password, totpAt(secret).code, ip);
}

/** Appel aux endpoints de l'app principale (moderation ou internes). */
async function mainFetch(
  method: "GET" | "POST",
  path: string,
  opts: {
    session?: RoleSession | null;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
    headers["x-admin-internal"] = INTERNAL_TOKEN;
    headers["x-admin-actor"] = opts.session.actorId;
    if (method === "POST") headers["x-admin-csrf"] = opts.session.csrf;
  }
  Object.assign(headers, opts.headers ?? {});
  const res = await fetch(`${MAIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function panelFetch(
  method: "GET" | "POST",
  path: string,
  opts: {
    cookie?: string | null;
    csrf?: string | null;
    ip?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: Record<string, unknown>; setCookie: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers["Cookie"] = `mbote_admin_session=${opts.cookie}`;
  if (opts.csrf) headers["x-admin-csrf"] = opts.csrf;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

// ── démarrage des serveurs ──────────────────────────────────────────────────
async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* pas prêt */
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`serveur non prêt : ${url}`);
}

beforeAll(async () => {
  if (process.env.DATABASE_URL !== url) {
    throw new Error(
      `DATABASE_URL doit pointer sur la DB du harness :\n` +
        `  DATABASE_URL="file:$(pwd)/db/adm-e2e-test.db" bun test tests/admin-auth-e2e.test.ts\n` +
        ` (reçu : ${process.env.DATABASE_URL} — piège du DATABASE_URL global du sandbox, DEV-SETUP §2a)`
    );
  }
  rmSync(DB_PATH, { force: true });
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });

  const rootEnv = {
    ...process.env,
    DATABASE_URL: url,
    ADMIN_INTERNAL_TOKEN: INTERNAL_TOKEN,
    NEXT_TELEMETRY_DISABLED: "1",
    MBOTE_EMBED_RELAY: "0", // le :3000 du sandbox possède déjà le relay embarqué
  };
  mainProc = spawn("bunx", ["next", "dev", "-p", "3101"], {
    cwd: process.cwd(),
    env: rootEnv,
    stdio: "ignore",
    detached: true,
  });
  adminProc = spawn("bunx", ["next", "dev", "-p", "3102"], {
    cwd: join(process.cwd(), "admin"),
    env: { ...rootEnv, BACKEND_INTERNAL_URL: "http://127.0.0.1:3101" },
    stdio: "ignore",
    detached: true,
  });
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
});

// ── fixtures ────────────────────────────────────────────────────────────────
interface RoleFixture {
  id: number;
  email: string;
  password: string;
  totpSecret: string;
  codes: string[];
}

const fixturesByEmail = new Map<string, RoleFixture>();
const emailByRole = new Map<string, string>();

async function seedAdmin(
  email: string,
  role: string,
  opts: { disabled?: boolean; enrolled?: boolean } = {}
): Promise<RoleFixture> {
  const password = `${PASSWORD}.${role}`;
  const totpSecret = generateTotpSecret();
  const codes = [CODE_A, CODE_B];
  const user = await db.adminUser.upsert({
    where: { email },
    create: {
      email,
      role,
      passwordHash: await argon2Hash(password),
      totpSecret,
      totpEnrolled: opts.enrolled ?? true,
      disabledAt: opts.disabled ? new Date() : null,
    },
    update: {
      passwordHash: await argon2Hash(password),
      totpSecret,
      totpEnrolled: opts.enrolled ?? true,
      disabledAt: opts.disabled ? new Date() : null,
      totpLastCounter: null,
    },
  });
  await db.adminRecoveryCode.deleteMany({ where: { adminUserId: user.id } });
  for (const code of codes) {
    await db.adminRecoveryCode.create({
      data: { adminUserId: user.id, codeHash: await argon2Hash(code) },
    });
  }
  passwords.add(password);
  totpSecretsByAccount.set(email, totpSecret);
  const fixture: RoleFixture = { id: user.id, email, password, totpSecret, codes };
  fixturesByEmail.set(email, fixture);
  if (!emailByRole.has(role)) emailByRole.set(role, email); // premier du rôle
  return fixture;
}

let bobPubkey = "";
let postWarnHide = "";
let postPurgeSA = "";
let postPurgeMod = "";

async function seedFixtures(): Promise<void> {
  await seedAdmin("sa@e2e.test", "super-admin");
  await seedAdmin("mod@e2e.test", "moderator");
  await seedAdmin("sup@e2e.test", "support");
  await seedAdmin("aud@e2e.test", "auditor");
  await seedAdmin("bg@e2e.test", "super-admin");
  await seedAdmin("dis@e2e.test", "super-admin", { disabled: true });
  // compte dédié au test du PREMIER login (enrôlement à la première connexion)
  await seedAdmin("first@e2e.test", "moderator", { enrolled: false });

  const bob = await db.user.upsert({
    where: { pubkey: "e2e-bob-pubkey" },
    create: { pubkey: "e2e-bob-pubkey", nickname: "Bob E2E" },
    update: { suspendedAt: null, suspendedById: null },
  });
  bobPubkey = bob.pubkey;
  const mkPost = async (c: string) =>
    (
      await db.post.create({
        data: { authorId: bob.id, content: c },
        select: { id: true },
      })
    ).id;
  postWarnHide = await mkPost("post cible warn/hide/unhide (matrice)");
  postPurgeSA = await mkPost("post purge cellule super-admin");
  postPurgeMod = await mkPost("post purge cellule moderator");
}

/** Session de lib (rapide, hors login) pour les appels directs app principale. */
async function libSession(email: string): Promise<RoleSession> {
  const f = must(fixturesByEmail.get(email), `fixture ${email}`);
  const s = await createAdminSession(f.id, { ip: "e2e-lib", userAgent: "admin-auth-e2e" });
  noteToken(s.sessionToken);
  return { token: s.sessionToken, csrf: s.csrfToken, actorId: String(f.id) };
}

const roleLibSession = (role: string) => libSession(must(emailByRole.get(role), `rôle ${role}`));

describe("ADM 3+4 · A — login (un seul round-trip, échecs uniformes)", () => {
  test("A1 · valide → 200 + cookie (HttpOnly, SameSite=Strict, Path=/) + csrfToken, token absent du body", async () => {
    const f = must(fixturesByEmail.get("sa@e2e.test"), "fixture sa");
    const r = await freshLogin("sa@e2e.test", f.password, freshIp());
    expect(r.status).toBe(200);
    expect(must(r.cookie, "cookie A1")).toBeTruthy();
    expect(r.body.csrfToken).toHaveLength(43); // base64url 32 octets
    // le token de session ne vit QUE dans le cookie — jamais dans le body
    expect(JSON.stringify(r.body)).not.toContain(must(r.cookie, "cookie A1"));
    // flags du cookie (Set-Cookie brut)
    expect(r.rawSetCookie).toContain("mbote_admin_session=");
    expect(r.rawSetCookie).toContain("HttpOnly");
    expect(r.rawSetCookie.toUpperCase()).toContain("SAMESITE=STRICT"); // Next normalise en minuscules
    expect(r.rawSetCookie).toContain("Path=/");
    expect(r.rawSetCookie).not.toContain("Secure"); // dev http — Secure en prod (arbitrage)
    // la session en DB référence bien le hash
    const row = await db.adminSession.findUnique({ where: { tokenHash: sha256hex(must(r.cookie, "cookie A1")) } });
    expect(row).not.toBeNull();
  });

  test("A1b · premier login (totpEnrolled=false) → TOTP exigé + totp_enrolled audité", async () => {
    const before = await db.adminUser.findUnique({ where: { email: "first@e2e.test" } });
    expect(must(before, "first@e2e.test").totpEnrolled).toBe(false);
    const r = await freshLogin("first@e2e.test", `${PASSWORD}.moderator`, freshIp());
    expect(r.status).toBe(200);
    const after = await db.adminUser.findUnique({ where: { email: "first@e2e.test" } });
    expect(must(after, "first@e2e.test après").totpEnrolled).toBe(true);
    const audits = await db.adminAudit.findMany({
      where: { actorId: must(before, "first@e2e.test").id, action: { in: ["login_success", "totp_enrolled"] } },
    });
    expect(audits.map((a) => a.action).sort()).toEqual(["login_success", "totp_enrolled"]);
  });

  test("A2..A7 · échecs → 401 uniformes « invalid credentials » (email/password/TOTP/expiré/rejoué/disabled)", async () => {
    const sa = must(fixturesByEmail.get("sa@e2e.test"), "fixture sa");
    const wrongSecret = generateTotpSecret();
    // THUNKS (pas de promesses eager) : les scénarios s'exécutent SÉQUENTIELLEMENT
    // — des logins concurrents se marcheraient dessus (anti-rejeu TOTP partagé).
    const cases: Array<[string, () => Promise<{ status: number; body: Record<string, unknown> }>]> = [];

    cases.push(["A2 email inconnu", async () => {
      const r = await panelLogin("ghost@e2e.test", sa.password, totpAt(sa.totpSecret).code, freshIp());
      record("A2 email inconnu", r.body);
      return r;
    }]);
    cases.push(["A3 mauvais password", async () => {
      const r = await freshLogin("sa@e2e.test", "Mauvais-Passw0rd!x", freshIp());
      record("A3 mauvais password", r.body);
      return r;
    }]);
    cases.push(["A4 mauvais TOTP", async () => {
      const ok = await freshLogin("sa@e2e.test", sa.password, freshIp());
      expect(ok.status).toBe(200); // pré-condition : identifiants valides
      const r = await panelLogin("sa@e2e.test", sa.password, totpAt(wrongSecret).code, freshIp());
      record("A4 mauvais TOTP", r.body);
      return r;
    }]);
    cases.push(["A5 TOTP expiré (−90 s)", async () => {
      const ok = await freshLogin("sa@e2e.test", sa.password, freshIp());
      expect(ok.status).toBe(200);
      const r = await panelLogin("sa@e2e.test", sa.password, totpAt(sa.totpSecret, Date.now() - 90_000).code, freshIp());
      record("A5 TOTP expiré", r.body);
      return r;
    }]);
    cases.push(["A6 TOTP rejoué", async () => {
      const ok = await freshLogin("sa@e2e.test", sa.password, freshIp());
      expect(ok.status).toBe(200);
      const sameCode = totpAt(sa.totpSecret).code; // MÊME code, MÊME période
      await db.adminUser.update({ where: { email: "sa@e2e.test" }, data: { totpLastCounter: null } });
      const first = await panelLogin("sa@e2e.test", sa.password, sameCode, freshIp());
      expect(first.status).toBe(200); // le compteur vient d'être remis à zéro
      const r = await panelLogin("sa@e2e.test", sa.password, sameCode, freshIp());
      record("A6 TOTP rejoué", r.body);
      return r;
    }]);
    cases.push(["A7 admin désactivé", async () => {
      const r = await freshLogin("dis@e2e.test", `${PASSWORD}.super-admin`, freshIp());
      record("A7 admin désactivé", r.body);
      return r;
    }]);

    const bodies = new Set<string>();
    for (const [label, run] of cases) {
      const r = await run();
      expect({ label, status: r.status }).toEqual({ label, status: 401 });
      bodies.add(JSON.stringify(r.body));
    }
    // UNIFORMITÉ : exactement UN corps de réponse pour les 6 échecs
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(JSON.stringify({ error: "invalid credentials" }));
  });
});

describe("ADM 3+4 · B — rate limit 5 tentatives / 5 min / IP", () => {
  test("B1 · 6ᵉ tentative (même IP) → 429, même avec des identifiants valides", async () => {
    const sup = must(fixturesByEmail.get("sup@e2e.test"), "fixture sup");
    const ip = "10.66.6.6"; // IP dédiée au test
    for (let i = 1; i <= 5; i++) {
      const r = await panelLogin(sup.email, "ratelimit-wrong-pass", totpAt(sup.totpSecret).code, ip);
      expect(r.status).toBe(401);
    }
    const sixth = await panelLogin(sup.email, sup.password, totpAt(sup.totpSecret).code, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe("too many attempts");
    record("B1 429", sixth.body);
  });
});

describe("ADM 3+4 · C — sessions (hash seul en DB, idle 30 min, absolu 8 h, révocation)", () => {
  test("C1 · cookie absent → 401 (app principale) / authenticated:false (panneau)", async () => {
    const r = await mainFetch("GET", "/api/moderation/queue", {
      headers: { "x-admin-internal": INTERNAL_TOKEN, "x-admin-actor": "1" },
    });
    expect(r.status).toBe(401);
    const p = await panelFetch("GET", "/api/admin/session");
    expect(p.status).toBe(200);
    expect(p.body.authenticated).toBe(false);
    record("C1 session anonyme", p.body);
  });

  test("C2 · cookie forgé (token inconnu) → 401", async () => {
    const r = await mainFetch("GET", "/api/moderation/queue", {
      session: { token: "forged-token-not-in-db", csrf: "x", actorId: "1" },
    });
    expect(r.status).toBe(401);
  });

  test("C3 · idle > 30 min → 401 + révocation TRACÉE (revokedReason=idle-timeout)", async () => {
    const s = await roleLibSession("support");
    await db.adminSession.update({
      where: { tokenHash: sha256hex(s.token) },
      data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) },
    });
    const r = await mainFetch("GET", "/api/moderation/queue", { session: s });
    expect(r.status).toBe(401);
    const row = await db.adminSession.findUnique({ where: { tokenHash: sha256hex(s.token) } });
    expect(must(row, "session C3").revokedAt).not.toBeNull();
    expect(must(row, "session C3").revokedReason).toBe("idle-timeout");
  });

  test("C4 · TTL absolu 8 h dépassé → 401", async () => {
    const s = await roleLibSession("auditor");
    await db.adminSession.update({
      where: { tokenHash: sha256hex(s.token) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const r = await mainFetch("GET", "/api/moderation/queue", { session: s });
    expect(r.status).toBe(401);
  });

  test("C5 · logout → session révoquée (reason=logout) + audit + verify mort", async () => {
    const s = await roleLibSession("super-admin");
    const out = await mainFetch("POST", "/api/internal/admin/logout", { session: s, body: {} });
    expect(out.status).toBe(200);
    const row = await db.adminSession.findUnique({ where: { tokenHash: sha256hex(s.token) } });
    expect(must(row, "session C5").revokedReason).toBe("logout");
    const audit = await db.adminAudit.findFirst({ where: { action: "logout", targetId: must(row, "session C5").id } });
    expect(audit).not.toBeNull();
    const after = await mainFetch("POST", "/api/internal/admin/verify", { session: s, body: {} });
    expect(after.status).toBe(401);
  });

  test("C6 · DB : le token en clair n'existe NULLE part, seul son hash SHA-256", async () => {
    const s = await roleLibSession("moderator");
    const row = await db.adminSession.findUnique({ where: { tokenHash: sha256hex(s.token) } });
    expect(must(row, "session C6").tokenHash).toBe(sha256hex(s.token));
    expect(JSON.stringify(row)).not.toContain(s.token);
  });
});

describe("ADM 3+4 · D — CSRF (mutations, message uniforme avec 401)", () => {
  test("D1 · hide sans header CSRF → 403", async () => {
    const s = await roleLibSession("moderator");
    const res = await fetch(`${MAIN}/api/moderation/action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `mbote_admin_session=${s.token}`,
        "x-admin-internal": INTERNAL_TOKEN,
        "x-admin-actor": s.actorId,
        // PAS de x-admin-csrf
      },
      body: JSON.stringify({ action: "hide", targetKind: "post", targetId: postWarnHide }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    record("D1 403 sans csrf", body);
    expect(body.error).toBe("unauthorized");
  });

  test("D2 · hide avec MAUVAIS csrf → 403, même message que 401 (anti-fuite de couche)", async () => {
    const s = await roleLibSession("moderator");
    const bad = await mainFetch("POST", "/api/moderation/action", {
      session: { ...s, csrf: "wrong-csrf-value" },
      body: { action: "hide", targetKind: "post", targetId: postWarnHide },
    });
    expect(bad.status).toBe(403);
    const noSession = await mainFetch("GET", "/api/moderation/queue", {
      headers: { "x-admin-internal": INTERNAL_TOKEN, "x-admin-actor": "1" },
    });
    expect(noSession.status).toBe(401);
    expect(JSON.stringify(bad.body)).toBe(JSON.stringify(noSession.body)); // uniformité 401/403
    record("D2 403 mauvais csrf", bad.body);
  });

  test("D3 · logout BFF avec session valide mais sans CSRF → 403", async () => {
    const sa = must(fixturesByEmail.get("sa@e2e.test"), "fixture sa");
    const login = await freshLogin(sa.email, sa.password, freshIp());
    expect(login.status).toBe(200);
    const res = await fetch(`${PANEL}/api/admin/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `mbote_admin_session=${must(login.cookie, "cookie D3")}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

describe("ADM 3+4 · E — break-glass (bypass TOTP, burn, ré-enrôlement forcé)", () => {
  let bgOldSecret = "";
  let bgSession: RoleSession | null = null;
  let bgNewSecret = "";
  let bgCsrf = "";
  let bgCookie: string | null = null;

  test("E0 · préparation : session active + secret d'origine", async () => {
    bgOldSecret = totpSecretsByAccount.get("bg@e2e.test") ?? "";
    const bg = await db.adminUser.findUnique({ where: { email: "bg@e2e.test" } });
    const s = await createAdminSession(must(bg, "bg@e2e.test").id, { ip: "e2e-bg", userAgent: "e2e" });
    noteToken(s.sessionToken);
    bgSession = { token: s.sessionToken, csrf: s.csrfToken, actorId: String(must(bg, "bg@e2e.test").id) };
  });

  test("E1 · code valide → 200, nouveau secret ≠ ancien, sessions révoquées, code brûlé, audit", async () => {
    const ip = freshIp();
    const r = await panelFetch("POST", "/api/admin/auth/break-glass", {
      ip,
      body: { email: "bg@e2e.test", code: CODE_A },
    });
    expect(r.status).toBe(200);
    bgCookie = extractCookie(r.setCookie);
    noteToken(bgCookie);
    bgCsrf = String(r.body.csrfToken);
    bgNewSecret = String(r.body.totpSecret);
    expect(bgNewSecret).toBeTruthy();
    expect(bgNewSecret).not.toBe(bgOldSecret);
    expect(String(r.body.otpauthUrl)).toContain("otpauth://totp/");
    expect(r.body.totpEnrolled).toBe(false);
    record("E1 break-glass (nouveau secret par conception)", r.body, true);

    // l'ancienne session est morte
    const oldVerify = await mainFetch("GET", "/api/moderation/queue", { session: bgSession });
    expect(oldVerify.status).toBe(401);

    // le code est brûlé en DB (usedAt + ip)
    const bgId = must(await db.adminUser.findUnique({ where: { email: "bg@e2e.test" } }), "bg@e2e.test").id;
    const burned = await db.adminRecoveryCode.findFirst({
      where: { adminUserId: bgId, usedAt: { not: null } },
    });
    expect(burned).not.toBeNull();
    expect(must(burned, "code brûlé E1").usedIp).toBe(ip);

    // audit break-glass (append-only)
    const audit = await db.adminAudit.findFirst({ where: { action: "break-glass" } });
    expect(audit).not.toBeNull();
    expect(must(audit, "audit E1").actorId).toBe(bgId);
    expect(must(audit, "audit E1").targetType).toBe("AdminUser");
  });

  test("E2 · le MÊME code re-soumis → 401 (brûlé, usage unique)", async () => {
    const r = await panelFetch("POST", "/api/admin/auth/break-glass", {
      ip: freshIp(),
      body: { email: "bg@e2e.test", code: CODE_A },
    });
    expect(r.status).toBe(401);
    record("E2 code brûlé", r.body);
  });

  test("E3 · code invalide → 401 uniforme « invalid credentials »", async () => {
    const r = await panelFetch("POST", "/api/admin/auth/break-glass", {
      ip: freshIp(),
      body: { email: "bg@e2e.test", code: "ZZZZZZZZZZZZZZZZZ" },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid credentials");
    record("E3 code invalide", r.body);
  });

  test("E4 · ré-enrôlement : code du NOUVEAU secret → totpEnrolled=true, l'ANCIEN secret est mort", async () => {
    const newCode = totpAt(bgNewSecret).code;
    const enroll = await panelFetch("POST", "/api/admin/auth/totp-enroll", {
      cookie: bgCookie,
      csrf: bgCsrf,
      body: { code: newCode },
    });
    expect(enroll.status).toBe(200);
    expect(enroll.body.totpEnrolled).toBe(true);

    // login avec le NOUVEAU secret (le compteur vient d'être posé par l'enroll
    // → remise à zéro harness, puis code courant du nouveau secret) → 200
    await db.adminUser.update({ where: { email: "bg@e2e.test" }, data: { totpLastCounter: null } });
    const okLogin = await panelLogin("bg@e2e.test", `${PASSWORD}.super-admin`, totpAt(bgNewSecret).code, freshIp());
    expect(okLogin.status).toBe(200);
    // un code dérivé de l'ANCIEN secret → 401
    const oldCode = totpAt(bgOldSecret).code;
    const oldLogin = await panelLogin("bg@e2e.test", `${PASSWORD}.super-admin`, oldCode, freshIp());
    expect(oldLogin.status).toBe(401);
    record("E4 login ancien secret", oldLogin.body);
  });
});

describe("ADM 3+4 · F — token interne (double contrôle /api/moderation/*)", () => {
  test("F1 · token SEUL (sans session) → 401 — rien ne peut être fait avec le token seul", async () => {
    const r = await mainFetch("GET", "/api/moderation/queue", {
      headers: { "x-admin-internal": INTERNAL_TOKEN, "x-admin-actor": "1" },
    });
    expect(r.status).toBe(401);
  });

  test("F2 · session seule (sans token interne) → 401", async () => {
    const s = await roleLibSession("super-admin");
    const res = await fetch(`${MAIN}/api/moderation/queue`, {
      headers: { Cookie: `mbote_admin_session=${s.token}`, "x-admin-actor": s.actorId },
    });
    expect(res.status).toBe(401);
  });

  test("F3 · mauvais token interne + session valide → 401", async () => {
    const s = await roleLibSession("super-admin");
    const r = await mainFetch("GET", "/api/moderation/queue", {
      session: s,
      headers: { "x-admin-internal": "wrong-token" },
    });
    expect(r.status).toBe(401);
  });

  test("F4 · token + session SANS X-Admin-Actor → 401", async () => {
    const s = await roleLibSession("super-admin");
    const r = await mainFetch("GET", "/api/moderation/queue", {
      session: s,
      headers: { "x-admin-actor": "" },
    });
    expect(r.status).toBe(401);
  });

  test("F5 · X-Admin-Actor ne correspondant PAS à la session → 401 (acteur forgé impossible)", async () => {
    const s = await roleLibSession("super-admin");
    const r = await mainFetch("GET", "/api/moderation/queue", {
      session: { ...s, actorId: "999999" },
    });
    expect(r.status).toBe(401);
  });

  test("F6 · token + session + actor cohérent → 200", async () => {
    const s = await roleLibSession("super-admin");
    const r = await mainFetch("GET", "/api/moderation/queue", { session: s });
    expect(r.status).toBe(200);
    expect(r.body.openTotal).toBeNumber();
  });

  test("F7 · chaîne BFF complète : cookie navigateur → proxy → app principale → 200", async () => {
    const aud = must(fixturesByEmail.get("aud@e2e.test"), "fixture aud");
    const login = await freshLogin(aud.email, aud.password, freshIp());
    expect(login.status).toBe(200);
    const proxied = await panelFetch("GET", "/api/admin/moderation/queue?limit=10", {
      cookie: login.cookie,
    });
    expect(proxied.status).toBe(200);
    expect(proxied.body.openTotal).toBeNumber();
    record("F7 proxy queue", proxied.body);
  });
});

describe("ADM 3+4 · G — sessions indépendantes (2 admins simultanés)", () => {
  test("G1 · deux sessions vivantes, csrfTokens distincts, actions tracées séparément", async () => {
    const sa = must(fixturesByEmail.get("sa@e2e.test"), "fixture sa");
    const mod = must(fixturesByEmail.get("mod@e2e.test"), "fixture mod");
    const lsa = await freshLogin(sa.email, sa.password, freshIp());
    const lmod = await freshLogin(mod.email, mod.password, freshIp());
    expect(lsa.status).toBe(200);
    expect(lmod.status).toBe(200);
    expect(lsa.body.csrfToken).not.toBe(lmod.body.csrfToken);
    expect(lsa.cookie).not.toBe(lmod.cookie);

    const a1 = await mainFetch("POST", "/api/moderation/action", {
      session: { token: must(lsa.cookie, "cookie G1 SA"), csrf: String(lsa.body.csrfToken), actorId: String(sa.id) },
      body: { action: "hide", targetKind: "post", targetId: postWarnHide, reason: "e2e G1 hide par super-admin" },
    });
    const a2 = await mainFetch("POST", "/api/moderation/action", {
      session: { token: must(lmod.cookie, "cookie G1 MOD"), csrf: String(lmod.body.csrfToken), actorId: String(mod.id) },
      body: { action: "unhide", targetKind: "post", targetId: postWarnHide, reason: "e2e G1 unhide par moderator" },
    });
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    const audits = await db.adminAudit.findMany({
      where: { action: { in: ["hide", "unhide"] }, targetId: postWarnHide },
      orderBy: { id: "asc" },
    });
    const actorIds = new Set(audits.map((a) => a.actorId));
    expect(actorIds.has(sa.id)).toBe(true);
    expect(actorIds.has(mod.id)).toBe(true);
  });
});

// ── H — MATRICE RBAC : 11 actions × 5 rôles = 55 cellules ───────────────────
type RoleName = "super-admin" | "moderator" | "support" | "auditor" | "anonymous";
const ROLES: RoleName[] = ["super-admin", "moderator", "support", "auditor", "anonymous"];

interface MatrixAction {
  id: string;
  minRole: RoleName;
  run: (role: RoleName, s: RoleSession | null) => Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Statut attendu pour une cellule (rôles humains hiérarchisés · anonymous → 401). */
function expectedFor(minRole: RoleName, role: RoleName): number {
  if (role === "anonymous") return 401;
  const order: RoleName[] = ["auditor", "support", "moderator", "super-admin"];
  return order.indexOf(role) >= order.indexOf(minRole) ? 200 : 403;
}

// ORDRE VOLONTAIRE : auth.login (pré-auth) avant internal.verify ; les actions
// qui RÉVOQUENT les sessions de rôle (auth.logout, auth.break-glass) en DERNIER.
const matrixActions: MatrixAction[] = [
  {
    id: "queue.view",
    minRole: "auditor",
    run: (_role, s) => mainFetch("GET", "/api/moderation/queue", { session: s }),
  },
  {
    id: "user.warn",
    minRole: "support",
    run: (_role, s) =>
      mainFetch("POST", "/api/moderation/action", {
        session: s,
        body: { action: "warn", targetKind: "user", targetId: bobPubkey, reason: "matrice warn" },
      }),
  },
  {
    id: "post.hide",
    minRole: "moderator",
    run: (_role, s) =>
      mainFetch("POST", "/api/moderation/action", {
        session: s,
        body: { action: "hide", targetKind: "post", targetId: postWarnHide, reason: "matrice hide" },
      }),
  },
  {
    id: "post.unhide",
    minRole: "moderator",
    run: (_role, s) =>
      mainFetch("POST", "/api/moderation/action", {
        session: s,
        body: { action: "unhide", targetKind: "post", targetId: postWarnHide, reason: "matrice unhide" },
      }),
  },
  {
    id: "user.suspend",
    minRole: "moderator",
    run: (_role, s) =>
      mainFetch("POST", "/api/moderation/action", {
        session: s,
        body: { action: "suspend", targetKind: "user", targetId: bobPubkey, reason: "matrice suspend" },
      }),
  },
  {
    id: "user.unsuspend",
    minRole: "moderator",
    run: (_role, s) =>
      mainFetch("POST", "/api/moderation/action", {
        session: s,
        body: { action: "unsuspend", targetKind: "user", targetId: bobPubkey, reason: "matrice unsuspend" },
      }),
  },
  {
    id: "post.purge",
    minRole: "moderator",
    run: (role, s) =>
      mainFetch("POST", "/api/moderation/action", {
        session: s,
        body: {
          action: "purge",
          targetKind: "post",
          targetId: role === "moderator" ? postPurgeMod : postPurgeSA,
          reason: "matrice purge",
        },
      }),
  },
  {
    id: "auth.login",
    minRole: "auditor",
    run: async (role) => {
      if (role === "anonymous") {
        return panelLogin("ghost@e2e.test", "nope", "000000", freshIp());
      }
      const email = must(emailByRole.get(role), `rôle ${role}`);
      return freshLogin(email, must(fixturesByEmail.get(email), `fixture ${email}`).password, freshIp());
    },
  },
  {
    id: "internal.verify",
    minRole: "auditor",
    run: (_role, s) => mainFetch("POST", "/api/internal/admin/verify", { session: s, body: {} }),
  },
  {
    id: "auth.logout",
    minRole: "auditor",
    run: (_role, s) => mainFetch("POST", "/api/internal/admin/logout", { session: s, body: {} }),
  },
  {
    id: "auth.break-glass",
    minRole: "auditor",
    run: async (role) => {
      if (role === "anonymous") {
        const r = await panelFetch("POST", "/api/admin/auth/break-glass", {
          ip: freshIp(),
          body: { email: "ghost@e2e.test", code: "XXXXXXXXXXXXXXXXX" },
        });
        record("M break-glass anonymous", r.body);
        return { status: r.status, body: r.body };
      }
      const f = must(fixturesByEmail.get(must(emailByRole.get(role), `rôle ${role}`)), `fixture ${role}`);
      const r = await panelFetch("POST", "/api/admin/auth/break-glass", {
        ip: freshIp(),
        body: { email: f.email, code: CODE_B },
      });
      record(`M break-glass ${role} (nouveau secret par conception)`, r.body, true);
      return { status: r.status, body: r.body };
    },
  },
];

const matrixResults: Array<{ action: string; role: RoleName; expected: number; got: number; pass: boolean }> = [];

describe("ADM 3+4 · H — MATRICE RBAC (11 actions × 5 rôles = 55 cellules)", () => {
  const roleSessions = new Map<RoleName, RoleSession | null>();

  beforeAll(async () => {
    for (const role of ["super-admin", "moderator", "support", "auditor"] as RoleName[]) {
      roleSessions.set(role, await roleLibSession(role));
    }
    roleSessions.set("anonymous", null);
  });

  for (const action of matrixActions) {
    for (const role of ROLES) {
      test(`H · ${action.id} × ${role}`, async () => {
        const expected = expectedFor(action.minRole, role);
        const r = await action.run(role, roleSessions.get(role) ?? null);
        const pass = r.status === expected;
        matrixResults.push({ action: action.id, role, expected, got: r.status, pass });
        expect({ action: action.id, role, got: r.status }).toEqual({ action: action.id, role, got: expected });
      });
    }
  }
});

describe("ADM 3+4 · I — preuve anti-fuite + relecture matrice", () => {
  test("55 cellules de matrice exécutées, toutes PASS", () => {
    expect(matrixResults).toHaveLength(55);
    expect(matrixResults.filter((r) => !r.pass)).toEqual([]);
  });

  test("aucun password / secret TOTP / code de secours / token de session dans les réponses", () => {
    const violations: string[] = [];
    for (const rec of leakLog) {
      const s = JSON.stringify(rec.body) ?? "";
      for (const pw of passwords) {
        if (pw && s.includes(pw)) violations.push(`${rec.label}: password présent`);
      }
      for (const tok of issuedTokens) {
        if (tok && s.includes(tok)) violations.push(`${rec.label}: token de session présent`);
      }
      for (const code of recoveryPlaintexts) {
        if (code && (s.includes(code) || s.includes(code.replace(/-/g, "")))) {
          violations.push(`${rec.label}: code de secours présent`);
        }
      }
      if (!rec.allowTotpSecret) {
        for (const [email, secret] of totpSecretsByAccount) {
          if (s.includes(secret)) violations.push(`${rec.label}: secret TOTP (${email}) présent`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
