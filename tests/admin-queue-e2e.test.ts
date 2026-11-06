/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 6 — QUEUE UI (endpoint interne cursor + actions §6)
 *  contre les DEUX serveurs RÉELS (app principale :3107 + panneau :3108)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : DATABASE_URL="file:$(pwd)/db/adm-queue-e2e-test.db" \
 *             bun test tests/admin-queue-e2e.test.ts
 *  (garde module-level → SKIP propre en suite globale — pattern Étape 5)
 *
 *  Scénarios (directive Étape 6) :
 *   A. auth/RBAC : token seul → 401 · session sans token → 401 · support → 200
 *      · auditor → 403 (arbitrage §12.17 : auditor STRICT) · anonymous → 401.
 *   B. TRI poids décroissant : 3 reports sur postA + 1 sur postB → A d'abord,
 *      weight=3 sur chaque item de A (badge).
 *   C. PAGINATION cursor : page 1 = 20 items + nextCursor · page 2 = items
 *      DISTINCTS · cursor malformé → 400 · cursor expiré (cible fermée entre
 *      deux pages) → restart page 1 + cursorReset=true.
 *   D. FILTRES : période 24h exclut un report de 48h (backdaté) · type=comment
 *      liste les commentaires seulement · status=open exclut les traités.
 *   E. ACTIONS + JUSTIFICATION §6 : texte < 20 → 422 · catégorie invalide →
 *      422 · hide → 200 + AdminAudit « SPAM: … » + report ne réapparaît pas ·
 *      dismiss → 200 + status=dismissed · dismiss déjà traité → 409.
 *   F. WARN → UserWarning : écrit en DB (même tx que l'audit) + lecture par
 *      preuve de possession (signature ECDSA P-256) · sans preuve → 401 ·
 *      mauvaise clé → 401.
 *   G. SUSPENSION TEMPORAIRE : 24h/7d → suspendedUntil correct · publication
 *      refusée 403 pendant la suspension · feed exclut · après expiration
 *      (backdatée) → publication OK + post de retour dans le fil · unsuspend →
 *      cleared.
 *   H. FOUR-EYES (Étape 9) : action "ban" hors enum → 400 refusée (la surface
 *      UI — bouton désactivé — est prouvée par capture navigateur).
 *   I. ANTI-FUITE : aucun email/IP/password dans le payload queue (pubkeys =
 *      identités publiques opératoires — documenté ADM-step6 §5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";

// ── environnement du harness ────────────────────────────────────────────────
const INTERNAL_TOKEN = "e2e-queue-internal-token-0123456789abcdef0123456789abcdef";
const MAIN = "http://127.0.0.1:3107";
const PANEL = "http://127.0.0.1:3108";

const DB_PATH = join(process.cwd(), "db", "adm-queue-e2e-test.db");
const url = `file:${DB_PATH}`;

// Garde MODULE-LEVEL (pattern Étape 5) : skip propre en suite globale.
const GUARD_OK = process.env.DATABASE_URL === url;
if (!GUARD_OK) {
  console.warn(
    "admin-queue-e2e SKIPPÉ — DATABASE_URL n'est pas la DB du harness. Lancer :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-queue-e2e-test.db" bun test tests/admin-queue-e2e.test.ts'
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
  const s = await createAdminSession(id, { ip: "e2e-queue", userAgent: "admin-queue-e2e" });
  const rs = { token: s.sessionToken, csrf: s.csrfToken, actorId: String(id) };
  sessions.set(role, rs);
  return rs;
}

// ── helpers HTTP ────────────────────────────────────────────────────────────
async function mainFetch(
  method: "GET" | "POST",
  path: string,
  opts: { session?: RoleSession | null; internal?: boolean; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // token interne présent SAUF si explicitement retiré (test A2 : session sans
  // token — le double contrôle Étape 4 exige les DEUX facteurs)
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

async function queueGet(
  role: string | null,
  qs: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return mainFetch("GET", `/api/internal/admin/queue${qs}`, {
    session: role ? await sessionFor(role) : null,
    internal: true,
  });
}

const JUST = { category: "SPAM", justification: "harnais Étape 6 — justification ≥ 20 caractères" };

// ── helpers crypto (preuves de possession utilisateur — ECDSA P-256 réelle) ─
const subtle = globalThis.crypto.subtle;

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}



interface UserKeys {
  pubkey: string;
  signPriv: CryptoKey;
}

async function makeUserKeys(nickname: string): Promise<UserKeys> {
  const pair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  await db.user.create({ data: { pubkey, nickname } });
  return { pubkey, signPriv: pair.privateKey };
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

// ── helpers crypto (preuves de possession utilisateur — ECDSA P-256 réelle) ─
// ── démarrage des serveurs ──────────────────────────────────────────────────
async function waitFor(u: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 503) return; // 503 = health DEGRADED (panel sans backend) — servi
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
let bobPubkey = "";
let postHeavy = ""; // 3 reports (poids 3)
let postLight = ""; // 1 report (poids 1)
let oldReportId = ""; // backdaté 48 h (filtre période)
let commentReportId = ""; // report de commentaire (filtre type)
const fillerPostIds: string[] = []; // 25 cibles poids 1 (pagination)
let warnTargetPubkey = ""; // cible du warn (F) — identité à clé réelle
let suspTargetPubkey = ""; // cible de la suspension (G)
let susanKeys: UserKeys | null = null; // clé de signature de Susan (posts G)

async function seedFixtures(): Promise<void> {
  for (const [role, email] of [
    ["super-admin", "sa-q@e2e.test"],
    ["moderator", "mod-q@e2e.test"],
    ["support", "sup-q@e2e.test"],
    ["auditor", "aud-q@e2e.test"],
  ] as const) {
    const u = await db.adminUser.upsert({
      where: { email },
      create: { email, role, passwordHash: null, totpEnrolled: false },
      update: { role },
    });
    adminIds.set(role, u.id);
  }

  const bob = await db.user.create({
    data: { pubkey: "e2e-q-bob", nickname: "Bob Queue" },
  });
  bobPubkey = bob.pubkey;
  const mkPost = async (c: string) =>
    (await db.post.create({ data: { authorId: bob.id, content: c }, select: { id: true } })).id;

  postHeavy = await mkPost("post lourd — 3 signalements ouverts sur la même cible");
  postLight = await mkPost("post léger — 1 signalement");
  // cible du warn : identité à CLÉ RÉELLE (la lecture des avertissements F2–F4
  // exige des preuves ECDSA sur une pubkey bien formée)
  warnTargetPubkey = (await makeUserKeys("Warn Target")).pubkey;
  const susan = await makeUserKeys("Susan Susp"); // suspension (G) — posts signés
  suspTargetPubkey = susan.pubkey;
  susanKeys = susan;

  let reporterN = 0;
  const mkReport = async (targetKind: string, targetId: string, reason = "spam") =>
    db.report.create({
      data: { reporterKey: `e2e-q-rep-${reporterN++}`, targetKind, targetId, reason },
    });

  // B — poids : 3 reports sur postHeavy, 1 sur postLight
  await mkReport("post", postHeavy);
  await mkReport("post", postHeavy);
  await mkReport("post", postHeavy);
  await mkReport("post", postLight);

  // D — période : un report backdaté de 48 h
  const old = await mkReport("post", await mkPost("post avec report ancien (48 h)"));
  await db.report.update({
    where: { id: old.id },
    data: { createdAt: new Date(Date.now() - 48 * 3600_000) },
  });
  oldReportId = old.id;

  // D — type : un report de COMMENTAIRE (Post enfant)
  const parent = await mkPost("parent du commentaire signalé");
  const comment = await db.post.create({
    data: { authorId: bob.id, content: "commentaire signalé", parentId: parent },
  });
  const cr = await mkReport("comment", comment.id);
  commentReportId = cr.id;

  // C — pagination : 25 cibles distinctes poids 1
  for (let i = 0; i < 25; i++) {
    const p = await mkPost(`post filler pagination ${i}`);
    fillerPostIds.push(p);
    await mkReport("post", p);
  }
}

// ═══════════════════════════ A — auth / RBAC ═══════════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · A — endpoint interne queue (auth + RBAC §12.17)", () => {
  test("A1 · token interne SEUL → 401", async () => {
    const r = await mainFetch("GET", "/api/internal/admin/queue", { internal: true });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "unauthorized" });
  });

  test("A2 · session SANS token interne → 401", async () => {
    const r = await mainFetch("GET", "/api/internal/admin/queue", {
      session: await sessionFor("support"),
      internal: false,
    });
    expect(r.status).toBe(401);
  });

  test("A3 · anonymous → 401", async () => {
    const r = await mainFetch("GET", "/api/internal/admin/queue", { internal: true, session: null });
    expect(r.status).toBe(401);
  });

  test("A4 · support → 200 (items + openTotal + page)", async () => {
    const r = await queueGet("support", "");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.openTotal).toBeNumber();
    expect((r.body.page as Record<string, unknown>).size).toBe(20);
  });

  test("A5 · auditor → 403 (STRICT — lecture seule AdminAudit, §12.17)", async () => {
    const r = await queueGet("auditor", "");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "unauthorized" });
  });

  test("A6 · paramètre period invalide → 400 · type invalide → 400", async () => {
    expect((await queueGet("support", "?period=2h")).status).toBe(400);
    expect((await queueGet("support", "?type=dm")).status).toBe(400);
  });
});

