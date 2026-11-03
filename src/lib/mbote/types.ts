export interface UserPublic {
  id: string;
  pubkey: string;
  nickname: string;
  bio?: string | null;
  avatarSeed?: string | null;
  ecdhPub?: string | null;
  isBot: boolean;
  createdAt: string;
  _count?: {
    posts: number;
    followers: number;
    following: number;
  };
}

export interface PostWithMeta {
  id: string;
  content: string;
  geohash?: string | null;
  precision?: number | null;
  parentId?: string | null;
  signature?: string | null;
  origin?: string | null; // web | mesh (arrivé via passerelle BitChat)
  meshHops?: number | null; // sauts mesh traversés
  createdAt: string;
  author: UserPublic;
  likeCount: number;
  replyCount: number;
  likedByMe: boolean;
}

export interface DirectMessageDto {
  id: string;
  senderKey: string;
  recipientKey: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
  readAt?: string | null;
}

export interface ChannelAgg {
  geohash: string;
  precision: number;
  postCount: number;
  participantCount: number;
  lastAt: string;
  label?: string | null;
}

export interface NetworkStats {
  users: number;
  posts: number;
  dms: number;
  channels: number;
  likes: number;
}

/** Post optimiste en attente de synchronisation (mode courrier hors-ligne) */
export interface PendingPost {
  clientRef: string;
  content: string;
  geohash?: string | null;
  precision?: number | null;
  queuedAt: number;
}

export type ViewKey = "feed" | "channels" | "messages" | "network" | "profile";

export interface ActiveChannel {
  geohash: string;
  precision: number;
  label: string;
}
