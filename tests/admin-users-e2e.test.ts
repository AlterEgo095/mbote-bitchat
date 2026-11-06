/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 7 — GESTION UTILISATEURS (annuaire + fiche + warn/suspend)
 *  contre les DEUX serveurs RÉELS (app principale :3107 + panneau :3108)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : DATABASE_URL="file:$(pwd)/db/adm-users-e2e-test.db" \
 *             bun test tests/admin-users-e2e.test.ts
 *  (garde module-level → SKIP propre en suite globale — pattern Étapes 5+6)
 *
 *  Scénarios (directive Étape 7) :
 *   A. AUTH/RBAC : token seul → 401 · session sans token → 401 · anonymous →
 *      401 · auditor → 403 (annuaire + fiche — arbitrage §13.1) · support →
 *      200 en LECTURE mais 403 sur POST warn (lecture seule mutations) ·
 *      moderator → tout OK.
 *   B. RECHERCHE : q=alice → ≥ 1 · q=zzzz-inexistant → 0 · q vide → 400 ·
 *      LIKE échappé (« 100%_pur » trouvé littéralement, pas « 100xpur ») ·
 *      limite 20 résultats.
 *   C. PAGINATION/TRI/FILTRES : cursor malformé → 400 · page 1 (20) → page 2
 *      (items DISTINCTS) · curseur d'un autre tri → 400 (k du curseur) ·
 *      tri reports : poids 3 d'abord · filtre suspendu · filtre banni → 0
 *      (arbitrage §13.7) · période 24h exclut un compte inscrit à 48 h.
 *   D. FICHE : 200 + format (pubkey/pseudo/bio/compteurs/audit/reports) ·
 *      pubkey inconnue → 404 · ANTI-FUITE : aucun email/password dans le
 *      payload (invariants §1).
 *   E. WARN : moderator → 200 + UserWarning en DB + AdminAudit « SPAM: … » ·
 *      lecture par le TITULAIRE via preuve de possession (ECDSA) · texte
 *      < 20 → 422 · catégorie invalide → 422 · sans CSRF → 403.
 *   F. SUSPEND : 24h → suspendedUntil ≈ +24 h · POST /api/posts → 403 ·
 *      POST /api/dms → 200 (DM POSSIBLE — E2EE préservée, directive) ·
 *      30d → ≈ +30 j · duration invalide (48h/indefinite) → 400 ·
 *      EXPIRATION (mock temporel : backdate DB) → posts → 200 + statut actif ·
 *      unsuspend → cleared.
 *   G. BAN (four-eyes Étape 9) : POST /ban interne → 404 · POST BFF /ban →
 *      404 — AUCUNE route ban n'existe (arbitrage §13.9).
 *   H. BFF (panneau) : liste 200 (support) · auditor → 403 · q vide → 400
 *      propagé · warn moderator 200 (CSRF) · warn sans CSRF → 403.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";

// ── environnement du harness ────────────────────────────────────────────────
const INTERNAL_TOKEN = "e2e-users-internal-token-0123456789abcdef0123456789abcdef";
const MAIN = "http://127.0.0.1:3107";
const PANEL = "http://127.0.0.1:3108";

const DB_PATH = join(process.cwd(), "db", "adm-users-e2e-test.db");
const url = `file:${DB_PATH}`;

// Garde MODULE-LEVEL (pattern Étapes 5+6) : skip propre en suite globale.
const GUARD_OK = process.env.DATABASE_URL === url;
if (!GUARD_OK) {
  console.warn(
    "admin-users-e2e SKIPPÉ — DATABASE_URL n'est pas la DB du harness. Lancer :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-users-e2e-test.db" bun test tests/admin-users-e2e.test.ts'
  );
}

let db: PrismaClient;
let mainProc: ChildProcess | null = null;
let panelProc: ChildProcess | null = null;

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

// ── sessions de test (direct DB — pas de login HTTP nécessaire ici) ─────────
interface RoleSession {
  token: string;
  csrf: string;
  actorId: string;
}
const adminIds = new Map<string, number>();
const sessions = new Map<string, RoleSession>();

