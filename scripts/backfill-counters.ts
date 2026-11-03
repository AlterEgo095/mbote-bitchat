/**
 * Nettoyage one-shot des signatures dupliquées (blocage de la migration D5).
 * Stratégie : le post le PLUS ANCIEN garde la signature, les suivants la perdent
 * (NULL = pas de contrainte d'unicité) — les contenus restent intacts.
 * Puis backfill des compteurs dénormalisés likeCount / replyCount.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // 1. dédoublonnage des signatures
  const signed = await db.post.findMany({
    where: { signature: { not: null } },
    select: { id: true, signature: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const seen = new Set<string>();
  let nulled = 0;
  for (const p of signed) {
    const sig = p.signature as string;
    if (seen.has(sig)) {
      await db.post.update({ where: { id: p.id }, data: { signature: null } });
      nulled++;
    } else {
      seen.add(sig);
    }
  }

  // 2. backfill des compteurs dénormalisés (2 requêtes SQL, O(n) chacune)
  await db.$executeRawUnsafe(
    `UPDATE Post SET likeCount = (SELECT COUNT(*) FROM Like WHERE Like.postId = Post.id)`
  );
  await db.$executeRawUnsafe(
    `UPDATE Post SET replyCount = (SELECT COUNT(*) FROM Post AS child WHERE child.parentId = Post.id)`
  );

  const [posts, likes, sumLike, sumReply] = await Promise.all([
    db.post.count(),
    db.like.count(),
    db.post.aggregate({ _sum: { likeCount: true } }),
    db.post.aggregate({ _sum: { replyCount: true } }),
  ]);
  console.log(
    `✓ signatures dédoublonnées : ${nulled} remises à NULL · ` +
      `posts=${posts} · likes=${likes} · ΣlikeCount=${sumLike._sum.likeCount} · ΣreplyCount=${sumReply._sum.replyCount}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
