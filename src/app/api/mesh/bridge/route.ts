import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { toPostDto } from "@/lib/mbote/dto";
import { relayNotify } from "@/lib/mbote/relay-notify";
import {
  PAYLOAD_MAX_BYTES,
  PKT_PUBLIC,
  PROTOCOL_VERSION,
  TTL_MAX,
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
import {
  clientIp,
  getFragmentAssembler,
  getRateStore,
  trackApiRequest,
} from "@/lib/mbote/state-store";
import { checkDmReplay } from "@/lib/mbote/anti-replay";
import { prismaReplayStore } from "@/lib/mbote/anti-replay-prisma";
import { isValidPubkeyFormat } from "@/lib/mbote/proof";
import { verifyPostSignature } from "@/lib/mbote/verify";

export const dynamic = "force-dynamic";

const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;
const MAX_BATCH = 64;
const DOWNLINK_MAX = 50;
const BRIDGE_PER_MIN_PER_GATEWAY = 120;
const BRIDGE_PER_MIN_PER_IP = 240;
const RATE_WINDOW_MS = 60_000;

/** réassembleur des paquets fragmentés — singleton pluggable (D2) :
 *  mémoire aujourd'hui, store partagé (Redis) au Palier 1, sans changer la route */
const assembler = getFragmentAssembler();

/** F-30 : dédup persistante cryptographique (SHA-256) — l'ancien FNV-64
 *  (non cryptographique) permettait des collisions forgées qui masquaient
 *  des paquets légitimes ou laissaient passer du rejeu. L'empreinte de la
 *  requête (hash d'entrée) est comptée en hex SHA-256 sur les octets bruts. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
  const done = trackApiRequest("bridge.post");
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

    // ── rate limit (D4) : les passerelles burstent le matin — on plafonne ──
    const rates = getRateStore();
    const byGw = rates.hit(
      `bridge:${gatewayId}`,
      BRIDGE_PER_MIN_PER_GATEWAY,
      RATE_WINDOW_MS
    );
    const byIp = rates.hit(
      `bridge-ip:${clientIp(req.headers)}`,
      BRIDGE_PER_MIN_PER_IP,
      RATE_WINDOW_MS
    );
    if (!byGw.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byGw.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de lots — réessayez plus tard" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

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
        hash = sha256Hex(bytes);

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

        if (event.kind === "announce") {
          // F-01 : un announce mesh n'est PAS signé (protocole v1) → création
          // seule : jamais d'écrasement d'une identité existante (usurpation
          // du pseudo/bio/ecdhPub par un tiers). Les identités prouvées
          // (posts signés, /api/identity) restent les seules voies de mise à jour.
          if (!isValidPubkeyFormat(event.pubkey)) {
            throw new Error("clé publique d'émetteur invalide");
          }
          const existing = await db.user.findUnique({ where: { pubkey: event.pubkey } });
          if (!existing) {
            await db.user.create({
              data: {
                pubkey: event.pubkey,
                nickname: event.nickname.slice(0, 32) || "pair-mesh",
                ecdhPub: event.ecdhPub ?? null,
              },
            });
          }
        }

        if (event.kind === "post") {
          // F-01 : signature ECDSA OBLIGATOIRE et vérifiée pour toute
          // publication entrant par le pont — sinon rejet du paquet.
          if (typeof event.signature !== "string" || event.signature.length === 0) {
            throw new Error("publication non signée (rejetée)");
          }
          const sigCheck = await verifyPostSignature({
            pubkey: event.pubkey,
            content: String(event.content ?? ""),
            ts: event.ts,
            signature: event.signature,
          });
          if (!sigCheck.valid) {
            throw new Error(`signature refusée : ${sigCheck.reason ?? "invalide"}`);
          }

          const text = String(event.content ?? "").trim();
          if (!text || text.length > 500) throw new Error("contenu invalide");
          if (event.geohash && !GEOHASH_RE.test(event.geohash)) {
            throw new Error("geohash invalide");
          }
          // Identité PROUVÉE par la signature ci-dessus → upsert complet autorisé
          const author = await db.user.upsert({
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

          // idempotence inter-canaux (D4) : le même événement signé arrivé
          // à la fois par le web et par une passerelle mesh = UN seul post.
          try {
            const post = await db.$transaction(async (tx) => {
              const created = await tx.post.create({
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
              });
              if (event.parentId) {
                await tx.post.update({
                  where: { id: event.parentId },
                  data: { replyCount: { increment: 1 } },
                });
              }
              return created;
            });
            const postDto = toPostDto({
              ...post,
              author: {
                ...author,
                _count: { posts: 0, followers: 0, following: 0 },
              },
            });
            createdPosts.push(postDto);
            relayNotify(
              "post:new",
              { post: postDto },
              post.geohash ? ["feed", `channel:${post.geohash}`] : ["feed"]
            );
            results.push({ hash, status: "accepted", detail: `publication · ${hops} saut(s)` });
          } catch (err) {
            if (
              typeof err === "object" &&
              err !== null &&
              "code" in err &&
              (err as { code?: string }).code === "P2002"
            ) {
              results.push({
                hash,
                status: "duplicate",
                detail: "déjà ingéré via un autre canal (signature identique)",
              });
              continue;
            }
            throw err;
          }
        } else if (event.kind === "dm") {
          // A1 : anti-rejeu UNIFIÉ — la garde est LIÉE AU PAYLOAD
          // (sender|recipient|iv|ciphertext) : ré-emballer le même DM dans un
          // nouveau paquet (nouveau TTL/timestamp, msgId/seq forgés — les
          // événements dm du pont ne sont pas signés, par conception E2EE)
          // reste un doublon. Ts hors fenêtre (7 j / futur) → invalid.
          const verdict = await checkDmReplay(prismaReplayStore(), {
            senderKey: event.senderPub,
            recipientKey: event.recipientPub,
            iv: event.iv,
            ciphertext: event.ciphertext,
            ts: event.ts,
            msgId: event.msgId ?? null,
            // A1 : seq NON opposable sur le pont — elle n'y est pas couverte par
            // une signature (événements dm opaques) ; l'imposer permettrait à un
            // tiers d'empoisonner le compteur de la conversation (DoS). Sur le
            // pont, la seule barrière est la garde liée au payload. Le seq
            // transporté reste stocké comme métadonnée.
            seq: null,
          });
          if (!verdict.ok) {
            if (verdict.outcome === "duplicate") {
              duplicates++;
              results.push({
                hash,
                status: "duplicate",
                detail: `anti-rejeu : ${verdict.reason}`,
              });
            } else {
              invalid++;
              results.push({
                hash,
                status: "invalid",
                detail: `anti-rejeu : ${verdict.reason}`,
              });
            }
            continue;
          }
          await db.directMessage.create({
            data: {
              senderKey: event.senderPub,
              recipientKey: event.recipientPub,
              iv: event.iv,
              ciphertext: event.ciphertext,
              ...(event.msgId ? { msgId: event.msgId, seq: event.seq ?? null } : {}),
            },
          });
          results.push({ hash, status: "accepted", detail: "DM scellé déposé (opaque, garde anti-rejeu)" });
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
  } finally {
    done();
  }
}

/** GET /api/mesh/bridge?gatewayId=…&since=<iso> — downlink pour la passerelle
 *
 *  La passerelle récupère les publications récentes déjà encodées en paquets
 *  BitChat (base64) pour les redistribuer localement en BLE aux appareils
 *  hors-ligne à portée. C'est le retour du store-and-forward.
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("bridge.get");
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
        // F-16 : l'horodatage SOCIAL de l'événement est en millisecondes,
        // comme les clients web/mobile qui signent `${pubkey}|${content}|${ts}`.
        // (L'en-tête du paquet BLE reste en secondes — spec protocole.)
        ts: p.createdAt.getTime(),
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
  } finally {
    done();
  }
}
