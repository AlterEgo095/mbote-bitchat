/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  mls/server — helpers communs aux endpoints groupes C4
 * ─────────────────────────────────────────────────────────────────────────────
 *  Preuves de transport : même mécanique ECDSA que les DM (proof.ts). Le
 *  serveur est un RELAIS AVEUGLE : les payloads MLS (commits/welcomes/ciphertext)
 *  ne sont que des bornes de taille — aucun contenu lu, jamais.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore } from "@/lib/mbote/state-store";
import { verifySignedMessage, READ_MAX_AGE_MS, READ_FUTURE_TOLERANCE_MS } from "@/lib/mbote/proof";

// bornes de payload (le binaire MLS reste petit — preuve C2/C3 : SDP ≤ 16 Ko)
export const MLS_KEYPACKAGE_MAX = 8_192;
export const MLS_HANDSHAKE_MAX = 16_384;
export const MLS_MESSAGE_MAX = 16_384;
export const GROUP_NAME_MAX = 60;
export const GROUP_MEMBERS_MAX = 50; // directive : au-delà = C5 (hors périmètre C4)

const RATE_WINDOW_MS = 60_000;

/** Vérifie une preuve `${message}|${ts}` (chaînes construites par le client). */
export async function verifyGroupProof(
  message: string,
  pubkey: string,
  ts: unknown,
  signature: unknown
): Promise<boolean> {
  const check = await verifySignedMessage({
    message: `${message}|${ts}`,
    pubkey,
    ts,
    signature,
    maxAgeMs: READ_MAX_AGE_MS,
    futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
  });
  return check.valid;
}

/** Réponse 401 uniforme (même message quel que soit le défaut — pas d'info). */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Preuve invalide ou absente" }, { status: 401 });
}

/** Rate limit unifié — retourne la réponse 429 ou null. */
export function rateLimit(
  req: NextRequest,
  bucket: string,
  perKey: number,
  keyId: string
): NextResponse | null {
  const rates = getRateStore();
  const byKey = rates.hit(`${bucket}:${keyId}`, perKey, RATE_WINDOW_MS);
  const byIp = rates.hit(`${bucket}-ip:${clientIp(req.headers)}`, Math.max(perKey * 4, 60), RATE_WINDOW_MS);
  if (!byKey.allowed || !byIp.allowed) {
    const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
    return NextResponse.json(
      { error: "Trop de requêtes — ralentissez" },
      { status: 429, headers: { "Retry-After": String(retry || 60) } }
    );
  }
  return null;
}

/** Membre ACTIF (leftAt null) — accès aux enveloppes/messages. */
export async function isActiveMember(groupId: string, userKey: string): Promise<boolean> {
  const m = await db.groupMember.findUnique({
    where: { groupId_userKey: { groupId, userKey } },
    select: { leftAt: true },
  });
  return !!m && m.leftAt === null;
}

/** Le créateur est l'admin MVP (invitations/retraits). */
export async function isCreator(groupId: string, userKey: string): Promise<boolean> {
  const g = await db.group.findUnique({ where: { id: groupId }, select: { creatorKey: true } });
  return g?.creatorKey === userKey;
}

/** Membres actifs (pour la diffusion relay-notify). */
export async function activeMemberKeys(groupId: string): Promise<string[]> {
  const members = await db.groupMember.findMany({
    where: { groupId, leftAt: null },
    select: { userKey: true },
  });
  return members.map((m) => m.userKey);
}

/** Parse un body JSON tolerant. */
export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}
