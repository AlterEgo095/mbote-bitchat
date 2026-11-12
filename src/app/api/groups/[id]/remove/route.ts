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

// ── C4 — POST /api/groups/[id]/remove ────────────────────────────────────────
// Retrait (créateur MVP uniquement) : remove-commit (diffusion) + leftAt.
// FORWARD SECRECY : le commit ratche la chaîne — l'ex-membre ne déchiffre
// plus les messages d'APRÈS (preuve PoC T1/T4). Le retrait du CRÉATEUR lui-
// même est refusé (admin MVP — sinon plus personne ne gère le groupe).

const REMOVE_PER_MIN = 15;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("groups.remove");
  try {
    const { id } = await params;
    const body = await readJson(req);
    const me = typeof body.me === "string" ? body.me : "";
    const userKey = typeof body.userKey === "string" ? body.userKey : "";
    if (!me || !userKey) return unauthorized();
    if (!(await verifyGroupProof(`${me}|group-remove|${id}|${userKey}`, me, body.ts, body.signature))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "group-remove", REMOVE_PER_MIN, me);
    if (rl) return rl;

    if (!(await isCreator(id, me))) {
      return NextResponse.json({ error: "seul le créateur retire" }, { status: 403 });
    }
    if (userKey === me) {
      return NextResponse.json({ error: "le créateur ne peut pas se retirer lui-même" }, { status: 400 });
    }
    const commit = typeof body.commit === "string" ? body.commit : "";
    if (!commit || commit.length > MLS_HANDSHAKE_MAX) {
      return NextResponse.json({ error: "commit requis (≤ 16 Ko)" }, { status: 400 });
    }
    const member = await db.groupMember.findUnique({
      where: { groupId_userKey: { groupId: id, userKey } },
      select: { id: true, leftAt: true },
    });
    if (!member || member.leftAt !== null) {
      return NextResponse.json({ error: "membre absent" }, { status: 409 });
    }

    await db.$transaction(async (tx) => {
      await tx.groupMember.update({ where: { id: member.id }, data: { leftAt: new Date() } });
      await tx.groupEnvelope.create({
        data: { groupId: id, kind: "commit", targetKey: null, payload: commit },
      });
    });

    // réveil des membres ACTIFS restants (l'exclu ne reçoit plus rien)
    const members = await activeMemberKeys(id);
    relayNotify(
      "group-envelope",
      { groupId: id, kind: "commit" },
      members.filter((k) => k !== me).map((k) => `dm:${k}`)
    );

    return NextResponse.json({ accepted: true }, { status: 201 });
  } catch (e) {
    console.error("POST /api/groups/[id]/remove", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
