/**
 * DTO partagé des posts — une seule définition de la sérialisation, utilisée
 * par /api/posts, /api/mesh/bridge et partout où un Post doit partir en JSON.
 * Les compteurs viennent des COLONNES dénormalisées (D5), plus aucun COUNT.
 */

// D2 — réputation/plafonds (module pur isomorphe, sans dépendance node)
import { dailyLimits, reputationTier, utcDay } from "./sybil";

export interface PostLikeRow {
  id: string;
  content: string;
  geohash: string | null;
  precision: number | null;
  parentId: string | null;
  signature: string | null;
  origin: string;
  meshHops: number;
  likeCount: number;
  replyCount: number;
  createdAt: Date;
  author: {
    id: string;
    pubkey: string;
    nickname: string;
    bio: string | null;
    ecdhPub: string | null;
    isBot: boolean;
    createdAt: Date;
    _count?: { posts: number; followers: number; following: number };
  };
}

export function toPostDto(p: PostLikeRow, likedByMe = false) {
  return {
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
    likeCount: p.likeCount,
    replyCount: p.replyCount,
    likedByMe,
  };
}

/**
 * DTO partagé des identités — SEULE sérialisation autorisée d'une ligne User.
 * `botPriv` (clé privée ECDH du bot de démo) ne quitte JAMAIS le serveur :
 * découverte Vague 3 — `GET /api/users`, `GET/POST /api/identity` et
 * `GET /api/dms/conversations` renvoyaient la ligne Prisma brute, clé privée
 * du bot comprise (décryptage + usurpation du bot par quiconque).
 */
export interface UserPrivateRow {
  id: string;
  pubkey: string;
  nickname: string;
  bio: string | null;
  ecdhPub: string | null;
  isBot: boolean;
  createdAt: Date;
  /** D2 — champs de réputation/plafonds (optionnels : les anciens appels
   *  sans select D2 continuent de sérialiser sans eux). */
  reputationScore?: number;
  flaggedCount?: number;
  postsToday?: number;
  dmsToday?: number;
  usageDay?: string | null;
  _count?: { posts: number; followers: number; following: number };
}

/** Quota quotidien exposé au client (D2) — calculé à la volée depuis les
 *  compteurs dénormalisés (reset paresseux appliqué en LECTURE pour l'affiche,
 *  l'écriture du reset reste aux points d'application). */
export function toUserQuotaDto(u: {
  reputationScore?: number;
  postsToday?: number;
  dmsToday?: number;
  usageDay?: string | null;
}) {
  const now = new Date();
  const today = utcDay(now);
  const freshPosts = u.usageDay === today ? (u.postsToday ?? 0) : 0;
  const freshDms = u.usageDay === today ? (u.dmsToday ?? 0) : 0;
  const score = u.reputationScore ?? 0;
  const limits = dailyLimits(score);
  const posts = {
    limit: limits.posts,
    used: freshPosts,
    remaining: Number.isFinite(limits.posts)
      ? Math.max(0, limits.posts - freshPosts)
      : null, // null = pas de plafond affichable
  };
  const dms = {
    limit: Number.isFinite(limits.dms) ? limits.dms : null,
    used: freshDms,
    remaining: Number.isFinite(limits.dms)
      ? Math.max(0, limits.dms - freshDms)
      : null,
  };
  return { reputationScore: score, tier: reputationTier(score), posts, dms };
}

export function toUserDto(u: UserPrivateRow) {
  return {
    id: u.id,
    pubkey: u.pubkey,
    nickname: u.nickname,
    bio: u.bio,
    ecdhPub: u.ecdhPub,
    isBot: u.isBot,
    createdAt: u.createdAt,
    // D2 : réputation + plafonds QUAND la ligne les porte (select D2) —
    // jamais botPriv ni aucune donnée privée.
    ...(u.reputationScore !== undefined
      ? { quota: toUserQuotaDto(u), flaggedCount: u.flaggedCount ?? 0 }
      : {}),
    ...(u._count ? { _count: u._count } : {}),
  };
}
