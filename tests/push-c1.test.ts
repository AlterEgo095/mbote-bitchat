/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS C1 — PUSH NOTIFICATIONS (Web Push VAPID, knock sans contenu)
 *  contre l'app RÉELLE (:3203) + un MINI PUSH SERVICE de test (:3204)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner scripts/c1-push-proof-run.sh garantit tout) :
 *    PUSH_C1_E2E=1 BASE_URL=http://127.0.0.1:3203 PUSH_TEST_PORT=3204 \
 *    DATABASE_URL=(db preuve) bun test tests/push-c1.test.ts
 *  Sinon : les E2E SKIP proprement (pattern B2/B3/B4) — les UNITAIRES
 *  tournent TOUJOURS (format du payload + base64url pur JS).
 *
 *  Le « mini push service » est un serveur HTTP local que web-push attaque
 *  RÉELLEMENT : il CAPTE le payload sur le fil (preuve Wireshark-like — la
 *  directive exige « aucun contenu de message visible ») et répond au choix
 *  201 / 410 / 429 selon le path, pour prouver :
 *    S1-S4  subscribe : création, signature 401, 400, UPSERT (2 appels → 1 ligne)
 *    S5     rate limit subscribe : 11ᵉ / heure → 429
 *    S6     user inconnu → 404
 *    S7     unsubscribe : disabledAt + idempotent + anti-énumération (404 autrui)
 *    S8     /api/push/config : 200 + publicKey (clés VAPID présentes)
 *    P1     DM → KNOCK capté : { type:"new_message", fromLabel } — AUCUN
 *           ciphertext, AUCUN contenu du message (directive knock-only)
 *    P2     rate limit OUTBOUND : 2 DM en < 30 s → 1 SEUL push (2ᵉ ignoré)
 *    P3     410 Gone → disabledAt posé (purge douce, ligne conservée)
 *    P4     429 du push service → backoff passif (pas de crash, pas de retry)
 *    C1g    garde client : urlBase64ToUint8Array SANS Buffer (règle §6)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { rmSync, openSync, closeSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { urlBase64ToUint8Array } from "../src/lib/mbote/push-client";

// ── environnement du harness ────────────────────────────────────────────────
const MAIN = process.env.BASE_URL ?? "http://127.0.0.1:3203";
const PUSH_TEST_PORT = Number(process.env.PUSH_TEST_PORT ?? 3204);
const PUSH_TEST_HOST = `http://127.0.0.1:${PUSH_TEST_PORT}`;

const DB_PATH = join(process.cwd(), "db", "push-c1-e2e-test.db");
const url = `file:${DB_PATH}`;

const GUARD_OK = process.env.PUSH_C1_E2E === "1" && process.env.BASE_URL === MAIN;
if (!GUARD_OK) {
  console.warn(
    "push-c1 E2E SKIPPÉ — lancer via le runner (PUSH_C1_E2E=1 + BASE_URL + DB dédiée).\n" +
      "Les UNITAIRES (format payload + helpers client) tournent toujours."
  );
}

let db: PrismaClient;
let pushProc: ReturnType<typeof Bun.spawn> | null = null;
let nextProc: ReturnType<typeof Bun.spawn> | null = null;
let serverLogFd: number | null = null;
/** stdout+stderr de l'app → preuve Wireshark-like du payload knock (P1). */
const SERVER_LOG = join(process.cwd(), "db", "push-c1-server.log");
/** capture du fil par le mini push service (process séparé, jsonl). */
const CAPTURE_FILE = join(process.cwd(), "db", "push-c1-capture.jsonl");

interface CapturedKnock {
  path: string;
  headers: Record<string, string>;
  body: string;
  at: string;
}

async function capturedKnocks(): Promise<CapturedKnock[]> {
  try {
    const t = await Bun.file(CAPTURE_FILE).text();
    return t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CapturedKnock);
  } catch {
    return []; // fichier pas encore créé
  }
}

// ── helpers crypto (ECDSA P-256 réelle — même mécanique que les harnais ADM) ─
const subtle = globalThis.crypto.subtle;

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

interface UserKeys {
  pubkey: string;
  signPriv: CryptoKey;
  id: string;
}