async function sessionFor(role: string): Promise<RoleSession> {
  const cached = sessions.get(role);
  if (cached) return cached;
  const id = must(adminIds.get(role), `admin ${role}`);
  const s = await createAdminSession(id, { ip: "e2e-users", userAgent: "admin-users-e2e" });
  const rs = { token: s.sessionToken, csrf: s.csrfToken, actorId: String(id) };
  sessions.set(role, rs);
  return rs;
}

// ── helpers HTTP (app principale — endpoints internes) ──────────────────────
async function mainFetch(
  method: "GET" | "POST",
  path: string,
  opts: { session?: RoleSession | null; internal?: boolean; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.internal !== false) headers["x-admin-internal"] = INTERNAL_TOKEN;
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
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
  opts: { session?: RoleSession | null; body?: unknown; csrf?: boolean; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
    if (opts.csrf) headers["x-admin-csrf"] = opts.session.csrf;
  }
  Object.assign(headers, opts.headers ?? {});
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

const JUST = { category: "SPAM", justification: "harnais Étape 7 — justification ≥ 20 caractères" };

// ── helpers crypto (ECDSA P-256 réelle — même mécanique que la queue E6) ────
const subtle = globalThis.crypto.subtle;

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

interface UserKeys {
  pubkey: string;
  signPriv: CryptoKey;
  id: string;
}

async function makeUserKeys(nickname: string, extra: { bio?: string } = {}): Promise<UserKeys> {
  const pair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const u = await db.user.create({ data: { pubkey, nickname, bio: extra.bio ?? null } });
  return { pubkey, signPriv: pair.privateKey, id: u.id };
}

async function sign(signPriv: CryptoKey, payload: string): Promise<string> {
  const sig = await subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    signPriv,
    new TextEncoder().encode(payload)
  );
  return b64url(new Uint8Array(sig));
}

async function postAs(who: UserKeys, content: string): Promise<number> {
  const ts = Date.now();
  const signature = await sign(who.signPriv, `${who.pubkey}|${content}|${ts}`);
  const res = await fetch(`${MAIN}/api/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: who.pubkey, content, ts, signature }),
  });
  return res.status;
}

/** DM legacy (enveloppe aveugle) — le serveur n'ouvre JAMAIS le contenu. */
async function dmAs(who: UserKeys, recipientKey: string): Promise<number> {
  const ts = Date.now();
  const iv = b64url(new Uint8Array(12).map(() => Math.floor(Math.random() * 256)));
  const ciphertext = b64url(new Uint8Array(64).map(() => Math.floor(Math.random() * 256)));
  const signature = await sign(who.signPriv, `${who.pubkey}|dm|${recipientKey}|${iv}|${ciphertext}|${ts}`);
  const res = await fetch(`${MAIN}/api/dms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderKey: who.pubkey, recipientKey, iv, ciphertext, ts, signature }),
  });
  return res.status;
}

// ── démarrage des serveurs ──────────────────────────────────────────────────
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
    MBOTE_EMBED_RELAY: "0",
  };
  mainProc = spawn("bunx", ["next", "dev", "-p", "3107"], {
    cwd: process.cwd(),
    env: rootEnv,
    stdio: "ignore",
    detached: true,
  });
  panelProc = spawn("bunx", ["next", "dev", "-p", "3108"], {
    cwd: join(process.cwd(), "admin"),
    env: { ...rootEnv, BACKEND_INTERNAL_URL: "http://127.0.0.1:3107" },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(`${MAIN}/api/stats`, 120_000);
  await waitFor(`${PANEL}/api/health`, 120_000);

  await seedFixtures();
}, 200_000);

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
});

// ── fixtures ────────────────────────────────────────────────────────────────
let alice: UserKeys | null = null; // cible du warn (E) — identité à clé réelle
function aliceK(): UserKeys {
  return must(alice, "alice (fixtures)");
}
let susp: UserKeys | null = null; // cible de la suspension (F)
function suspK(): UserKeys {
  return must(susp, "susp-target (fixtures)");
}
let poids3Pubkey = ""; // 3 reports ouverts (tri reports)
let poids1Pubkey = ""; // 1 report ouvert
let oldTimerPubkey = ""; // inscrit à -48 h (filtre période)

