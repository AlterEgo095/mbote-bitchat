import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPostDto } from "@/lib/mbote/dto";
import { relayNotify } from "@/lib/mbote/relay-notify";
import {
  clientIp,
  getRateStore,
  trackApiRequest,
} from "@/lib/mbote/state-store";
import { isValidPubkeyFormat } from "@/lib/mbote/proof";
import { verifyPostSignature } from "@/lib/mbote/verify";

export const dynamic = "force-dynamic";

const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;

// ── Rate limits (D4) — par identité ET par IP (derrière Caddy) ──
const POSTS_PER_MIN_PER_KEY = 12;
const POSTS_PER_MIN_PER_IP = 60;
const RATE_WINDOW_MS = 60_000;

// ── Pagination par curseur (D6) : (createdAt, id) = ordre total stable ──

function encodeCursor(date: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: date.toISOString(), id })).toString("base64url");
}

function decodeCursor(raw: string | null): { t: Date; id: string } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      t?: string;
      id?: string;
    };
    if (!obj.t || !obj.id) return null;
    const t = new Date(obj.t);
    if (Number.isNaN(t.getTime())) return null;
    return { t, id: obj.id };
  } catch {
    return null;
  }
}

/** GET /api/posts — fils : global | channel | user | replies | following
 *  Pagination : `?before=<cursor base64url>` → réponse `nextCursor` (null = fin).
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("posts.get");
  try {
    const sp = req.nextUrl.searchParams;
    const scope = sp.get("scope") ?? "global";
    const myPub = sp.get("myPub");
    const limit = Math.min(parseInt(sp.get("limit") ?? "50", 10) || 50, 100);
    const cursor = decodeCursor(sp.get("before"));

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

    // curseur : strictement antérieur au point (createdAt, id) — ordre total,
    // aucun doublon ni trou même si plusieurs posts partagent la même ms
    // (cas fréquent : ingestion mesh en batch).
    if (cursor) {
      where = {
        AND: [
          where,
          {
            OR: [
              { createdAt: { lt: cursor.t } },
              { AND: [{ createdAt: { equals: cursor.t } }, { id: { lt: cursor.id } }] },
            ],
          },
        ],
      };
    }

    const posts = await db.post.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // tie-break déterministe
      take: limit,
      include: {
        author: {
          include: { _count: { select: { posts: true, followers: true, following: true } } },
        },
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

    const last = posts[posts.length - 1];
    return NextResponse.json({
      posts: posts.map((p) => toPostDto(p, likedIds.has(p.id))),
      // compteurs en colonnes (D5) : plus aucun COUNT à chaud
      nextCursor: posts.length === limit && last ? encodeCursor(last.createdAt, last.id) : null,
    });
  } catch (e) {
    console.error("GET /api/posts", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

/** POST /api/posts — publier (ou répondre)
 *  D4 + F-01 : signature ECDSA OBLIGATOIRE et vérifiée serveur ; idempotence
 *  par signature (même événement → même post) ; rate limit par pubkey + IP.
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("posts.post");
  try {
    const body = await req.json();
    const { pubkey, content, geohash, precision, parentId, signature, ts } = body ?? {};

    if (!isValidPubkeyFormat(pubkey)) {
      return NextResponse.json(
        { error: "pubkey invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
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

    // ── rate limit (D4) : fenêtre 1 min, par clé puis par IP ──
    const rates = getRateStore();
    const ip = clientIp(req.headers);
    const byKey = rates.hit(`post:${pubkey}`, POSTS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`post-ip:${ip}`, POSTS_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de publications — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    // ── vérification de signature (D4 + F-01) : OBLIGATOIRE, rejet immédiat ──
    if (typeof signature !== "string" || signature.length === 0) {
      return NextResponse.json(
        { error: "Signature ECDSA requise — les publications non signées sont refusées" },
        { status: 400 }
      );
    }
    const check = await verifyPostSignature({
      pubkey,
      content: String(content ?? ""), // la chaîne signée = contenu BRUT tel qu'émis
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Signature refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
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

    const data = {
      authorId: author.id,
      content: text,
      geohash: geohash ?? null,
      precision: precision != null ? parseInt(String(precision), 10) : null,
      parentId: parentId ?? null,
      signature,
    };

    try {
      // écriture atomique : le post + l'incrément du compteur du parent (D5)
      const post = await db.$transaction(async (tx) => {
        const created = await tx.post.create({ data });
        if (parentId) {
          await tx.post.update({
            where: { id: parentId },
            data: { replyCount: { increment: 1 } },
          });
        }
        return created;
      });

      const full = await db.post.findUnique({
        where: { id: post.id },
        include: {
          author: {
            include: { _count: { select: { posts: true, followers: true, following: true } } },
          },
        },
      });
      const postDto = toPostDto(full ?? { ...post, author });

      // diffusion temps réel : fil public + canal géohash concerné
      relayNotify(
        "post:new",
        { post: postDto },
        post.geohash ? ["feed", `channel:${post.geohash}`] : ["feed"]
      );

      return NextResponse.json({ post: postDto });
    } catch (err) {
      // idempotence : même signature = même événement déjà ingéré (web OU mesh)
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        const existing = await db.post.findUnique({
          where: { signature: data.signature },
          include: {
            author: {
              include: { _count: { select: { posts: true, followers: true, following: true } } },
            },
          },
        });
        if (existing) {
          return NextResponse.json({ post: toPostDto(existing), duplicate: true });
        }
      }
      throw err;
    }
  } catch (e) {
    console.error("POST /api/posts", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
