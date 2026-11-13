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

/**
 * F (Clarification 3) — mapping central statut → message FR actionnable.
 * Couvre TOUS les codes réellement émis par les routes (inventaire :
 * grep 'status: [0-9]+' src/app/api/ admin/src/app/api/ → 400, 401, 403,
 * 404, 405, 409, 410, 413, 422, 429, 500 (app) + 502, 400 (BFF admin)
 * + 503 (pile média) — plus des défauts honnêtes pour tout le reste).
 * Le message serveur (déjà FR sur la plupart des routes) reste prioritaire :
 * ce mapping n'est le fallback QUE quand body.error est absent ou brut.
 */
export function describeApiStatus(status: number): string {
  switch (status) {
    case 400:
      return "Requête invalide — vérifie le contenu envoyé puis réessaie.";
    case 401:
      return "Session absente ou expirée — reconnecte-toi (ou recrée ton identité locale).";
    case 403:
      return "Action refusée — ton rôle ou la frontière du canal ne le permet pas.";
    case 404:
      return "Ressource introuvable — elle a peut-être été supprimée entre-temps.";
    case 405:
      return "Action non supportée par le serveur — mets à jour l'application.";
    case 409:
      return "Conflit — l'élément existe déjà ou son état a changé depuis l'affichage.";
    case 410:
      return "Élément expiré — refais l'action avec un élément neuf (les intentions four-eyes vivent 1 h).";
    case 413:
      return "Contenu trop volumineux — réduis la taille du fichier ou du message.";
    case 422:
      return "Contenu refusé par la validation — corrige le formulaire (justification, format…) puis renvoie.";
    case 429:
      return "Trop de requêtes — patiente un instant avant de réessayer.";
    case 500:
      return "Erreur côté serveur — réessaie dans un instant.";
    case 502:
      return "Liaison avec le service interrompue — réessaie dans un instant.";
    case 503:
      return "Service momentanément indisponible — réessaie plus tard.";
    default:
      return status >= 500
        ? "Erreur côté serveur — réessaie dans un instant."
        : "Action refusée par le serveur — réessaie.";
  }
}

/**
 * F (groupe « erreurs honnêtes ») — message FR actionnable pour l'affichage :
 * · ApiError → le message serveur s'il existe et n'est pas brut (« HTTP 429 »),
 *   sinon le mapping central du statut ;
 * · AbortError → délai dépassé ;
 * · transport/réseau → message actionnable hors-ligne ;
 * · autre Error → son message (erreurs locales déjà FR).
 */
export function describeApiError(e: unknown): string {
  if (e instanceof ApiError) {
    const raw = e.message ?? "";
    if (raw.length === 0 || /^HTTP \d{3}/.test(raw)) return describeApiStatus(e.status);
    return raw;
  }
  if (e instanceof DOMException && e.name === "AbortError") {
    return "Délai dépassé — vérifie ta connexion puis réessaie.";
  }
  if (e instanceof TypeError) {
    return "Réseau injoignable — ton action reste en file locale et partira au retour du réseau.";
  }
  if (e instanceof Error && e.message.length > 0) return e.message;
  return "Une erreur inattendue est survenue — réessaie.";
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
      const serverError = (body as { error?: unknown }).error;
      const message =
        typeof serverError === "string" && serverError.length > 0
          ? serverError
          : describeApiStatus(res.status);
      throw new ApiError(message, res.status);
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
  /** D2 — preuve de travail de CRÉATION (nonce, 20 bits). Absent si le PoW
   *  n'a pas pu être calculé (worker indisponible) : le serveur refusera la
   *  création mais le payload reste rejouable dans la file courrier. */
  pow?: { nonce: string };
}) {
  return jsonFetch<{ user: UserPublic }>("/api/identity", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Quota quotidien exposé par GET/POST /api/identity (D2). */
export interface UserQuota {
  reputationScore: number;
  tier: "negative" | "neutral" | "established" | "exemplary";
  posts: { limit: number; used: number; remaining: number | null };
  dms: { limit: number | null; used: number; remaining: number | null };
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
  /** A1 v2 : identifiant client + séquence monotone (signés dm2) */
  msgId?: string;
  seq?: number;
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

// ---------- confiance (A2 — authentification des clés) ----------

export interface TrustStatusDto {
  peerEcdhPub: string | null;
  safetyNumber: string | null;
  state: "unverified" | "verified" | "changed";
  level: "green" | "yellow" | "red";
  changedAt: string | null;
  verifiedAt: string | null;
  keyChanged: boolean;
}

/** État de confiance côté serveur (audit + détection inter-appareils). */
export function apiGetTrust(
  me: string,
  peer: string,
  proof: { ts: number; signature: string }
) {
  const q = new URLSearchParams({ me, peer, ts: String(proof.ts), signature: proof.signature });
  return jsonFetch<{ trust: TrustStatusDto }>(`/api/trust?${q.toString()}`);
}

/** Confirmation hors-bande du numéro de sécurité (audit serveur). */
export function apiVerifyTrust(payload: {
  me: string;
  peer: string;
  safetyNumber: string;
  ts: number;
  signature: string;
}) {
  return jsonFetch<{ trust: TrustStatusDto }>("/api/trust/verify", {
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

// ---------- recherche (D1) ----------

export interface SearchResultPost {
  postId: string;
  snippet: string;
  /** bm25(PostFTS) — plus petit = plus pertinent (convention SQLite) */
  rank: number;
  authorPubkey: string;
  authorNickname: string;
  createdAt: string;
}

/**
 * D1 : recherche SERVEUR du fil public uniquement. Les DM ne passent JAMAIS
 * par le réseau (searchLocalDm dans dm-search-index.ts) — frontière E2EE.
 */
export function apiSearchPosts(q: string, offset = 0, limit = 20) {
  const sp = new URLSearchParams({ q, type: "posts", limit: String(limit), offset: String(offset) });
  return jsonFetch<{
    query: string;
    ftsQuery: string;
    results: SearchResultPost[];
    hasMore: boolean;
    nextOffset: number | null;
  }>(`/api/search?${sp.toString()}`);
}

/**
 * D1 : fetch isolé d'un post public (navigation depuis la recherche — le post
 * ciblé n'est pas forcément dans la première page du fil). 404 si non public.
 */
export function apiGetPost(id: string) {
  return jsonFetch<{ post: PostWithMeta }>(`/api/posts/${encodeURIComponent(id)}`);
}