async function seedFixtures(): Promise<void> {
  for (const [role, email] of [
    ["super-admin", "sa-u@e2e.test"],
    ["moderator", "mod-u@e2e.test"],
    ["support", "sup-u@e2e.test"],
    ["auditor", "aud-u@e2e.test"],
  ] as const) {
    const u = await db.adminUser.upsert({
      where: { email },
      create: { email, role, passwordHash: null, totpEnrolled: false },
      update: { role },
    });
    adminIds.set(role, u.id);
  }

  alice = await makeUserKeys("alice", { bio: "Bio publique d'Alice — rien de privé ici." });
  await makeUserKeys("bob");
  await makeUserKeys("carol");
  susp = await makeUserKeys("susp-target", { bio: "Cible de suspension du harness." });

  // LIKE échappé : un pseudo contenant % et _
  await db.user.create({ data: { pubkey: "e2e-u-literal-pct", nickname: "100%_pur" } });
  // un pseudo proche mais DIFFÉRENT (ne doit PAS matcher la recherche échappée)
  await db.user.create({ data: { pubkey: "e2e-u-pct-swap", nickname: "100x5pur" } });

  // poids reports : rep-poids3 (3 reports ouverts) vs rep-poids1 (1 report)
  const p3 = await db.user.create({ data: { pubkey: "e2e-u-poids3", nickname: "rep-poids3" } });
  const p1 = await db.user.create({ data: { pubkey: "e2e-u-poids1", nickname: "rep-poids1" } });
  poids3Pubkey = p3.pubkey;
  poids1Pubkey = p1.pubkey;
  const post3 = await db.post.create({ data: { authorId: p3.id, content: "post du compte poids 3" } });
  const post1 = await db.post.create({ data: { authorId: p1.id, content: "post du compte poids 1" } });
  const reporters = ["e2e-u-r1", "e2e-u-r2", "e2e-u-r3", "e2e-u-r4"];
  for (const rk of reporters) {
    await db.user.create({ data: { pubkey: rk, nickname: `reporter-${rk.slice(-2)}` } });
  }
  await db.report.create({ data: { reporterKey: reporters[0], targetKind: "post", targetId: post3.id, reason: "spam" } });
  await db.report.create({ data: { reporterKey: reporters[1], targetKind: "post", targetId: post3.id, reason: "spam" } });
  await db.report.create({ data: { reporterKey: reporters[2], targetKind: "post", targetId: post3.id, reason: "spam" } });
  await db.report.create({ data: { reporterKey: reporters[3], targetKind: "post", targetId: post1.id, reason: "harassment" } });

  // ancien compte (48 h) — filtre période
  const old = await db.user.create({ data: { pubkey: "e2e-u-oldtimer", nickname: "old-timer" } });
  oldTimerPubkey = old.pubkey;
  await db.user.update({
    where: { id: old.id },
    data: { createdAt: new Date(Date.now() - 48 * 3600_000) },
  });

  // pagination : 22 fillers (page 1 = 20, page 2 = le reste)
  for (let i = 1; i <= 22; i++) {
    await db.user.create({
      data: { pubkey: `e2e-u-filler-${String(i).padStart(2, "0")}`, nickname: `zz-filler-${String(i).padStart(2, "0")}` },
    });
  }

  // limite de recherche : 21 pseudos commençant par « limit- » → 20 max
  for (let i = 1; i <= 21; i++) {
    await db.user.create({
      data: { pubkey: `e2e-u-limit-${String(i).padStart(2, "0")}`, nickname: `limit-mate-${String(i).padStart(2, "0")}` },
    });
  }
}

// ── A. AUTH / RBAC ──────────────────────────────────────────────────────────
describe("A. auth/RBAC annuaire + fiche", () => {
  test("token interne SEUL → 401", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users", { session: null });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
  });

  test("session SANS token interne → 401", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users", {
      session: await sessionFor("support"),
      internal: false,
    });
    expect(r.status).toBe(401);
  });

  test("anonymous → 401", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users", { session: null, internal: false });
    expect(r.status).toBe(401);
  });

  test("auditor → 403 sur l'annuaire ET la fiche (arbitrage §13.1)", async () => {
    if (!GUARD_OK) return;
    const list = await mainFetch("GET", "/api/internal/admin/users", { session: await sessionFor("auditor") });
    expect(list.status).toBe(403);
    const fiche = await mainFetch("GET", `/api/internal/admin/users/${aliceK().pubkey}`, {
      session: await sessionFor("auditor"),
    });
    expect(fiche.status).toBe(403);
  });

  test("support → 200 en lecture (annuaire + fiche)", async () => {
    if (!GUARD_OK) return;
    const list = await mainFetch("GET", "/api/internal/admin/users", { session: await sessionFor("support") });
    expect(list.status).toBe(200);
    expect(list.body.mode).toBe("list");
    const fiche = await mainFetch("GET", `/api/internal/admin/users/${aliceK().pubkey}`, {
      session: await sessionFor("support"),
    });
    expect(fiche.status).toBe(200);
  });

  test("support → 403 sur POST warn (lecture seule mutations, directive)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("POST", `/api/internal/admin/users/${aliceK().pubkey}/warn`, {
      session: await sessionFor("support"),
      body: JUST,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("unauthorized");
  });
});

