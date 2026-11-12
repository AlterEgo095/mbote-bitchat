/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D2 — SYBIL PHASE 0 : tests adversariaux (PoW + réputation + plafonds)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (lancée par le runner avec le serveur RÉEL en route) :
 *    APP_URL=http://127.0.0.1:3165 DATABASE_URL=file:db/d2-sybil-proof.db \
 *      bun test tests/d2-sybil.test.ts
 *  Sans APP_URL : SKIPPED (CI tests.yml — pas de serveur de preuve).
 *
 *  Scénarios (directive D2) :
 *   P1  création valide (PoW correct) → acceptée, quota exposé
 *   P2  création SANS nonce → 403 pow_required
 *   P3  création nonce invalide → 403 (difficulté non atteinte)
 *   P4  nonce REJOUÉ → 409 pow_replayed (anti-rejeu global PowSpent)
 *   Q1  score 0 : 10 posts OK, 11ᵉ → 429 quota_posts + message directive
 *   Q2  score −5 : plafond 3/j → 4ᵉ refusé ; GET identity → limit 3
 *   Q3  score 15 : GET identity → limit 50 posts / 200 DMs, tier established
 *   Q4  DMs score −5 : 10 OK, 11ᵉ → 429 quota_dms
 *   R1  rate-limit créations : 4ᵉ identité/1h/IP → 429 + Retry-After ≥ 3600
 *   M1  T0 mesh : une clé JAMAIS onboardée publie via la passerelle mesh
 *       sans PoW ni plafond (contrainte RDC non négociable)
 *   F1  fonctions pures : matrice dailyLimits complète, reset du jour UTC,
 *       hashMeetsDifficultyHex (cas limites), reputationTier
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  cfSpoofHeaders,
  solvePow,
} from "./pow-harness";
import {
  dailyLimits,
  DMS_LIMIT_MESSAGE,
  hashMeetsDifficultyHex,
  POSTS_LIMIT_MESSAGE,
  POW_DIFFICULTY_BITS,
  powChallengeMessage,
  quotaVerdict,
  reputationTier,
  secondsUntilUtcMidnight,
  utcDay,
} from "../src/lib/mbote/sybil";
import {
  PROTOCOL_VERSION,
  PKT_PUBLIC,
  TTL_MAX,
  PAYLOAD_MAX_BYTES,
  bytesToBase64,
  encodePacket,
  fragmentPayload,
  fnv64,
  senderIdFromPubkey,
  utf8Encode,
} from "../src/lib/mbote/bitchat-protocol.ts";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3165";
const d = process.env.APP_URL ? describe : describe.skip;

const subtle = globalThis.crypto.subtle;
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const prisma = new PrismaClient();

interface Keys {
  pub: string;
  priv: CryptoKey;
}
async function newKeys(): Promise<Keys> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pub: b64url(pubRaw), priv: pair.privateKey };
}
async function sign(priv: CryptoKey, msg: string): Promise<string> {
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    priv,
    new TextEncoder().encode(msg)
  );
  return b64url(new Uint8Array(sig));
}

