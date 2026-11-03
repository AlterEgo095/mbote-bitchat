import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";

export const dynamic = "force-dynamic";

const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;

/** GET /api/posts — fils : global | channel | user | replies | following */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const scope = sp.get("scope") ?? "global";
    const myPub = sp.get("myPub");
    const limit = Math.min(parseInt(sp.get("limit") ?? "50", 10) || 50, 100);

    let where: Record<string, unknown> = {};

    switch (scope) {
      case "channel": {
        const geohash = sp.get("geohash") ?? "";
        const precision = sp.get("precision");
        if (!geohash) {
          return NextResponse.json({ error: "geohash requis" }, { status: 400 });
        }
        where = {
          geohash,
          ...(precision ? { precision: parseInt(precision, 10) } : {}),
        };
        break;
      }
      case "user": {
        const authorPub = sp.get("authorPub");
        if (!authorPub) {
          return NextResponse.json({ error: "authorPub requis" }, { status: 400 });
        }
        where = { author: { pubkey: authorPub } };
        break;
      }
      case "replies": {
        const parentId = sp.get("parentId");
        if (!parentId) {
          return NextResponse.json({ error: "parentId requis" }, { status: 400 });
        }
        where = { parentId };
        break;
      }
      case "following": {
        if (!myPub) {
          return NextResponse.json({ error: "myPub requis" }, { status: 400 });
        }
        where = {
          author: {
            followers: { some: { follower: { pubkey: myPub } } },
          },
        };
        break;
      }
      case "global":
      default: {
        where = { parentId: null }; // fil global = publications racines
      }
    }

    const posts = await db.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        author: {
          include: { _count: { select: { posts: true, followers: true, following: true } } },
        },
        _count: { select: { likes: true, replies: true } },
      },
    });

    // annotation likedByMe
    let likedIds = new Set<string>();
    if (myPub && posts.length) {
      const me = await db.user.findUnique({ where: { pubkey: myPub } });
      if (me) {
        const likes = await db.like.findMany({
          where: { userId: me.id, postId: { in: posts.map((p) => p.id) } },
        });
        likedIds = new Set(likes.map((l) => l.postId));
      }
    }

    return NextResponse.json({
      posts: posts.map((p) => ({
        id: p.id,
        content: p.content,
        geohash: p.geohash,
        precision: p.precision,
        parentId: p.parentId,
        signature: p.signature,
        origin: p.origin,
        meshHops: p.meshHops,
        createdAt: p.createdAt,
        author: p.author,
        likeCount: p._count.likes,
        replyCount: p._count.replies,
        likedByMe: likedIds.has(p.id),
      })),
    });
  } catch (e) {
    console.error("GET /api/posts", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

/** POST /api/posts — publier (ou répondre) */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pubkey, content, geohash, precision, parentId, signature } = body ?? {};

    if (!pubkey || typeof pubkey !== "string") {
      return NextResponse.json({ error: "pubkey requis" }, { status: 400 });
    }
    const text = String(content ?? "").trim();
    if (!text || text.length > 500) {
      return NextResponse.json(
        { error: "Le message doit contenir entre 1 et 500 caractères" },
        { status: 400 }
      );
    }
    if (geohash != null && (typeof geohash !== "string" || !GEOHASH_RE.test(geohash))) {
      return NextResponse.json({ error: "geohash invalide" }, { status: 400 });
    }

    const author = await db.user.findUnique({ where: { pubkey } });
    if (!author) {
      return NextResponse.json(
        { error: "Identité inconnue — créez d'abord votre identité" },
        { status: 404 }
      );
    }

    if (parentId) {
      const parent = await db.post.findUnique({ where: { id: parentId } });
      if (!parent) {
        return NextResponse.json({ error: "Publication parent introuvable" }, { status: 404 });
      }
    }

    const post = await db.post.create({
      data: {
        authorId: author.id,
        content: text,
        geohash: geohash ?? null,
        precision: precision != null ? parseInt(String(precision), 10) : null,
        parentId: parentId ?? null,
        signature: typeof signature === "string" ? signature : null,
      },
      include: {
        author: {
          include: { _count: { select: { posts: true, followers: true, following: true } } },
        },
        _count: { select: { likes: true, replies: true } },
      },
    });

    const postDto = {
      id: post.id,
      content: post.content,
      geohash: post.geohash,
      precision: post.precision,
      parentId: post.parentId,
      signature: post.signature,
      origin: post.origin,
      meshHops: post.meshHops,
      createdAt: post.createdAt,
      author: post.author,
      likeCount: post._count.likes,
      replyCount: post._count.replies,
      likedByMe: false,
    };

    // diffusion temps réel : fil public + canal géohash concerné
    relayNotify(
      "post:new",
      { post: postDto },
      post.geohash ? ["feed", `channel:${post.geohash}`] : ["feed"]
    );

    return NextResponse.json({ post: postDto });
  } catch (e) {
    console.error("POST /api/posts", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