// ═══════════════════════════ B — tri par poids ═════════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · B — tri poids décroissant puis ancienneté croissante", () => {
  test("B1 · 3 reports sur postA + 1 sur postB → A en premier, weight=3", async () => {
    const r = await queueGet("support", "");
    expect(r.status).toBe(200);
    const items = r.body.items as Array<Record<string, unknown>>;
    const heavy = items.filter((i) => i.targetId === postHeavy);
    const light = items.filter((i) => i.targetId === postLight);
    expect(heavy.length).toBe(3);
    expect(light.length).toBe(1);
    expect(heavy.every((i) => i.weight === 3)).toBe(true);
    expect(light[0].weight).toBe(1);
    // TOUT item de poids 3 précède TOUT item de poids 1 (dans la page servie)
    const firstLightIdx = items.findIndex((i) => i.weight === 1);
    const lastHeavyIdx = items.reduce((acc, i, idx) => (i.weight === 3 ? idx : acc), -1);
    expect(lastHeavyIdx).toBeGreaterThanOrEqual(0);
    expect(firstLightIdx).toBeGreaterThan(lastHeavyIdx);
  });
});

// ═══════════════════════════ C — pagination cursor ═════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · C — pagination cursor-based (20/page)", () => {
  let cursor1: string | null = null;
  let page1Ids: string[] = [];

  test("C1 · page 1 = 20 items + nextCursor", async () => {
    const r = await queueGet("support", "?period=all&type=all");
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ id: string }>;
    expect(items).toHaveLength(20);
    expect(r.body.nextCursor).toBeString();
    cursor1 = r.body.nextCursor as string;
    page1Ids = items.map((i) => i.id);
    expect(r.body.cursorReset).toBe(false);
  });

  test("C2 · page 2 → items DISTINCTS de la page 1 (aucun chevauchement)", async () => {
    expect(cursor1).toBeTruthy();
    const r = await queueGet("support", `?period=all&type=all&cursor=${encodeURIComponent(must(cursor1, "cursor"))}`);
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ id: string }>;
    expect(items.length).toBeGreaterThan(0);
    const overlap = items.filter((i) => page1Ids.includes(i.id));
    expect(overlap).toEqual([]);
  });

  test("C3 · cursor malformé → 400 (jamais de restart silencieux)", async () => {
    expect((await queueGet("support", "?cursor=pas-base64!!")).status).toBe(400);
    const fake = Buffer.from(JSON.stringify({ w: "x" }), "utf8").toString("base64url");
    expect((await queueGet("support", `?cursor=${fake}`)).status).toBe(400);
    const missing = Buffer.from(JSON.stringify({ w: 1, c: Date.now() }), "utf8").toString("base64url");
    expect((await queueGet("support", `?cursor=${missing}`)).status).toBe(400);
  });

  test("C4 · cursor expiré (cible fermée entre deux pages) → restart page 1 + cursorReset", async () => {
    expect(cursor1).toBeTruthy();
    // ferme la cible de l'ANCRE du curseur (dernier item de la page 1)
    const page1 = await queueGet("support", "?period=all&type=all");
    const items = page1.body.items as Array<{ id: string; targetId: string; weight: number }>;
    const anchor = items[19];
    const hide = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "hide", targetKind: "post", targetId: anchor.targetId, ...JUST },
    });
    expect(hide.status).toBe(200);
    // refetch page 2 avec le VIEUX curseur → l'ancre n'est plus ouverte
    const r = await queueGet("support", `?period=all&type=all&cursor=${encodeURIComponent(must(cursor1, "cursor"))}`);
    expect(r.status).toBe(200);
    expect(r.body.cursorReset).toBe(true);
    // sémantique : « restart page 1 » = IDENTIQUE à une requête fraîche sans
    // cursor (les reports de la cible fermée ont quitté la file ; un item de
    // l'ancienne page 2 peut légitimement remonter)
    const restarted = r.body.items as Array<{ id: string; targetId: string }>;
    const fresh = await queueGet("support", "?period=all&type=all");
    expect(restarted.map((i) => i.id)).toEqual((fresh.body.items as Array<{ id: string }>).map((i) => i.id));
    // et aucun item de la cible fermée ne réapparaît
    expect(restarted.every((i) => i.targetId !== anchor.targetId)).toBe(true);
  });
});

