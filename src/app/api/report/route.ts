import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { isValidPubkeyFormat, reportProofMessage, verifySignedMessage } from "@/lib/mbote/proof";
import { REPORT_REASONS, REPORT_TARGET_KINDS } from "@/lib/mbote/moderation";

export const dynamic = "force-dynamic";

const REPORTS_PER_MIN_PER_KEY = 20;
const REPORTS_PER_MIN_PER_IP = 60;
const RATE_WINDOW_MS = 60_000;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/report — signalement d'un contenu PUBLIC vers la file de modération
 * ─────────────────────────────────────────────────────────────────────────────
 *  PÉRIMÈTRE STRICT (validation A3) : fil public uniquement — posts et
 *  commentaires publics (les deux sont des lignes `Post`).
 *
 *  AUCUNE MODÉRATION DM — IMPOSSIBLE PAR CONCEPTION : le serveur ne stocke que
 *  du chiffré E2EE (boîte aux lettres aveugle, cf. /api/dms) ; il ne peut ni
 *  lire, ni qualifier, ni « modérer » un message privé. `targetKind` n'admet
 *  que "post" | "comment" — toute autre valeur (dont "dm") est refusée 400 avec
 *  ce rappel explicite.
 *
 *  Auth : preuve de possession ECDSA du signaleur —
 *    `${reporter}|report|${targetKind}|${targetId}|${reason}|${ts}` (401 sinon).
 *
 *  Idempotence : @@unique(reporterKey, targetKind, targetId) — re-signaler la
 *  même cible renvoie le signalement existant (`duplicate: true`), la file ne
 *  gonfle pas par répétition d'un même signaleur.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("report.post");
  try {
    const body = await req.json().catch(() => null);
    const { reporter, targetKind, targetId, reason, details, ts, signature } =
      (body ?? {}) as Record<string, unknown>;

    if (!isValidPubkeyFormat(reporter)) {
      return NextResponse.json(
        { error: "reporter invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }
    if (typeof targetKind !== "string" || !(REPORT_TARGET_KINDS as readonly string[]).includes(targetKind)) {
      return NextResponse.json(
        {
          error:
            "targetKind invalide — fil public uniquement (\"post\" | \"comment\"). Aucune modération DM : impossible par conception (E2EE, le serveur ne lit pas les messages privés).",
        },
        { status: 400 }
      );
    }
    if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 64) {
      return NextResponse.json({ error: "targetId invalide" }, { status: 400 });
    }
    if (typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason)) {
      return NextResponse.json(
        { error: `reason invalide (valeurs : ${REPORT_REASONS.join(", ")})` },
        { status: 400 }
      );
    }
    if (details != null && (typeof details !== "string" || details.length > 500)) {
      return NextResponse.json({ error: "details invalide (≤ 500 caractères)" }, { status: 400 });
    }

    // rate limit (D4) : la file de modération ne doit pas être gonflée
    const rates = getRateStore();
    const byKey = rates.hit(`report:${reporter}`, REPORTS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`report-ip:${clientIp(req.headers)}`, REPORTS_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de signalements — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    // preuve de possession du signaleur (avant tout write)
    const check = await verifySignedMessage({
      message: reportProofMessage(reporter, targetKind, targetId, reason, ts as number),
      pubkey: reporter,
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    // la cible doit exister et correspondre au kind déclaré
    const target = await db.post.findUnique({
      where: { id: targetId },
      select: { id: true, parentId: true },
    });
    if (!target) {
      return NextResponse.json({ error: "Contenu ciblé introuvable" }, { status: 404 });
    }
    const isComment = target.parentId != null;
    if ((targetKind === "post" && isComment) || (targetKind === "comment" && !isComment)) {
      return NextResponse.json(
        { error: `targetKind "${targetKind}" ne correspond pas au contenu ciblé` },
        { status: 400 }
      );
    }

    try {
      const report = await db.report.create({
        data: {
          reporterKey: reporter,
          targetKind,
          targetId,
          reason,
          details: typeof details === "string" ? details : null,
        },
      });
      const queueSize = await db.report.count({ where: { status: "open" } });
      return NextResponse.json({ report, queueSize }, { status: 201 });
    } catch (err) {
      // idempotence : même signaleur + même cible = signalement déjà en file
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        const existing = await db.report.findUnique({
          where: {
            reporterKey_targetKind_targetId: {
              reporterKey: reporter,
              targetKind,
              targetId,
            },
          },
        });
        if (existing) {
          const queueSize = await db.report.count({ where: { status: "open" } });
          return NextResponse.json({ report: existing, queueSize, duplicate: true });
        }
      }
      throw err;
    }
  } catch (e) {
    console.error("POST /api/report", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
