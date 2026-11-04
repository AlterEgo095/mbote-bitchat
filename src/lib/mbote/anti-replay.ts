/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  anti-replay — A1 (recadrage) : anti-rejeu DM en trois barrières indépendantes
 * ─────────────────────────────────────────────────────────────────────────────
 *  Menace : la preuve de possession d'un DM (signature ECDSA) est tolérée 7 j
 *  (ACTION_MAX_AGE_MS — les actions peuvent dormir des jours dans un outbox
 *  hors-ligne). Une enveloppe capturée est donc REJOUABLE pendant 7 j :
 *   • via /api/dms (rejeu HTTPS verbatim) ;
 *   • via le pont mesh : la dédup par octets de paquet (SHA-256 du paquet brut)
 *     est contournée en RE-EMBALLANT le même DM dans un nouveau paquet
 *     (nouveau TTL, nouveau timestamp d'en-tête, nouveaux msgId/seq forgés —
 *     les événements `dm` du pont ne sont pas signés, par conception E2EE).
 *
 *  Les trois barrières (indépendantes — la compromise d'une seule ne suffit pas) :
 *   1. GARDE PERSISTANTE (ReplayGuard) : SHA-256 du tuple canonique
 *      `sender|recipient|iv|ciphertext` — LIÉE AU PAYLOAD, pas aux octets de
 *      transport. Un rejeu réemballé reste un doublon. TTL 7 j (fenêtre maximale
 *      de validité d'une preuve — au-delà, la signature elle-même est rejetée).
 *   2. COMPTEUR PAR CLÉ (ReplayCounter) : pour les enveloppes v2 (msgId + seq
 *      couverts par la signature `dm2`), la séquence doit être STRICTEMENT
 *      croissante par (conversation, époque). Rejet de toute régression — même
 *      si la garde a été purgée ou contournée.
 *   3. ÉPOQUES : epoch = floor(tsSigné / 6 h). Les compteurs vivent par époque
 *      (rotation naturelle, pas de compteur éternel à synchroniser) ; un `ts`
 *      hors fenêtre (ancien de > 7 j, futur de > 60 s) est rejeté AVANT tout.
 *
 *  Idempotence outbox : le flush hors-ligne REJOUE des enveloppes déjà
 *  livrées (échec réseau après write serveur). La garde transforme ce rejeu
 *  légitime en réponse 409 `duplicate` — traitée comme un succès par le client.
 *
 *  Fichier serveur (Node/Bun crypto) — les routes l'utilisent via l'interface
 *  ReplayStore (Memory pour les tests, Prisma en production).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";
import {
  ACTION_FUTURE_TOLERANCE_MS,
  normalizeTsToMs,
} from "./proof";

/** Durée d'une époque anti-rejeu (rotation des compteurs par conversation) */
export const REPLAY_EPOCH_MS = 6 * 60 * 60 * 1000;

/** TTL de la garde = fenêtre maximale de validité d'une preuve (proof.ts) */
export const REPLAY_GUARD_TTL_MS = 7 * 24 * 3600 * 1000;

export type ReplayOutcome = "duplicate" | "stale" | "seq_regression";

export type ReplayVerdict =
  | { ok: true; guardId: string }
  | { ok: false; outcome: ReplayOutcome; reason: string };

export interface DmReplayInput {
  senderKey: string;
  recipientKey: string;
  iv: string;
  ciphertext: string;
  /** horodatage signé (ms ou s — normalisé comme les preuves) */
  ts: number | string | undefined;
  /** v2 : identifiant client (couvert par la signature dm2) — null = legacy */
  msgId?: string | null;
  /** v2 : séquence monotone (couverte par la signature dm2) — null = legacy */
  seq?: number | null;
}

/** Garde LIÉE AU PAYLOAD — le cœur du correctif (ré-emballage transport inopérant) */
export function dmGuardId(
  senderKey: string,
  recipientKey: string,
  iv: string,
  ciphertext: string
): string {
  return createHash("sha256")
    .update(`${senderKey}|${recipientKey}|${iv}|${ciphertext}`)
    .digest("hex");
}

/** Clé technique du compteur (conversation × époque) */
export function dmCounterKey(senderKey: string, recipientKey: string, epoch: number): string {
  return createHash("sha256")
    .update(`${senderKey}|${recipientKey}|${epoch}`)
    .digest("hex");
}

export function dmEpochFromTs(tsMs: number): number {
  return Math.floor(tsMs / REPLAY_EPOCH_MS);
}

// ───────────────────────── Store pluggable (décision D2) ─────────────────────────

/**
 * Le store est atomique par construction : `checkAndRecordGuard` crée la garde
 * et signale le doublon via l'unicité de la clé primaire (jamais de fenêtre
 * check-then-insert), `commitSeq` n'accepte qu'une progression monotone
 * (mise à jour conditionnelle `lastSeq < seq`).
 */
export interface ReplayStore {
  checkAndRecordGuard(guardId: string, expiresAt: Date): Promise<"new" | "duplicate">;
  commitSeq(
    counterKey: string,
    data: { senderKey: string; recipientKey: string; epoch: number; seq: bigint }
  ): Promise<"ok" | "regression">;
  /** Purge périodique (gardes expirées + compteurs d'époques révolues) */
  prune(now: Date): Promise<{ guards: number; counters: number }>;
}

/** Implémentation mémoire — tests + référence sémantique du contrat. */
export class MemoryReplayStore implements ReplayStore {
  private guards = new Map<string, Date>();
  private counters = new Map<string, { epoch: number; seq: bigint }>();

  async checkAndRecordGuard(guardId: string, expiresAt: Date): Promise<"new" | "duplicate"> {
    const existing = this.guards.get(guardId);
    if (existing && existing.getTime() > Date.now()) return "duplicate";
    this.guards.set(guardId, expiresAt);
    return "new";
  }

  async commitSeq(
    counterKey: string,
    data: { senderKey: string; recipientKey: string; epoch: number; seq: bigint }
  ): Promise<"ok" | "regression"> {
    const last = this.counters.get(counterKey);
    if (last && data.seq <= last.seq) return "regression";
    this.counters.set(counterKey, { epoch: data.epoch, seq: data.seq });
    return "ok";
  }

  async prune(now: Date): Promise<{ guards: number; counters: number }> {
    let guards = 0;
    for (const [id, expiresAt] of this.guards) {
      if (expiresAt <= now) {
        this.guards.delete(id);
        guards++;
      }
    }
    // les compteurs d'époques antérieures à la plus vieille garde vivante sont révolus
    const oldestLiveEpoch = Math.floor((now.getTime() - REPLAY_GUARD_TTL_MS) / REPLAY_EPOCH_MS);
    let counters = 0;
    for (const [key, entry] of this.counters) {
      if (entry.epoch < oldestLiveEpoch) {
        this.counters.delete(key);
        counters++;
      }
    }
    return { guards, counters };
  }

  /** Diagnostic tests : nombre de gardes vivantes */
  get guardCount(): number {
    return this.guards.size;
  }
}

/** Verdict d'anti-rejeu d'une enveloppe DM (sans effet de bord si refus). */
export async function checkDmReplay(
  store: ReplayStore,
  input: DmReplayInput,
  now = Date.now()
): Promise<ReplayVerdict> {
  const tsNum = Number(input.ts ?? 0);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { ok: false, outcome: "stale", reason: "ts invalide" };
  }
  const tsMs = normalizeTsToMs(tsNum);
  const age = now - tsMs;
  if (age > REPLAY_GUARD_TTL_MS) {
    return {
      ok: false,
      outcome: "stale",
      reason: "message trop ancien (hors fenêtre anti-rejeu de 7 jours)",
    };
  }
  if (age < -ACTION_FUTURE_TOLERANCE_MS) {
    return { ok: false, outcome: "stale", reason: "ts dans le futur" };
  }

  const guardId = dmGuardId(input.senderKey, input.recipientKey, input.iv, input.ciphertext);
  const guardResult = await store.checkAndRecordGuard(
    guardId,
    new Date(now + REPLAY_GUARD_TTL_MS)
  );
  if (guardResult === "duplicate") {
    return {
      ok: false,
      outcome: "duplicate",
      reason: "enveloppe déjà reçue (garde persistante liée au payload)",
    };
  }

  // Barrière 2 : compteur de séquence (enveloppes v2 uniquement —
  // seq non signée sur une enveloppe legacy ne prouve rien)
  if (typeof input.seq === "number" && Number.isFinite(input.seq) && input.seq >= 0) {
    const epoch = dmEpochFromTs(tsMs);
    const counterKey = dmCounterKey(input.senderKey, input.recipientKey, epoch);
    const seqResult = await store.commitSeq(counterKey, {
      senderKey: input.senderKey,
      recipientKey: input.recipientKey,
      epoch,
      seq: BigInt(Math.trunc(input.seq)),
    });
    if (seqResult === "regression") {
      return {
        ok: false,
        outcome: "seq_regression",
        reason: `séquence non monotone dans l'époque ${epoch} (rejet — rejeu ou réordonnancement hostile)`,
      };
    }
  }

  return { ok: true, guardId };
}