// ═══════════════════════════ D — filtres ═══════════════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · D — filtres période / type / statut", () => {
  test("D1 · période 24h exclut le report de 48h ; all le inclut", async () => {
    const recent = await queueGet("support", "?period=24h");
    const items = recent.body.items as Array<{ id: string }>;
    expect(items.some((i) => i.id === oldReportId)).toBe(false);
    const all = await queueGet("support", "?period=all");
    expect((all.body.items as Array<{ id: string }>).some((i) => i.id === oldReportId)).toBe(true);
  });

  test("D2 · période 7d inclut le report de 48h (fenêtre correcte)", async () => {
    const r = await queueGet("support", "?period=7d");
    expect((r.body.items as Array<{ id: string }>).some((i) => i.id === oldReportId)).toBe(true);
  });

  test("D3 · type=comment ne liste QUE les commentaires ; type=post les posts seuls", async () => {
    const comments = await queueGet("support", "?type=comment");
    const ci = comments.body.items as Array<{ id: string; targetKind: string }>;
    expect(ci.length).toBeGreaterThan(0);
    expect(ci.every((i) => i.targetKind === "comment")).toBe(true);
    expect(ci.some((i) => i.id === commentReportId)).toBe(true);
    const posts = await queueGet("support", "?type=post");
    const pi = posts.body.items as Array<{ id: string; targetKind: string }>;
    expect(pi.every((i) => i.targetKind === "post")).toBe(true);
    expect(pi.some((i) => i.id === commentReportId)).toBe(false);
  });

  test("D4 · status=open (handledById IS NULL) exclut les reports traités", async () => {
    // dismiss d'un report FILLER (cible dédiée pagination — jamais réutilisée
    // par les autres tests) puis vérification
    const all = await queueGet("support", "?period=all");
    const items = all.body.items as Array<{ id: string; targetId: string }>;
    const victim = items.find((i) => fillerPostIds.includes(i.targetId));
    expect(victim).toBeTruthy();
    const d = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("support"),
      body: { action: "dismiss", targetKind: "report", targetId: must(victim, "victim").id, ...JUST },
    });
    expect(d.status).toBe(200);
    const after = await queueGet("support", "?period=all");
    expect((after.body.items as Array<{ id: string }>).some((i) => i.id === victim?.id)).toBe(false);
    // vue status=all (tous les reports, traités inclus) : le report dismissé
    // a un poids 0 → il trie en FIN de vue (peut être au-delà de la page 1) —
    // l'état TRAITÉ est prouvé en DB (status=dismissed, handledById posé)
    const row = await db.report.findUnique({ where: { id: must(victim, "victim").id } });
    expect(row?.status).toBe("dismissed");
    expect(row?.handledById).toBeNumber();
  });
});

