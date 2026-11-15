import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { isValidPubkeyFormat, preferencesProofMessage, verifySignedMessage } from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

/** G (i18n) — locales supportées (miroir de src/lib/mbote/i18n.tsx). */
const SUPPORTED = new Set(["fr", "en"]);
/** Écritures signées mais non critiques : plafond large (F-18 pattern). */
const PREFS_PER_MIN_PER_KEY = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * GET /api/preferences?pubkey=… — préférence de locale du compte.
 * Lecture PUBLIQUE (pas plus sensible que le profil — la locale ne révèle
 * rien de privé). Compte inconnu → locale: null.
 */
export async function GET(req: NextRequest) {
  try {
    const pubkey = req.nextUrl.searchParams.get("pubkey");
    if (!pubkey || !isValidPubkeyFormat(pubkey)) {
      return NextResponse.json({ error: "pubkey invalide" }, { status: 400 });
    }
    const user = await db.user.findUnique({
      where: { pubkey },
      select: { locale: true, localeExplicit: true },
    });
    // `explicit` : la locale n'est ADOPTÉE par un autre appareil que si elle
    // a été CHOISIE (le défaut 'fr' d'un compte jamais réglé ne doit pas
    // écraser la détection navigateur — bug détecté par le harnais G).
    return NextResponse.json({
      locale: user?.locale ?? null,
      explicit: user?.localeExplicit ?? false,
    });
  } catch (e) {
    console.error("GET /api/preferences", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

/**
 * POST /api/preferences — { pubkey, locale, ts, signature }.
 * PREUVE DE POSSESSION ECDSA (chaîne canonique
 * `${pubkey}|preferences|${locale}|${ts}`) : un tiers ne peut pas réécrire la
 * préférence d'un tiers. SÉCURITÉ : ne crée JAMAIS de compte (pas de upsert
 * « create ») — contourner le PoW/anti-Sybil D2 via ce route serait une
 * brèche ; compte inconnu → 404, le client garde sa préférence locale.
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("preferences.post");
  try {
    const body = await req.json();
    const { pubkey, locale, ts, signature } = body ?? {};

    if (!isValidPubkeyFormat(pubkey)) {
      return NextResponse.json(
        { error: "pubkey invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }
    if (typeof locale !== "string" || !SUPPORTED.has(locale)) {
      return NextResponse.json(
        { error: "locale non supportée (fr | en)" },
        { status: 400 }
      );
    }

    const rates = getRateStore();
    const ip = clientIp(req.headers);
    const byKey = rates.hit(`preferences:${pubkey}`, PREFS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`preferences-ip:${ip}`, PREFS_PER_MIN_PER_KEY * 4, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de mises à jour de préférences — réessayez plus tard" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    const check = await verifySignedMessage({
      message: preferencesProofMessage(pubkey, locale, ts),
      pubkey,
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    const existing = await db.user.findUnique({ where: { pubkey }, select: { id: true } });
    if (!existing) {
      // JAMAIS de création ici : l'onboarding (PoW + plafond Sybil) est le
      // seul chemin de création de compte.
      return NextResponse.json(
        { error: "Compte inexistant — la préférence reste locale jusqu'à publication de l'identité" },
        { status: 404 }
      );
    }

    const user = await db.user.update({
      where: { pubkey },
      data: { locale, localeExplicit: true },
      select: { locale: true, localeExplicit: true },
    });
    return NextResponse.json({ locale: user.locale, explicit: user.localeExplicit });
  } catch (e) {
    console.error("POST /api/preferences", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
