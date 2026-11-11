import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPostDto } from "@/lib/mbote/dto";
import { trackApiRequest } from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

// ── D1 — GET /api/posts/[id] : un post PUBLIC par identifiant ────────────────
// Sert la navigation depuis la recherche (clic sur un résultat « Fil public ») :
// le post ciblé n'est pas forcément dans la première page du fil → fetch isolé.
// MÊME visibilité que le fil public (route.ts GET where) : hiddenAt IS NULL,
// auteur ni suspendu (temporaire) ni banné. Sinon → 404 (pas de 403 : un post
// masqué est absent de TOUTES les surfaces publiques — indistinguable d'un
// identifiant inexistant, cf. sémantique du fil).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("posts.getOne");
  try {
    const { id } = await params;
    if (!id || typeof id !== "string" || id.length > 64) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const now = new Date();
    const post = await db.post.findFirst({
      where: {
        id,
        hiddenAt: null,
        author: {
          OR: [{ suspendedAt: null }, { suspendedUntil: { lt: now } }],
          bannedAt: null,
        },
      },
      include: {
        author: {
          include: { _count: { select: { posts: true, followers: true, following: true } } },
        },
      },
    });

    if (!post) {
      return NextResponse.json(
        { error: "Post introuvable ou non public" },
        { status: 404 }
      );
    }

    return NextResponse.json({ post: toPostDto(post) });
  } catch (e) {
    console.error("GET /api/posts/[id]", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
