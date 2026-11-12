import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { trackApiRequest } from "@/lib/mbote/state-store";
import {
  readJson,
  unauthorized,
  verifyGroupProof,
  rateLimit,
  MLS_HANDSHAKE_MAX,
  GROUP_NAME_MAX,
  GROUP_MEMBERS_MAX,
} from "@/lib/mbote/mls/server";

export const dynamic = "force-dynamic";

// ── C4 — POST /api/groups (créer) · GET /api/groups (mes groupes) ────────────

const GROUP_CREATE_PER_MIN = 10;
const GROUP_LIST_PER_MIN = 30;

export async function POST(req: NextRequest) {
  const done = trackApiRequest("groups.post");
  try {
    const body = await readJson(req);
    const me = typeof body.me === "string" ? body.me : "";
    if (!me) return unauthorized();
    const mlsGroupId = typeof body.mlsGroupId === "string" ? body.mlsGroupId : "";
    if (!mlsGroupId || !/^[0-9a-f]{32,128}$/.test(mlsGroupId)) {
      return NextResponse.json({ error: "mlsGroupId hex requis (16-64 octets)" }, { status: 400 });
    }
    if (!(await verifyGroupProof(`${me}|group-create|${mlsGroupId}`, me, body.ts, body.signature))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "group-create", GROUP_CREATE_PER_MIN, me);
    if (rl) return rl;

    const name = typeof body.name === "string" ? body.name.trim().slice(0, GROUP_NAME_MAX) : "";
    if (!name) return NextResponse.json({ error: "nom de groupe requis" }, { status: 400 });
    const commit = typeof body.commit === "string" ? body.commit : "";
    const welcome = typeof body.welcome === "string" ? body.welcome : "";
    if (!commit || commit.length > MLS_HANDSHAKE_MAX || !welcome || welcome.length > MLS_HANDSHAKE_MAX) {
      return NextResponse.json({ error: "commit/welcome requis (≤ 16 Ko)" }, { status: 400 });
    }
    const members = Array.isArray(body.members)
      ? body.members.filter((m): m is string => typeof m === "string")
      : [];
    if (members.length === 0 || members.length > GROUP_MEMBERS_MAX) {
      return NextResponse.json(
        { error: `1 à ${GROUP_MEMBERS_MAX} membres invités` },
        { status: 400 }
      );
    }
    if (members.includes(me)) {
      return NextResponse.json({ error: "le créateur n'est pas dans members" }, { status: 400 });
    }
    // tous les invités doivent exister (pas de groupes fantômes)
    const known = await db.user.findMany({
      where: { pubkey: { in: members } },
      select: { pubkey: true },
    });
    if (known.length !== members.length) {
      return NextResponse.json({ error: "un ou plusieurs contacts inconnus" }, { status: 400 });
    }

    const group = await db.group.create({
      data: {
        name,
        mlsGroupId,
        creatorKey: me,
        members: {
          create: [
            { userKey: me, mlsLeafIndex: 0 },
            ...members.map((k, i) => ({ userKey: k, mlsLeafIndex: i + 1 })),
          ],
        },
        envelopes: {
          create: [
            { kind: "commit", targetKey: null, payload: commit },
            ...members.map((k) => ({ kind: "welcome", targetKey: k, payload: welcome })),
          ],
        },
      },
      select: { id: true, name: true, createdAt: true },
    });

    // temps réel : réveiller les invités (rooms DM personnelles — aucun contenu)
    relayNotify(
      "group-envelope",
      { groupId: group.id, kind: "welcome" },
      members.map((k) => `dm:${k}`)
    );

    return NextResponse.json({ groupId: group.id, name: group.name }, { status: 201 });
  } catch (e) {
    console.error("POST /api/groups", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("groups.list");
  try {
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me") ?? "";
    if (!me) return unauthorized();
    if (!(await verifyGroupProof(`${me}|groups-list`, me, sp.get("ts"), sp.get("signature")))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "groups-list", GROUP_LIST_PER_MIN, me);
    if (rl) return rl;

    const memberships = await db.groupMember.findMany({
      where: { userKey: me, leftAt: null },
      select: {
        joinedAt: true,
        group: {
          select: {
            id: true,
            name: true,
            creatorKey: true,
            createdAt: true,
            members: { where: { leftAt: null }, select: { userKey: true, joinedAt: true, leftAt: true } },
          },
        },
      },
      orderBy: { joinedAt: "desc" },
    });
    return NextResponse.json({
      groups: memberships.map((mship) => ({
        id: mship.group.id,
        name: mship.group.name,
        creatorKey: mship.group.creatorKey,
        createdAt: mship.group.createdAt,
        joinedAt: mship.joinedAt,
        members: mship.group.members.map((mm) => ({
          userKey: mm.userKey,
          joinedAt: mm.joinedAt,
        })),
      })),
    });
  } catch (e) {
    console.error("GET /api/groups", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
