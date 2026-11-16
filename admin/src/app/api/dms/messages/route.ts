/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/dms/messages — proxy ENVELOPPES d'une paire DM (MÉTADONNÉES ONLY,
 *  back-office 2026-11)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique fiche post) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/dms/messages (requireAdmin minRole support).
 *
 *  INVARIANT E2EE (ADMIN-RBAC §1.4) : la liste est celle des ENVELOPPES d'une
 *  paire — id, direction (reconstruite par comparaison de clés), msgId/seq,
 *  état lu/non-lu, LENGTH(ciphertext). AUCUN iv, AUCUN ciphertext ne traverse
 *  ce proxy : « ce qui a circulé, quand, dans quel sens » — jamais « quoi ».
 *
 *  Query forwardée BRUTE (pair = `keyA|keyB` canonique, cursor) — le BFF ne
 *  décide rien : 400 (paire absente/malformée, cursor rejeté) est une
 *  validation métier PROPAGÉE ; 502 backend-unreachable ≠ 401/403.
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  try {
    const qs = req.nextUrl.search; // pair, cursor — brut
    const r = await callBackend(`/api/internal/admin/dms/messages${qs}`, {
      method: "GET",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      clientForwardedFor: req.headers.get("x-forwarded-for"),
    });
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
