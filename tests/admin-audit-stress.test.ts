/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM — STRESS writeAdminAudit (Point 1, clarification Étape 9+C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : DATABASE_URL="file:$(pwd)/db/adm-audit-stress-test.db" \
 *             bun test tests/admin-audit-stress.test.ts
 *  (garde module-level → SKIP propre en suite globale — pattern Étapes 5-9)
 *
 *  Objectif (directive opérateur) : prouver qu'AUCUN chemin qui écrit
 *  AdminAudit ne peut deadlocker SQLite quand DEUX admins frappent la même
 *  cible simultanément. Le bug fondateur (Étape 9) : cancelPendingAction
 *  écrivait pendingaction_cancelled via le client global DANS une transaction
 *  ouverte → « database is locked » → pool bloqué 5 s. Corrigé
 *  (pending-action.ts:638 — writeAdminAudit({tx})). Ce harnais verrouille la
 *  non-régression et couvre les AUTRES chemins transactionnels (warn/suspend/
 *  hide/dismiss/approve/cancel) sous contention.
 *
 *  Scénarios :
 *   S1. WARN + SUSPEND simultanés par 2 admins distincts sur le MÊME user →
 *       les deux 200, zéro deadlock, exactement 2 lignes AdminAudit (warn +
 *       suspend), reports clos une seule fois chacun (première transaction).
 *   S2. HIDE + HIDE simultanés sur le même post (2 moderators) → les deux 200
 *       (hide idempotent), zéro deadlock, 2 lignes AdminAudit `hide`.
 *   S3. CANCEL vs APPROVE concurrents (le chemin exact du bug É9) : demandeur
 *       annule pendant qu'un 2ᵉ super-admin approuve → EXACTEMENT un gagne
 *       (200), l'autre 409 (course d'annulation) — jamais de deadlock, jamais
 *       les DEUX gagnants, jamais 500.
 *   S4. 2 super-admins créent simultanément une intention sur la même cible →
 *       une seule 201, l'autre 409 (doublon), zéro deadlock.
 *   S5. DISMISS concurrent du même report (2 moderators) → une seule 200,
 *       l'autre 409 (déjà traité), zéro deadlock.
 *   ZÉRO  « database is locked » / SQLITE_BUSY / « Timed out fetching » dans
 *   les logs serveur pour TOUTE la durée du harnais (assertion finale).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync, openSync, readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";

// ── environnement du harness ────────────────────────────────────────────────
const INTERNAL_TOKEN = "e2e-stress-token-0123456789abcdef0123456789abcdef";
const MAIN = "http://127.0.0.1:3121";

const DB_PATH = join(process.cwd(), "db", "adm-audit-stress-test.db");
// URL VOLONTAIREMENT par défaut (pas de busy_timeout) : le fix est le mutex
// d'écriture in-process (write-mutex.ts), pas un réglage d'URL — la preuve
// doit tenir sur la configuration de prod telle quelle.
const url = `file:${DB_PATH}`;

const GUARD_OK = process.env.DATABASE_URL === url;
if (!GUARD_OK) {
  console.warn(
    "admin-audit-stress SKIPPÉ — DATABASE_URL n'est pas la DB du harness. Lancer :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-audit-stress-test.db" bun test tests/admin-audit-stress.test.ts'
  );
}

let db: PrismaClient;
let mainProc: ChildProcess | null = null;
const MAIN_LOG = join(process.cwd(), "db", "adm-audit-stress-main.log");

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

// ── sessions (direct DB — pattern four-eyes) ────────────────────────────────
interface RoleSession {
  token: string;
  csrf: string;
  actorId: string;
  /** AdminSession.id réel — requis par le garde createdBySessionId du cancel. */
  sessionId: string;
}
const adminIds = new Map<string, number>();
const sessions = new Map<string, RoleSession>();

async function sessionFor(role: string): Promise<RoleSession> {
  const cached = sessions.get(role);
  if (cached) return cached;
  const id = must(adminIds.get(role), `admin ${role}`);
  const s = await createAdminSession(id, { ip: "e2e-stress", userAgent: "admin-audit-stress" });
  const rs = { token: s.sessionToken, csrf: s.csrfToken, actorId: String(id), sessionId: s.sessionId };
  sessions.set(role, rs);
  return rs;
}

