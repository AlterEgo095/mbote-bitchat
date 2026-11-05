"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  trust-client — épinglage LOCAL des clés de chiffrement (A2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Barrière indépendante du serveur : chaque appareil garde son propre épinglage
 *  (localStorage). Toute rotation de l'`ecdhPub` vue par CET appareil → alerte
 *  rouge BLOQUANTE, même si le serveur est compromis et ne le signale pas.
 *  Contre un serveur pleinement malveillant qui sert des clés différentes à
 *  chaque partie, seul le comparage hors-bande du numéro de sécurité fait foi
 *  (modèle Signal — docs/SAFETY-NUMBER-SPEC.md §5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { safetyNumber } from "./safety-number";

const PREFIX = "mbote.trust.v1.";

export interface LocalPin {
  ecdhPub: string;
  safetyNumber: string;
  verifiedAt: number | null;
}

export type TrustLevel = "green" | "yellow" | "red";

export interface LocalTrustVerdict {
  level: TrustLevel;
  /** numéro calculé sur les clés COURANTES (affiché dans le dialogue) */
  safetyNumber: string;
  /** premier contact avec ce pair — épinglage initial non vérifié */
  firstContact: boolean;
  /** la clé servie diverge de l'épinglée localement → ENVOI BLOQUÉ */
  keyChanged: boolean;
}

function pinKey(myPub: string, peerPub: string): string {
  return `${PREFIX}${myPub}.${peerPub}`;
}

/** Évalue la confiance locale pour (moi → pair) et calcule le numéro courant. */
export async function evaluateLocalTrust(
  me: { pubkey: string; ecdhPub: string },
  peerPub: string,
  peerEcdhPub: string
): Promise<LocalTrustVerdict> {
  const number = await safetyNumber(me.pubkey, me.ecdhPub, peerPub, peerEcdhPub);
  const key = pinKey(me.pubkey, peerPub);
  const raw = localStorage.getItem(key);

  if (!raw) {
    // premier contact : on épingle localement (non vérifié) — jamais de blocage
    // au cold-start (impasse), mais bannière d'invitation à la vérification
    const pin: LocalPin = { ecdhPub: peerEcdhPub, safetyNumber: number, verifiedAt: null };
    try {
      localStorage.setItem(key, JSON.stringify(pin));
    } catch {
      /* quota : l'épinglage restera en mémoire pour cette session */
    }
    return { level: "yellow", safetyNumber: number, firstContact: true, keyChanged: false };
  }

  try {
    const pin = JSON.parse(raw) as LocalPin;
    if (pin.ecdhPub !== peerEcdhPub) {
      // SUBSTITUTION / nouvel appareil : on n'écrase JAMAIS l'épinglage —
      // seul le flux de re-vérification explicite (confirmLocalTrust) le fait
      return { level: "red", safetyNumber: number, firstContact: false, keyChanged: true };
    }
    return {
      level: pin.verifiedAt ? "green" : "yellow",
      safetyNumber: number,
      firstContact: !pin.verifiedAt,
      keyChanged: false,
    };
  } catch {
    // épinglage illisible → reprendre comme premier contact
    localStorage.removeItem(key);
    return evaluateLocalTrust(me, peerPub, peerEcdhPub);
  }
}

/** Confirmation hors-bande : ré-épingle la clé COURANTE comme vérifiée. */
export async function confirmLocalTrust(
  me: { pubkey: string; ecdhPub: string },
  peerPub: string,
  peerEcdhPub: string,
  number: string
): Promise<void> {
  const pin: LocalPin = { ecdhPub: peerEcdhPub, safetyNumber: number, verifiedAt: Date.now() };
  localStorage.setItem(pinKey(me.pubkey, peerPub), JSON.stringify(pin));
}
