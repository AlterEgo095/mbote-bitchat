/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/audit/export.csv — proxy EXPORT CSV (ADM Étape 8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  TÉLÉCHARGEMENT DIRECT : la réponse CSV du backend est relayée BRUTE
 *  (Content-Disposition: attachment préservé) — le navigateur déclenche le
 *  téléchargement, aucun JSON intermédiaire.
 *
 *  callBackend() parse du JSON — inadapté ici : ce proxy fait son propre
 *  fetch avec les MÊMES en-têtes (x-admin-internal / session / actor), puis
 *  transmet le corps OCTET POUR OCTET. 401/403 uniformes ; 422 (export trop
 *  volumineux) PROPAGÉ en JSON (la UI l'affiche — pas de téléchargement).
 *
 *  LECTURE SEULE — aucun verbe d'écriture n'existe sur ce chemin.
 */

import { NextRequest, NextResponse } from "next/server";
import { backendBase, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

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

  const token = process.env.ADMIN_INTERNAL_TOKEN ?? "";
  const headers: Record<string, string> = {
    "x-admin-session": sessionTokenFrom(req) ?? "",
    "x-admin-actor": String(session.adminUserId),
    "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "",
  };
  if (token) headers["x-admin-internal"] = token;

  let backend: Response;
  try {
    backend = await fetch(`${backendBase()}/api/internal/admin/audit/export.csv${req.nextUrl.search}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }

  if (backend.status === 401 || backend.status === 403) return denied(backend.status as 401 | 403);
  if (backend.status !== 200) {
    const body = (await backend.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(body, { status: backend.status });
  }

  const csv = await backend.text();
  const disposition = backend.headers.get("content-disposition") ?? "attachment; filename=audit.csv";
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": backend.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
}
