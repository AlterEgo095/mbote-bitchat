/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/admin/moderation/action — proxy MUTATION (ADM Étape 6)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Première surface de MUTATION proxyfiée du panneau (la queue UI en a besoin
 *  — hide/unhide/dismiss/warn/suspend). Chaîne :
 *    navigateur ─cookie + x-admin-csrf─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor + x-admin-csrf─▶
 *    POST /api/moderation/action (requireAdmin mutation:true — CSRF vérifié
 *    TIMING-SAFE CÔTÉ APP PRINCIPALE, jamais ici : le BFF ne décide rien).
 *
 *  Le CSRF est EXIGÉ à l'entrée du BFF (présence seulement — la valeur est
 *  validée par l'app principale contre la session) : une mutation sans
 *  header n'a aucune raison d'atteindre le backend.
 *
 *  DÉGRADATION : 502 backend-unreachable (réseau) ≠ 401/403 (réponses du
 *  backend propagées à l'identique) ≠ 400/404/409/422 (validations métier
 *  propagées — justification §6, curseurs, cibles inconnues).
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  const csrf = req.headers.get("x-admin-csrf");
  if (!csrf) return denied(403); // mutation sans CSRF : même message uniforme

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps JSON illisible" }, { status: 400 });
  }

  try {
    const r = await callBackend("/api/moderation/action", {
      method: "POST",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      csrf,
      clientForwardedFor: req.headers.get("x-forwarded-for"),
      body,
    });
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