async function createIdentity(
  keys: Keys,
  nickname: string,
  opts?: { powNonce?: string; ip?: string }
): Promise<Response> {
  const ts = Date.now();
  const signature = await sign(keys.priv, `${keys.pub}|identity|${nickname}|||${ts}`);
  const pow = opts?.powNonce !== undefined ? { nonce: opts.powNonce } : solvePow(keys.pub, ts);
  return fetch(`${APP_URL}/api/identity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...cfSpoofHeaders("d2t", opts?.ip), // IP fixe si fournie (test rate-limit), sinon unique
    },
    body: JSON.stringify({ pubkey: keys.pub, nickname, bio: "", ts, signature, pow }),
  });
}

async function createPost(
  keys: Keys,
  content: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ts = Date.now();
  const signature = await sign(keys.priv, `${keys.pub}|${content}|${ts}`);
  const r = await fetch(`${APP_URL}/api/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: keys.pub, content, signature, ts }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

let dmSeq = 0; // dm2 : séquence monotone par conversation (A1) — jamais 0 deux fois
async function sendDm(
  keys: Keys,
  recipient: string,
  msgId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ts = Date.now();
  const iv = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const ciphertext = Buffer.from(`secret-${msgId}`).toString("base64");
  const seq = dmSeq;
  dmSeq += 1;
  const signature = await sign(
    keys.priv,
    `${keys.pub}|dm2|${recipient}|${msgId}|${seq}|${iv}|${ciphertext}|${ts}`
  );
  const r = await fetch(`${APP_URL}/api/dms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      senderKey: keys.pub,
      recipientKey: recipient,
      iv,
      ciphertext,
      ts,
      signature,
      msgId,
      seq,
    }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

let a: Keys; // compte principal (tests PoW + plafonds)
let r: Keys; // destinataire DMs

beforeAll(async () => {
  a = await newKeys();
  r = await newKeys();
});

d("D2 — PoW de création (serveur réel)", () => {
  test("P1 — création valide acceptée : 200, user créé, quota exposé", async () => {
    const res = await createIdentity(a, "D2-Pow-Valide");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { user?: { pubkey: string; quota?: { reputationScore: number; posts: { limit: number } } } };
    expect(j.user?.pubkey).toBe(a.pub);
    // nouveau compte : score 0 → plafond 10 posts/j
    expect(j.user?.quota?.reputationScore).toBe(0);
    expect(j.user?.quota?.posts.limit).toBe(10);
  });

  test("P2 — création sans nonce → 403 pow_required", async () => {
    const k = await newKeys();
    const ts = Date.now();
    const signature = await sign(k.priv, `${k.pub}|identity|D2-Sans-Pow|||${ts}`);
    const res = await fetch(`${APP_URL}/api/identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cfSpoofHeaders("d2np") },
      body: JSON.stringify({ pubkey: k.pub, nickname: "D2-Sans-Pow", ts, signature }),
    });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { code?: string };
    expect(j.code).toBe("pow_required");
  });

  test("P3 — nonce invalide (difficulté non atteinte) → 403", async () => {
    const k = await newKeys();
    const res = await createIdentity(k, "D2-Pow-Faible", { powNonce: "1" });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { code?: string; error?: string };
    expect(j.code).toBe("pow_required");
    expect(j.error).toContain("Preuve de travail refusée");
    // le compte n'existe pas (création refusée)
    const row = await prisma.user.findUnique({ where: { pubkey: k.pub } });
    expect(row).toBeNull();
  });

  test("P4 — nonce REJOUÉ (rejeu exact de la création de A) → 409 pow_replayed", async () => {
    // reconstruit le payload EXACT de P1 : même ts ? Impossible — on rejoue
    // le challenge tel quel avec un NOUVEAU payload signé sur le même ts que
    // la création : le serveur doit reconnaître le challenge déjà consommé.
    // Pour garantir le même ts, on lit le challenge stocké sur A.
    const row = await prisma.user.findUnique({ where: { pubkey: a.pub }, select: { powChallenge: true } });
    expect(row?.powChallenge).toBeTruthy();
    const challenge = row?.powChallenge ?? "";
    const ts = Number(challenge.split("|")[2]);
    const nonce = solvePow(a.pub, ts).nonce;
    const nickname = "D2-Pow-Valide";
    const signature = await sign(a.priv, `${a.pub}|identity|${nickname}|||${ts}`);
    const res = await fetch(`${APP_URL}/api/identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cfSpoofHeaders("d2rp") },
      body: JSON.stringify({ pubkey: a.pub, nickname, ts, signature, pow: { nonce } }),
    });
    expect(res.status).toBe(409);
    const j = (await res.json()) as { code?: string };
    expect(j.code).toBe("pow_replayed");
  });
});

d("D2 — réputation et plafonds (serveur réel + DB directe)", () => {
  test("Q2 — score −5 (report confirmé simulé) : plafond 3/j → 4ᵉ refusé", async () => {
    await prisma.user.update({ where: { pubkey: a.pub }, data: { reputationScore: -5 } });
    const me = await fetch(`${APP_URL}/api/identity?pubkey=${encodeURIComponent(a.pub)}`);
    const j = (await me.json()) as { user?: { quota?: { reputationScore: number; posts: { limit: number }; tier: string } } };
    expect(j.user?.quota?.posts.limit).toBe(3);
    expect(j.user?.quota?.tier).toBe("negative");
    // 4 publications seulement (3 OK + 1 refusée) — sous la fenêtre de
    // rate-limit posts 12/min/clé : le message reçu est bien le PLAFOND D2,
    // pas le rate-limit minute.
    for (let i = 0; i < 3; i++) {
      const { status } = await createPost(a, `Post score négatif #${i} — plafond réduit.`);
      expect(status).toBe(200);
    }
    const { status, body } = await createPost(a, "Post 4 score négatif — refusé.");
    expect(status).toBe(429);
    expect(body.error).toBe(POSTS_LIMIT_MESSAGE);
    expect(body.limit).toBe(3);
  }, 90000);

  test("Q1 — score 0 : 10 posts OK, 11ᵉ → 429 quota_posts + message directive", async () => {
    // second compte dédié (Q2 a déjà consommé 4 créneaux du rate-limit
    // posts 12/min/clé de `a` — un compte neuf reste sous la fenêtre minute)
    const a2 = await newKeys();
    const resA2 = await createIdentity(a2, "D2-Quota-Neuf");
    expect(resA2.status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const { status } = await createPost(a2, `Post quota #${i} — participation normale.`);
      expect(status).toBe(200);
    }
    const { status, body } = await createPost(a2, "Post 11 — au-delà du plafond score 0.");
    expect(status).toBe(429);
    expect(body.error).toBe(POSTS_LIMIT_MESSAGE);
    expect(body.code).toBe("quota_posts");
    expect(body.limit).toBe(10);
    expect(body.used).toBe(10);
  }, 90000);

  test("Q3 — score 15 : plafonds 50 posts / 200 DMs, tier established", async () => {
    await prisma.user.update({
      where: { pubkey: a.pub },
      data: { reputationScore: 15, postsToday: 0, dmsToday: 0, usageDay: utcDay(new Date()) },
    });
    const me = await fetch(`${APP_URL}/api/identity?pubkey=${encodeURIComponent(a.pub)}`);
    const j = (await me.json()) as { user?: { quota?: { reputationScore: number; posts: { limit: number }; dms: { limit: number | null }; tier: string } } };
    expect(j.user?.quota?.posts.limit).toBe(50);
    expect(j.user?.quota?.dms.limit).toBe(200);
    expect(j.user?.quota?.tier).toBe("established");
  });

  test("Q4 — DMs score −5 : 10 OK, 11ᵉ → 429 quota_dms", async () => {
    // destinataire réel (créé dans beforeAll via le test R1 plus bas ? non —
    // créé ici même : la création passe (IP forgée distincte))
    const resR = await createIdentity(r, "D2-Destinataire");
    expect(resR.status).toBe(200);
    await prisma.user.update({
      where: { pubkey: a.pub },
      data: { reputationScore: -5, dmsToday: 0, postsToday: 0, usageDay: utcDay(new Date()) },
    });
    for (let i = 0; i < 10; i++) {
      const { status } = await sendDm(a, r.pub, `d2-dm-${Date.now()}-${i}`);
      expect(status).toBe(200);
    }
    const { status, body } = await sendDm(a, r.pub, `d2-dm-${Date.now()}-11`);
    expect(status).toBe(429);
    expect(body.error).toBe(DMS_LIMIT_MESSAGE);
    expect(body.code).toBe("quota_dms");
    expect(body.limit).toBe(10);
  }, 90000);
});

