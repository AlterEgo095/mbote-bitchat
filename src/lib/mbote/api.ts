"use client";

import type {
  ChannelAgg,
  DirectMessageDto,
  NetworkStats,
  PostWithMeta,
  UserPublic,
} from "./types";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------- identité ----------

export function apiUpsertIdentity(payload: {
  pubkey: string;
  nickname: string;
  bio?: string;
  ecdhPub: string;
  /** preuve de possession (F-01) : horodatage signé + signature ECDSA */
  ts: number;
  signature: string;
}) {
  return jsonFetch<{ user: UserPublic }>("/api/identity", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function apiGetUser(pubkey: string) {
  return jsonFetch<{ user: UserPublic | null }>(
    `/api/identity?pubkey=${encodeURIComponent(pubkey)}`
  );
}

export function apiListUsers() {
  return jsonFetch<{ users: UserPublic[] }>("/api/users");
}

// ---------- posts ----------

export type FeedScope = "global" | "channel" | "user" | "replies" | "following";

export interface FeedParams {
  scope: FeedScope;
  geohash?: string;
  precision?: number;
  authorPub?: string;
  parentId?: string;
  myPub?: string;
  limit?: number;
  /** curseur de pagination (renvoyé par la réponse précédente : nextCursor) */
  before?: string;
}

export function feedUrl(p: FeedParams): string {
  const q = new URLSearchParams({ scope: p.scope });
  if (p.geohash) q.set("geohash", p.geohash);
  if (p.precision != null) q.set("precision", String(p.precision));
  if (p.authorPub) q.set("authorPub", p.authorPub);
  if (p.parentId) q.set("parentId", p.parentId);
  if (p.myPub) q.set("myPub", p.myPub);
  if (p.before) q.set("before", p.before);
  q.set("limit", String(p.limit ?? 50));
  return `/api/posts?${q.toString()}`;
}

export function apiFetchFeed(p: FeedParams) {
  return jsonFetch<{ posts: PostWithMeta[]; nextCursor?: string | null }>(feedUrl(p));
}

export function apiCreatePost(payload: {
  pubkey: string;
  content: string;
  geohash?: string | null;
  precision?: number | null;
  parentId?: string | null;
  signature?: string | null;
  /** horodatage SIGNÉ (ms) — requis pour vérifier la signature côté serveur */
  ts?: number;
}) {
  return jsonFetch<{ post: PostWithMeta; duplicate?: boolean }>("/api/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function apiToggleLike(payload: {
  pubkey: string;
  postId: string;
  /** preuve de possession (F-01) */
  ts: number;
  signature: string;
}) {
  return jsonFetch<{ liked: boolean; likeCount: number }>("/api/posts/like", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ---------- follows ----------

export function apiSetFollow(payload: {
  followerPub: string;
  targetPub: string;
  action: "follow" | "unfollow";
  /** preuve de possession (F-01) */
  ts: number;
  signature: string;
}) {
  return jsonFetch<{ following: boolean }>("/api/follows", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function apiGetFollow(followerPub: string, targetPub: string) {
  return jsonFetch<{ following: boolean }>(
    `/api/follows?followerPub=${encodeURIComponent(followerPub)}&targetPub=${encodeURIComponent(targetPub)}`
  );
}

// ---------- DMs ----------

export function apiGetConversation(me: string, peer: string) {
  return jsonFetch<{ messages: DirectMessageDto[] }>(
    `/api/dms?me=${encodeURIComponent(me)}&peer=${encodeURIComponent(peer)}`
  );
}

export function apiSendDm(payload: {
  senderKey: string;
  recipientKey: string;
  iv: string;
  ciphertext: string;
  /** preuve de possession (F-01) */
  ts: number;
  signature: string;
}) {
  return jsonFetch<{ message: DirectMessageDto }>("/api/dms", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function apiGetConversations(me: string) {
  return jsonFetch<{
    conversations: { peer: UserPublic; last: DirectMessageDto | null; unread: number }[];
  }>(`/api/dms/conversations?me=${encodeURIComponent(me)}`);
}

export function apiBotReply(payload: { meKey: string; iv: string; ciphertext: string }) {
  return jsonFetch<{ message: DirectMessageDto }>("/api/dms/bot", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ---------- canaux / stats ----------

export function apiFetchChannels(precision?: number) {
  const q = precision != null ? `?precision=${precision}` : "";
  return jsonFetch<{ channels: ChannelAgg[] }>(`/api/channels${q}`);
}

export function apiFetchStats() {
  return jsonFetch<NetworkStats>("/api/stats");
}

// ---------- passerelle BitChat (mesh ↔ VPS) ----------

export interface BridgeResult {
  received: number;
  accepted: number;
  duplicates: number;
  invalid: number;
  results: { hash: string; status: string; detail?: string }[];
  posts: PostWithMeta[];
}

/** Dépose les paquets mesh (base64) comme le fait une passerelle native */
export function apiBridgePost(payload: { gatewayId: string; label?: string; packets: string[] }) {
  return jsonFetch<BridgeResult>("/api/mesh/bridge", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface BridgeDownlink {
  since: string;
  packets: { id: string; base64: string; bytes: number; geohash: string | null }[];
  stats: {
    ingested24h: number;
    totalIngested: number;
    avgHops: number;
    gateways: {
      id: string;
      label: string | null;
      lastSeen: string;
      packetsIn: number;
      packetsOut: number;
    }[];
  };
}

/** Le downlink : paquets BitChat à redistribuer localement en BLE */
export function apiBridgeDownlink(gatewayId: string, since?: string) {
  const q = new URLSearchParams({ gatewayId });
  if (since) q.set("since", since);
  return jsonFetch<BridgeDownlink>(`/api/mesh/bridge?${q.toString()}`);
}
