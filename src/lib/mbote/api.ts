"use client";

import type {
  ChannelAgg,
  DirectMessageDto,
  NetworkStats,
  PostWithMeta,
  UserPublic,
} from "./types";

/** Délai par défaut des appels API (F-32) — abort propre au lieu d'un fetch suspendu */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * F-28/F-31 : erreur HTTP TYPÉE — le statut voyage avec l'erreur, ce qui
 * permet aux appelants (rollback du like optimiste, purge de l'outbox)
 * de distinguer une erreur DÉFINITIVE (4xx : inutile de retester) d'une
 * erreur de transport (réseau : retest → outbox).
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Le rejet est-il une erreur HTTP définitive (4xx, hors 429 rate-limit) ? */
export function isDefinitiveApiError(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
}

async function jsonFetch<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`Délai dépassé (${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s)`)),
    timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(
        (body as { error?: string }).error ?? `HTTP ${res.status}`,
        res.status
      );
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
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

interface FeedParams {
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

function feedUrl(p: FeedParams): string {
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

// ---------- DMs ----------

/** F-07 : preuve de possession requise pour TOUTE lecture de boîte DM. */
interface DmReadProof {
  /** horodatage de la signature (ms) — fenêtre courte côté serveur */
  ts: number;
  /** signature ECDSA sur `${me}|dm-read|${peer ou *}|${ts}` */
  signature: string;
}

export function apiGetConversation(me: string, peer: string, proof: DmReadProof) {
  const q = new URLSearchParams({
    me,
    peer,
    ts: String(proof.ts),
    signature: proof.signature,
  });
  return jsonFetch<{ messages: DirectMessageDto[] }>(`/api/dms?${q.toString()}`);
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

export function apiGetConversations(me: string, proof: DmReadProof) {
  const q = new URLSearchParams({
    me,
    ts: String(proof.ts),
    signature: proof.signature,
  });
  return jsonFetch<{
    conversations: { peer: UserPublic; last: DirectMessageDto | null; unread: number }[];
  }>(`/api/dms/conversations?${q.toString()}`);
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
