import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toUserDto } from "@/lib/mbote/dto";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { identityProofMessage, isValidPubkeyFormat, verifySignedMessage } from "@/lib/mbote/proof";
import { verifyPowServer } from "@/lib/mbote/sybil-server";

export const dynamic = "force-dynamic";

// F-18 : rate limiting sur l'écriture d'identité (la preuve ECDSA bloque
// l'usurpation, pas le spam de creations/récritures légitimement signées)
const IDENTITY_PER_MIN_PER_KEY = 10;
const IDENTITY_PER_MIN_PER_IP = 30;
const RATE_WINDOW_MS = 60_000;
// D2 — Sybil phase 0 : 3 CRÉATIONS de compte par heure et par IP (la mise à
// jour d'une identité existante n'y est PAS soumise — un utilisateur légitime
// édite son profil sans plafond horaire). Le hit est incrémenté AVANT toute
// vérification cryptographique (fail-closed, leçon V4) : sonder le PoW coûte
// un créneau.
const IDENTITY_CREATIONS_PER_HOUR_PER_IP = 3;
const CREATION_WINDOW_MS = 3_600_000;

// C1 — Clarification 1 (post-F, artefact harnais récurrent famille #47) : mode
// TEST du garde D2. SYBIL_BYPASS=1 désactive UNIQUEMENT le plafond de
// CRÉATION 3/h/IP : tout harnais qui crée >3 identités en <1h (re-onboard de
// secours après une action destructive, phases multiples) sinon casse — le
// 429 real laisse le dialog d'onboarding bloqué et l'audit sauté. Le PoW, la
// preuve de possession ECDSA et les plafonds par minute restent INTACTS : le
// chemin cryptographique réel est toujours exercé. DÉFENSE EN PROFONDEUR :
// variable explicite (jamais NODE_ENV), opt-in par harnais, jamais présente
// en production ; l'activation est annoncée en console (jamais silencieux).
const SYBIL_BYPASS = process.env.SYBIL_BYPASS === "1";
if (SYBIL_BYPASS) {
  console.warn(
    "[identity] SYBIL_BYPASS=1 — plafond D2 (3 créations/h/IP) DÉSACTIVÉ — environnement de test uniquement"
  );
}

