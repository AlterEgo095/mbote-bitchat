/**
 * DTO partagé des posts — une seule définition de la sérialisation, utilisée
 * par /api/posts, /api/mesh/bridge et partout où un Post doit partir en JSON.
 * Les compteurs viennent des COLONNES dénormalisées (D5), plus aucun COUNT.
 */

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
    avatarSeed: string | null;
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
  avatarSeed: string | null;
  ecdhPub: string | null;
  isBot: boolean;
  createdAt: Date;
  _count?: { posts: number; followers: number; following: number };
}

export function toUserDto(u: UserPrivateRow) {
  return {
    id: u.id,
    pubkey: u.pubkey,
    nickname: u.nickname,
    bio: u.bio,
    avatarSeed: u.avatarSeed,
    ecdhPub: u.ecdhPub,
    isBot: u.isBot,
    createdAt: u.createdAt,
    ...(u._count ? { _count: u._count } : {}),
  };
}