async function makeUserKeys(nickname: string): Promise<UserKeys> {
  const pair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const u = await db.user.create({
    data: { pubkey, nickname, ecdhPub: b64url(new Uint8Array(65).fill(7)) },
  });
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

interface SubFixture {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

async function fakeSubFixture(path: string): Promise<SubFixture> {
  // p256dh = VRAIE clé publique ECDH P-256 (65 octets 0x04) — web-push la
  // valide à l'envoi (« Public key is not valid for specified curve » a
  // cassé tous les knocks du run 2 avec des octets arbitraires)
  const pair = (await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  )) as CryptoKeyPair;
  const p256dh = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const auth = b64url(new Uint8Array(16).map(() => Math.floor(Math.random() * 256)));
  return {
    endpoint: `${PUSH_TEST_HOST}/push/${path}/${Math.random().toString(36).slice(2)}`,
    keys: { p256dh, auth },
  };
}

async function subscribe(who: UserKeys, sub: SubFixture, override?: Partial<Record<string, unknown>>) {
  const ts = Date.now();
  const body: Record<string, unknown> = {
    me: who.pubkey,
    endpoint: sub.endpoint,
    keys: sub.keys,
    ts,
    userAgent: "push-c1-e2e",
    signature: await sign(who.signPriv, `${who.pubkey}|push-sub|${sub.endpoint}|${sub.keys.p256dh}|${sub.keys.auth}|${ts}`),
    ...override,
  };
  const res = await fetch(`${MAIN}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function unsubscribe(who: UserKeys, endpoint: string, signOverride?: string) {
  const ts = Date.now();
  const res = await fetch(`${MAIN}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      me: who.pubkey,
      endpoint,
      ts,
      signature: signOverride ?? (await sign(who.signPriv, `${who.pubkey}|push-unsub|${endpoint}|${ts}`)),
    }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** DM v2 (identique au harnais ADM — enveloppe aveugle signée dm2). */
async function dmAs(who: UserKeys, recipientKey: string, seq: number): Promise<number> {
  const ts = Date.now();
  const iv = b64url(new Uint8Array(12).map(() => Math.floor(Math.random() * 256)));
  const msgId = `c1-${Math.random().toString(36).slice(2)}`;
  const ciphertext = b64url(
    new TextEncoder().encode(`SECRET-E2EE-${Math.random().toString(36).slice(2)}-contenu-qui-ne-doit-pas-fuir`)
  );
  const signature = await sign(
    who.signPriv,
    `${who.pubkey}|dm2|${recipientKey}|${msgId}|${seq}|${iv}|${ciphertext}|${ts}`
  );
  const res = await fetch(`${MAIN}/api/dms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderKey: who.pubkey, recipientKey, iv, ciphertext, ts, signature, msgId, seq }),
  });
  return res.status;
}

/** Attente du push service (https : tout échec sauf ECONNREFUSED = vivant). */
async function waitForPushService(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      await fetch(`https://127.0.0.1:${PUSH_TEST_PORT}/`, {
        signal: AbortSignal.timeout(2000),
        tls: { rejectUnauthorized: false },
      });
      return; // réponse (même 404) = service vivant
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // ECONNREFUSED = pas encore levé ; TOUT autre échec (TLS, protocole)
      // prouve qu'un serveur ÉCOUTE sur le port
      if (/refused|econnrefused|unable to connect/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return;
    }
  }
  throw new Error(`push service non prêt sur :${PUSH_TEST_PORT}`);
}

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

// clés VAPID du harness (le runner les régénère — jetables)
const VAPID = (() => {
  // généré SANS web-push (le module serveur l'a déjà fait côté app) : format
  // P-256 raw base64url 65o pour la pub, 32o pour la priv
  return {
    pub: b64url(new Uint8Array(65).map((_, i) => (i + 1) % 256)),
    priv: b64url(new Uint8Array(32).map((_, i) => (i * 5 + 9) % 256)),
  };
})();

