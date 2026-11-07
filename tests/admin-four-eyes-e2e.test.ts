/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 9 — FOUR-EYES (ban définitif + purge) contre les DEUX
 *  serveurs RÉELS (app principale :3119 + panneau :3120)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : DATABASE_URL="file:$(pwd)/db/adm-four-eyes-e2e-test.db" \
 *             bun test tests/admin-four-eyes-e2e.test.ts
 *  (garde module-level → SKIP propre en suite globale — pattern Étapes 5-8)
 *
 *  Scénarios (directive Étape 9) :
 *   A. CRÉATION : moderator → 403 · support → 403 · auditor → 403 ·
 *      super-admin → 201 avec expiresAt ≈ +1 h · actionType non-destructif →
 *      400 · justification < 20 → 422 · cible inconnue → 404 · doublon
 *      pending → 409 · cible déjà bannie → 409.
 *   B. LISTE : super-admin/moderator → 200 · support/auditor → 403 · payload
 *      figé (nickname) · drapeaux canApprove/canCancel corrects.
 *   C. AUTO-APPROBATION : même admin (2ᵉ session) → 403 (garde id ET session).
 *   D. BAN EXÉCUTÉ (2 admins distincts) : approve → 200 · User.bannedAt +
 *      bannedBy · posts masqués (hiddenById = exécutant) · publication → 403
 *      · EXACTEMENT 2 lignes AdminAudit (pendingaction_created + ban) avec
 *      requestedBy/approvedBy · filtre status=banni → 1 · fiche → « banni ».
 *   E. TIMEOUT : expiresAt backdaté → approve → 410 Gone · GET liste marque
 *      `expired` (audit pendingaction_expired).
 *   F. ANNULATION : demandeur → 200 cancelled + AUCUNE mutation (bannedAt
 *      null) · audit _cancelled · autre admin → 403 · approve après cancel →
 *      409.
 *   G. PURGE EXÉCUTÉE : approve → 200 · post SUPPRIMÉ · AdminAudit `purge`
 *      avec beforeJson (contenu conservé) + fourEyes (requestedBy/approvedBy)
 *      · cycle = 2 lignes exactement · re-demande sur post purgé → 404.
 *   H. NOTIFICATION : log `[pending-action:notify]` à chaque création
 *      (destinataires = autres super-admins actifs).
 *   I. RBAC approve : moderator → 403 (super-admin requis).
 *   J. AUCUNE route ban directe : POST /users/<id>/ban interne → 404 (scénario
 *      G Étape 7 — toujours vrai, le ban passe par les intentions).
 *   K. BFF panneau : GET 200 · POST 201 · approve (2ᵉ admin) 200 · sans CSRF →
 *      403 · auditor → 403 · page SSR /pending-actions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync, openSync, readFileSync, closeSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";

// ── environnement du harness ────────────────────────────────────────────────
const INTERNAL_TOKEN = "e2e-four-eyes-token-0123456789abcdef0123456789abcdef";
const MAIN = "http://127.0.0.1:3119";
const PANEL = "http://127.0.0.1:3120";

const DB_PATH = join(process.cwd(), "db", "adm-four-eyes-e2e-test.db");
const url = `file:${DB_PATH}`;

// Garde MODULE-LEVEL (pattern Étapes 5-8) : skip propre en suite globale.
const GUARD_OK = process.env.DATABASE_URL === url;
if (!GUARD_OK) {
  console.warn(
    "admin-four-eyes-e2e SKIPPÉ — DATABASE_URL n'est pas la DB du harness. Lancer :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-four-eyes-e2e-test.db" bun test tests/admin-four-eyes-e2e.test.ts'
  );
}

let db: PrismaClient;
let mainProc: ChildProcess | null = null;
let panelProc: ChildProcess | null = null;
let mainLogFd: number | null = null;
/** stdout+stderr de l'app principale — PREUVE du log de notification (H). */
const MAIN_LOG = join(process.cwd(), "db", "adm-four-eyes-e2e-main.log");

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
  const s = await createAdminSession(id, { ip: "e2e-four-eyes", userAgent: "admin-four-eyes-e2e" });
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
): Promise<{ status: number; body: Record<string, unknown>; text?: string }> {
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
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }
  return { status: res.status, body: {}, text: await res.text().catch(() => "") };
}

