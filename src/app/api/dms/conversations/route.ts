import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toUserDto } from "@/lib/mbote/dto";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import {
  dmReadProofMessage,
  READ_MAX_AGE_MS,
  READ_FUTURE_TOLERANCE_MS,
  verifySignedMessage,
} from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

const DM_READ_PER_MIN_PER_KEY = 60;
const DM_READ_PER_MIN_PER_IP = 180;
const RATE_WINDOW_MS = 60_000;

/** GET /api/dms/conversations?me=&ts=&signature= — liste des pairs avec dernier message + non-lus
 *  F-07 : lecture authentifiée (preuve courte durée sur `${me}|dm-read|*|${ts}`)
 *  — la boîte d'autrui n'est plus lisible ni dénombrable sans sa clé.
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("dms.conversations");
  try {
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me");
    if (!me) {
      return NextResponse.json({ error: "me requis" }, { status: 400 });
    }

    // rate limit (même fenêtre que la lecture d'une conversation)
    const rates = getRateStore();
    const byKey = rates.hit(`dm-read:${me}`, DM_READ_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`dm-read-ip:${clientIp(req.headers)}`, DM_READ_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de lectures — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    // F-07 : preuve de possession courte durée (peer = "*" pour la liste)
    const check = await verifySignedMessage({
      message: dmReadProofMessage(me, "*", sp.get("ts") as unknown as number),
      pubkey: me,
      ts: sp.get("ts"),
      signature: sp.get("signature"),
      maxAgeMs: READ_MAX_AGE_MS,
      futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Lecture refusée (preuve requise) : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    const messages = await db.directMessage.findMany({
      where: { OR: [{ senderKey: me }, { recipientKey: me }] },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    // groupe par pair
    const byPeer = new Map<string, { last: (typeof messages)[number]; unread: number }>();
    for (const m of messages) {
      const peer = m.senderKey === me ? m.recipientKey : m.senderKey;
      const entry = byPeer.get(peer) ?? { last: m, unread: 0 };
      if (m.senderKey === me ? false : m.readAt == null) entry.unread += 1;
      byPeer.set(peer, entry);
    }

    const peers = [...byPeer.keys()];
    const users = peers.length
      ? await db.user.findMany({
          where: { pubkey: { in: peers } },
          include: { _count: { select: { posts: true, followers: true, following: true } } },
        })
      : [];

    const userByPub = new Map(users.map((u) => [u.pubkey, u]));

    // A3 : pairs bloqués par le lecteur — conversations MARQUÉES (`blocked`),
    // messages toujours reçus (aucun filtrage de contenu E2EE — décision A3 :
    // « reçus, avec option bloquer distincte de masquer »)
    const myBlocks = new Set(
      (
        await db.peerBlock.findMany({
          where: { blockerKey: me },
          select: { blockedKey: true },
        })
      ).map((b) => b.blockedKey)
    );

    const conversations = peers
      .map((peer) => {
        const entry = byPeer.get(peer);
        const user = userByPub.get(peer);
        if (!entry || !user) return null;
        return {
          peer: toUserDto(user), // Vague 3 : champs publics uniquement (botPriv jamais exposé)
          last: {
            id: entry.last.id,
            senderKey: entry.last.senderKey,
            recipientKey: entry.last.recipientKey,
            iv: entry.last.iv,
            ciphertext: entry.last.ciphertext,
            createdAt: entry.last.createdAt,
            readAt: entry.last.readAt,
          },
          unread: entry.unread,
          blocked: myBlocks.has(peer),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c != null)
      .sort((a, b) => {
        const ta = new Date(a.last.createdAt).getTime();
        const tb = new Date(b.last.createdAt).getTime();
        return tb - ta;
      });

    return NextResponse.json({ conversations });
  } catch (e) {
    console.error("GET /api/dms/conversations", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