// ── B. RECHERCHE ────────────────────────────────────────────────────────────
describe("B. recherche par pseudo (LIKE, limite 20)", () => {
  test("q=alice → ≥ 1 résultat exact", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?q=alice", { session: await sessionFor("support") });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("search");
    const items = r.body.items as Array<{ pseudo: string }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => i.pseudo === "alice")).toBe(true);
  });

  test("q=zzzz-inexistant → 0 résultat", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?q=zzzz-inexistant", {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });

  test("q vide → 400 (directive)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?q=", { session: await sessionFor("support") });
    expect(r.status).toBe(400);
  });

  test("LIKE échappé : « 100% » matche « 100%_pur », PAS « 100x5pur »", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?q=100%25", { session: await sessionFor("support") });
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ pseudo: string }>;
    expect(items.some((i) => i.pseudo === "100%_pur")).toBe(true);
    expect(items.some((i) => i.pseudo === "100x5pur")).toBe(false);
  });

  test("limite 20 résultats (21 pseudos limit-mate-*)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?q=limit-", { session: await sessionFor("support") });
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBe(20);
  });
});

// ── C. PAGINATION / TRI / FILTRES ───────────────────────────────────────────
describe("C. pagination cursor + tri + filtres", () => {
  test("cursor malformé → 400", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?cursor=pas-du-base64!!", {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("cursor invalide");
  });

  test("page 1 = 20 items + nextCursor · page 2 = items DISTINCTS", async () => {
    if (!GUARD_OK) return;
    const p1 = await mainFetch("GET", "/api/internal/admin/users", { session: await sessionFor("support") });
    expect(p1.status).toBe(200);
    const items1 = p1.body.items as Array<{ pubkey: string }>;
    expect(items1.length).toBe(20);
    const next = p1.body.nextCursor as string;
    expect(next).toBeTruthy();
    const p2 = await mainFetch(
      "GET",
      `/api/internal/admin/users?cursor=${encodeURIComponent(next)}`,
      { session: await sessionFor("support") }
    );
    expect(p2.status).toBe(200);
    const items2 = p2.body.items as Array<{ pubkey: string }>;
    expect(items2.length).toBeGreaterThan(0);
    const overlap = items2.filter((i) => items1.some((j) => j.pubkey === i.pubkey));
    expect(overlap.length).toBe(0);
  });

  test("curseur d'un AUTRE tri → 400 (k du curseur = garde anti-rejeu de vue)", async () => {
    if (!GUARD_OK) return;
    const p1 = await mainFetch("GET", "/api/internal/admin/users", { session: await sessionFor("support") });
    const next = p1.body.nextCursor as string;
    const r = await mainFetch(
      "GET",
      `/api/internal/admin/users?sort=reports&cursor=${encodeURIComponent(next)}`,
      { session: await sessionFor("support") }
    );
    expect(r.status).toBe(400);
  });

  test("tri reports : poids 3 en tête (badge visuel côté UI)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?sort=reports", {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ pubkey: string; openReports: number }>;
    expect(items[0].pubkey).toBe(poids3Pubkey);
    expect(items[0].openReports).toBe(3);
    expect(items.some((i) => i.pubkey === poids1Pubkey && i.openReports === 1)).toBe(true);
  });

  test("filtre status=suspendu : exclut les actifs · status=banni → 0 (§13.7)", async () => {
    if (!GUARD_OK) return;
    // suspension API (détaillée en F) sur susp-target
    const s = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/suspend`, {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "24h" },
    });
    expect(s.status).toBe(200);
    const only = await mainFetch("GET", "/api/internal/admin/users?status=suspendu", {
      session: await sessionFor("support"),
    });
    expect(only.status).toBe(200);
    const items = only.body.items as Array<{ pubkey: string; status: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.status === "suspendu")).toBe(true);

    const banned = await mainFetch("GET", "/api/internal/admin/users?status=banni", {
      session: await sessionFor("support"),
    });
    expect(banned.status).toBe(200);
    expect(banned.body.items).toEqual([]);

    // nettoyage pour la suite : unsuspend
    const u = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/unsuspend`, {
      session: await sessionFor("moderator"),
      body: JUST,
    });
    expect(u.status).toBe(200);
  });

  test("filtre période 24h : exclut le compte inscrit à 48 h", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?period=24h", {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ pubkey: string }>;
    expect(items.some((i) => i.pubkey === oldTimerPubkey)).toBe(false);
  });
});

