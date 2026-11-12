import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { trackApiRequest } from "@/lib/mbote/state-store";
import {
  readJson,
  unauthorized,
  verifyGroupProof,
  rateLimit,
  isCreator,
  activeMemberKeys,
  MLS_HANDSHAKE_MAX,
} from "@/lib/mbote/mls/server";

export const dynamic = "force-dynamic";

// ── C4 — POST /api/groups/[id]/invite ────────────────────────────────────────
// Invitation (créateur MVP uniquement) : add-commit (diffusion) + welcome
// (ciblé). Le serveur crée le GroupMember et relaye les enveloppes — il ne
// peut pas les lire (binaires MLS).

const INVITE_PER_MIN = 15;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("groups.invite");
  try {
    const { id } = await params;
    const body = await readJson(req);
    const me = typeof body.me === "string" ? body.me : "";
    const userKey = typeof body.userKey === "string" ? body.userKey : "";
    if (!me || !userKey) return unauthorized();
    if (!(await verifyGroupProof(`${me}|group-invite|${id}|${userKey}`, me, body.ts, body.signature))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "group-invite", INVITE_PER_MIN, me);
    if (rl) return rl;

    if (!(await isCreator(id, me))) {
      return NextResponse.json({ error: "seul le créateur invite" }, { status: 403 });
    }
    const commit = typeof body.commit === "string" ? body.commit : "";
    const welcome = typeof body.welcome === "string" ? body.welcome : "";
    if (!commit || commit.length > MLS_HANDSHAKE_MAX || !welcome || welcome.length > MLS_HANDSHAKE_MAX) {
      return NextResponse.json({ error: "commit/welcome requis (≤ 16 Ko)" }, { status: 400 });
    }

    // le membre existe ? (key package = preuve d'existence indirecte)
    const target = await db.user.findUnique({ where: { pubkey: userKey }, select: { pubkey: true } });
    if (!target) {
      return NextResponse.json({ error: "contact inconnu" }, { status: 400 });
    }
    const existing = await db.groupMember.findUnique({
      where: { groupId_userKey: { groupId: id, userKey } },
      select: { id: true, leftAt: true },
    });
    if (existing && existing.leftAt === null) {
      return NextResponse.json({ error: "déjà membre" }, { status: 409 });
    }

    await db.$transaction(async (tx) => {
      if (existing) {
        // ré-invitation d'un membre retiré : feuille reprise
        await tx.groupMember.update({ where: { id: existing.id }, data: { leftAt: null } });
      } else {
        await tx.groupMember.create({ data: { groupId: id, userKey } });
      }
      await tx.groupEnvelope.create({
        data: { groupId: id, kind: "commit", targetKey: null, payload: commit },
      });
      await tx.groupEnvelope.create({
        data: { groupId: id, kind: "welcome", targetKey: userKey, payload: welcome },
      });
    });

    // réveil : membres actifs (commit) + cible (welcome)
    const members = await activeMemberKeys(id);
    relayNotify(
      "group-envelope",
      { groupId: id, kind: "commit" },
      members.filter((k) => k !== me).map((k) => `dm:${k}`)
    );
    relayNotify("group-envelope", { groupId: id, kind: "welcome" }, [`dm:${userKey}`]);

    return NextResponse.json({ accepted: true }, { status: 201 });
  } catch (e) {
    console.error("POST /api/groups/[id]/invite", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
