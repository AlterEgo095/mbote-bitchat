/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADVERSARIAL A1 — anti-rejeu DM (recadrage, phase A1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Scénarios hostiles exigés + compléments :
 *    1.  rejeu à 1 s        → duplicate   (garde persistante)
 *    2.  rejeu à 1 h        → duplicate
 *    3.  rejeu à 24 h       → duplicate   (garde TTL 7 j vivante)
 *    4.  rejeu après REDÉMARRAGE (nouveau store sur le même fichier SQLite)
 *                           → duplicate   (preuve de persistance)
 *    5.  compteur manipulé  : seq égale → seq_regression
 *                             seq inférieure → seq_regression
 *                             seq croissante → accepté
 *    6.  ré-emballage hostile : même (iv, ciphertext), NOUVEAU msgId/seq signés
 *                           → duplicate   (garde liée au PAYLOAD, pas aux
 *                             métadonnées — le contournement d'emballage échoue)
 *    7.  époques            : ts +7 h (nouvelle époque) → compteur neuf, accepté
 *    8.  fenêtres           : ts > 7 j → stale ; ts futur → stale ; ts invalide → stale
 *    9.  purge              : les gardes expirées et compteurs d'époques révolues
 *                             partent, les vivants restent
 *   10.  enveloppe legacy (sans msgId/seq) → acceptée, rejeu → duplicate
 *
 *  Commandes de reproduction :
 *    bun test tests/anti-replay.test.ts            (unitaire + persistance SQLite)
 *    DATABASE_URL="file:./db/dev.db" bun tests/anti-replay-e2e.ts   (API réelle)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import {
  MemoryReplayStore,
  checkDmReplay,
  dmGuardId,
  dmCounterKey,
  dmEpochFromTs,
  REPLAY_GUARD_TTL_MS,
  type ReplayStore,
} from "../src/lib/mbote/anti-replay";
import { prismaReplayStoreFor } from "../src/lib/mbote/anti-replay-prisma";

// ── fixature : une enveloppe DM de référence ────────────────────────────────
const SENDER = "A" + "x".repeat(42);
const RECIPIENT = "B" + "y".repeat(42);
const IV = "aXY0ZXN0aXY=";
const CT = "Y2lwaGVydGV4dGVkcmVmZXJlbmNl";
const NOW = Date.now();

function input(overrides: Record<string, unknown> = {}) {
  return {
    senderKey: SENDER,
    recipientKey: RECIPIENT,
    iv: IV,
    ciphertext: CT,
    ts: NOW,
    msgId: "msg-1",
    seq: 1,
    ...overrides,
  } as Parameters<typeof checkDmReplay>[1];
}

// ── 1–3, 5–10 : matrice unitaire sur store mémoire (déterministe) ──────────
describe("A1 — matrice unitaire (MemoryReplayStore)", () => {
  test("1. rejeu à 1 s → duplicate", async () => {
    const store = new MemoryReplayStore();
    expect((await checkDmReplay(store, input(), NOW)).ok).toBe(true);
    const v = await checkDmReplay(store, input(), NOW + 1_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.outcome).toBe("duplicate");
  });

  test("2. rejeu à 1 h → duplicate", async () => {
    const store = new MemoryReplayStore();
    expect((await checkDmReplay(store, input(), NOW)).ok).toBe(true);
    const v = await checkDmReplay(store, input(), NOW + 3_600_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.outcome).toBe("duplicate");
  });

  test("3. rejeu à 24 h → duplicate (garde 7 j vivante)", async () => {
    const store = new MemoryReplayStore();
    expect((await checkDmReplay(store, input(), NOW)).ok).toBe(true);
    const v = await checkDmReplay(store, input(), NOW + 24 * 3_600_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.outcome).toBe("duplicate");
  });

  test("6. ré-emballage hostile : même payload, msgId/seq forgés → duplicate", async () => {
    const store = new MemoryReplayStore();
    expect((await checkDmReplay(store, input(), NOW)).ok).toBe(true);
    // l'adversaire réemballle : nouveaux msgId/seq (non signés via le pont) —
    // la garde est liée au payload → le contournement échoue
    const v = await checkDmReplay(store, input({ msgId: "forged-uuid", seq: 999 }), NOW + 1_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.outcome).toBe("duplicate");
  });

  test("5. compteur manipulé : seq égale puis inférieure → seq_regression", async () => {
    const store = new MemoryReplayStore();
    expect((await checkDmReplay(store, input({ msgId: "m1", seq: 5 }), NOW)).ok).toBe(true);
    const eq = await checkDmReplay(store, input({ msgId: "m2", iv: "aXYy", ciphertext: "Q3Qy", seq: 5 }), NOW + 1_000);
    expect(eq.ok).toBe(false);
    if (!eq.ok) expect(eq.outcome).toBe("seq_regression");
    const lower = await checkDmReplay(store, input({ msgId: "m3", iv: "aXYz", ciphertext: "Q3Qz", seq: 4 }), NOW + 2_000);
    expect(lower.ok).toBe(false);
    if (!lower.ok) expect(lower.outcome).toBe("seq_regression");
    // seq croissante → accepté (les trous sont légitimes : pertes mesh)
    const up = await checkDmReplay(store, input({ msgId: "m4", iv: "aXY0", ciphertext: "Q3Q0", seq: 6 }), NOW + 3_000);
    expect(up.ok).toBe(true);
  });

  test("7. nouvelle époque (+7 h) → compteur neuf, seq redémarre", async () => {
    const store = new MemoryReplayStore();
    expect((await checkDmReplay(store, input({ msgId: "e1", seq: 3 }), NOW)).ok).toBe(true);
    const later = NOW + 7 * 3_600_000; // traverse la frontière d'époque de 6 h
    expect(dmEpochFromTs(NOW)).not.toBe(dmEpochFromTs(later));
    const v = await checkDmReplay(store, input({ msgId: "e2", iv: "aXY1", ciphertext: "Q3Q1", seq: 3, ts: later }), later);
    expect(v.ok).toBe(true);
  });

  test("8. fenêtres : > 7 j → stale ; futur > 60 s → stale ; ts invalide → stale", async () => {
    const store = new MemoryReplayStore();
    const old = await checkDmReplay(store, input({ ts: NOW - REPLAY_GUARD_TTL_MS - 60_000 }), NOW);
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.outcome).toBe("stale");
    const future = await checkDmReplay(store, input({ ts: NOW + 61_000 }), NOW);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.outcome).toBe("stale");
    const bad = await checkDmReplay(store, input({ ts: undefined }), NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.outcome).toBe("stale");
  });

  test("10. enveloppe legacy (sans msgId/seq) → acceptée, rejeu → duplicate", async () => {
    const store = new MemoryReplayStore();
    const legacy = input({ msgId: null, seq: null });
    expect((await checkDmReplay(store, legacy, NOW)).ok).toBe(true);
    const v = await checkDmReplay(store, legacy, NOW + 1_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.outcome).toBe("duplicate");
  });

  test("9. purge : les gardes expirées partent, les vivantes restent", async () => {
    const store = new MemoryReplayStore();
    await checkDmReplay(store, input(), NOW);
    const { guards } = await store.prune(new Date(NOW + REPLAY_GUARD_TTL_MS + 60_000));
    expect(guards).toBe(1);
    expect(store.guardCount).toBe(0);
  });

  test("déterminisme de la garde : le tuple canonique fixe l'empreinte", () => {
    expect(dmGuardId(SENDER, RECIPIENT, IV, CT)).toBe(dmGuardId(SENDER, RECIPIENT, IV, CT));
    expect(dmGuardId(SENDER, RECIPIENT, IV, CT)).toHaveLength(64);
    // la garde distingue les directions (A→B ≠ B→A)
    expect(dmGuardId(SENDER, RECIPIENT, IV, CT)).not.toBe(dmGuardId(RECIPIENT, SENDER, IV, CT));
    // la clé de compteur sépare les conversations et les époques
    expect(dmCounterKey(SENDER, RECIPIENT, 1)).not.toBe(dmCounterKey(SENDER, RECIPIENT, 2));
    expect(dmCounterKey(SENDER, RECIPIENT, 1)).not.toBe(dmCounterKey(RECIPIENT, SENDER, 1));
  });
});