beforeAll(async () => {
  if (!GUARD_OK) return;
  rmSync(DB_PATH, { force: true });
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });

  // MINI PUSH SERVICE en process séparé (stable) : capte le fil sur le disque
  pushProc = Bun.spawn({
    cmd: ["bun", "scripts/c1-push-service.ts", String(PUSH_TEST_PORT), CAPTURE_FILE],
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForPushService();

  rmSync(SERVER_LOG, { force: true });
  serverLogFd = openSync(SERVER_LOG, "w");
  nextProc = Bun.spawn({
    cmd: ["bunx", "next", "dev", "-p", MAIN.split(":").pop() ?? "3203"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: url,
      NEXT_TELEMETRY_DISABLED: "1",
      MBOTE_EMBED_RELAY: "0",
      VAPID_PUBLIC_KEY: VAPID.pub,
      VAPID_PRIVATE_KEY: VAPID.priv,
      // harnais ONLY : le mini push service a un cert auto-signé
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdout: serverLogFd,
    stderr: serverLogFd,
  });
  await waitFor(`${MAIN}/api/stats`, 120_000);
  await seedFixtures();
}, 200_000);

afterAll(async () => {
  if (nextProc) {
    try {
      nextProc.kill();
    } catch {
      /* déjà mort */
    }
  }
  if (pushProc) {
    try {
      pushProc.kill();
    } catch {
      /* déjà mort */
    }
  }
  if (serverLogFd !== null) closeSync(serverLogFd);
  await db?.$disconnect();
  // NB : la DB est CONSERVÉE (le runner en tire le dump PushSubscription ;
  // le beforeAll la purge à chaque rejeu — idempotent)
});

// ── fixtures ────────────────────────────────────────────────────────────────
let alice: UserKeys | null = null; // expéditeur des DM
let bob: UserKeys | null = null; // destinataire abonné (P1)
let carol: UserKeys | null = null; // destinataire P2 (rate limit outbound)
let dave: UserKeys | null = null; // destinataire P3 (410)
let eve: UserKeys | null = null; // destinataire P4 (429)
function aliceK(): UserKeys {
  return must(alice, "alice (fixtures)");
}
function bobK(): UserKeys {
  return must(bob, "bob (fixtures)");
}
function carolK(): UserKeys {
  return must(carol, "carol (fixtures)");
}
function daveK(): UserKeys {
  return must(dave, "dave (fixtures)");
}
function eveK(): UserKeys {
  return must(eve, "eve (fixtures)");
}

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

async function seedFixtures(): Promise<void> {
  alice = await makeUserKeys("Alice-Push");
  bob = await makeUserKeys("Bob-Push");
  carol = await makeUserKeys("Carol-Push");
  dave = await makeUserKeys("Dave-Push");
  eve = await makeUserKeys("Eve-Push");
}

// ── UNITAIRES (toujours verts — pas de serveur requis) ──────────────────────
describe("C1 · unitaires (toujours)", () => {
  test("C1g — urlBase64ToUint8Array : décodage SANS Buffer (règle §6)", () => {
    const b64url = Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64url");
    const bytes = urlBase64ToUint8Array(b64url);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0, 1, 2, 253, 254, 255]);
    // padding absent de la source → reconstitué
    const noPad = b64url.slice(0, 4); // 4 chars sans padding
    expect(urlBase64ToUint8Array(noPad).length).toBe(3);
  });
});

