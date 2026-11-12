import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { trackApiRequest } from "@/lib/mbote/state-store";
import {
  readJson,
  unauthorized,
  verifyGroupProof,
  rateLimit,
  isActiveMember,
  activeMemberKeys,
  MLS_MESSAGE_MAX,
} from "@/lib/mbote/mls/server";

export const dynamic = "force-dynamic";

// ── C4 — POST/GET /api/groups/[id]/messages ──────────────────────────────────
// POST : ciphertext MLS OPAQUE (PrivateMessage wire b64). INVARIANT SERVEUR :
// aucun plaintext n'existe côté serveur — le payload est stocké tel quel.
// GET : les ciphertexts des membres actifs (l'exclu ne lit plus rien — mais
// reçoit une liste vide uniforme, pas d'information).

const MSG_POST_PER_MIN = 60;
const MSG_GET_PER_MIN = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("groups.messages.post");
  try {
    const { id } = await params;
    const body = await readJson(req);
    const me = typeof body.me === "string" ? body.me : "";
    if (!me) return unauthorized();
    if (!(await verifyGroupProof(`${me}|group-msg|${id}`, me, body.ts, body.signature))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "group-msg", MSG_POST_PER_MIN, me);
    if (rl) return rl;

    if (!(await isActiveMember(id, me))) {
      return NextResponse.json({ error: "membre inactif ou groupe inconnu" }, { status: 403 });
    }
    const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
    if (!ciphertext || ciphertext.length > MLS_MESSAGE_MAX) {
      return NextResponse.json({ error: "ciphertext requis (≤ 16 Ko)" }, { status: 400 });
    }
    const epochRaw = body.mlsEpoch;
    const mlsEpoch = typeof epochRaw === "number" || typeof epochRaw === "string" ? BigInt(epochRaw) : null;
    if (mlsEpoch === null || mlsEpoch < 0n) {
      return NextResponse.json({ error: "mlsEpoch requis" }, { status: 400 });
    }

    const message = await db.groupMessage.create({
      data: { groupId: id, senderKey: me, mlsEpoch, ciphertext },
      select: { id: true, createdAt: true },
    });

    // temps réel : réveiller les membres actifs (rooms DM — aucun contenu)
    const members = await activeMemberKeys(id);
    relayNotify(
      "group-envelope",
      { groupId: id, kind: "message" },
      members.filter((k) => k !== me).map((k) => `dm:${k}`)
    );

    return NextResponse.json({ messageId: message.id }, { status: 201 });
  } catch (e) {
    console.error("POST /api/groups/[id]/messages", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("groups.messages.get");
  try {
    const { id } = await params;
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me") ?? "";
    if (!me) return unauthorized();
    if (!(await verifyGroupProof(`${me}|group-msgs|${id}`, me, sp.get("ts"), sp.get("signature")))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "group-msgs", MSG_GET_PER_MIN, me);
    if (rl) return rl;

    if (!(await isActiveMember(id, me))) {
      // liste vide uniforme (membre exclu = plus de contenu, pas d'énumération)
      return NextResponse.json({ messages: [] });
    }
    const rows = await db.groupMessage.findMany({
      where: { groupId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, senderKey: true, mlsEpoch: true, ciphertext: true, createdAt: true },
    });
    return NextResponse.json({
      messages: rows.map((r) => ({
        id: r.id,
        senderKey: r.senderKey,
        mlsEpoch: r.mlsEpoch.toString(),
        ciphertext: r.ciphertext,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    console.error("GET /api/groups/[id]/messages", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
