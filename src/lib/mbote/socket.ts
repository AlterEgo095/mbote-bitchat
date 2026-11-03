"use client";

/**
 * Connexion socket.io unique du client Mbote Mesh.
 * ⚠️ Toujours via la passerelle Caddy : io('/?XTransformPort=3030'), path '/'.
 * Jamais de port ni d'URL absolue côté navigateur.
 */

import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // VPS : NEXT_PUBLIC_SOCKET_URL = URL publique du hub (ex. https://socket.mondomaine.net)
    // Sandbox Z.ai : pas d'URL → la passerelle Caddy route chaque requête engine.io
    // portant la query XTransformPort vers le hub. Le pattern io('/?XTransformPort=…')
    // perd la query : on la passe donc via les options engine.io, qui l'ajoutent à
    // TOUTES les URLs de transport (polling ET websocket).
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;
    socket = io(socketUrl, {
      query: socketUrl ? undefined : { XTransformPort: "3030" },
      transports: ["websocket", "polling"],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 8000,
      timeout: 10000,
    });
  }
  return socket;
}

/** Événements diffusés par le relay */
export interface RealtimePostPayload {
  post: {
    id: string;
    content: string;
    geohash: string | null;
    precision: number | null;
    parentId: string | null;
    signature: string | null;
    createdAt: string;
    author: unknown;
    likeCount: number;
    replyCount: number;
    likedByMe: boolean;
  };
}

export interface RealtimeLikePayload {
  postId: string;
  likeCount: number;
  liked: boolean;
  pubkey: string;
}

export interface RealtimeDmPayload {
  message: {
    id: string;
    senderKey: string;
    recipientKey: string;
    iv: string;
    ciphertext: string;
    createdAt: string;
    readAt: string | null;
  };
}

export interface RealtimePresencePayload {
  online: number;
}
