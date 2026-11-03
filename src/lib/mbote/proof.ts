/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  proof — preuves de possession de clé (F-01, audit Vague 1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le modèle « clé = compte » n'est sûr que si chaque mutation d'identité ou
 *  d'action sociale est signée par la clé privée correspondante. Ce module
 *  définit les chaînes canoniques signées + la vérification ECDSA P-256.
 *
 *  Fichier ISOMORPHE : importable côté client (builders) comme côté serveur
 *  (builders + verify). Zéro Buffer, zéro API Node — WebCrypto uniquement.
 *
 *  Chaînes canoniques (miroirs exacts client ↔ serveur) :
 *    post    : `${pubkey}|${content}|${ts}`                       (historique)
 *    identity: `${pubkey}|identity|${nickname}|${bio}|${ecdhPub}|${ts}`
 *    like    : `${pubkey}|like|${postId}|${ts}`
 *    follow  : `${pubkey}|follow|${action}|${targetPub}|${ts}`
 *    dm      : `${senderKey}|dm|${recipientKey}|${iv}|${ciphertext}|${ts}`
 *
 *  Fraîcheur : les actions peuvent dormir des jours dans un outbox hors-ligne
 *  (store-and-forward) → tolérance 7 jours alignée sur les posts. Un `ts`
 *  dans le futur (> 60 s de dérive) est rejeté.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Tolérance de fraîcheur des preuves d'action (hors-ligne 7 j, comme les posts) */
export const ACTION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Dérive horloge acceptée dans le futur */
export const ACTION_FUTURE_TOLERANCE_MS = 60_000;

// ───────────────────────── Chaînes canoniques ─────────────────────────

export interface IdentityProofFields {
  pubkey: string;
  nickname: string;
  bio?: string;
  ecdhPub?: string;
  ts: number;
}

/** Chaîne canonique signée pour la création / mise à jour d'identité. */
export function identityProofMessage(f: IdentityProofFields): string {
  return `${f.pubkey}|identity|${f.nickname}|${f.bio ?? ""}|${f.ecdhPub ?? ""}|${f.ts}`;
}

export function likeProofMessage(pubkey: string, postId: string, ts: number): string {
  return `${pubkey}|like|${postId}|${ts}`;
}

export function followProofMessage(
  followerPub: string,
  targetPub: string,
  action: "follow" | "unfollow",
  ts: number
): string {
  return `${followerPub}|follow|${action}|${targetPub}|${ts}`;
}

export function dmProofMessage(
  senderKey: string,
  recipientKey: string,
  iv: string,
  ciphertext: string,
  ts: number
): string {
  return `${senderKey}|dm|${recipientKey}|${iv}|${ciphertext}|${ts}`;
}

/** Chaîne canonique des publications (historique, inchangée) */
export function postSignatureMessage(pubkey: string, content: string, ts: number): string {
  return `${pubkey}|${content}|${ts}`;
}

// ───────────────────────── Décodage base64url pur JS ─────────────────────────

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64url → octets (100 % JS, sans Buffer — isomorphe). null si invalide. */
export function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (clean.length === 0) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_ALPHABET.indexOf(clean[i]);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

/**
 * Format de clé valide = clé publique ECDSA P-256 brute non compressée :
 * 65 octets, préfixe 0x04. C'est le format produit par WebCrypto
 * `exportKey("raw")` (web) et le module mobile — rejet de tout autre format.
 */
export function isValidPubkeyFormat(pubkey: unknown): pubkey is string {
  const bytes = typeof pubkey === "string" ? b64urlToBytes(pubkey) : null;
  return !!bytes && bytes.length === 65 && bytes[0] === 0x04;
}

// ───────────────────────── Vérification ECDSA ─────────────────────────

export interface SignatureCheck {
  valid: boolean;
  reason?: string;
}

function checkFreshness(ts: unknown): { tsNum: number } | SignatureCheck {
  const tsNum = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, reason: "ts invalide" };
  }
  const age = Date.now() - tsNum;
  if (age > ACTION_MAX_AGE_MS) {
    return { valid: false, reason: "preuve trop ancienne (hors tolérance offline)" };
  }
  if (age < -ACTION_FUTURE_TOLERANCE_MS) {
    return { valid: false, reason: "ts dans le futur" };
  }
  return { tsNum };
}

/**
 * Vérifie une signature ECDSA P-256 (SHA-256) sur une chaîne canonique
 * quelconque (identity, like, follow, dm). La clé publique est fournie
 * brute base64url — exactement le `pubkey` de l'identité.
 */
export async function verifySignedMessage(params: {
  message: string;
  pubkey: string;
  ts: unknown;
  signature: unknown;
}): Promise<SignatureCheck> {
  const { message, pubkey, ts, signature } = params;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { valid: false, reason: "WebCrypto indisponible côté serveur" };
  if (typeof signature !== "string" || signature.length === 0) {
    return { valid: false, reason: "signature manquante" };
  }
  if (!isValidPubkeyFormat(pubkey)) {
    return { valid: false, reason: "format de clé publique invalide (65 octets attendus)" };
  }

  const fresh = checkFreshness(ts);
  if ("valid" in fresh) return fresh;

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
      new TextEncoder().encode(message)
    );
    return ok ? { valid: true } : { valid: false, reason: "signature invalide" };
  } catch {
    return { valid: false, reason: "vérification impossible (clé ou signature malformée)" };
  }
}