const JUST = { category: "HARASSMENT", justification: "harnais Étape 9 — ban définitif à deux yeux" };

// ── helpers crypto (ECDSA P-256 réelle) ─────────────────────────────────────
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
  rmSync(MAIN_LOG, { force: true });
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
  // stdout+stderr de l'app principale → fichier (preuve notification H — le
  // console.warn du SERVEUR n'est pas capturable depuis le process de test)
  mainLogFd = openSync(MAIN_LOG, "w");
  mainProc = spawn("bunx", ["next", "dev", "-p", "3119"], {
    cwd: process.cwd(),
    env: rootEnv,
    stdio: ["ignore", mainLogFd, mainLogFd],
    detached: true,
  });
  panelProc = spawn("bunx", ["next", "dev", "-p", "3120"], {
    cwd: join(process.cwd(), "admin"),
    env: { ...rootEnv, BACKEND_INTERNAL_URL: "http://127.0.0.1:3119" },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(`${MAIN}/api/stats`, 120_000);
  await waitFor(`${PANEL}/api/health`, 120_000);

  await seedFixtures();

  // ÉCHAUFFEMENT (Turbo pack compile à la demande — le timeout bun de 5 s
  // suffirait sinon à casser le PREMIER hit de chaque route BFF/SSR) :
  await panelFetch("GET", "/api/pending-actions", { session: null }); // 401 attendu
  await panelFetch("GET", "/pending-actions", { session: null }); // redirect attendu
  await mainFetch("GET", "/api/internal/admin/pending-actions", { session: null }); // 401 attendu
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
  if (mainLogFd !== null) closeSync(mainLogFd);
  rmSync(DB_PATH, { force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────
let banTarget: UserKeys | null = null; // cible du ban exécuté (D)
function banTargetK(): UserKeys {
  return must(banTarget, "ban-target (fixtures)");
}
let cancelTarget: UserKeys | null = null; // cible de l'annulation (F)
function cancelTargetK(): UserKeys {
  return must(cancelTarget, "cancel-target (fixtures)");
}
let expireTarget: UserKeys | null = null; // cible de l'expiration (E)
function expireTargetK(): UserKeys {
  return must(expireTarget, "expire-target (fixtures)");
}
let purgePostId = ""; // post purgé par four-eyes (G)
let notifyPubkey = ""; // cible du test notification (H)
let notifyActionId = 0; // intention du test notification (H)

async function seedFixtures(): Promise<void> {
  // ⚠️ « super-admin-2 » est une CLÉ DE SESSION (2ᵉ compte), pas un rôle : les
  // DEUX comptes portent le rôle « super-admin » (un rôle inconnu → 403 partout,
  // bug attrapé par ce harnais au premier run). Les deux admins sont DISTINCTS
  // (id + session) — c'est la seule exigence du four-eyes.
  for (const [key, email] of [
    ["super-admin", "sa-fe1@e2e.test"],
    ["super-admin-2", "sa-fe2@e2e.test"],
    ["moderator", "mod-fe@e2e.test"],
    ["support", "sup-fe@e2e.test"],
    ["auditor", "aud-fe@e2e.test"],
  ] as const) {
    const role = key === "super-admin-2" ? "super-admin" : key;
    const u = await db.adminUser.upsert({
      where: { email },
      create: { email, role, passwordHash: null, totpEnrolled: false },
      update: { role },
    });
    adminIds.set(key, u.id);
  }

  banTarget = await makeUserKeys("ban-target", { bio: "Cible du ban four-eyes." });
  cancelTarget = await makeUserKeys("cancel-target");
  expireTarget = await makeUserKeys("expire-target");
  notifyPubkey = (await makeUserKeys("notify-target")).pubkey;

  // posts VISIBLES de ban-target (masqués par l'exécution du ban)
  await postAs(banTargetK(), "post 1 de ban-target — sera masqué par le ban");
  await postAs(banTargetK(), "post 2 de ban-target — sera masqué par le ban");

  // post à purger (G) — direct DB pour figer l'id sans dépendre du feed
  const purgeAuthor = await makeUserKeys("purge-author");
  const p = await db.post.create({
    data: { authorId: purgeAuthor.id, content: "post à purger par four-eyes — contenu sensible" },
  });
  purgePostId = p.id;
}

/** Crée une intention par l'API interne (helper des scénarios). */
async function createIntent(
  session: RoleSession,
  actionType: string,
  targetId: string,
  just: { category: string; justification: string } = JUST
): Promise<{ status: number; body: Record<string, unknown> }> {
  return mainFetch("POST", "/api/internal/admin/pending-actions", {
    session,
    body: { actionType, targetId, ...just },
  });
}

// ── A. CRÉATION D'INTENTION ─────────────────────────────────────────────────
describe("A. création d'intention (RBAC + validation)", () => {
  test("moderator → 403 (super-admin requis, arbitrage §15.1)", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("moderator"), "ban_user", banTargetK().pubkey);
    expect(r.status).toBe(403);
  });

  test("support → 403 · auditor → 403", async () => {
    if (!GUARD_OK) return;
    const rs = await createIntent(await sessionFor("support"), "ban_user", banTargetK().pubkey);
    expect(rs.status).toBe(403);
    const ra = await createIntent(await sessionFor("auditor"), "ban_user", banTargetK().pubkey);
    expect(ra.status).toBe(403);
  });

  test("super-admin → 201 avec expiresAt ≈ +1 h", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("super-admin"), "ban_user", cancelTargetK().pubkey);
    expect(r.status).toBe(201);
    const pa = r.body.pendingAction as { id: number; expiresAt: string; status: string };
    expect(pa.status).toBe("pending");
    const deltaMs = new Date(pa.expiresAt).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(61 * 60_000);
    // nettoyage : cette intention sert aussi au scénario F (annulation) — pas de nettoyage
  });

  test("actionType non-destructif (warn) → 400 — four-eyes réservé à l'irréversible", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("super-admin"), "warn", banTargetK().pubkey);
    expect(r.status).toBe(400);
  });

  test("justification < 20 chars → 422", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("super-admin"), "ban_user", banTargetK().pubkey, {
      category: "SPAM",
      justification: "trop court",
    });
    expect(r.status).toBe(422);
  });

  test("cible inconnue → 404 (aucune ligne créée)", async () => {
    if (!GUARD_OK) return;
    const before = await db.pendingAction.count();
    const r = await createIntent(await sessionFor("super-admin"), "ban_user", "pubkey-inconnue-xyz");
    expect(r.status).toBe(404);
    expect(await db.pendingAction.count()).toBe(before);
  });

  test("doublon : 2ᵉ intention OUVERTE sur la même cible → 409", async () => {
    if (!GUARD_OK) return;
    const r1 = await createIntent(await sessionFor("super-admin"), "ban_user", banTargetK().pubkey);
    expect(r1.status).toBe(201);
    const r2 = await createIntent(await sessionFor("super-admin-2"), "ban_user", banTargetK().pubkey);
    expect(r2.status).toBe(409);
  });
});