// ═══════════════════ E — actions + justification §6 ════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · E — actions (justification §6 obligatoire)", () => {
  test("E1 · justification < 20 chars → 422 (validation SERVEUR)", async () => {
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "hide", targetKind: "post", targetId: postLight, category: "SPAM", justification: "trop court" },
    });
    expect(r.status).toBe(422);
  });

  test("E2 · catégorie invalide → 422 · sans catégorie → 422", async () => {
    const bad = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "hide", targetKind: "post", targetId: postLight, category: "BOGUS", justification: "justification valide de vingt caractères" },
    });
    expect(bad.status).toBe(422);
    const none = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "hide", targetKind: "post", targetId: postLight, justification: "justification valide de vingt caractères" },
    });
    expect(none.status).toBe(422);
  });

  test("E3 · hide (moderator) → 200 + AdminAudit « SPAM: … » + report ne réapparaît pas", async () => {
    const before = await queueGet("support", "?period=all");
    const items = before.body.items as Array<{ id: string; targetId: string }>;
    const target = items.find((i) => i.targetId === postLight);
    expect(target).toBeTruthy();

    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "hide", targetKind: "post", targetId: postLight, category: "SPAM", justification: "harnais E3 — hide avec justification complète" },
    });
    expect(r.status).toBe(200);

    // audit écrit au format §6
    const audit = await db.adminAudit.findFirst({
      where: { action: "hide", targetType: "post", targetId: postLight },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.justification).toBe("SPAM: harnais E3 — hide avec justification complète");

    // le report ne réapparaît plus dans la file ouverte
    const after = await queueGet("support", "?period=all");
    expect((after.body.items as Array<{ id: string }>).some((i) => i.id === target?.id)).toBe(false);
  });

  test("E4 · dismiss (support) → 200 + status=dismissed · re-dismiss → 409", async () => {
    const all = await queueGet("support", "?period=all");
    const items = all.body.items as Array<{ id: string; targetId: string; weight: number }>;
    const victim = items.find((i) => i.targetId === postHeavy && i.weight === 3);
    expect(victim).toBeTruthy();

    const d = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("support"),
      body: { action: "dismiss", targetKind: "report", targetId: must(victim, "victim").id, category: "OTHER", justification: "harnais E4 — signalement non fondé, classé sans suite" },
    });
    expect(d.status).toBe(200);

    const row = await db.report.findUnique({ where: { id: must(victim, "victim").id } });
    expect(row?.status).toBe("dismissed");
    expect(row?.handledById).toBeNumber();

    // les DEUX autres reports du même post restent ouverts (poids 2)
    const after = await queueGet("support", "?period=all");
    const heavyAfter = (after.body.items as Array<{ targetId: string; weight: number }>).filter(
      (i) => i.targetId === postHeavy
    );
    expect(heavyAfter.every((i) => i.weight === 2)).toBe(true);

    // re-dismiss du même report → 409 (déjà traité)
    const again = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("support"),
      body: { action: "dismiss", targetKind: "report", targetId: must(victim, "victim").id, category: "OTHER", justification: "harnais E4 — re-dismiss d'un report déjà traité" },
    });
    expect(again.status).toBe(409);
  });

  test("E5 · dismiss × auditor → 403 (lecture seule stricte)", async () => {
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("auditor"),
      body: { action: "dismiss", targetKind: "report", targetId: "peu-importe", category: "OTHER", justification: "harnais E5 — l'auditor ne peut rien muter" },
    });
    expect(r.status).toBe(403);
  });
});