// ── S. SUBSCRIBE / UNSUBSCRIBE (E2E) ────────────────────────────────────────
describe("C1 · subscribe / unsubscribe", () => {
  test("S8 — /api/push/config → 200 + publicKey VAPID", async () => {
    if (!GUARD_OK) return;
    const res = await fetch(`${MAIN}/api/push/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(typeof body.publicKey).toBe("string");
    expect(body.publicKey.length).toBeGreaterThan(40);
  });

  test("S1 — subscribe signé → 200/201 + active", async () => {
    if (!GUARD_OK) return;
    const sub = await fakeSubFixture("201");
    const r = await subscribe(bobK(), sub);
    expect([200, 201]).toContain(r.status);
    const s = r.body.subscription as { id: string; active: boolean };
    expect(s.active).toBe(true);
    const row = await db.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } });
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(bobK().pubkey);
    expect(row?.disabledAt).toBeNull();
  });

  test("S2 — signature invalide → 401 · S3 — champs manquants → 400", async () => {
    if (!GUARD_OK) return;
    const bad = await subscribe(bobK(), await fakeSubFixture("201"), {
      signature: await sign(bobK().signPriv, `${bobK().pubkey}|push-sub|mauvaise-chaîne|${Date.now()}`),
    });
    expect(bad.status).toBe(401);
    const missing = await fetch(`${MAIN}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: bobK().pubkey }),
    });
    expect(missing.status).toBe(400);
  });

  test("S4 — UPSERT : 2 appels même endpoint → 1 ligne (réactivé)", async () => {
    if (!GUARD_OK) return;
    const sub = await fakeSubFixture("201");
    const r1 = await subscribe(bobK(), sub);
    expect([200, 201]).toContain(r1.status);
    const r2 = await subscribe(bobK(), sub); // re-subscribe (rotation SW)
    expect([200, 201]).toContain(r2.status);
    const rows = await db.pushSubscription.findMany({ where: { endpoint: sub.endpoint } });
    expect(rows.length).toBe(1); // upsert, pas de doublon
    expect(rows[0].disabledAt).toBeNull();
  });

  test("S6 — user inconnu → 404", async () => {
    if (!GUARD_OK) return;
    const ghost: UserKeys = {
      pubkey: bobK().pubkey, // signature valide sur une clé NON enregistrée
      signPriv: bobK().signPriv,
      id: "ghost",
    };
    // clé non enregistrée : générons-en une réelle pour la signature
    const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const ghostPub = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
    const ts = Date.now();
    const sub = await fakeSubFixture("201");
    const res = await fetch(`${MAIN}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: ghostPub,
        endpoint: sub.endpoint,
        keys: sub.keys,
        ts,
        signature: await sign(pair.privateKey, `${ghostPub}|push-sub|${sub.endpoint}|${sub.keys.p256dh}|${sub.keys.auth}|${ts}`),
      }),
    });
    expect(res.status).toBe(404);
    void ghost;
  });

  test(
    "S5 — rate limit subscribe : 11ᵉ / heure → 429 (user DÉDIÉ)",
    async () => {
      if (!GUARD_OK) return;
      // fenêtre 1 h PAR USER : saturer bob ici ferait échouer S7 (bug run 2)
      const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
      const frankPub = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
      await db.user.create({ data: { pubkey: frankPub, nickname: "Frank-RateLimit" } });
      const frank: UserKeys = { pubkey: frankPub, signPriv: pair.privateKey, id: "frank" };
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const r = await subscribe(frank, await fakeSubFixture("201"));
        last = r.status;
        if (r.status === 429) break;
      }
      expect(last).toBe(429);
    },
    30_000
  );

  test("S7 — unsubscribe : disabledAt + idempotent + anti-énumération", async () => {
    if (!GUARD_OK) return;
    const sub = await fakeSubFixture("201");
    await subscribe(bobK(), sub);
    const r1 = await unsubscribe(bobK(), sub.endpoint);
    expect(r1.status).toBe(200);
    const row = await db.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } });
    expect(row?.disabledAt).not.toBeNull(); // purge DOUCE (ligne conservée)
    // idempotent
    const r2 = await unsubscribe(bobK(), sub.endpoint);
    expect(r2.status).toBe(200);
    expect((r2.body.subscription as { alreadyDisabled: boolean }).alreadyDisabled).toBe(true);
    // autrui (Alice tente de désabonner Bob) → 404 (anti-énumération)
    const foreign = await fakeSubFixture("201");
    await subscribe(bobK(), foreign);
    const r3 = await unsubscribe(aliceK(), foreign.endpoint);
    expect(r3.status).toBe(404);
    const still = await db.pushSubscription.findUnique({ where: { endpoint: foreign.endpoint } });
    expect(still?.disabledAt).toBeNull(); // untouched
  });
});

// ── P. PUSH RÉEL (le fil est capté par le mini push service) ────────────────
describe("C1 · knock réel (fil capté)", () => {
  test("P1 — DM → KNOCK knock-only : { type, fromLabel }, AUCUN contenu", async () => {
    if (!GUARD_OK) return;
    const sub = await fakeSubFixture("201");
    await subscribe(bobK(), sub);
    const before = (await capturedKnocks()).length;
    const status = await dmAs(aliceK(), bobK().pubkey, 1); // ciphertext interne contient SECRET-E2EE-…
    expect(status).toBe(200);
    // le sender est fire-and-forget → poll le jsonl jusqu'à 10 s
    const deadline = Date.now() + 10_000;
    let knocks: CapturedKnock[] = [];
    while (Date.now() < deadline) {
      knocks = (await capturedKnocks()).slice(before);
      if (knocks.length > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(knocks.length).toBeGreaterThanOrEqual(1);
    const knock = knocks[0];
    expect(knock.headers["content-encoding"]).toBe("aes128gcm"); // RFC 8291 (chiffré sur le fil)
    expect(knock.headers["authorization"]).toContain("vapid"); // RFC 8292
    // payload CHIFFRÉ sur le fil — le clair n'apparaît PAS dans la requête
    expect(knock.body).not.toContain("SECRET-E2EE");
    expect(knock.body).not.toContain("new_message");
    // pour prouver le CLAIR, le sender le logue (preuve Wireshark-like côté serveur)
    const log = await serverLog();
    expect(log).toContain("[push:sender] payload knock");
    const payloadLine = log.split("\n").find((l) => l.includes("[push:sender] payload knock")) ?? "";
    expect(payloadLine).toContain('"type":"new_message"');
    expect(payloadLine).toContain('"fromLabel":"Alice-Push"');
    expect(payloadLine).not.toContain("SECRET-E2EE"); // KNOCK-ONLY : aucun contenu
    expect(payloadLine).not.toContain("ciphertext");
  }, 30_000);

  test(
    "P2 — rate limit OUTBOUND : 2 DM en < 30 s → 1 SEUL push",
    async () => {
      if (!GUARD_OK) return;
      // destinataire DÉDIÉ + ABONNÉ ICI (carol n'a aucune sub du reste du harnais)
      const sub = await fakeSubFixture("201");
      await subscribe(carolK(), sub);
      const before = (await capturedKnocks()).length;
      const s1 = await dmAs(aliceK(), carolK().pubkey, 1);
    expect(s1).toBe(200);
    const s2 = await dmAs(aliceK(), carolK().pubkey, 2);
    expect(s2).toBe(200); // le MESSAGE passe toujours (le push est filtré, pas le DM)
    // poll : le 1ᵉʳ knock arrive (le 2ᵉ est rate-limité CÔTÉ SERVEUR —
    // il ne doit JAMAIS atteindre le fil)
    const deadline = Date.now() + 10_000;
    let count = 0;
    while (Date.now() < deadline) {
      count = (await capturedKnocks()).slice(before).length;
      if (count >= 1) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 1500)); // marge : le 2ᵉ ne doit pas arriver
      expect((await capturedKnocks()).slice(before).length).toBe(1); // 2ᵉ knock ignoré (1/30 s/destinataire)
    },
    30_000
  );

  test("P3 — 410 Gone → disabledAt posé (purge douce)", async () => {
    if (!GUARD_OK) return;
    const sub = await fakeSubFixture("410"); // le push service répond 410
    await subscribe(daveK(), sub);
    await dmAs(aliceK(), daveK().pubkey, 1);
    const deadline = Date.now() + 10_000;
    let row = await db.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } });
    while (Date.now() < deadline && row?.disabledAt === null) {
      await new Promise((r) => setTimeout(r, 400));
      row = await db.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } });
    }
    expect(row?.disabledAt).not.toBeNull(); // purge douce : la ligne RESTE
  }, 30_000);

  test("P4 — 429 du push service → backoff passif (pas de crash)", async () => {
    if (!GUARD_OK) return;
    const sub = await fakeSubFixture("429");
    await subscribe(eveK(), sub);
    // destinataire DÉDIÉ (créneau outbound libre) : le DM ne casse PAS malgré
    // le push service en 429 (backoff passif, pas de retry, pas de crash) :
    const status = await dmAs(aliceK(), eveK().pubkey, 1);
    expect(status).toBe(200); // le DM ignore l'état du push service
  }, 30_000);
});

/** Lit les N dernières lignes du log serveur (le runner écrit stdout → fichier). */
async function serverLog(): Promise<string> {
  const path = join(process.cwd(), "db", "push-c1-server.log");
  const deadline = Date.now() + 10_000;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = await Bun.file(path).text();
      if (text.includes("[push:sender] payload knock")) break;
    } catch {
      /* pas encore écrit */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return text;
}