// ── B. LISTE ────────────────────────────────────────────────────────────────
describe("B. liste des intentions", () => {
  test("super-admin → 200, items ≥ 2, payload figé (nickname)", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/pending-actions", {
      session: await sessionFor("super-admin"),
    });
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{
      id: number;
      actionType: string;
      targetId: string;
      payload: Record<string, unknown> | null;
      canApprove: boolean;
      canCancel: boolean;
    }>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const banItem = items.find((i) => i.targetId === banTargetK().pubkey);
    expect(banItem).toBeDefined();
    const bi = must(banItem, "intention banTarget (liste)");
    expect(bi.payload).not.toBeNull();
    expect((bi.payload as { nickname?: string }).nickname).toBe("ban-target");
    // le demandeur (super-admin) ne peut PAS approuver sa propre intention
    expect(bi.canApprove).toBe(false);
    expect(bi.canCancel).toBe(true);
  });

  test("moderator → 200 (lecture de la file) · support → 403 · auditor → 403", async () => {
    if (!GUARD_OK) return;
    const rm = await mainFetch("GET", "/api/internal/admin/pending-actions", {
      session: await sessionFor("moderator"),
    });
    expect(rm.status).toBe(200);
    const rs = await mainFetch("GET", "/api/internal/admin/pending-actions", {
      session: await sessionFor("support"),
    });
    expect(rs.status).toBe(403);
    const ra = await mainFetch("GET", "/api/internal/admin/pending-actions", {
      session: await sessionFor("auditor"),
    });
    expect(ra.status).toBe(403);
  });
});

