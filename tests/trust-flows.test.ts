/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS A2 — flux de confiance (premier contact, substitution, re-vérification)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Scénarios adversariaux exigés :
 *    T1. substitution au PREMIER CONTACT → deux numéros différents = détectable
 *    T2. substitution APRÈS établissement → état `changed` + niveau ROUGE bloquant
 *    T3. nouvel appareil légitime → flux de re-vérification → `verified` avec la
 *        nouvelle clé épinglée (et une nouvelle substitution re-déclenche l'alerte)
 *
 *  Commande : bun test tests/trust-flows.test.ts   (SQLite fichier temporaire)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { trustStatus, verifyTrust } from "../src/lib/mbote/trust";

function fakeKey(seed: number): string {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  for (let i = 1; i < 65; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return Buffer.from(bytes).toString("base64url");
}

const ALICE = { pubkey: fakeKey(1), ecdhPub: fakeKey(2) };
const BOB = { pubkey: fakeKey(3), ecdhPub: fakeKey(4) };
const BOB_ATTACKER_ECDH = fakeKey(99);
const BOB_NEW_DEVICE_ECDH = fakeKey(50);

let dir: string;
let client: PrismaClient;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mbote-a2-"));
  const url = `file:${join(dir, "trust.db")}`;
  execSync(`bunx prisma db push --skip-generate`, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  client = new PrismaClient({ datasourceUrl: url });
});

afterAll(async () => {
  await client?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function seedUsers() {
  await client.user.create({
    data: { pubkey: ALICE.pubkey, nickname: "Alice", ecdhPub: ALICE.ecdhPub },
  });
  await client.user.create({
    data: { pubkey: BOB.pubkey, nickname: "Bob", ecdhPub: BOB.ecdhPub },
  });
}

describe("A2 — flux de confiance (Prisma, SQLite fichier)", () => {
  test("T0. premier contact → épinglage initial non vérifié (jaune, non bloquant)", async () => {
    await seedUsers();
    const s1 = await trustStatus(client, { me: ALICE.pubkey, meEcdhPub: ALICE.ecdhPub, peer: BOB.pubkey });
    expect(s1.state).toBe("unverified");
    expect(s1.level).toBe("yellow");
    expect(s1.safetyNumber).toMatch(/^(\d{5} ){11}\d{5}$/);
    // idempotent : un second contact ne duplique pas la ligne
    await trustStatus(client, { me: ALICE.pubkey, meEcdhPub: ALICE.ecdhPub, peer: BOB.pubkey });
    expect(await client.trustedKey.count()).toBe(1);
  });

  test("T1. substitution au premier contact → deux numéros différents (détectable)", async () => {
    const legit = await safetyNumberOf(BOB.ecdhPub);
    const attack = await safetyNumberOf(BOB_ATTACKER_ECDH);
    expect(legit).not.toBe(attack);
  });

  test("T2. substitution APRÈS établissement → `changed` + ROUGE bloquant", async () => {
    // établissement : Bob vérifie le numéro légitime
    const verified = await verifyTrust(client, {
      me: ALICE.pubkey,
      meEcdhPub: ALICE.ecdhPub,
      peer: BOB.pubkey,
      number: await safetyNumberOf(BOB.ecdhPub),
    });
    expect(verified.state).toBe("verified");
    expect(verified.level).toBe("green");

    // ATTAQUE : le serveur (compromis) sert la clé d'un attaquant pour Bob
    await client.user.update({ where: { pubkey: BOB.pubkey }, data: { ecdhPub: BOB_ATTACKER_ECDH } });
    const after = await trustStatus(client, {
      me: ALICE.pubkey,
      meEcdhPub: ALICE.ecdhPub,
      peer: BOB.pubkey,
    });
    expect(after.state).toBe("changed");
    expect(after.level).toBe("red"); // ← le niveau qui bloque l'envoi E2EE côté UI
    expect(after.keyChanged).toBe(true);
    expect(after.changedAt).not.toBeNull();
    // l'alerte PERSISTE (pas de retour au calme sans action explicite)
    const again = await trustStatus(client, { me: ALICE.pubkey, meEcdhPub: ALICE.ecdhPub, peer: BOB.pubkey });
    expect(again.level).toBe("red");
  });

  test("T3. nouvel appareil légitime → re-vérification → `verified` sur la nouvelle clé", async () => {
    // état au début : alerte rouge (clé attaquant servie, fin de T2).
    // Le NOUVEL appareil légitime de Bob PUBLIE sa nouvelle clé…
    await client.user.update({ where: { pubkey: BOB.pubkey }, data: { ecdhPub: BOB_NEW_DEVICE_ECDH } });
    // …et Alice re-vérifie avec lui le NOUVEAU numéro de vive voix
    const re = await verifyTrust(client, {
      me: ALICE.pubkey,
      meEcdhPub: ALICE.ecdhPub,
      peer: BOB.pubkey,
      number: await safetyNumberOf(BOB_NEW_DEVICE_ECDH),
    });
    expect(re.state).toBe("verified");
    expect(re.level).toBe("green");
    expect(re.keyChanged).toBe(false);
    const row = await client.trustedKey.findUnique({
      where: { ownerKey_peerKey: { ownerKey: ALICE.pubkey, peerKey: BOB.pubkey } },
    });
    expect(row?.ecdhPubPinned).toBe(BOB_NEW_DEVICE_ECDH);
    expect(row?.verifiedAt).not.toBeNull();

    // et une NOUVELLE substitution après re-vérification re-déclenche l'alerte rouge
    await client.user.update({ where: { pubkey: BOB.pubkey }, data: { ecdhPub: BOB_ATTACKER_ECDH } });
    const after = await trustStatus(client, { me: ALICE.pubkey, meEcdhPub: ALICE.ecdhPub, peer: BOB.pubkey });
    expect(after.level).toBe("red");
  });

  async function safetyNumberOf(peerEcdhPub: string): Promise<string> {
    const { safetyNumber } = await import("../src/lib/mbote/safety-number");
    return safetyNumber(ALICE.pubkey, ALICE.ecdhPub, BOB.pubkey, peerEcdhPub);
  }
});
