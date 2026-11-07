import { NextRequest, NextResponse } from "next/server";
import { vapidPublicKey } from "@/lib/mbote/push/sender";

export const dynamic = "force-dynamic";

/**
 * GET /api/push/config — clé publique VAPID pour le subscribe navigateur.
 * NON SENSIBLE par définition (la clé VAPID publique est embarquée dans
 * chaque requête push signée). Fail-closed : sans clés côté serveur → 503,
 * l'UI désactive le bouton avec un message explicite.
 */
export async function GET(_req: NextRequest) {
  const publicKey = vapidPublicKey();
  if (!publicKey) {
    return NextResponse.json(
      { error: "Push non configuré côté serveur (clés VAPID absentes)" },
      { status: 503 }
    );
  }
  return NextResponse.json({ publicKey });
}