// ── C. AUTO-APPROBATION ─────────────────────────────────────────────────────
describe("C. auto-approbation impossible", () => {
  test("le DEMANDEUR (même admin, 2ᵉ session) → 403", async () => {
    if (!GUARD_OK) return;
    // cible dédiée : l'intention de banTarget (demandeur = super-admin)
    const sa = await sessionFor("super-admin");
    const list = await mainFetch("GET", "/api/internal/admin/pending-actions", { session: sa });
    const items = list.body.items as Array<{ id: number; targetId: string; actionType: string; status: string }>;
    const mine = items.find((i) => i.actionType === "ban_user" && i.targetId === banTargetK().pubkey && i.status === "pending");
    expect(mine).toBeDefined();
    const mineAction = must(mine, "intention banTarget (auto-approb)");
    // deuxième SESSION du MÊME admin (garde id ET session)
    const saSession2 = await createAdminSession(must(adminIds.get("super-admin"), "sa1"), {
      ip: "e2e-2nd",
      userAgent: "second-session",
    });
    const r = await mainFetch("POST", `/api/internal/admin/pending-actions/${mineAction.id}/approve`, {
      session: { token: saSession2.sessionToken, csrf: saSession2.csrfToken, actorId: sa.actorId },
    });
    expect(r.status).toBe(403);
    // garde session : la 2ᵉ session du même id est refusée AUSSI (la garde id
    // fire d'abord — message « le demandeur ne peut pas approuver » — les DEUX
    // gardes sont actives, l'ordre id→session n'est qu'un choix de message)
    const r2 = await mainFetch("POST", `/api/internal/admin/pending-actions/${mineAction.id}/approve`, {
      session: { token: saSession2.sessionToken, csrf: saSession2.csrfToken, actorId: sa.actorId },
    });
    expect(r2.status).toBe(403);
    expect(String(r2.body.error)).toContain("Auto-approbation impossible");
  });
});

