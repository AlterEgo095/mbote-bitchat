/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/admin/session — état de session du panneau (BFF, ADM Étapes 3+4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Interroge l'app principale (verify — token interne + session). Aucun secret
 *  en réponse : { authenticated, email, role, totpEnrolled }. Le csrfToken de
 *  la session n'est volontairement PAS retourné ici — il a été remis au login
 *  et reste en mémoire côté navigateur (jamais stockable côté serveur BFF).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await verifyPanelSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    role: session.role,
    totpEnrolled: session.totpEnrolled,
  });
}
