import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";
import {
  PAYLOAD_MAX_BYTES,
  PKT_PUBLIC,
  PROTOCOL_VERSION,
  TTL_MAX,
  FragmentAssembler,
  base64ToBytes,
  bytesToBase64,
  decodeMeshEvent,
  decodePacket,
  encodeMeshEvent,
  encodePacket,
  fnv64,
  fragmentPayload,
  senderIdFromPubkey,
  utf8Encode,
  type MeshEvent,
} from "@/lib/mbote/bitchat-protocol";

export const dynamic = "force-dynamic";

const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;
const INGEST_TTL_MS = 6 * 60 * 60 * 1000; // dédup persistante : fenêtre 6 h (comme la gossip window)
const MAX_BATCH = 64;
const DOWNLINK_MAX = 50;

/** réassembleur des paquets fragmentés (fragId → chunks), en mémoire process */
const assembler = new FragmentAssembler();

/** senderID fixe du serveur (b64url de "serverdownlink") pour les paquets downlink */
const SERVER_PUBKEY_B64 = "c2VydmV1cmRvd25saW5r";

/** POST /api/mesh/bridge — le dépôt de paquets d'une passerelle native
 *
 *  Une passerelle (app native BitChat, Raspberry Pi avec BT…) accumule des
 *  paquets mesh hors-ligne puis les remonte ici dès qu'elle trouve internet
 *  (store-and-forward). Le serveur déduplique, crée les entités sociales et
 *  répond paquet par paquet pour que la passerelle purge sa file locale.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const gatewayId: string = String(body?.gatewayId ?? "").trim();
    const label = typeof body?.label === "string" ? body.label.slice(0, 60) : undefined;
    const packets: unknown[] = Array.isArray(body?.packets) ? body.packets : [];

    if (!gatewayId || gatewayId.length < 4) {
      return NextResponse.json({ error: "gatewayId requis (≥ 4 caractères)" }, { status: 400 });
    }
    if (packets.length === 0) {
      return NextResponse.json({ error: "packets[] vide" }, { status: 400 });
    }
    if (packets.length > MAX_BATCH) {
      return NextResponse.json({ error: `max ${MAX_BATCH} paquets par lot` }, { status: 400 });
    }

    // purge de la dédup expirée (fenêtre 6 h)
    await db.meshIngest
      .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - INGEST_TTL_MS) } } })
      .catch(() => undefined);

    const results: {
      hash: string;
      status: "accepted" | "duplicate" | "invalid";
      detail?: string;
    }[] = [];
    const createdPosts: unknown[] = [];
    let invalid = 0;
    let duplicates = 0;

    for (const raw of packets) {
      let bytes: Uint8Array;
      let hash = "";
      try {
        if (typeof raw !== "string") throw new Error("paquet non base64");
        bytes = base64ToBytes(raw);
        hash = fnv64(bytes);

        // dédup persistante (le même paquet peut arriver de plusieurs passerelles)
        const already = await db.meshIngest.findUnique({ where: { hash } });
        if (already) {
          duplicates++;
          results.push({ hash, status: "duplicate", detail: "déjà ingéré (fenêtre 6 h)" });
          continue;
        }

        const pkt = decodePacket(bytes);
        const hops = Math.max(0, TTL_MAX - pkt.ttl);

        // marque ingéré AVANT traitement (un paquet = une entité, jamais deux)
        await db.meshIngest.create({
          data: { hash, gatewayId, type: pkt.type, hops },
        });

        // payload complet, ou fragment d'un paquet fragmenté (§2 whitepaper) :
        // le serveur réassemble comme le ferait un pair BitChat (jusqu'à 1 MiB)
        let event: MeshEvent;
        try {
          event = decodeMeshEvent(pkt.payload);
        } catch {
          const fragIndex = pkt.payload[2];
          const fragTotal = pkt.payload[3];
          if (pkt.payload.length <= 4 || fragTotal < 2) {
            throw new Error("payload illisible (ni JSON ni fragment valide)");
          }
          const full = assembler.push(pkt.payload);
          if (!full) {
            results.push({
              hash,
              status: "accepted",
              detail: `fragment ${fragIndex + 1}/${fragTotal} en attente de réassembly`,
            });
            continue;
          }
          event = decodeMeshEvent(full);
        }

        if (event.kind === "announce" || event.kind === "post") {
          // ANNOUNCE implicite : l'événement porte l'identité complète
          await db.user.upsert({
            where: { pubkey: event.pubkey },
            update: {
              nickname: event.nickname.slice(0, 32),
              ...(event.ecdhPub ? { ecdhPub: event.ecdhPub } : {}),
            },
            create: {
              pubkey: event.pubkey,
              nickname: event.nickname.slice(0, 32) || "pair-mesh",
              ecdhPub: event.ecdhPub ?? null,
            },
          });
        }

        if (event.kind === "post") {
          const text = String(event.content ?? "").trim();
          if (!text || text.length > 500) throw new Error("contenu invalide");
          if (event.geohash && !GEOHASH_RE.test(event.geohash)) {
            throw new Error("geohash invalide");
          }
          const author = await db.user.findUnique({ where: { pubkey: event.pubkey } });
          if (!author) throw new Error("identité introuvable après upsert");

          const post = await db.post.create({
            data: {
              authorId: author.id,
              content: text,
              geohash: event.geohash ?? null,
              precision: event.precision ?? null,
              parentId: event.parentId ?? null,
              signature: event.signature ?? null,
              origin: "mesh",
              meshHops: hops,
            },
            include: {
              author: {
                include: { _count: { select: { posts: true, followers: true, following: true } } },
              },
              _count: { select: { likes: true, replies: true } },
            },
          });
          const postDto = {
            id: post.id,
            content: post.content,
            geohash: post.geohash,
            precision: post.precision,
            parentId: post.parentId,
            signature: post.signature,
            origin: post.origin,
            meshHops: post.meshHops,
            createdAt: post.createdAt,
            author: post.author,
            likeCount: post._count.likes,
            replyCount: post._count.replies,
            likedByMe: false,
          };
          createdPosts.push(postDto);
          relayNotify(
            "post:new",
            { post: postDto },
            post.geohash ? ["feed", `channel:${post.geohash}`] : ["feed"]
          );
          results.push({ hash, status: "accepted", detail: `publication · ${hops} saut(s)` });
        } else if (event.kind === "dm") {
          await db.directMessage.create({
            data: {
              senderKey: event.senderPub,
              recipientKey: event.recipientPub,
              iv: event.iv,
              ciphertext: event.ciphertext,
            },
          });
          results.push({ hash, status: "accepted", detail: "DM scellé déposé (opaque)" });
        } else if (event.kind === "announce") {
          results.push({ hash, status: "accepted", detail: "présence enregistrée" });
        } else {
          results.push({ hash, status: "accepted", detail: "gossip comptabilisé" });
        }
      } catch (e) {
        invalid++;
        results.push({
          hash: hash || "-",
          status: "invalid",
          detail: e instanceof Error ? e.message : "paquet illisible",
        });
      }
    }

    // trace la passerelle
    await db.gatewayNode
      .upsert({
        where: { id: gatewayId },
        update: {
          packetsIn: { increment: packets.length - duplicates - invalid },
          ...(label ? { label } : {}),
        },
        create: {
          id: gatewayId,
          label: label ?? "passerelle sans nom",
          packetsIn: packets.length - duplicates - invalid,
        },
      })
      .catch(() => undefined);

    return NextResponse.json({
      received: packets.length,
      accepted: results.filter((r) => r.status === "accepted").length,
      duplicates,
      invalid,
      results,
      posts: createdPosts,
    });
  } catch (e) {
    console.error("POST /api/mesh/bridge", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

/** GET /api/mesh/bridge?gatewayId=…&since=<iso> — downlink pour la passerelle
 *
 *  La passerelle récupère les publications récentes déjà encodées en paquets
 *  BitChat (base64) pour les redistribuer localement en BLE aux appareils
 *  hors-ligne à portée. C'est le retour du store-and-forward.
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const gatewayId = sp.get("gatewayId") ?? "";
    const sinceStr = sp.get("since");
    const since = sinceStr ? new Date(sinceStr) : new Date(Date.now() - 60 * 60 * 1000);
    if (Number.isNaN(since.getTime())) {
      return NextResponse.json({ error: "since invalide (ISO)" }, { status: 400 });
    }

    const posts = await db.post.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      take: DOWNLINK_MAX,
      include: { author: true },
    });

    const now = Math.floor(Date.now() / 1000);
    const senderId = senderIdFromPubkey(SERVER_PUBKEY_B64);
    const packets = posts.flatMap((p) => {
      const ev: MeshEvent = {
        kind: "post",
        clientRef: p.id,
        pubkey: p.author.pubkey,
        nickname: p.author.nickname,
        ecdhPub: p.author.ecdhPub ?? undefined,
        content: p.content,
        geohash: p.geohash,
        precision: p.precision,
        parentId: p.parentId,
        signature: p.signature,
        ts: Math.floor(p.createdAt.getTime() / 1000),
      };
      const payload = encodeMeshEvent(ev);
      // ≤ 452 o → un seul paquet ; sinon fragmentation BitChat (fragId stable)
      const chunks: Uint8Array[] = [];
      if (payload.length <= PAYLOAD_MAX_BYTES) {
        chunks.push(payload);
      } else {
        const fragId = parseInt(fnv64(utf8Encode(p.id)).slice(0, 4), 16);
        chunks.push(...fragmentPayload(payload, fragId));
      }
      return chunks.map((chunk, i) => {
        const bytes = encodePacket({
          version: PROTOCOL_VERSION,
          type: PKT_PUBLIC,
          ttl: TTL_MAX,
          senderId,
          timestamp: now,
          payloadLen: chunk.length,
          payload: chunk,
        });
        return {
          id: p.id,
          base64: bytesToBase64(bytes),
          bytes: bytes.length,
          geohash: p.geohash,
          fragment:
            chunks.length > 1 ? { index: i, total: chunks.length } : null,
        };
      });
    });

    if (gatewayId) {
      await db.gatewayNode
        .upsert({
          where: { id: gatewayId },
          update: { packetsOut: { increment: packets.length } },
          create: { id: gatewayId, label: "passerelle sans nom", packetsOut: packets.length },
        })
        .catch(() => undefined);
    }

    // statistiques mesh du serveur
    const [ingested24h, gateways, hopAgg] = await Promise.all([
      db.meshIngest.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } } }),
      db.gatewayNode.findMany({ orderBy: { lastSeen: "desc" }, take: 10 }),
      db.meshIngest.aggregate({ _avg: { hops: true }, _count: { _all: true } }),
    ]);

    return NextResponse.json({
      since: since.toISOString(),
      packets,
      stats: {
        ingested24h,
        totalIngested: hopAgg._count._all,
        avgHops: hopAgg._avg.hops ?? 0,
        gateways: gateways.map((g) => ({
          id: g.id,
          label: g.label,
          lastSeen: g.lastSeen,
          packetsIn: g.packetsIn,
          packetsOut: g.packetsOut,
        })),
      },
    });
  } catch (e) {
    console.error("GET /api/mesh/bridge", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
