import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/dms/conversations?me= — liste des pairs avec dernier message + non-lus */
export async function GET(req: NextRequest) {
  try {
    const me = req.nextUrl.searchParams.get("me");
    if (!me) {
      return NextResponse.json({ error: "me requis" }, { status: 400 });
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

    const conversations = peers
      .map((peer) => {
        const entry = byPeer.get(peer)!;
        const user = userByPub.get(peer);
        if (!user) return null;
        return {
          peer: user,
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
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const ta = new Date(a!.last!.createdAt).getTime();
        const tb = new Date(b!.last!.createdAt).getTime();
        return tb - ta;
      });

    return NextResponse.json({ conversations });
  } catch (e) {
    console.error("GET /api/dms/conversations", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