// ── D. BAN EXÉCUTÉ (2 admins distincts) ─────────────────────────────────────
describe("D. ban exécuté par four-eyes", () => {
  test("approbation par un 2ᵉ super-admin → 200 · bannedAt + posts masqués", async () => {
    if (!GUARD_OK) return;
    const sa2 = await sessionFor("super-admin-2");
    // l'intention existe (créée au test A doublon) — demandeur sa-fe1, approbateur sa2
    const list = await mainFetch("GET", "/api/internal/admin/pending-actions", { session: sa2 });
    const items = list.body.items as Array<{ id: number; targetId: string; actionType: string; status: string; canApprove: boolean }>;
    const target = items.find((i) => i.actionType === "ban_user" && i.targetId === banTargetK().pubkey && i.status === "pending");
    expect(target).toBeDefined();
    const targetAction = must(target, "intention banTarget (approve)");
    expect(targetAction.canApprove).toBe(true); // sa2 ≠ demandeur sa

    const r = await mainFetch("POST", `/api/internal/admin/pending-actions/${targetAction.id}/approve`, {
      session: sa2,
    });
    expect(r.status).toBe(200);
    const executed = r.body.executed as {
      actionType: string;
      requestedBy: { id: number; email: string };
      approvedBy: { id: number; email: string };
      outcome: { bannedAt: string; postsHidden: number };
    };
    expect(executed.actionType).toBe("ban_user");
    expect(executed.requestedBy.email).toBe("sa-fe1@e2e.test");
    expect(executed.approvedBy.email).toBe("sa-fe2@e2e.test");
    expect(executed.outcome.postsHidden).toBeGreaterThanOrEqual(2);

    // effet : User.bannedAt + bannedBy = exécutant
    const user = await db.user.findUnique({ where: { pubkey: banTargetK().pubkey } });
    expect(user?.bannedAt).not.toBeNull();
    expect(user?.bannedById).toBe(must(adminIds.get("super-admin-2"), "sa2"));

    // effet : posts masqués PAR L'EXÉCUTANT
    const posts = await db.post.findMany({ where: { authorId: banTargetK().id } });
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const p of posts) {
      expect(p.hiddenAt).not.toBeNull();
      expect(p.hiddenById).toBe(must(adminIds.get("super-admin-2"), "sa2"));
    }

    // statut de la pending
    const pa = await db.pendingAction.findUnique({ where: { id: targetAction.id } });
    expect(pa?.status).toBe("executed");
    expect(pa?.approvedById).toBe(must(adminIds.get("super-admin-2"), "sa2"));
    expect(pa?.executedAt).not.toBeNull();
  });

  test("EXACTEMENT 2 lignes AdminAudit (request + execute) avec requestedBy/approvedBy", async () => {
    if (!GUARD_OK) return;
    const rows = await db.adminAudit.findMany({
      where: { targetType: "user", targetId: banTargetK().pubkey },
      orderBy: { id: "asc" },
    });
    const cycle = rows.filter((r) => r.action === "pendingaction_created" || r.action === "ban");
    // la demande « doublon » A n'a créé qu'UNE pending (2ᵉ → 409) : le cycle
    // complet = 2 lignes EXACTEMENT (directive É9)
    expect(cycle.length).toBe(2);
    const [created, ban] = cycle;
    expect(created.action).toBe("pendingaction_created");
    expect(ban.action).toBe("ban");
    const banAfter = JSON.parse(ban.afterJson ?? "{}") as {
      fourEyes?: { requestedBy: string; requestedByEmail: string; approvedBy: string };
      bannedAt?: string;
    };
    expect(banAfter.fourEyes).toBeDefined();
    const fourEyesBan = must(banAfter.fourEyes, "fourEyes dans afterJson du ban");
    expect(fourEyesBan.requestedByEmail).toBe("sa-fe1@e2e.test");
    // l'exécutant est le DEUXIÈME super-admin (id dépend du seed — system=1)
    expect(fourEyesBan.approvedBy).toBe(`admin-${must(adminIds.get("super-admin-2"), "id sa2")}`);
    expect(banAfter.bannedAt).toBeDefined();
    // la ligne request porte aussi le demandeur
    const createdAfter = JSON.parse(created.afterJson ?? "{}") as { requestedByEmail?: string };
    expect(createdAfter.requestedBy).toBeDefined();
  });

  test("publication du banni → 403 « banni définitivement »", async () => {
    if (!GUARD_OK) return;
    const status = await postAs(banTargetK(), "je suis banni — publication refusée");
    expect(status).toBe(403);
  });

  test("feed public : les posts du banni sont absents", async () => {
    if (!GUARD_OK) return;
    const res = await fetch(`${MAIN}/api/posts?limit=100`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { posts?: Array<{ pubkey: string }> };
    const fromBanned = (data.posts ?? []).filter((p) => p.pubkey === banTargetK().pubkey);
    expect(fromBanned.length).toBe(0);
  });

  test("filtre annuaire status=banni → contient la cible · fiche → « banni »", async () => {
    if (!GUARD_OK) return;
    const r = await mainFetch("GET", "/api/internal/admin/users?status=banni", {
      session: await sessionFor("support"),
    });
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ pubkey: string; status: string }>;
    const hit = items.find((i) => i.pubkey === banTargetK().pubkey);
    expect(hit).toBeDefined();
    expect(must(hit, "banni dans l'annuaire").status).toBe("banni");

    const fiche = await mainFetch("GET", `/api/internal/admin/users/${banTargetK().pubkey}`, {
      session: await sessionFor("support"),
    });
    expect(fiche.status).toBe(200);
    const u = fiche.body.user as { status: string; bannedAt: string | null };
    expect(u.status).toBe("banni");
    expect(u.bannedAt).not.toBeNull();
  });

  test("ban d'un utilisateur DÉJÀ banni → 409", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("super-admin"), "ban_user", banTargetK().pubkey);
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("déjà banni");
  });
});