// ── D. FICHE ────────────────────────────────────────────────────────────────
describe("D. fiche utilisateur", () => {
  test("200 + format complet (pubkey, bio, compteurs, audit, reports)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", `/api/internal/admin/users/${aliceK().pubkey}`, {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(200);
    const user = r.body.user as { pubkey: string; pseudo: string; bio: string | null; status: string };
    expect(user.pubkey).toBe(aliceK().pubkey);
    expect(user.pseudo).toBe("alice");
    expect(user.bio).toContain("Bio publique");
    expect(user.status).toBe("actif");
    expect(r.body.counts).toBeTruthy();
    expect(r.body.audit).toEqual([]);
  });

  test("pubkey inconnue → 404", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users/e2e-u-inconnu-xyz", {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(404);
  });

  test("ANTI-FUITE : ni email, ni password, ni IP dans annuaire et fiche (§1)", async () => {
    if (!GUARD_OK) return;
    const list = await mainFetch("GET", "/api/internal/admin/users", { session: await sessionFor("support") });
    const fiche = await mainFetch("GET", `/api/internal/admin/users/${aliceK().pubkey}`, {
      session: await sessionFor("support"),
    });
    for (const [name, r] of [["annuaire", list], ["fiche", fiche]] as const) {
      const raw = JSON.stringify(r.body);
      expect(raw.includes('"email"'), `${name} ne doit pas porter d'email`).toBe(false);
      expect(raw.includes('"password"'), `${name} ne doit pas porter de password`).toBe(false);
      expect(raw.includes('"ip"'), `${name} ne doit pas porter d'IP`).toBe(false);
    }
  });
});