/** POST /api/identity — enregistre / met à jour une identité (clé publique = compte)
 *
 *  F-01 (audit Vague 1) : toute écriture d'identité exige une PREUVE DE
 *  POSSESSION — signature ECDSA P-256 sur la chaîne canonique
 *  `${pubkey}|identity|${nickname}|${bio}|${ecdhPub}|${ts}`.
 *  Sans preuve valide : 401. Empêche la réécriture du pseudo, de la bio et
 *  surtout de `ecdhPub` (détournement des DM futurs) d'un tiers.
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("identity.post");
  try {
    const body = await req.json();
    const { pubkey, nickname, bio, ecdhPub, ts, signature } = body ?? {};

    if (!isValidPubkeyFormat(pubkey)) {
      return NextResponse.json(
        { error: "pubkey invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }

    // D2 — création vs mise à jour : le PoW et le plafond horaire ne
    // s'appliquent qu'à la CRÉATION d'un compte serveur (T0 hors-ligne
    // préservé : l'upsert d'un profil existant reste sans PoW).
    const existingUser = await db.user.findUnique({
      where: { pubkey },
      select: { id: true, powChallenge: true },
    });
    const isCreation = !existingUser;

    // F-18 : avant toute vérification cryptographique (coûteuse) ni écriture
    const rates = getRateStore();
    const ip = clientIp(req.headers);
    const byKey = rates.hit(`identity:${pubkey}`, IDENTITY_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`identity-ip:${ip}`, IDENTITY_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de mises à jour d'identité — réessayez plus tard" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }
    if (ecdhPub !== undefined && ecdhPub !== null && !isValidPubkeyFormat(ecdhPub)) {
      return NextResponse.json(
        { error: "ecdhPub invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }

    // ── D2 — Sybil phase 0 : PoW à la CRÉATION + 3 créations/h/IP ─────────
    let powChallenge: string | undefined;
    if (isCreation) {
      // fail-closed : le hit incrémente AVANT toute vérification (sonder = payer)
      // C1 : SYBIL_BYPASS=1 court-circuite UNIQUEMENT ce plafond (mode test,
      // voir const SYBIL_BYPASS) — le PoW ci-dessous reste obligatoire.
      const byCreateIp = SYBIL_BYPASS
        ? { allowed: true, remaining: IDENTITY_CREATIONS_PER_HOUR_PER_IP, retryAfterMs: 0 }
        : rates.hit(
            `identity-create-ip:${ip}`,
            IDENTITY_CREATIONS_PER_HOUR_PER_IP,
            CREATION_WINDOW_MS
          );
      if (!byCreateIp.allowed) {
        const retry = Math.ceil(byCreateIp.retryAfterMs / 1000);
        return NextResponse.json(
          {
            error:
              "Trop de créations de comptes depuis cette adresse — réessayez plus tard (3 comptes par heure).",
            code: "identity_create_rate_limited",
          },
          { status: 429, headers: { "Retry-After": String(retry || 3600) } }
        );
      }

      const pow = (body?.pow ?? undefined) as { nonce?: unknown } | undefined;
      const verdict = verifyPowServer({ pubkey, ts, nonce: pow?.nonce });
      if (!verdict.valid || !verdict.challenge) {
        return NextResponse.json(
          {
            error: `Preuve de travail refusée : ${verdict.reason ?? "invalide"} — la création d'un compte exige un PoW (SHA-256 itéré, 20 bits).`,
            code: "pow_required",
          },
          { status: 403 }
        );
      }
      // La CONSOMMATION (anti-rejeu global, table PowSpent) est faite dans la
      // MÊME transaction que l'upsert (plus bas) : un échec de signature ou
      // d'écriture ne brûle PAS le PoW — le client peut rejouer son payload
      // sans recalculer (tolérance réseau RDC).
      powChallenge = verdict.challenge;
    } else if (body?.pow?.nonce !== undefined) {
      // Mise à jour portant un PoW = rejeu probable d'une création : si ce
      // challenge a déjà été consommé, refus explicite (directive D2 :
      // « nonce rejoué → refusé »). Sans consumption, un rejeu prendrait le
      // chemin update et passerait inaperçu.
      const replayCheck = verifyPowServer({ pubkey, ts, nonce: body.pow.nonce });
      if (replayCheck.valid && replayCheck.challenge) {
        const spent = await db.powSpent.findUnique({
          where: { challenge: replayCheck.challenge },
        });
        if (spent) {
          return NextResponse.json(
            { error: "Preuve de travail déjà consommée (rejeu refusé)", code: "pow_replayed" },
            { status: 409 }
          );
        }
      }
    }

    // La preuve porte sur les valeurs BRUTES envoyées (telles que signées),
    // pas sur les versions tronquées/trimmées stockées ensuite.
    const nickRaw = typeof nickname === "string" ? nickname : "";
    const bioRaw = typeof bio === "string" ? bio : "";
    const ecdhRaw = typeof ecdhPub === "string" ? ecdhPub : "";

    const check = await verifySignedMessage({
      message: identityProofMessage({ pubkey, nickname: nickRaw, bio: bioRaw, ecdhPub: ecdhRaw, ts }),
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

    const nick = nickRaw.trim();
    if (nick.length < 2 || nick.length > 32) {
      return NextResponse.json(
        { error: "Le pseudo doit contenir entre 2 et 32 caractères" },
        { status: 400 }
      );
    }

    // D2 — création : consommation de l'anti-rejeu PoW DANS la même
    // transaction que l'upsert — soit tout passe, soit RIEN n'est brûlé
    // (le client peut rejouer son payload après une perte réseau, tolérance
    // RDC). Un challenge déjà consommé → 409 (rejeu refusé).
    const user = await db.$transaction(async (tx) => {
      if (isCreation && powChallenge) {
        try {
          await tx.powSpent.create({ data: { challenge: powChallenge } });
        } catch {
          throw new PowReplayError();
        }
      }
      return tx.user.upsert({
        where: { pubkey },
        update: {
          nickname: nick,
          bio: typeof bio === "string" ? bio.slice(0, 240) : undefined,
          ecdhPub: typeof ecdhPub === "string" ? ecdhPub : undefined,
        },
        create: {
          pubkey,
          nickname: nick,
          bio: typeof bio === "string" ? bio.slice(0, 240) : null,
          ecdhPub: typeof ecdhPub === "string" ? ecdhPub : null,
          ...(isCreation && powChallenge ? { powChallenge } : {}),
        },
        include: {
          _count: { select: { posts: true, followers: true, following: true } },
        },
      });
    });

    // Vague 3 : le broadcast relay et la réponse ne contiennent que les champs
    // publics — botPriv (clé privée du bot de démo) ne quitte jamais le serveur.
    const publicUser = toUserDto(user);
    relayNotify("identity:new", { user: publicUser }, ["feed"]);
    return NextResponse.json({ user: publicUser });
  } catch (e) {
    if (e instanceof PowReplayError) {
      return NextResponse.json(
        { error: "Preuve de travail déjà consommée (rejeu refusé)", code: "pow_replayed" },
        { status: 409 }
      );
    }
    console.error("POST /api/identity", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

/** Rejeu PoW : challenge déjà consommé dans PowSpent (D2). */
class PowReplayError extends Error {}

/** GET /api/identity?pubkey=… — récupère un profil */
export async function GET(req: NextRequest) {
  try {
    const pubkey = req.nextUrl.searchParams.get("pubkey");
    if (!pubkey) {
      return NextResponse.json({ error: "pubkey requis" }, { status: 400 });
    }
    const user = await db.user.findUnique({
      where: { pubkey },
      include: {
        _count: { select: { posts: true, followers: true, following: true } },
      },
    });
    return NextResponse.json({ user: user ? toUserDto(user) : null });
  } catch (e) {
    console.error("GET /api/identity", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