// ── E. TIMEOUT ──────────────────────────────────────────────────────────────
describe("E. expiration (1 h, paresseuse)", () => {
  test("intention expirée → 410 Gone (ne peut plus être approuvée)", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("super-admin"), "ban_user", expireTargetK().pubkey);
    expect(r.status).toBe(201);
    const { id } = r.body.pendingAction as { id: number };
    // mock temporel : backdate DB (pattern F Étape 7 — suspension expirée)
    await db.pendingAction.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const approve = await mainFetch("POST", `/api/internal/admin/pending-actions/${id}/approve`, {
      session: await sessionFor("super-admin-2"),
    });
    expect(approve.status).toBe(410);
    // la cible n'a PAS été bannie
    const u = await db.user.findUnique({ where: { pubkey: expireTargetK().pubkey } });
    expect(u?.bannedAt).toBeNull();
    // marquée expired en DB + auditée
    const pa = await db.pendingAction.findUnique({ where: { id } });
    expect(pa?.status).toBe("expired");
    const audit = await db.adminAudit.findFirst({ where: { action: "pendingaction_expired", targetId: expireTargetK().pubkey } });
    expect(audit).not.toBeNull();
  });

  test("annulation d'une intention expirée → 410 (jamais « cancelled »)", async () => {
    if (!GUARD_OK) return;
    const list = await mainFetch("GET", "/api/internal/admin/pending-actions?status=expired", {
      session: await sessionFor("super-admin"),
    });
    const items = list.body.items as Array<{ id: number; targetId: string }>;
    const expired = items.find((i) => i.targetId === expireTargetK().pubkey);
    expect(expired).toBeDefined();
    const r = await mainFetch("POST", `/api/internal/admin/pending-actions/${must(expired, "intention expirée").id}/cancel`, {
      session: await sessionFor("super-admin"),
    });
    expect(r.status).toBe(410);
  });
});

// ── F. ANNULATION (demandeur uniquement) ────────────────────────────────────
describe("F. annulation par le demandeur", () => {
  test("autre admin → 403 (seul le demandeur annule)", async () => {
    if (!GUARD_OK) return;
    const list = await mainFetch("GET", "/api/internal/admin/pending-actions?status=pending", {
      session: await sessionFor("super-admin"),
    });
    const items = list.body.items as Array<{ id: number; targetId: string; actionType: string }>;
    const intent = items.find((i) => i.actionType === "ban_user" && i.targetId === cancelTargetK().pubkey);
    expect(intent).toBeDefined();
    const r = await mainFetch("POST", `/api/internal/admin/pending-actions/${must(intent, "intention cancelTarget (403)").id}/cancel`, {
      session: await sessionFor("super-admin-2"),
    });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("demandeur");
  });

  test("demandeur annule → 200 · status cancelled · AUCUNE mutation", async () => {
    if (!GUARD_OK) return;
    const sa = await sessionFor("super-admin");
    const list = await mainFetch("GET", "/api/internal/admin/pending-actions?status=pending", { session: sa });
    const items = list.body.items as Array<{ id: number; targetId: string; actionType: string }>;
    const intent = items.find((i) => i.actionType === "ban_user" && i.targetId === cancelTargetK().pubkey);
    expect(intent).toBeDefined();
    const intentAction = must(intent, "intention cancelTarget (annulation)");
    const r = await mainFetch("POST", `/api/internal/admin/pending-actions/${intentAction.id}/cancel`, { session: sa });
    expect(r.status).toBe(200);
    expect((r.body.pendingAction as { status: string }).status).toBe("cancelled");

    // AUCUNE mutation : cancelTarget n'est PAS banni
    const u = await db.user.findUnique({ where: { pubkey: cancelTargetK().pubkey } });
    expect(u?.bannedAt).toBeNull();

    // audit _cancelled
    const audit = await db.adminAudit.findFirst({
      where: { action: "pendingaction_cancelled", targetId: cancelTargetK().pubkey },
    });
    expect(audit).not.toBeNull();

    // re-approbation d'une intention annulée → 409
    const r2 = await mainFetch("POST", `/api/internal/admin/pending-actions/${intentAction.id}/approve`, {
      session: await sessionFor("super-admin-2"),
    });
    expect(r2.status).toBe(409);
  });
});

