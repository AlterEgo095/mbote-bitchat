/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  verify — vérification ECDSA serveur (décision scalabilité D4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le client signe déjà chaque publication (ECDSA P-256, WebCrypto) sur la
 *  chaîne canonique du protocole : `${pubkey}|${content}|${ts}`.
 *  Jusqu'ici le serveur STOCKAIT la signature sans la VÉRIFIER — un quidam
 *  pouvait publier sous n'importe quelle pubkey. Ce module ferme la porte.
 *
 *  Exécuté côté serveur (WebCrypto de Node 18+, globalThis.crypto.subtle) —
 *  sans aucune dépendance, sans "use client".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Tolérance de fraîcheur : les posts créés HORS-LIGNE partent depuis l'outbox
 *  des clients et des passerelles mesh — parfois des jours plus tard. 7 jours. */
export const POST_SIGNATURE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Chaîne canonique signée (miroir exact de signPayload côté client). */
export function postSignatureMessage(pubkey: string, content: string, ts: number): string {
  return `${pubkey}|${content}|${ts}`;
}

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const buf = Buffer.from(s, "base64url");
    if (buf.length === 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export interface SignatureCheck {
  valid: boolean;
  reason?: string;
}

/**
 * Vérifie une signature ECDSA P-256 (SHA-256) sur la chaîne canonique.
 * - clé publique brute (65 o, base64url) = le `pubkey` de l'identité
 * - `ts` doit être numérique et d'âge ≤ POST_SIGNATURE_MAX_AGE_MS
 */
export async function verifyPostSignature(params: {
  pubkey: string;
  content: string;
  ts: unknown;
  signature: string;
}): Promise<SignatureCheck> {
  const { pubkey, content, ts, signature } = params;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { valid: false, reason: "WebCrypto indisponible côté serveur" };

  const tsNum = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, reason: "ts invalide" };
  }
  const age = Date.now() - tsNum;
  if (age > POST_SIGNATURE_MAX_AGE_MS) {
    return { valid: false, reason: "signature trop ancienne (hors tolérance offline)" };
  }
  if (age < -60_000) {
    return { valid: false, reason: "ts dans le futur" };
  }

  const pubBytes = b64urlToBytes(pubkey);
  const sigBytes = b64urlToBytes(signature);
  if (!pubBytes || !sigBytes) {
    return { valid: false, reason: "encodage base64url invalide" };
  }

  try {
    const key = await subtle.importKey(
      "raw",
      pubBytes as unknown as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const ok = await subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      key,
      sigBytes as unknown as BufferSource,
      new TextEncoder().encode(postSignatureMessage(pubkey, content, tsNum))
    );
    return ok ? { valid: true } : { valid: false, reason: "signature invalide" };
  } catch {
    return { valid: false, reason: "vérification impossible (clé ou signature malformée)" };
  }
}