// ── helpers HTTP ────────────────────────────────────────────────────────────
async function mainFetch(
  method: "GET" | "POST",
  path: string,
  opts: { session?: RoleSession | null; internal?: boolean; body?: unknown; timeoutMs?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.internal !== false) headers["x-admin-internal"] = INTERNAL_TOKEN;
  if (opts.session) {
    headers["Cookie"] = `mbote_admin_session=${opts.session.token}`;
    headers["x-admin-actor"] = opts.session.actorId;
    if (method === "POST") headers["x-admin-csrf"] = opts.session.csrf;
  }
  const res = await fetch(`${MAIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

const JUST = { category: "HARASSMENT", justification: "stress test — contention sur la même cible" };

// ── fixtures ────────────────────────────────────────────────────────────────
let s1User = ""; // pubkey du user visé par warn+suspend simultanés (S1)
const s1PostIds: string[] = []; // posts de la cible S1 (scope du count reports)
let s2Post = ""; // post visé par hide+hide simultanés (S2)
let s5Report = ""; // report visé par dismiss+dismiss (S5)
const s3Ids: number[] = []; // intentions cancel-vs-approve (S3)
let s4Pubkey = ""; // cible de la création doublon (S4)

async function seedFixtures(): Promise<void> {
  for (const [key, email] of [
    ["moderator", "mod-stress1@e2e.test"],
    ["moderator-2", "mod-stress2@e2e.test"],
    ["super-admin", "sa-stress1@e2e.test"],
    ["super-admin-2", "sa-stress2@e2e.test"],
  ] as const) {
    const role = key === "moderator-2" ? "moderator" : key === "super-admin-2" ? "super-admin" : key;
    const u = await db.adminUser.upsert({
      where: { email },
      create: { email, role, passwordHash: null, totpEnrolled: false },
      update: { role },
    });
    adminIds.set(key, u.id);
  }

  // S1 : user avec des posts reportés (les transactions warn/suspend ferment
  // des reports → contention maximale sur Report + AdminAudit)
  const v = await db.user.create({ data: { pubkey: "stress-target-1", nickname: "stress-target-1" } });
  s1User = v.pubkey;
  for (let i = 0; i < 3; i++) {
    const p = await db.post.create({
      data: { authorId: v.id, content: `post stress cible S1 #${i}` },
    });
    s1PostIds.push(p.id);
    await db.report.create({
      data: { targetKind: "post", targetId: p.id, reason: "stress S1", reporterKey: "stress-reporter" },
    });
  }

  // S2 : post à masquer par deux moderators en même temps
  const a2 = await db.user.create({ data: { pubkey: "stress-author-2", nickname: "stress-author-2" } });
  const p2 = await db.post.create({ data: { authorId: a2.id, content: "post stress S2" } });
  s2Post = p2.id;

  // S5 : un report OUVERT sur un post (dismiss concurrent)
  const a5 = await db.user.create({ data: { pubkey: "stress-author-5", nickname: "stress-author-5" } });
  const p5 = await db.post.create({ data: { authorId: a5.id, content: "post stress S5" } });
  const r5 = await db.report.create({
    data: { targetKind: "post", targetId: p5.id, reason: "stress S5", reporterKey: "stress-reporter" },
  });
  s5Report = r5.id;

  // S3 : 4 intentions (2 paires cancel-vs-approve) — toutes sur des users
  // DISTINCTS pour isoler la course cancel/approve de la course 409-doublon.
  // ⚠️ createdBySessionId = la session RÉELLE du demandeur (sessionFor) — le
  // cancel vérifie id ET session (garde double anti 2ᵉ onglet, É9).
  const requester = await sessionFor("super-admin");
  for (let i = 0; i < 4; i++) {
    const t = await db.user.create({ data: { pubkey: `stress-s3-${i}`, nickname: `stress-s3-${i}` } });
    const intent = await db.pendingAction.create({
      data: {
        actionType: "ban_user",
        targetType: "user",
        targetId: t.pubkey,
        payloadJson: JSON.stringify({ pubkey: t.pubkey, nickname: t.nickname }),
        justification: JUST.justification,
        status: "pending",
        createdById: must(adminIds.get("super-admin"), "sa1"),
        createdBySessionId: requester.sessionId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    s3Ids.push(intent.id);
  }

  // S4 : cible de la création d'intention simultanée
  const u4 = await db.user.create({ data: { pubkey: "stress-s4-target", nickname: "stress-s4-target" } });
  s4Pubkey = u4.pubkey;
}

// ── démarrage ───────────────────────────────────────────────────────────────
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

  mainProc = spawn("bunx", ["next", "dev", "-p", "3121"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: url,
      ADMIN_INTERNAL_TOKEN: INTERNAL_TOKEN,
      NEXT_TELEMETRY_DISABLED: "1",
      MBOTE_EMBED_RELAY: "0",
    },
    stdio: ["ignore", openSync(MAIN_LOG, "w"), openSync(MAIN_LOG, "a")],
    detached: true,
  });
  await waitFor(`${MAIN}/api/stats`, 120_000);
  await seedFixtures();

  // échauffement (Turbo compile à la demande — timeout bun 5 s sinon)
  await mainFetch("GET", "/api/internal/admin/pending-actions", { session: null }); // 401 attendu
  await mainFetch("POST", "/api/moderation/action", { session: null, body: {} }); // 401 attendu
}, 240_000);

