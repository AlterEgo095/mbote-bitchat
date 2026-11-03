import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toUserDto } from "@/lib/mbote/dto";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { identityProofMessage, isValidPubkeyFormat, verifySignedMessage } from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

/** POST /api/identity — enregistre / met à jour une identité (clé publique = compte)
 *
 *  F-01 (audit Vague 1) : toute écriture d'identité exige une PREUVE DE
 *  POSSESSION — signature ECDSA P-256 sur la chaîne canonique
 *  `${pubkey}|identity|${nickname}|${bio}|${ecdhPub}|${ts}`.
 *  Sans preuve valide : 401. Empêche la réécriture du pseudo, de la bio et
 *  surtout de `ecdhPub` (détournement des DM futurs) d'un tiers.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pubkey, nickname, bio, ecdhPub, ts, signature } = body ?? {};

    if (!isValidPubkeyFormat(pubkey)) {
      return NextResponse.json(
        { error: "pubkey invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }
    if (ecdhPub !== undefined && ecdhPub !== null && !isValidPubkeyFormat(ecdhPub)) {
      return NextResponse.json(
        { error: "ecdhPub invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }

    // La preuve porte sur les valeurs BRUTES envoyées (telles que signées),
    // pas sur les versions tronquées/trimmées stockées ensuite.
    const nickRaw = typeof nickname === "string" ? nickname : "";
    const bioRaw = typeof bio === "string" ? bio : "";
    const ecdhRaw = typeof ecdhPub === "string" ? ecdhPub : "";

    const check = await verifySignedMessage({
      message: identityProofMessage({ pubkey, nickname: nickRaw, bio: bioRaw, ecdhPub: ecdhRaw, ts }),
      pubkey,
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    const nick = nickRaw.trim();
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

    // Vague 3 : le broadcast relay et la réponse ne contiennent que les champs
    // publics — botPriv (clé privée du bot de démo) ne quitte jamais le serveur.
    const publicUser = toUserDto(user);
    relayNotify("identity:new", { user: publicUser }, ["feed"]);
    return NextResponse.json({ user: publicUser });
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
    return NextResponse.json({ user: user ? toUserDto(user) : null });
  } catch (e) {
    console.error("GET /api/identity", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