d("D2 — rate-limit durci et T0 mesh", () => {
  test("R1 — 4ᵉ création de compte sur la même heure/IP → 429 + Retry-After ≥ 3600", async () => {
    // créations sur UNE IP dédiée : B(1), B2(2), B3(3) → 4ᵉ → 429
    const ip = `d2rl-${Date.now()}`;
    const b1 = await newKeys();
    const b2 = await newKeys();
    const b3 = await newKeys();
    const b4 = await newKeys();
    const r1 = await createIdentity(b1, "D2-RL-1", { ip });
    expect(r1.status).toBe(200);
    const r2 = await createIdentity(b2, "D2-RL-2", { ip });
    expect(r2.status).toBe(200);
    const r3 = await createIdentity(b3, "D2-RL-3", { ip });
    expect(r3.status).toBe(200);
    const r4 = await createIdentity(b4, "D2-RL-4", { ip });
    expect(r4.status).toBe(429);
    const j = (await r4.json()) as { code?: string };
    expect(j.code).toBe("identity_create_rate_limited");
    const retry = r4.headers.get("Retry-After");
    expect(retry).toBeTruthy();
    expect(Number(retry)).toBeGreaterThanOrEqual(3590);
  });

  test("M1 — T0 mesh : clé jamais onboardée publie via la passerelle sans PoW ni plafond", async () => {
    // identité mesh-only : JAMAIS passée par POST /api/identity
    const m = await newKeys();
    const ts = Date.now();
    const content = `Mbote mesh-only D2 — publié sans PoW ni plafond (${ts}).`;
    const signature = await sign(m.priv, `${m.pub}|${content}|${ts}`);
    const ev = {
      kind: "post",
      clientRef: `d2-mesh-${ts}`,
      pubkey: m.pub,
      nickname: "Mesh-Only-D2",
      ecdhPub: b64url(new Uint8Array(65).fill(7)),
      content,
      geohash: "kdx0v",
      precision: 5,
      signature,
      ts,
    };
    const payload = utf8Encode(JSON.stringify(ev));
    // fragmente si > 452 o — exactement comme MeshTransport.publish (F-03) ;
    // le bridge réassemble les fragments avant d'accepter l'événement
    const fragId = parseInt(fnv64(utf8Encode(String(ev.clientRef))).slice(0, 4), 16);
    const chunks =
      payload.length <= PAYLOAD_MAX_BYTES ? [payload] : fragmentPayload(payload, fragId);
    const packets = chunks.map((chunk) =>
      bytesToBase64(
        encodePacket({
          version: PROTOCOL_VERSION,
          type: PKT_PUBLIC,
          ttl: TTL_MAX,
          senderId: senderIdFromPubkey(m.pub),
          timestamp: Math.floor(ts / 1000), // en-tête BLE en secondes (spec)
          payloadLen: chunk.length,
          payload: chunk,
        })
      )
    );
    const res = await fetch(`${APP_URL}/api/mesh/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gatewayId: "GW-D2-T0", packets }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { accepted?: number; results?: Array<{ status?: string }> };
    // le bridge compte chaque FRAGMENT accepté (réassemblage : 1 paquet par
    // chunk) — la preuve réelle est le post visible dans le fil plus bas
    expect(j.accepted).toBe(packets.length);
    // le post est visible dans le fil public (origine mesh)
    const feed = await fetch(`${APP_URL}/api/posts?scope=global&limit=10`);
    const fj = (await feed.json()) as { posts?: Array<{ content: string; origin: string }> };
    const found = fj.posts?.find((p) => p.content === content);
    expect(found?.origin).toBe("mesh");
  }, 90000);
});

// ── fonctions pures (tourneront aussi en CI sans serveur) ────────────────────
describe("D2 — fonctions pures (matrice plafonds, reset UTC, difficulté)", () => {
  test("F1a — matrice dailyLimits exacte (directive)", () => {
    expect(dailyLimits(-7)).toEqual({ posts: 3, dms: 10 });
    expect(dailyLimits(-1)).toEqual({ posts: 3, dms: 10 });
    expect(dailyLimits(0)).toEqual({ posts: 10, dms: 50 });
    expect(dailyLimits(9)).toEqual({ posts: 10, dms: 50 });
    expect(dailyLimits(10)).toEqual({ posts: 50, dms: 200 });
    expect(dailyLimits(99)).toEqual({ posts: 50, dms: 200 });
    expect(dailyLimits(100).posts).toBe(200);
    expect(dailyLimits(100).dms).toBe(Number.POSITIVE_INFINITY);
    expect(dailyLimits(1000).dms).toBe(Number.POSITIVE_INFINITY);
  });

  test("F1b — quotaVerdict : reset du jour + Retry-After jusqu'à minuit UTC", () => {
    const now = new Date("2026-11-13T10:00:00Z");
    const row = { reputationScore: 0, postsToday: 10, dmsToday: 50, usageDay: "2026-11-13" };
    const full = quotaVerdict(row, "posts", now);
    expect(full.allowed).toBe(false);
    expect(full.used).toBe(10);
    expect(full.retryAfterSeconds).toBe(secondsUntilUtcMidnight(now));
    expect(secondsUntilUtcMidnight(now)).toBe(14 * 3600); // 10:00 → minuit
    // jour obsolète → compteur remis à zéro (reset paresseux calculé)
    const stale = quotaVerdict(
      { reputationScore: 0, postsToday: 10, dmsToday: 50, usageDay: "2026-11-12" },
      "posts",
      now
    );
    expect(stale.allowed).toBe(true);
    expect(stale.used).toBe(0);
    expect(stale.needsDayReset).toBe(true);
    // score ≥ 100 : DMs illimités
    const vet = quotaVerdict(
      { reputationScore: 150, postsToday: 0, dmsToday: 999999, usageDay: "2026-11-13" },
      "dms",
      now
    );
    expect(vet.allowed).toBe(true);
    expect(Number.isFinite(vet.limit)).toBe(false);
  });

  test("F1c — hashMeetsDifficultyHex : cas limites (0 bits, 20 bits, octets zéros)", () => {
    expect(hashMeetsDifficultyHex("", POW_DIFFICULTY_BITS)).toBe(false);
    expect(hashMeetsDifficultyHex("00", 8)).toBe(true);
    expect(hashMeetsDifficultyHex("01", 8)).toBe(false);
    expect(hashMeetsDifficultyHex("00", 9)).toBe(false);
    // 16 bits = 2 octets à zéro ("0000" = 2 octets hex = 16 bits)
    expect(hashMeetsDifficultyHex("0000", 16)).toBe(true);
    expect(hashMeetsDifficultyHex("0001", 16)).toBe(false);
    expect(hashMeetsDifficultyHex("ff", 0)).toBe(true);
    // vérification croisée avec le solveur harnais : un nonce résolu Passe
    const k = "D2-cross-check-pubkey";
    const { nonce } = solvePow(k, 1700000000000);
    const digest = createHash("sha256")
      .update(`${powChallengeMessage(k, 1700000000000)}:${nonce}`)
      .digest("hex");
    expect(hashMeetsDifficultyHex(digest, POW_DIFFICULTY_BITS)).toBe(true);
  });

  test("F1d — reputationTier : 4 tiers", () => {
    expect(reputationTier(-3)).toBe("negative");
    expect(reputationTier(5)).toBe("neutral");
    expect(reputationTier(42)).toBe("established");
    expect(reputationTier(150)).toBe("exemplary");
  });

  test("F1e — utcDay : borne UTC (pas locale)", () => {
    expect(utcDay(new Date("2026-11-13T23:59:59Z"))).toBe("2026-11-13");
    expect(utcDay(new Date("2026-11-14T00:00:00Z"))).toBe("2026-11-14");
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