// ═══════════════ F — warn → UserWarning + preuve de possession ═════════════
describe.skipIf(!GUARD_OK)("ADM 6 · F — warn (notification profil, pas de DM)", () => {
  test("F1 · warn (support) → 200 + UserWarning en DB (catégorie + note)", async () => {
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("support"),
      body: { action: "warn", targetKind: "user", targetId: warnTargetPubkey, category: "HARASSMENT", justification: "harnais F1 — avertissement pour propos répétés" },
    });
    expect(r.status).toBe(200);
    const user = await db.user.findUnique({ where: { pubkey: warnTargetPubkey } });
    const w = await db.userWarning.findFirst({ where: { userId: must(user, "user").id } });
    expect(w?.category).toBe("HARASSMENT");
    expect(w?.note).toBe("harnais F1 — avertissement pour propos répétés");
    expect(w?.createdById).toBeNumber();
  });

  test("F2 · lecture SANS preuve → 401 (même pour une pubkey bien formée)", async () => {
    const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
    const res = await fetch(`${MAIN}/api/moderation/warnings?me=${encodeURIComponent(pubkey)}&ts=${Date.now()}`);
    expect(res.status).toBe(401);
  });

  test("F3 · lecture AVEC preuve valide → les avertissements du titulaire", async () => {
    const reader = await makeUserKeys("Warn Reader");
    const ts = Date.now();
    const signature = await sign(reader.signPriv, `${reader.pubkey}|warnings-read|${ts}`);
    const res = await fetch(
      `${MAIN}/api/moderation/warnings?me=${encodeURIComponent(reader.pubkey)}&ts=${ts}&signature=${encodeURIComponent(signature)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: unknown[] };
    expect(body.warnings).toEqual([]); // ce titulaire n'a aucun avertissement
  });

  test("F4 · signature d'une AUTRE clé (usurpation) → 401", async () => {
    const impostor = await makeUserKeys("Impostor");
    const ts = Date.now();
    // signe AVEC la clé de l'imposteur mais déclare me = warnTarget (autre identité)
    const signature = await sign(impostor.signPriv, `${warnTargetPubkey}|warnings-read|${ts}`);
    const res = await fetch(
      `${MAIN}/api/moderation/warnings?me=${encodeURIComponent(warnTargetPubkey)}&ts=${ts}&signature=${encodeURIComponent(signature)}`
    );
    expect(res.status).toBe(401);
  });
});

// ═══════════════ G — suspension temporaire (24h / 7j) ══════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · G — suspension temporaire et expiration paresseuse", () => {
  let suspPost = "";

  beforeAll(async () => {
    if (!GUARD_OK) return;
    const p = await db.post.create({
      data: { authorId: must(await db.user.findUnique({ where: { pubkey: suspTargetPubkey } }), "susan").id, content: "post de Susan avant suspension" },
    });
    suspPost = p.id;
  });

  test("G1 · suspend 24h → suspendedUntil ≈ now+24h · publication refusée 403 · feed exclut", async () => {
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "suspend", targetKind: "user", targetId: suspTargetPubkey, duration: "24h", category: "SPAM", justification: "harnais G1 — suspension temporaire 24 heures" },
    });
    expect(r.status).toBe(200);
    const affected = r.body.affected as { user: { suspendedUntil: string | null } };
    const until = new Date(must(affected.user.suspendedUntil, "suspendedUntil")).getTime();
    expect(until).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(until).toBeLessThan(Date.now() + 25 * 3600_000);

    // publication REFUSÉE pendant la suspension (post signé valide → la 403
    // vient bien de la suspension, pas d'une preuve invalide)
    expect(await postAs(must(susanKeys, "susanKeys"), "post pendant suspension")).toBe(403);

    // le fil exclut le contenu préexistant de l'auteur suspendu
    const feed = await (await fetch(`${MAIN}/api/posts?scope=global`)).json();
    expect((feed.posts as Array<{ id: string }>).some((p) => p.id === suspPost)).toBe(false);
  });

  test("G2 · suspend 7d → suspendedUntil ≈ now+7j · duration invalide → 400", async () => {
    const bad = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "suspend", targetKind: "user", targetId: suspTargetPubkey, duration: "72h", category: "SPAM", justification: "harnais G2 — durée hors enum refusée" },
    });
    expect(bad.status).toBe(400);
    // re-suspend 7d (l'utilisateur est déjà suspendu — la suspension est
    // réallouée, comportement mono-session conservé)
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "suspend", targetKind: "user", targetId: suspTargetPubkey, duration: "7d", category: "SPAM", justification: "harnais G2 — suspension temporaire 7 jours" },
    });
    expect(r.status).toBe(200);
    const affected = r.body.affected as { user: { suspendedUntil: string | null } };
    const until = new Date(must(affected.user.suspendedUntil, "suspendedUntil")).getTime();
    expect(until).toBeGreaterThan(Date.now() + 6.9 * 24 * 3600_000);
  });

  test("G3 · suspension EXPIRÉE (backdatée) → publication OK + post de retour au fil", async () => {
    // évaluation paresseuse : on backdate suspendedUntil dans le passé
    const susan = must(await db.user.findUnique({ where: { pubkey: suspTargetPubkey } }), "susan");
    await db.user.update({
      where: { id: susan.id },
      data: { suspendedUntil: new Date(Date.now() - 1000) },
    });
    // publication : acceptée à nouveau (preuve ECDSA valide → la 200 vient
    // bien de l'expiration paresseuse, pas d'un contournement)
    expect(await postAs(must(susanKeys, "susanKeys"), "post après expiration")).toBe(200);
    // et le post préexistant de l'auteur réapparaît au fil
    const feed = await (await fetch(`${MAIN}/api/posts?scope=global`)).json();
    expect((feed.posts as Array<{ id: string }>).some((p) => p.id === suspPost)).toBe(true);
    // et la DB n'a PAS été réécrite (lazy — pas de cron)
    const still = await db.user.findUnique({ where: { id: susan.id } });
    expect(still?.suspendedAt).not.toBeNull();
  });

  test("G4 · unsuspend → suspendedAt/until/by cleared", async () => {
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("moderator"),
      body: { action: "unsuspend", targetKind: "user", targetId: suspTargetPubkey, category: "OTHER", justification: "harnais G4 — levée de suspension après vérification" },
    });
    expect(r.status).toBe(200);
    const susan = await db.user.findUnique({ where: { pubkey: suspTargetPubkey } });
    expect(susan?.suspendedAt).toBeNull();
    expect(susan?.suspendedUntil).toBeNull();
    expect(susan?.suspendedById).toBeNull();
  });
});

// ═══════════════ H — four-eyes (Étape 9) refusé ════════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · H — four-eyes ban/purge : hors surface (Étape 9)", () => {
  test("H1 · action ban → 400 (hors MODERATION_ACTIONS — four-eyes arrive en Étape 9)", async () => {
    const r = await mainFetch("POST", "/api/moderation/action", {
      session: await sessionFor("super-admin"),
      body: { action: "ban", targetKind: "user", targetId: bobPubkey, category: "SCAM", justification: "harnais H1 — tentative de ban direct refusée" },
    });
    expect(r.status).toBe(400);
    const h = await db.user.findUnique({ where: { pubkey: bobPubkey } });
    expect(h).toBeTruthy();
  });
});

// ═══════════════ I — anti-fuite payload ════════════════════════════════════
describe.skipIf(!GUARD_OK)("ADM 6 · I — anti-fuite (payload queue)", () => {
  test("I1 · aucun email / IP / password / mot de passe dans le payload", async () => {
    const r = await queueGet("support", "?period=all&status=all");
    const s = JSON.stringify(r.body);
    expect(s).not.toContain("@e2e.test");
    expect(s).not.toContain("password");
    expect(s).not.toContain('"ip"');
    // pubkeys opératoires présentes (documenté — identités publiques du mesh)
    expect(s).toContain("e2e-q-bob");
  });
});


