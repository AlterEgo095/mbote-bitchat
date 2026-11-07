import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { requireAdmin, isDenied } from "@/lib/mbote/admin-auth";
import { auditFiltersFrom, auditWhereFrom } from "@/lib/mbote/admin-audit";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/audit — journal AdminAudit, LECTURE SEULE (ADM É8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 8 : page /audit (requireAdmin('auditor')) — liste paginée
 *  (cursor) triée createdAt DÉCROISSANT, filtres acteur / action / targetType
 *  / période (24h|7d|30d) + plage custom (from/to), recherche par cible.
 *
 *  AUTH (arbitrage §14.1) : requireAdmin({ exactRoles: ["auditor",
 *  "super-admin"] }) — porte EXACTE, PAS une hiérarchie : le rôle auditor est
 *  LE PLUS RESTRICTIF de la matrice (§12.17 — lecture seule AdminAudit), et
 *  la directive Étape 8 teste explicitement support → 403 ET moderator → 403.
 *  Le super-admin conserve l'accès (règle structurelle : le rôle sommet n'est
 *  jamais exclu). LECTURE SEULE : aucun handler POST/PUT/DELETE ici, aucun
 *  autre verbe n'existera (append-only par construction, triggers SQLite
 *  `admin_audit_no_update` / `admin_audit_no_delete` — invariant §1.3).
 *
 *  CURSOR OPAQUE : base64url de JSON {c, i} — (createdAt ms, id) de l'ancre ;
 *  AdminAudit est APPEND-ONLY (le tri ne change jamais sous vos pieds, au
 *  contraire du poids de la queue É6) : keyset simple suffisant. Malformé →
 *  400 (jamais de restart silencieux — pattern É6).
 *
 *  FACETS : acteurs (id+email+rôle), actions, targetTypes DISTINCTS de
 *  l'ensemble FILTRÉ (sans cursor) — alimentent les dropdowns de la UI sans
 *  second endpoint.
 *
 *  AUCUN contenu de DM, aucun email UTILISATEUR : les seules adresses ici
 *  sont celles des COMPTES ADMIN (identités opératoires du panneau, colonne
 *  exigée par la directive). AdminAudit.targetId pour targetType='user' est
 *  la PUBKEY (identité publique du mesh — arbitrage §13.2).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;

interface AuditCursor {
  c: number; // createdAt de l'ancre (epoch ms)
  i: number; // id de l'ancre (Int autoincrement)
}

function decodeCursor(raw: string | null): AuditCursor | null | "malformed" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "number" || !Number.isInteger(json.i) || json.i <= 0
    ) {
      return "malformed";
    }
    return { c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.audit");
  try {
    const gate = await requireAdmin(req, { exactRoles: ["auditor", "super-admin"] });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    const filtersOr = auditFiltersFrom(sp);
    if ("error" in filtersOr) {
      return NextResponse.json({ error: filtersOr.error }, { status: 400 });
    }
    const where = auditWhereFrom(filtersOr);

    // keyset DESC : page suivante = createdAt < ancre OU (= ET id < ancre)
    const keyset: Prisma.AdminAuditWhereInput = cursorOr
      ? {
          OR: [
            { createdAt: { lt: new Date(cursorOr.c) } },
            { AND: [{ createdAt: new Date(cursorOr.c) }, { id: { lt: cursorOr.i } }] },
          ],
        }
      : {};

    const rows = await db.adminAudit.findMany({
      where: cursorOr ? { AND: [where, keyset] } : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      include: { actor: { select: { email: true, role: true } } },
    });

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeCursor({ c: new Date(last.createdAt).getTime(), i: last.id })
        : null;

    // FACETS sur l'ensemble FILTRÉ (sans cursor) — dropdowns UI
    const [actorGroups, actionGroups, typeGroups] = await Promise.all([
      db.adminAudit.groupBy({ by: ["actorId"], where }),
      db.adminAudit.groupBy({ by: ["action"], where }),
      db.adminAudit.groupBy({ by: ["targetType"], where }),
    ]);
    const actorIds = actorGroups.map((g) => g.actorId);
    const actors = await db.adminUser.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true, role: true },
      orderBy: { id: "asc" },
    });

    return NextResponse.json({
      items: page.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        actorId: r.actorId,
        actorEmail: r.actor.email,
        actorRole: r.actorRole,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        justification: r.justification,
      })),
      nextCursor,
      facets: {
        actors,
        actions: actionGroups.map((g) => g.action).sort(),
        targetTypes: typeGroups.map((g) => g.targetType).sort(),
      },
      page: { size: PAGE_SIZE },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/audit", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
