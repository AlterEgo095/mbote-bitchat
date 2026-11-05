import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { blockProofMessage, isValidPubkeyFormat, verifySignedMessage } from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

const BLOCKS_PER_MIN_PER_KEY = 30;
const BLOCKS_PER_MIN_PER_IP = 90;
const RATE_WINDOW_MS = 60_000;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/block — l'utilisateur bloque (ou débloque) un pair
 * ─────────────────────────────────────────────────────────────────────────────
 *  Effets livrés (décision tranchée à la validation A3 — « reçus, avec option
 *  bloquer distincte de masquer ») :
 *   - fil public du bloqueur : les posts du bloqué n'y apparaissent plus
 *     (filtrage côté serveur dans GET /api/posts quand `myPub` est fourni) ;
 *   - DM : les messages du bloqué RESTENT reçus mais MARQUÉS (`fromBlocked: true`
 *     dans GET /api/dms et `blocked: true` sur la conversation) — le blocage
 *     n'est NI un rejet réseau NI de la confidentialité : le fil est public par
 *     nature et le canal DM reste E2EE (le serveur n'y applique aucun filtrage).
 *
 *  Auth : preuve ECDSA — l'ACTION est couverte par la signature
 *    `${blocker}|block|${blocked}|${action}|${ts}` (action = block | unblock)
 *  → une preuve `block` rejouée ne peut pas devenir `unblock`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("block.post");
  try {
    const body = await req.json().catch(() => null);
    const { blocker, blocked, action, ts, signature } = (body ?? {}) as Record<string, unknown>;

    if (!isValidPubkeyFormat(blocker) || !isValidPubkeyFormat(blocked)) {
      return NextResponse.json(
        { error: "blocker/blocked invalides (clés publiques P-256 brutes base64url attendues)" },
        { status: 400 }
      );
    }
    const act = action === "unblock" ? "unblock" : "block"; // défaut : bloquer
    if (blocker === blocked) {
      return NextResponse.json({ error: "On ne se bloque pas soi-même" }, { status: 400 });
    }

    // rate limit
    const rates = getRateStore();
    const byKey = rates.hit(`block:${blocker}`, BLOCKS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`block-ip:${clientIp(req.headers)}`, BLOCKS_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop d'actions de blocage — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    // preuve de possession (l'action est signée)
    const check = await verifySignedMessage({
      message: blockProofMessage(blocker, blocked, act, ts as number),
      pubkey: blocker,
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    const target = await db.user.findUnique({ where: { pubkey: blocked }, select: { id: true } });
    if (!target) {
      return NextResponse.json({ error: "Pair inconnu (clé non enregistrée)" }, { status: 404 });
    }

    if (act === "block") {
      await db.peerBlock.upsert({
        where: { blockerKey_blockedKey: { blockerKey: blocker, blockedKey: blocked } },
        create: { blockerKey: blocker, blockedKey: blocked },
        update: {}, // idempotent
      });
    } else {
      await db.peerBlock.deleteMany({
        where: { blockerKey: blocker, blockedKey: blocked },
      });
    }

    return NextResponse.json({ blocker, blockedKey: blocked, blocked: act === "block", action: act });
  } catch (e) {
    console.error("POST /api/block", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
