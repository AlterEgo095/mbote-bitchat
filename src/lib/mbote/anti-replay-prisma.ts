/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  anti-replay-prisma — store PERSISTANT de la garde anti-rejeu (A1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Implémentation Prisma/SQLite de l'interface ReplayStore. Les écritures
 *  sont atomiques :
 *   • la garde repose sur l'UNICITÉ de sa clé primaire (create → P2002 =
 *     doublon) — aucune fenêtre check-then-insert ;
 *   • le compteur n'accepte qu'une progression monotone (updateMany
 *     conditionnel `lastSeq < seq` — atomique au niveau du moteur).
 *
 *  Survis au redémarrage du process : c'est la preuve « rejeu après
 *  redémarrage » du harness adversarial.
 *
 *  Note runtime : la détection P2002 se fait par DUCK TYPING (`"code" in err`)
 *  et non par `instanceof Prisma.PrismaClientKnownRequestError` — sous Bun,
 *  l'instanceof est non fiable pour les erreurs Prisma (convention du repo,
 *  cf. bridge/route.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { REPLAY_EPOCH_MS, REPLAY_GUARD_TTL_MS, type ReplayStore } from "./anti-replay";

/** Le sous-ensemble de délégates nécessaire — satisfait par PrismaClient ET par
 *  un client de transaction (permet les tests sur une base fichier isolée). */
type GuardDb = Pick<Prisma.TransactionClient, "replayGuard" | "replayCounter">;

function isP2002(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "P2002"
  );
}

function makeStore(dbh: GuardDb): ReplayStore {
  return {
    async checkAndRecordGuard(guardId, expiresAt) {
      try {
        await dbh.replayGuard.create({ data: { id: guardId, kind: "dm", expiresAt } });
        return "new";
      } catch (e) {
        if (isP2002(e)) return "duplicate";
        throw e;
      }
    },
    async commitSeq(counterKey, data) {
      try {
        await dbh.replayCounter.create({
          data: {
            key: counterKey,
            senderKey: data.senderKey,
            recipientKey: data.recipientKey,
            epoch: BigInt(data.epoch),
            lastSeq: data.seq,
          },
        });
        return "ok";
      } catch (e) {
        if (!isP2002(e)) throw e;
        // course de création : progression conditionnelle atomique
        const res = await dbh.replayCounter.updateMany({
          where: { key: counterKey, lastSeq: { lt: data.seq } },
          data: { lastSeq: data.seq },
        });
        return res.count > 0 ? "ok" : "regression";
      }
    },
    async prune(now) {
      const guards = await dbh.replayGuard.deleteMany({ where: { expiresAt: { lte: now } } });
      const oldestLiveEpoch = BigInt(
        Math.floor((now.getTime() - REPLAY_GUARD_TTL_MS) / REPLAY_EPOCH_MS)
      );
      const counters = await dbh.replayCounter.deleteMany({
        where: { epoch: { lt: oldestLiveEpoch } },
      });
      return { guards: guards.count, counters: counters.count };
    },
  };
}

/** Store lié à une transaction (route /api/dms : garde + message écrits ensemble). */
export function prismaReplayStoreFor(tx: GuardDb): ReplayStore {
  return makeStore(tx);
}

/** Store production (autonome, hors transaction — pont mesh). */
export function prismaReplayStore(): ReplayStore {
  return makeStore(db);
}
