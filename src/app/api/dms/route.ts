import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";

export const dynamic = "force-dynamic";

/** GET /api/dms?me=&peer= — conversation (le serveur ne lit jamais le contenu) */
export async function GET(req: NextRequest) {
  try {
    const me = req.nextUrl.searchParams.get("me");
    const peer = req.nextUrl.searchParams.get("peer");
    if (!me || !peer) {
      return NextResponse.json({ error: "me et peer requis" }, { status: 400 });
    }

    const messages = await db.directMessage.findMany({
      where: {
        OR: [
          { senderKey: me, recipientKey: peer },
          { senderKey: peer, recipientKey: me },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    // marquer comme lus les messages reçus
    await db.directMessage.updateMany({
      where: { senderKey: peer, recipientKey: me, readAt: null },
      data: { readAt: new Date() },
    });

    return NextResponse.json({ messages });
  } catch (e) {
    console.error("GET /api/dms", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

/** POST /api/dms — dépose une enveloppe chiffrée (boîte aux lettres aveugle) */
export async function POST(req: NextRequest) {
  try {
    const { senderKey, recipientKey, iv, ciphertext } = await req.json();
    if (!senderKey || !recipientKey || !iv || !ciphertext) {
      return NextResponse.json(
        { error: "senderKey, recipientKey, iv, ciphertext requis" },
        { status: 400 }
      );
    }
    if (senderKey === recipientKey) {
      return NextResponse.json({ error: "Autolivraison refusée" }, { status: 400 });
    }
    if (ciphertext.length > 8192) {
      return NextResponse.json({ error: "Enveloppe trop volumineuse (16 KiB max)" }, { status: 413 });
    }

    const [sender, recipient] = await Promise.all([
      db.user.findUnique({ where: { pubkey: senderKey } }),
      db.user.findUnique({ where: { pubkey: recipientKey } }),
    ]);
    if (!sender || !recipient) {
      return NextResponse.json(
        { error: "Expéditeur ou destinataire inconnu (clés non enregistrées)" },
        { status: 404 }
      );
    }

    const message = await db.directMessage.create({
      data: { senderKey, recipientKey, iv, ciphertext },
    });

    // livraison temps réel : boîtes aux lettres des deux parties (contenu opaque)
    relayNotify("dm:new", { message }, [`dm:${senderKey}`, `dm:${recipientKey}`]);

    return NextResponse.json({ message });
  } catch (e) {
    console.error("POST /api/dms", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
