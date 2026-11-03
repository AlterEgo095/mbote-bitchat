import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import {
  dmProofMessage,
  dmReadProofMessage,
  READ_MAX_AGE_MS,
  READ_FUTURE_TOLERANCE_MS,
  verifySignedMessage,
} from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

const DMS_PER_MIN_PER_KEY = 30;
const DMS_PER_MIN_PER_IP = 90;
const DM_READ_PER_MIN_PER_KEY = 60;
const DM_READ_PER_MIN_PER_IP = 180;
const RATE_WINDOW_MS = 60_000;

/**
 * F-07 : pré-authentification commune aux lectures de boîte DM — le lecteur
 * `me` doit prouver la possession de SA clé (signature courte durée sur
 * `${me}|dm-read|${peer}|${ts}`). Sans preuve valide : 401, et surtout
 * AUCUN effet de bord (pas de marquage « lu »).
 */
async function requireDmReadProof(
  me: string,
  peer: string,
  ts: unknown,
  signature: unknown
): Promise<NextResponse | null> {
  const check = await verifySignedMessage({
    message: dmReadProofMessage(me, peer, ts as number),
    pubkey: me,
    ts,
    signature,
    maxAgeMs: READ_MAX_AGE_MS,
    futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
  });
  if (!check.valid) {
    return NextResponse.json(
      { error: `Lecture refusée (preuve requise) : ${check.reason ?? "invalide"}` },
      { status: 401 }
    );
  }
  return null;
}

function dmReadRateLimited(me: string, ip: string): NextResponse | null {
  const rates = getRateStore();
  const byKey = rates.hit(`dm-read:${me}`, DM_READ_PER_MIN_PER_KEY, RATE_WINDOW_MS);
  const byIp = rates.hit(`dm-read-ip:${ip}`, DM_READ_PER_MIN_PER_IP, RATE_WINDOW_MS);
  if (!byKey.allowed || !byIp.allowed) {
    const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
    return NextResponse.json(
      { error: "Trop de lectures — ralentissez" },
      { status: 429, headers: { "Retry-After": String(retry || 60) } }
    );
  }
  return null;
}

/** GET /api/dms?me=&peer=&ts=&signature= — conversation (le serveur ne lit jamais le contenu)
 *  F-07 : lecture authentifiée par preuve de possession courte durée —
 *  impossible de lire la boîte d'autrui ni de marquer ses messages comme lus.
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("dms.get");
  try {
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me");
    const peer = sp.get("peer");
    if (!me || !peer) {
      return NextResponse.json({ error: "me et peer requis" }, { status: 400 });
    }

    const limited = dmReadRateLimited(me, clientIp(req.headers));
    if (limited) return limited;

    const unauthorized = await requireDmReadProof(
      me,
      peer,
      sp.get("ts"),
      sp.get("signature")
    );
    if (unauthorized) return unauthorized;

    const messages = await db.directMessage.findMany({
      where: {
        OR: [
          { senderKey: me, recipientKey: peer },
          { senderKey: peer, recipientKey: me },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    // marquer comme lus les messages reçus (lecteur authentifié)
    await db.directMessage.updateMany({
      where: { senderKey: peer, recipientKey: me, readAt: null },
      data: { readAt: new Date() },
    });

    return NextResponse.json({ messages });
  } catch (e) {
    console.error("GET /api/dms", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

/** POST /api/dms — dépose une enveloppe chiffrée (boîte aux lettres aveugle)
 *  F-01 : preuve de possession obligatoire — signature ECDSA sur
 *  `${senderKey}|dm|${recipientKey}|${iv}|${ciphertext}|${ts}` → impossible de
 *  déposer une enveloppe au nom d'un autre expéditeur.
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("dms.post");
  try {
    const { senderKey, recipientKey, iv, ciphertext, ts, signature } = await req.json();
    if (!senderKey || !recipientKey || !iv || !ciphertext) {
      return NextResponse.json(
        { error: "senderKey, recipientKey, iv, ciphertext requis" },
        { status: 400 }
      );
    }

    // F-01 : preuve de possession de la clé de l'expéditeur (avant tout write)
    const check = await verifySignedMessage({
      message: dmProofMessage(String(senderKey), String(recipientKey), String(iv), String(ciphertext), ts),
      pubkey: String(senderKey),
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    // rate limit (D4) : les DMs sont le vecteur de spam n°1 (contenu opaque)
    const rates = getRateStore();
    const byKey = rates.hit(`dm:${senderKey}`, DMS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`dm-ip:${clientIp(req.headers)}`, DMS_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      return NextResponse.json(
        { error: "Trop de messages — ralentissez" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    if (senderKey === recipientKey) {
      return NextResponse.json({ error: "Autolivraison refusée" }, { status: 400 });
    }
    if (ciphertext.length > 8192) {
      return NextResponse.json({ error: "Enveloppe trop volumineuse (16 KiB max)" }, { status: 413 });
    }

    const [sender, recipient] = await Promise.all([
      db.user.findUnique({ where: { pubkey: senderKey } }),
      db.user.findUnique({ where: { pubkey: recipientKey } }),
    ]);
    if (!sender || !recipient) {
      return NextResponse.json(
        { error: "Expéditeur ou destinataire inconnu (clés non enregistrées)" },
        { status: 404 }
      );
    }

    const message = await db.directMessage.create({
      data: { senderKey, recipientKey, iv, ciphertext },
    });

    // livraison temps réel : boîtes aux lettres des deux parties (contenu opaque)
    relayNotify("dm:new", { message }, [`dm:${senderKey}`, `dm:${recipientKey}`]);

    return NextResponse.json({ message });
  } catch (e) {
    console.error("POST /api/dms", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
