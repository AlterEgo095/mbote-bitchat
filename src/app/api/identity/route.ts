import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";

export const dynamic = "force-dynamic";

/** POST /api/identity — enregistre / met à jour une identité (clé publique = compte) */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pubkey, nickname, bio, ecdhPub } = body ?? {};

    if (!pubkey || typeof pubkey !== "string" || pubkey.length < 16) {
      return NextResponse.json({ error: "pubkey invalide" }, { status: 400 });
    }
    const nick = String(nickname ?? "").trim();
    if (nick.length < 2 || nick.length > 32) {
      return NextResponse.json(
        { error: "Le pseudo doit contenir entre 2 et 32 caractères" },
        { status: 400 }
      );
    }

    const user = await db.user.upsert({
      where: { pubkey },
      update: {
        nickname: nick,
        bio: typeof bio === "string" ? bio.slice(0, 240) : undefined,
        ecdhPub: typeof ecdhPub === "string" ? ecdhPub : undefined,
      },
      create: {
        pubkey,
        nickname: nick,
        bio: typeof bio === "string" ? bio.slice(0, 240) : null,
        ecdhPub: typeof ecdhPub === "string" ? ecdhPub : null,
      },
      include: {
        _count: { select: { posts: true, followers: true, following: true } },
      },
    });

    relayNotify("identity:new", { user }, ["feed"]);
    return NextResponse.json({ user });
  } catch (e) {
    console.error("POST /api/identity", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

/** GET /api/identity?pubkey=… — récupère un profil */
export async function GET(req: NextRequest) {
  try {
    const pubkey = req.nextUrl.searchParams.get("pubkey");
    if (!pubkey) {
      return NextResponse.json({ error: "pubkey requis" }, { status: 400 });
    }
    const user = await db.user.findUnique({
      where: { pubkey },
      include: {
        _count: { select: { posts: true, followers: true, following: true } },
      },
    });
    return NextResponse.json({ user });
  } catch (e) {
    console.error("GET /api/identity", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