// ── G. PURGE EXÉCUTÉE ───────────────────────────────────────────────────────
describe("G. purge exécutée par four-eyes", () => {
  test("create + approve → post SUPPRIMÉ · 2 lignes (created + purge) · beforeJson conservé", async () => {
    if (!GUARD_OK) return;
    const sa = await sessionFor("super-admin");
    const sa2 = await sessionFor("super-admin-2");
    const created = await createIntent(sa, "purge_post", purgePostId, {
      category: "SCAM",
      justification: "harnais Étape 9 — purge à deux yeux du post scam",
    });
    expect(created.status).toBe(201);
    const { id } = created.body.pendingAction as { id: number };

    const approved = await mainFetch("POST", `/api/internal/admin/pending-actions/${id}/approve`, {
      session: sa2,
    });
    expect(approved.status).toBe(200);

    // post SUPPRIMÉ
    const post = await db.post.findUnique({ where: { id: purgePostId } });
    expect(post).toBeNull();

    // EXACTEMENT 2 lignes pour la cible : pendingaction_created + purge
    const rows = await db.adminAudit.findMany({
      where: { targetId: purgePostId },
      orderBy: { id: "asc" },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].action).toBe("pendingaction_created");
    expect(rows[1].action).toBe("purge");
    // beforeJson conserve le CONTENU purgé
    const before = JSON.parse(rows[1].beforeJson ?? "{}") as { content?: string };
    expect(before.content).toContain("contenu sensible");
    // afterJson porte fourEyes (requestedBy/approvedBy)
    const after = JSON.parse(rows[1].afterJson ?? "{}") as {
      fourEyes?: { requestedBy: string; requestedByEmail: string; approvedBy: string };
    };
    expect(after.fourEyes).toBeDefined();
    const fourEyesPurge = must(after.fourEyes, "fourEyes dans afterJson de la purge");
    expect(fourEyesPurge.requestedByEmail).toBe("sa-fe1@e2e.test");
    expect(fourEyesPurge.approvedBy).toBe(`admin-${must(adminIds.get("super-admin-2"), "id sa2")}`);
  });

  test("re-demande de purge sur un post purgé → 404 (cible disparue)", async () => {
    if (!GUARD_OK) return;
    const r = await createIntent(await sessionFor("super-admin"), "purge_post", purgePostId);
    expect(r.status).toBe(404);
  });
});

// ── H. NOTIFICATION (log serveur, fichier MAIN_LOG) ─────────────────────────
describe("H. notification à la création", () => {
  test(
    "log serveur [pending-action:notify] avec les autres super-admins (fichier stdout)",
    async () => {
      if (!GUARD_OK) return;
      const r = await createIntent(await sessionFor("super-admin"), "ban_user", notifyPubkey);
      expect(r.status).toBe(201);
      notifyActionId = (r.body.pendingAction as { id: number }).id;
      // le console.warn est émis PAR LE SERVEUR (process séparé) → le harnais
      // poll son fichier stdout jusqu'à 10 s (flush async)
      let hit = "";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        let text = "";
        try {
          text = readFileSync(MAIN_LOG, "utf8");
        } catch {
          text = ""; // fichier pas encore créé — retry
        }
        const lines = text.split("\n").filter((l) => l.includes("[pending-action:notify]"));
        const line = lines.find((l) => l.includes(`#${notifyActionId}`));
        if (line) {
          hit = line;
          break;
        }
        await new Promise((res) => setTimeout(res, 500));
      }
      expect(hit).not.toBe("");
      expect(hit).toContain("ban_user");
      expect(hit).toContain("sa-fe1@e2e.test"); // demandeur
      expect(hit).toContain("sa-fe2@e2e.test"); // destinataire (autre super-admin actif)
      // nettoyage : intention résiduelle annulée pour ne pas polluer la file
      await mainFetch("POST", `/api/internal/admin/pending-actions/${notifyActionId}/cancel`, {
        session: await sessionFor("super-admin"),
      });
    },
    30_000
  );
});

