/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  trust — authentification des clés côté serveur (A2, lacune L-3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le serveur tient le REGISTRE d'épinglage (audit + détection inter-appareils)
 *  : quand l'`ecdhPub` servi pour un pair diverge du dernier épinglé, l'état
 *  passe en `changed` → alerte rouge côté client.
 *
 *  Barrière indépendante du serveur : l'épinglage LOCAL par appareil
 *  (`trust-client.ts`) — contre un serveur pleinement malveillant, seul le
 *  comparage hors-bande du numéro de sécurité fait foi (modèle Signal, cf.
 *  docs/SAFETY-NUMBER-SPEC.md §5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Prisma } from "@prisma/client";
import { safetyNumber } from "./safety-number";

type TrustDb = Pick<Prisma.TransactionClient, "trustedKey" | "user">;

export type TrustState = "unverified" | "verified" | "changed";

/** Niveau d'alerte UI : red = envoi E2EE BLOQUANT (verrou médias A2). */
export type TrustLevel = "green" | "yellow" | "red";

export interface TrustStatus {
  peerEcdhPub: string | null;
  /** numéro calculé sur les clés COURANTES (à re-vérifier après changement) */
  safetyNumber: string | null;
  state: TrustState;
  level: TrustLevel;
  changedAt: string | null;
  verifiedAt: string | null;
  /** l'ecdhPub servi diffère du dernier épinglé — la raison de l'alerte rouge */
  keyChanged: boolean;
}

export async function trustStatus(
  dbh: TrustDb,
  params: { me: string; meEcdhPub: string | null; peer: string }
): Promise<TrustStatus> {
  const { me, meEcdhPub, peer } = params;
  const peerUser = await dbh.user.findUnique({
    where: { pubkey: peer },
    select: { ecdhPub: true },
  });
  const peerEcdhPub = peerUser?.ecdhPub ?? null;

  let row = await dbh.trustedKey.findUnique({
    where: { ownerKey_peerKey: { ownerKey: me, peerKey: peer } },
  });

  // premier contact : enregistrement de l'épinglage initial (état non vérifié)
  if (!row && peerEcdhPub) {
    row = await dbh.trustedKey.create({
      data: {
        ownerKey: me,
        peerKey: peer,
        ecdhPubPinned: peerEcdhPub,
        safetyNumber: meEcdhPub ? await safetyNumber(me, meEcdhPub, peer, peerEcdhPub) : "",
        state: "unverified",
      },
    });
  }

  // DÉTECTION DE SUBSTITUTION (le cœur de A2) : la clé servie diverge de
  // l'épinglée → `changed` persistant (alerte rouge) jusqu'à re-vérification.
  let keyChanged = false;
  if (row && peerEcdhPub && row.ecdhPubPinned !== peerEcdhPub) {
    keyChanged = true;
    if (row.state !== "changed") {
      row = await dbh.trustedKey.update({
        where: { id: row.id },
        data: { state: "changed", changedAt: new Date() },
      });
    }
  }

  const state: TrustState = row ? (row.state as TrustState) : "unverified";
  const level: TrustLevel =
    state === "changed" ? "red" : state === "verified" ? "green" : "yellow";

  return {
    peerEcdhPub,
    safetyNumber:
      meEcdhPub && peerEcdhPub ? await safetyNumber(me, meEcdhPub, peer, peerEcdhPub) : null,
    state,
    level,
    changedAt: row?.changedAt?.toISOString() ?? null,
    verifiedAt: row?.verifiedAt?.toISOString() ?? null,
    keyChanged,
  };
}

/** Confirmation hors-bande du numéro (ré-épingle la clé courante du pair). */
export async function verifyTrust(
  dbh: TrustDb,
  params: { me: string; meEcdhPub: string | null; peer: string; number: string }
): Promise<TrustStatus> {
  const { me, meEcdhPub, peer, number } = params;
  const peerUser = await dbh.user.findUnique({
    where: { pubkey: peer },
    select: { ecdhPub: true },
  });
  const peerEcdhPub = peerUser?.ecdhPub ?? null;
  if (!peerEcdhPub) throw new Error("pair sans clé ECDH — rien à épingler");

  const existing = await dbh.trustedKey.findUnique({
    where: { ownerKey_peerKey: { ownerKey: me, peerKey: peer } },
  });
  const data = {
    ecdhPubPinned: peerEcdhPub,
    safetyNumber: number,
    state: "verified" as const,
    verifiedAt: new Date(),
    changedAt: null,
  };
  if (existing) {
    await dbh.trustedKey.update({ where: { id: existing.id }, data });
  } else {
    await dbh.trustedKey.create({
      data: { ownerKey: me, peerKey: peer, ...data },
    });
  }
  return trustStatus(dbh, { me, meEcdhPub, peer });
}