// ── 4 : rejeu après REDÉMARRAGE — Prisma + fichier SQLite temporaire ───────
describe("A1 — persistance (PrismaReplayStore, SQLite fichier)", () => {
  let dir: string;
  let url: string;
  let clientA: PrismaClient;
  let clientB: PrismaClient;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mbote-a1-"));
    url = `file:${join(dir, "test.db")}`;
    execSync(`bunx prisma db push --skip-generate`, {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
    clientA = new PrismaClient({ datasourceUrl: url });
  });

  afterAll(async () => {
    await clientA?.$disconnect();
    await clientB?.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test("4. rejeu après redémarrage (disconnect → nouveau client → même fichier) → duplicate", async () => {
    const now = Date.now();
    // « avant redémarrage » : garde + compteur écrits via un store transactionnel
    await clientA.$transaction(async (tx) => {
      const v = await checkDmReplay(prismaReplayStoreFor(tx), input({ ts: now }), now);
      expect(v.ok).toBe(true);
    });

    // REDÉMARRAGE : on ferme TOUTES les connexions puis on rouvre un nouveau client
    await clientA.$disconnect();
    clientB = new PrismaClient({ datasourceUrl: url });

    const v1 = await checkDmReplay(prismaReplayStoreFor(clientB), input({ ts: now }), now + 1_000);
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.outcome).toBe("duplicate");

    // le compteur aussi a survécu : seq inférieure rejetée même après restart
    const v2 = await checkDmReplay(
      prismaReplayStoreFor(clientB),
      input({ ts: now, iv: "aXYy", ciphertext: "Q3Qy", msgId: "m9", seq: 1 }),
      now + 2_000
    );
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.outcome).toBe("seq_regression");
  });

  test("4b. atomicité transactionnelle : refus → RIEN n'est écrit (rollback)", async () => {
    const now = Date.now();
    const first = input({ ts: now, iv: "aXYx", ciphertext: "Q3Qx", msgId: "a1", seq: 10 });
    expect((await checkDmReplay(prismaReplayStoreFor(clientB), first, now)).ok).toBe(true);
    // une transaction qui refuse (seq_regression) après avoir touché la garde
    // ne doit laisser AUCUNE trace : rollback intégral
    await expect(
      clientB.$transaction(async (tx) => {
        const store = prismaReplayStoreFor(tx);
        const v = await checkDmReplay(store, input({ ts: now, iv: "aXY2", ciphertext: "Q3Q2", msgId: "a2", seq: 5 }), now);
        if (!v.ok) throw new Error("refusé: " + v.outcome);
        return tx.directMessage.create({
          data: { senderKey: SENDER, recipientKey: RECIPIENT, iv: "x", ciphertext: "y" },
        });
      })
    ).rejects.toThrow();
    // seq=5 a été refusée (10 déjà vu) : ni message, ni garde a2, compteur intact
    const counters = await clientB.replayCounter.findMany();
    expect(counters.length).toBe(1); // uniquement celui de `first`
    expect(counters[0].lastSeq).toBe(10n);
    // preuve précise du ROLLBACK : la garde de a2 (créée PUIS refusée seq dans
    // la même transaction) n'existe pas — le throw a tout annulé
    const a2Guard = await clientB.replayGuard.findUnique({
      where: { id: dmGuardId(SENDER, RECIPIENT, "aXY2", "Q3Q2") },
    });
    expect(a2Guard).toBeNull();
  });
});

// ── garde-fou : les deux stores implémentent le même contrat sémantique ────
describe("A1 — contrat commun Memory/Prisma", () => {
  test("même verdict sur les mêmes entrées", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbote-a1c-"));
    const url = `file:${join(dir, "c.db")}`;
    execSync(`bunx prisma db push --skip-generate`, {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      const mem: ReplayStore = new MemoryReplayStore();
      const cases = [
        input(),
        input({ msgId: "b2", iv: "aXYy", ciphertext: "Q3Qy", seq: 2 }),
        input({ msgId: "b2", iv: "aXYy", ciphertext: "Q3Qy", seq: 2 }), // doublon
        input({ ts: NOW - REPLAY_GUARD_TTL_MS - 60_000 }), // stale
      ];
      for (const c of cases) {
        const a = await checkDmReplay(mem, c, NOW);
        const b = await checkDmReplay(prismaReplayStoreFor(client), c, NOW);
        expect(a).toEqual(b);
      }
    } finally {
      await client.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