// ── E. WARN ─────────────────────────────────────────────────────────────────
describe("E. warn (moderator) — UserWarning + audit + notification profil", () => {
  test("moderator → 200, UserWarning en DB, AdminAudit « SPAM: … »", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("POST", `/api/internal/admin/users/${aliceK().pubkey}/warn`, {
      session: await sessionFor("moderator"),
      body: JUST,
    });
    expect(r.status).toBe(200);
    expect((r.body.affected as { warningIssued: boolean }).warningIssued).toBe(true);

    const w = await db.userWarning.findFirst({ where: { user: { pubkey: aliceK().pubkey } } });
    expect(w).toBeTruthy();
    expect(must(w, "userWarning").category).toBe("SPAM");

    const a = await db.adminAudit.findFirst({
      where: { targetType: "user", targetId: aliceK().pubkey, action: "warn" },
      orderBy: { createdAt: "desc" },
    });
    expect(a).toBeTruthy();
    expect(must(a, "adminAudit").justification?.startsWith("SPAM: ")).toBe(true);
  });

  test("le TITULAIRE lit son avertissement via preuve de possession (profil)", async () => {
    if (!GUARD_OK) return;
    const ts = Date.now();
    const signature = await sign(aliceK().signPriv, `${aliceK().pubkey}|warnings-read|${ts}`);
    const res = await fetch(
      `${MAIN}/api/moderation/warnings?me=${encodeURIComponent(aliceK().pubkey)}&ts=${ts}&signature=${encodeURIComponent(signature)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: Array<{ category: string; note: string }> };
    expect(body.warnings.length).toBeGreaterThanOrEqual(1);
    expect(body.warnings[0].category).toBe("SPAM");
  });

  test("texte < 20 chars → 422 · catégorie invalide → 422", async () => {
    if (!GUARD_OK) return;
    const short = await mainFetch("POST", `/api/internal/admin/users/${aliceK().pubkey}/warn`, {
      session: await sessionFor("moderator"),
      body: { category: "SPAM", justification: "trop court" },
    });
    expect(short.status).toBe(422);
    const badCat = await mainFetch("POST", `/api/internal/admin/users/${aliceK().pubkey}/warn`, {
      session: await sessionFor("moderator"),
      body: { category: "PAS_UNE_CATEGORIE", justification: "justification suffisamment longue ici" },
    });
    expect(badCat.status).toBe(422);
  });

  test("sans CSRF → 403 (mutation, double contrôle Étape 4)", async () => {
    if (!GUARD_OK) return;
    const s = await sessionFor("moderator");
    const res = await fetch(`${MAIN}/api/internal/admin/users/${aliceK().pubkey}/warn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-internal": INTERNAL_TOKEN,
        Cookie: `mbote_admin_session=${s.token}`,
        "x-admin-actor": s.actorId,
        // PAS de x-admin-csrf
      },
      body: JSON.stringify(JUST),
    });
    expect(res.status).toBe(403);
  });

  test("fiche : l'historique admin liste le warn", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", `/api/internal/admin/users/${aliceK().pubkey}`, {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(200);
    const audit = r.body.audit as Array<{ action: string; justification: string | null }>;
    expect(audit.some((a) => a.action === "warn" && a.justification?.startsWith("SPAM: "))).toBe(true);
    expect((r.body.counts as { warnings: number }).warnings).toBeGreaterThanOrEqual(1);
  });
});