// ── I. RBAC APPROVE ─────────────────────────────────────────────────────────
describe("I. RBAC approbation", () => {
  let rbacTarget = ""; // cible DÉDIÉE (une cascade de doublon 409 masquerait le 403 réel)
  test("moderator → 403 sur approve (super-admin requis)", async () => {
    if (!GUARD_OK) return;
    rbacTarget = (await makeUserKeys("rbac-approve-target")).pubkey;
    const sa = await sessionFor("super-admin");
    const r = await createIntent(sa, "ban_user", rbacTarget);
    expect(r.status).toBe(201);
    const { id } = r.body.pendingAction as { id: number };
    const rm = await mainFetch("POST", `/api/internal/admin/pending-actions/${id}/approve`, {
      session: await sessionFor("moderator"),
    });
    expect(rm.status).toBe(403);
    // l'intention reste pending (le moderator ne peut rien exécuter)
    const pa = await db.pendingAction.findUnique({ where: { id } });
    expect(pa?.status).toBe("pending");
    // nettoyage
    await mainFetch("POST", `/api/internal/admin/pending-actions/${id}/cancel`, { session: sa });
  }, 30_000);
});

// ── J. AUCUNE ROUTE BAN DIRECTE ─────────────────────────────────────────────
describe("J. zéro route ban directe (scénario G É7 — toujours vrai)", () => {
  test(
    "POST /api/internal/admin/users/<pubkey>/ban → 404 · BFF idem",
    async () => {
      if (!GUARD_OK) return;
      const ri = await mainFetch("POST", `/api/internal/admin/users/${banTargetK().pubkey}/ban`, {
        session: await sessionFor("super-admin"),
        body: { ...JUST },
      });
      expect(ri.status).toBe(404);
      const rp = await panelFetch("POST", `/api/users/${banTargetK().pubkey}/ban`, {
        session: await sessionFor("super-admin"),
        csrf: true,
        body: { ...JUST },
      });
      expect(rp.status).toBe(404);
    },
    60_000
  );
});

// ── K. BFF (panneau) ────────────────────────────────────────────────────────
describe("K. BFF /api/pending-actions (panneau)", () => {
  test(
    "GET super-admin → 200 · auditor → 403",
    async () => {
      if (!GUARD_OK) return;
      const rok = await panelFetch("GET", "/api/pending-actions", {
        session: await sessionFor("super-admin"),
      });
      expect(rok.status).toBe(200);
      const items = rok.body.items as Array<{ id: number }>;
      expect(Array.isArray(items)).toBe(true);
      const raud = await panelFetch("GET", "/api/pending-actions", {
        session: await sessionFor("auditor"),
      });
      expect(raud.status).toBe(403);
      expect(raud.body.error).toBe("unauthorized");
    },
    60_000
  );

  test(
    "POST 201 → approve par le 2ᵉ admin 200 (cycle complet via BFF)",
    async () => {
      if (!GUARD_OK) return;
      const r1 = await panelFetch("POST", "/api/pending-actions", {
        session: await sessionFor("super-admin"),
        csrf: true,
        body: { actionType: "ban_user", targetId: expireTargetK().pubkey, ...JUST },
      });
      expect(r1.status).toBe(201);
      const { id } = r1.body.pendingAction as { id: number };
      const r2 = await panelFetch("POST", `/api/pending-actions/${id}/approve`, {
        session: await sessionFor("super-admin-2"),
        csrf: true,
        body: {},
      });
      expect(r2.status).toBe(200);
      const u = await db.user.findUnique({ where: { pubkey: expireTargetK().pubkey } });
      expect(u?.bannedAt).not.toBeNull();
    },
    60_000
  );

  test("POST sans CSRF → 403", async () => {
    if (!GUARD_OK) return;
    const r = await panelFetch("POST", "/api/pending-actions", {
      session: await sessionFor("super-admin"),
      csrf: false,
      body: { actionType: "ban_user", targetId: notifyPubkey, ...JUST },
    });
    expect(r.status).toBe(403);
  });

  test(
    "page SSR /pending-actions : 200 HTML pour moderator · refus pour auditor",
    async () => {
      if (!GUARD_OK) return;
      const rmod = await panelFetch("GET", "/pending-actions", { session: await sessionFor("moderator") });
      expect(rmod.status).toBe(200);
      expect(rmod.text ?? "").toContain("four-eyes");
      const raud = await panelFetch("GET", "/pending-actions", { session: await sessionFor("auditor") });
      expect(raud.status).toBe(200);
      expect(raud.text ?? "").toContain("Accès refusé");
    },
    60_000
  );
});