afterAll(async () => {
  if (mainProc?.pid) {
    try {
      process.kill(-mainProc.pid, "SIGTERM");
    } catch {
      try {
        mainProc.kill("SIGKILL");
      } catch {
        /* déjà mort */
      }
    }
  }
  await db?.$disconnect();
  rmSync(DB_PATH, { force: true });
});

// ── helpers de scénarios ────────────────────────────────────────────────────
/** warn / suspend / dismiss par l'API interne (E7 / legacy). */
const warnOn = (s: RoleSession, pubkey: string) =>
  mainFetch("POST", `/api/internal/admin/users/${pubkey}/warn`, { session: s, body: JUST });
const suspendOn = (s: RoleSession, pubkey: string, duration: string) =>
  mainFetch("POST", `/api/internal/admin/users/${pubkey}/suspend`, { session: s, body: { ...JUST, duration } });
const hideOn = (s: RoleSession, postId: string) =>
  mainFetch("POST", "/api/moderation/action", { session: s, body: { targetKind: "post", targetId: postId, action: "hide", ...JUST } });
const dismissOn = (s: RoleSession, reportId: string) =>
  mainFetch("POST", "/api/moderation/action", { session: s, body: { targetKind: "report", targetId: reportId, action: "dismiss", ...JUST } });
const createIntent = (s: RoleSession, targetId: string) =>
  mainFetch("POST", "/api/internal/admin/pending-actions", { session: s, body: { actionType: "ban_user", targetId, ...JUST } });
const approveIntent = (s: RoleSession, id: number) =>
  mainFetch("POST", `/api/internal/admin/pending-actions/${id}/approve`, { session: s });
const cancelIntent = (s: RoleSession, id: number) =>
  mainFetch("POST", `/api/internal/admin/pending-actions/${id}/cancel`, { session: s });

/** Le demandeur S3 est super-admin — recreates sessions cohérentes avec seed. */
async function stressLogLocked(): Promise<string[]> {
  const log = readFileSync(MAIN_LOG, "utf8");
  return log.split("\n").filter((l) =>
    /database is locked|SQLITE_BUSY|SQLITE_LOCKED|Timed out fetching/i.test(l)
  );
}

// ── S1. warn + suspend simultanés sur le MÊME user ──────────────────────────
describe("S1. warn + suspend simultanés (même user) — zéro deadlock", () => {
  test("2 admins distincts en Promise.all → 200+200, 2 lignes AdminAudit", async () => {
    if (!GUARD_OK) return;
    const m1 = await sessionFor("moderator");
    const m2 = await sessionFor("moderator-2");
    const [r1, r2] = await Promise.all([warnOn(m1, s1User), suspendOn(m2, s1User, "24h")]);
    if (r1.status !== 200 || r2.status !== 200) {
      console.log("S1 DIAG statuts:", JSON.stringify({ warn: { s: r1.status, b: r1.body }, suspend: { s: r2.status, b: r2.body } }));
    }
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // chaque action a écrit SA ligne d'audit (2 lignes, warn + suspend)
    const audits = await db.adminAudit.findMany({
      where: { targetType: "user", targetId: s1User, action: { in: ["warn", "suspend"] } },
      select: { action: true },
    });
    expect(audits.map((a) => a.action).sort()).toEqual(["suspend", "warn"]);

    // reports de la CIBLE S1 clos : les 3 (le count est scopé aux posts S1 —
    // la DB contient aussi le report de S5, encore ouvert à ce stade du run)
    const stillOpen = await db.report.count({
      where: { status: "open", targetId: { in: s1PostIds } },
    });
    expect(stillOpen).toBe(0);

    expect(await stressLogLocked()).toEqual([]);
  }, 60_000);
});