// ── F. SUSPEND ──────────────────────────────────────────────────────────────
describe("F. suspend — publication bloquée, DM possible, expiration", () => {
  test("avant suspension : posts → 200 (témoin)", async () => {
    if (!GUARD_OK) return;
    expect(await postAs(suspK(), "post témoin avant suspension — harness E7")).toBe(200);
  });

  test("suspend 24h → 200, suspendedUntil ≈ +24 h, sessionsRevoked=0 (§13.4)", async () => {
    if (!GUARD_OK) return;
    const before = Date.now();
    const r = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/suspend`, {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "24h" },
    });
    expect(r.status).toBe(200);
    const affected = r.body.affected as { user: { suspendedUntil: string | null }; sessionsRevoked: number };
    expect(affected.sessionsRevoked).toBe(0);
    const until = new Date(must(affected.user.suspendedUntil, "suspendedUntil")).getTime();
    const delta = until - before;
    expect(delta).toBeGreaterThan(23.5 * 3600_000);
    expect(delta).toBeLessThan(24.5 * 3600_000);
  });

  test("suspendu : POST /api/posts → 403 (A3 — publication bloquée)", async () => {
    if (!GUARD_OK) return;
    expect(await postAs(suspK(), "ce post doit être refusé pendant la suspension")).toBe(403);
  });

  test("suspendu : POST /api/dms → 200 (DM POSSIBLE — E2EE préservée, directive)", async () => {
    if (!GUARD_OK) return;
    const status = await dmAs(suspK(), aliceK().pubkey);
    expect(status).toBe(200);
  });

  test("duration invalide (48h) → 400 · indefinite → 400 (arbitrage §13.3)", async () => {
    if (!GUARD_OK) return;
    const r48 = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/suspend`, {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "48h" },
    });
    expect(r48.status).toBe(400);
    const rInd = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/suspend`, {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "indefinite" },
    });
    expect(rInd.status).toBe(400);
  });

  test("suspend 30d → suspendedUntil ≈ +30 j (dropdown Étape 7)", async () => {
    if (!GUARD_OK) return;
    const before = Date.now();
    const r = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/suspend`, {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "30d" },
    });
    expect(r.status).toBe(200);
    const affected30 = r.body.affected as { user: { suspendedUntil: string | null } };
    const until = new Date(must(affected30.user.suspendedUntil, "suspendedUntil 30d")).getTime();
    const delta = until - before;
    expect(delta).toBeGreaterThan(29.5 * 24 * 3600_000);
    expect(delta).toBeLessThan(30.5 * 24 * 3600_000);
  });

  test("EXPIRATION (mock temporel : backdate DB) → posts redevient 200 + statut actif", async () => {
    if (!GUARD_OK) return;
    // backdate : la suspension est « passée » (évaluation paresseuse)
    await db.user.update({
      where: { pubkey: suspK().pubkey },
      data: { suspendedAt: new Date(Date.now() - 48 * 3600_000), suspendedUntil: new Date(Date.now() - 24 * 3600_000) },
    });
    expect(await postAs(suspK(), "post après expiration simulée — harness E7")).toBe(200);
    const fiche = await mainFetch("GET", `/api/internal/admin/users/${suspK().pubkey}`, {
      session: await sessionFor("support"),
    });
    expect((fiche.body.user as { status: string }).status).toBe("actif");
  });

  test("unsuspend (arbitrage §13.5) → 200, suspendedAt/until cleared", async () => {
    if (!GUARD_OK) return;
    // re-suspendre pour tester la levée
    const s = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/suspend`, {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "7d" },
    });
    expect(s.status).toBe(200);
    const u = await mainFetch("POST", `/api/internal/admin/users/${suspK().pubkey}/unsuspend`, {
      session: await sessionFor("moderator"),
      body: JUST,
    });
    expect(u.status).toBe(200);
    const dbUser = await db.user.findUnique({ where: { pubkey: suspK().pubkey } });
    const row = must(dbUser, "user en DB après unsuspend");
    expect(row.suspendedAt).toBeNull();
    expect(row.suspendedUntil).toBeNull();
  });

  test("suspend d'un pubkey inconnu → 404", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("POST", "/api/internal/admin/users/e2e-u-inconnu-xyz/suspend", {
      session: await sessionFor("moderator"),
      body: { ...JUST, duration: "24h" },
    });
    expect(r.status).toBe(404);
  });
});

// ── G. BAN (four-eyes Étape 9) ──────────────────────────────────────────────
describe("G. ban — AUCUNE route (four-eyes Étape 9)", () => {
  test("POST interne /ban → 404 (route inexistante)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("POST", `/api/internal/admin/users/${aliceK().pubkey}/ban`, {
      session: await sessionFor("super-admin"),
      body: JUST,
    });
    expect(r.status).toBe(404);
  });

  test("POST BFF /ban → 404 (le panneau n'expose rien non plus)", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("POST", `/api/users/${aliceK().pubkey}/ban`, {
      session: await sessionFor("super-admin"),
      csrf: true,
      body: JUST,
    });
    expect(r.status).toBe(404);
  });
});

// ── H. BFF (panneau) ────────────────────────────────────────────────────────
describe("H. BFF /api/users — proxy authentifié", () => {
  test("support : liste 200 via le panneau", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/users", { session: await sessionFor("support") });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("list");
  });

  test("auditor → 403 propagé", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/users", { session: await sessionFor("auditor") });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("unauthorized");
  });

  test("q vide → 400 propagé (validation métier du backend)", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/users?q=", { session: await sessionFor("support") });
    expect(r.status).toBe(400);
  });

  test("fiche via BFF → 200 · inconnue → 404", async () => {
    if (!GUARD_OK) return;
    const ok = await panelFetch("GET", `/api/users/${aliceK().pubkey}`, { session: await sessionFor("support") });
    expect(ok.status).toBe(200);
    const ko = await panelFetch("GET", "/api/users/e2e-u-inconnu-xyz", { session: await sessionFor("support") });
    expect(ko.status).toBe(404);
  });

  test("warn via BFF (moderator + CSRF) → 200 · sans CSRF → 403", async () => {
    if (!GUARD_OK) return;
    const ok = await panelFetch("POST", `/api/users/${aliceK().pubkey}/warn`, {
      session: await sessionFor("moderator"),
      csrf: true,
      body: JUST,
    });
    expect(ok.status).toBe(200);
    const bad = await panelFetch("POST", `/api/users/${aliceK().pubkey}/warn`, {
      session: await sessionFor("moderator"),
      csrf: false,
      body: JUST,
    });
    expect(bad.status).toBe(403);
  });

  test("anonymous sur le BFF → 401", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("GET", "/api/users", { session: null });
    expect(r.status).toBe(401);
  });
});
