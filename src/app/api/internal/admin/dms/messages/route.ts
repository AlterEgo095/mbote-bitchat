import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/dms/messages — fil d'UNE paire DM (MÉTADONNÉES ONLY)
 *  (back-office 2026-11 : détail d'une conversation, dérivé de l'annuaire
 *  /api/internal/admin/dms)
 * ─────────────────────────────────────────────────────────────────────────────
 *  INVARIANT ABSOLU (ADMIN-RBAC §1.4) : les DM sont E2EE — le serveur ne
 *  stocke QUE du chiffré opaque (DirectMessage.iv + ciphertext AES-GCM). Cet
 *  endpoint liste les ENVELOPPES d'une paire — id, direction, msgId/seq,
 *  timestamps, taille LENGTH(ciphertext) — JAMAIS `iv`, JAMAIS `ciphertext`,
 *  JAMAIS un contenu : l'admin voit QU'UN message a transité, sa taille et
 *  son état (lu/non lu, legacy), pas ce qu'il contient. Le badge `e2ee: true`
 *  dans la réponse est un CONTRAT : cette vue ne contient aucun contenu, par
 *  construction.
 *
 *  PAIRE : paramètre `pair` OBLIGATOIRE au format canonique `keyA|keyB`
 *  (exactement un « | », deux clés de 1..200 caractères) ; keyA > keyB → 400
 *  « paire non canonique — utilise la clé triée retournée par l'annuaire »
 *  (le client réutilise TELLE QUELLE la paire de l'annuaire /dms). La
 *  DIRECTION est reconstruite côté serveur par comparaison senderKey/keyA :
 *  "a_to_b" | "b_to_a" — le graphe A→B / B→A est visible en métadonnées.
 *
 *  LEGACY : msgId IS NULL = enveloppe pré-A1 (non couverte par la signature
 *  dm2) → `legacy: true` + compteur `legacy` dans pairTotals — suivi de la
 *  migration A1 sans toucher au contenu.
 *
 *  CURSOR OPAQUE : base64url JSON {k:"dms-msg", c, i} — keyset (createdAt
 *  DESC, id DESC) 20/page, id en tiebreak (messages créés dans la même ms
 *  restent ordonnés). GARDE DE VUE (k ≠ "dms-msg" → 400 « émis sous un autre
 *  annuaire ») ; ancre disparue (id absent de la paire — SELECT d'existence
 *  par id, mêmes conditions) → RESTART page 1 + `cursorReset: true`
 *  (sémantique users/queue/posts/dms). PAGINATION APPROXIMATIVE SOUS MUTATION
 *  CONFORTE (ADM-step6 §5) : les DM sont append-only par paire (createdAt
 *  immuable) — le keyset est stable ici, seules des purges peuvent trouer.
 *
 *  AUTH : requireAdmin({minRole:"support"}) — même arbitrage §13.1 que
 *  l'annuaire dms (lecture) ; l'auditor reste STRICT (403 auto via
 *  roleAtLeast).
 *
 *  DONNÉES : SQLite renvoie LENGTH(ciphertext) en BigInt → Number()
 *  systématique ; les colonnes DATETIME directes (createdAt/readAt) passent
 *  par la conversion Date de Prisma → sérialisées en ISO par
 *  NextResponse.json (comme posts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;

interface DmsMsgCursor {
  k: "dms-msg";
  c: number; // createdAt de l'ancre (epoch ms)
  i: string; // id de l'ancre
}

/**
 * Décode le cursor opaque. Renvoie :
 *  - null         : pas de cursor (page 1) ;
 *  - "wrong-view" : garde de vue — cursor émis sous un AUTRE annuaire
 *                   (k ≠ "dms-msg") → 400 dédié ;
 *  - "malformed"  : illisible / champs absents / type incorrect → 400.
 */
function decodeCursor(raw: string | null): DmsMsgCursor | null | "malformed" | "wrong-view" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (json.k !== "dms-msg") return "wrong-view";
    if (
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "string" || json.i.length === 0 || json.i.length > 128
    ) {
      return "malformed";
    }
    return { k: "dms-msg", c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: DmsMsgCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * Ligne brute d'enveloppe DM — métadonnées only : le SELECT ne projette
 * JAMAIS `iv` ni `ciphertext` (LENGTH ok : taille du chiffré opaque).
 */
interface RawMsgRow {
  id: string;
  senderKey: string;
  recipientKey: string;
  msgId: string | null; // null = enveloppe legacy (pré-A1)
  seq: number | null;
  createdAt: Date;
  readAt: Date | null;
  bytes: bigint; // LENGTH(ciphertext) — BigInt SQLite → Number()
}

interface RawPairTotalsRow {
  messages: bigint;
  unread: bigint | null; // SUM → null si la paire n'a plus aucune ligne
  bytes: bigint | null;
  legacy: bigint | null;
}

function mapItem(r: RawMsgRow, keyA: string) {
  return {
    id: r.id,
    senderKey: r.senderKey,
    recipientKey: r.recipientKey,
    direction: r.senderKey === keyA ? ("a_to_b" as const) : ("b_to_a" as const),
    msgId: r.msgId,
    seq: r.seq,
    legacy: r.msgId === null,
    createdAt: r.createdAt, // Date → ISO string via NextResponse.json (comme posts)
    readAt: r.readAt,
    bytes: Number(r.bytes),
  };
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.dms.messages");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const pairRaw = sp.get("pair");
    if (pairRaw === null || pairRaw.length === 0) {
      return NextResponse.json({ error: "pair requise (format keyA|keyB)" }, { status: 400 });
    }
    const parts = pairRaw.split("|");
    if (parts.length !== 2) {
      return NextResponse.json(
        { error: "pair invalide (exactement un séparateur « | » — format keyA|keyB)" },
        { status: 400 }
      );
    }
    const [keyA, keyB] = parts;
    if (keyA.length === 0 || keyA.length > 200 || keyB.length === 0 || keyB.length > 200) {
      return NextResponse.json(
        { error: "pair invalide (2 clés de 1..200 caractères — format keyA|keyB)" },
        { status: 400 }
      );
    }
    if (keyA > keyB) {
      return NextResponse.json(
        { error: "paire non canonique — utilise la clé triée retournée par l'annuaire" },
        { status: 400 }
      );
    }

    // ── MODE LISTE : cursor keyset (20/page) ────────────────────────────────
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    if (cursorOr === "wrong-view") {
      return NextResponse.json(
        { error: "cursor invalide (émis sous un autre annuaire — repartez de la page 1)" },
        { status: 400 }
      );
    }

    // ancre : disparue (purgée) ou hors paire → restart page 1 (SELECT
    // d'existence par id sous les MÊMES conditions de paire)
    let cursor: DmsMsgCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n
         FROM DirectMessage
         WHERE id = ?
           AND ((senderKey = ? AND recipientKey = ?) OR (senderKey = ? AND recipientKey = ?))`,
        cursor.i,
        keyA, keyB, keyB, keyA
      );
      if (Number(anchor[0]?.n ?? 0) === 0) {
        cursor = null;
        cursorReset = true;
      }
    }

    const keysetCond = cursor ? " AND (createdAt < ? OR (createdAt = ? AND id < ?))" : "";
    const keysetParams: (string | number)[] = cursor ? [cursor.c, cursor.c, cursor.i] : [];

    // MÉTADONNÉES ONLY : LENGTH(ciphertext) = taille du chiffré — JAMAIS le
    // contenu (aucun iv/ciphertext dans ce SELECT, invariant §1.4).
    const rows = await db.$queryRawUnsafe<Array<RawMsgRow>>(
      `SELECT id, senderKey, recipientKey, msgId, seq, createdAt, readAt, LENGTH(ciphertext) AS bytes
       FROM DirectMessage
       WHERE ((senderKey = ? AND recipientKey = ?) OR (senderKey = ? AND recipientKey = ?))${keysetCond}
       ORDER BY createdAt DESC, id DESC
       LIMIT ${PAGE_SIZE + 1}`,
      keyA, keyB, keyB, keyA,
      ...keysetParams
    );

    // pairTotals : la paire ENTIÈRE (requête agrégée séparée) — BigInt → Number()
    const totalsRows = await db.$queryRawUnsafe<Array<RawPairTotalsRow>>(
      `SELECT COUNT(*) AS messages,
              SUM(CASE WHEN readAt IS NULL THEN 1 ELSE 0 END) AS unread,
              SUM(LENGTH(ciphertext)) AS bytes,
              SUM(CASE WHEN msgId IS NULL THEN 1 ELSE 0 END) AS legacy
       FROM DirectMessage
       WHERE (senderKey = ? AND recipientKey = ?) OR (senderKey = ? AND recipientKey = ?)`,
      keyA, keyB, keyB, keyA
    );
    const pt = totalsRows[0];

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeCursor({ k: "dms-msg", c: new Date(last.createdAt).getTime(), i: last.id })
        : null;

    return NextResponse.json({
      pair: { keyA, keyB },
      items: page.map((r) => mapItem(r, keyA)),
      nextCursor,
      cursorReset,
      pairTotals: {
        messages: Number(pt?.messages ?? 0),
        unread: Number(pt?.unread ?? 0),
        bytes: Number(pt?.bytes ?? 0),
        legacy: Number(pt?.legacy ?? 0),
      },
      e2ee: true, // BADGE E2EE : métadonnées only, aucun iv/ciphertext (invariant §1.4)
      page: { size: PAGE_SIZE, pair: `${keyA}|${keyB}` },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/dms/messages", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