// ── S2. hide + hide simultanés sur le même post ─────────────────────────────
describe("S2. hide + hide simultanés (même post) — zéro deadlock", () => {
  test("2 moderators en Promise.all → 200+200, 2 lignes AdminAudit `hide`", async () => {
    if (!GUARD_OK) return;
    const m1 = await sessionFor("moderator");
    const m2 = await sessionFor("moderator-2");
    const [r1, r2] = await Promise.all([hideOn(m1, s2Post), hideOn(m2, s2Post)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const audits = await db.adminAudit.count({ where: { action: "hide", targetId: s2Post } });
    expect(audits).toBe(2);
    expect(await stressLogLocked()).toEqual([]);
  }, 60_000);
});

// ── S3. cancel vs approve concurrents (le chemin EXACT du bug É9) ───────────
describe("S3. cancel vs approve concurrents — exactement un gagnant, zéro deadlock", () => {
  test("paire 1 : approve gagne → ban exécuté · cancel → 409", async () => {
    if (!GUARD_OK) return;
    const requester = await sessionFor("super-admin");
    const approver = await sessionFor("super-admin-2");
    const [rc, ra] = await Promise.all([
      cancelIntent(requester, s3Ids[0]),
      approveIntent(approver, s3Ids[0]),
    ]);
    // exactement UN des deux gagne (200) — l'autre refuse PROPREMENT (409)
    const statuses = [rc.status, ra.status].sort();
    expect(statuses).toEqual([200, 409]);
    // la cible est bannie (approve exécuté) ou ne l'est PAS (cancel exécuté) —
    // jamais un état intermédiaire : la pending est résolue une seule fois
    const pa = await db.pendingAction.findUnique({ where: { id: s3Ids[0] } });
    must(pa, "pendingAction");
    expect(pa.status).not.toBe("pending");
    expect(await stressLogLocked()).toEqual([]);
  }, 60_000);

  test("paire 2 : cancel gagne → intention cancelled · approve → 409", async () => {
    if (!GUARD_OK) return;
    const requester = await sessionFor("super-admin");
    const approver = await sessionFor("super-admin-2");
    const [rc, ra] = await Promise.all([
      cancelIntent(requester, s3Ids[1]),
      approveIntent(approver, s3Ids[1]),
    ]);
    const statuses = [rc.status, ra.status].sort();
    expect(statuses).toEqual([200, 409]);
    const pa = await db.pendingAction.findUnique({ where: { id: s3Ids[1] } });
    must(pa, "pendingAction");
    expect(pa.status).not.toBe("pending");
    expect(await stressLogLocked()).toEqual([]);
  }, 60_000);

  test("paire 3+4 : 4 requêtes simultanées (2 cancels + 2 approves) — résolues proprement", async () => {
    if (!GUARD_OK) return;
    const requester = await sessionFor("super-admin");
    const approver = await sessionFor("super-admin-2");
    const results = await Promise.all([
      cancelIntent(requester, s3Ids[2]),
      approveIntent(approver, s3Ids[2]),
      cancelIntent(requester, s3Ids[3]),
      approveIntent(approver, s3Ids[3]),
    ]);
    // chaque paire : exactement un 200 — les autres 409 ; JAMAIS 500 ni timeout
    for (const [pairStart, pairEnd] of [[0, 2], [2, 4]] as const) {
      const pair = results.slice(pairStart, pairEnd);
      const wins = pair.filter((r) => r.status === 200).length;
      if (wins !== 1) {
        console.log(`S3 DIAG paire ${pairStart / 2}:`, JSON.stringify(pair.map((r) => ({ s: r.status, b: r.body }))));
      }
      expect(wins).toBe(1);
      for (const r of pair) {
        expect([200, 409, 410]).toContain(r.status);
      }
    }
    const pa3 = await db.pendingAction.findUnique({ where: { id: s3Ids[2] } });
    const pa4 = await db.pendingAction.findUnique({ where: { id: s3Ids[3] } });
    expect(pa3?.status).not.toBe("pending");
    expect(pa4?.status).not.toBe("pending");
    expect(await stressLogLocked()).toEqual([]);
  }, 90_000);
});

// ── S4. création d'intention simultanée (doublon) ───────────────────────────
describe("S4. 2 super-admins créent la même intention — une seule 201", () => {
  test("Promise.all → exactement une 201, l'autre 409", async () => {
    if (!GUARD_OK) return;
    const sa1 = await sessionFor("super-admin");
    const sa2 = await sessionFor("super-admin-2");
    const [r1, r2] = await Promise.all([createIntent(sa1, s4Pubkey), createIntent(sa2, s4Pubkey)]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([201, 409]);
    const pendings = await db.pendingAction.count({
      where: { targetId: s4Pubkey, status: "pending" },
    });
    expect(pendings).toBe(1);
    expect(await stressLogLocked()).toEqual([]);
  }, 60_000);
});

// ── S5. dismiss concurrent du même report ───────────────────────────────────
describe("S5. dismiss + dismiss simultanés (même report) — un 200, un 409", () => {
  test("2 moderators en Promise.all → [200, 409], 1 ligne AdminAudit", async () => {
    if (!GUARD_OK) return;
    const m1 = await sessionFor("moderator");
    const m2 = await sessionFor("moderator-2");
    const [r1, r2] = await Promise.all([dismissOn(m1, s5Report), dismissOn(m2, s5Report)]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const audits = await db.adminAudit.count({ where: { action: "dismiss", targetId: s5Report } });
    expect(audits).toBe(1);
    expect(await stressLogLocked()).toEqual([]);
  }, 60_000);
});
