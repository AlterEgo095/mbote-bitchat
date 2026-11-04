/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  bot-key — clé privée du bot de démo CHIFFRÉE AU REPOS (F-29, Vague 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  F-29 : `User.botPriv` stockait la JWK privée ECDH du bot en clair dans la
 *  base (démo assumée, mais un dump SQL suffisait à usurper le bot auprès de
 *  TOUS les utilisateurs). Ce module chiffre désormais la JWK au repos :
 *
 *    • format stocké : `enc:v1:<iv b64url>:<ciphertext b64url>` (AES-GCM 256)
 *    • clé de chiffrement : SHA-256(`MBOTE_BOT_KEY` si défini, sinon
 *      `SEED_SECRET`, sinon secret de repli dev journalisé en warning)
 *    • lecture transparente : une valeur legacy en clair (JWK JSON sans
 *      préfixe) est acceptée puis RE-CHIFFRÉE à la prochaine écriture de seed
 *
 *  Note honnête : sans `MBOTE_BOT_KEY` ni `SEED_SECRET` défini, le secret de
 *  repli est dérivable par quiconque lit ce dépôt — la protection vaut alors
 *  surtout contre un dump partiel / une exfiltration par copier-coller de la
 *  colonne. En production, définir `MBOTE_BOT_KEY` (32+ octets aléatoires).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ENC_PREFIX = "enc:v1:";

const subtle = () => globalThis.crypto.subtle;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64url");
}

function b64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

async function deriveKeyMaterial(): Promise<CryptoKey> {
  const secret =
    process.env.MBOTE_BOT_KEY ??
    process.env.SEED_SECRET ??
    (() => {
      console.warn(
        "[bot-key] MBOTE_BOT_KEY/SEED_SECRET absents — botPriv chiffré avec le secret de repli dev (définir MBOTE_BOT_KEY en production)"
      );
      return "mbote-dev-insecure-fallback-key";
    })();
  const digest = await subtle().digest(
    "SHA-256",
    new TextEncoder().encode(`mbote-bot-priv:${secret}`)
  );
  return subtle().importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** true si la valeur stockée est au format chiffré `enc:v1:…`. */
export function isBotPrivEncrypted(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(ENC_PREFIX);
}

/** Chiffre la JWK du bot au repos → `enc:v1:<iv>:<ciphertext>`. */
export async function encryptBotPriv(jwkJson: string): Promise<string> {
  const key = await deriveKeyMaterial();
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(jwkJson)
  );
  return `${ENC_PREFIX}${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
}

/**
 * Déchiffre la valeur stockée → JWK JSON.
 * Accepte le format legacy en clair (migration sans downtime) et lève sur
 * une enveloppe `enc:v1:` indéchiffrable (mauvaise clé serveur).
 */
export async function decryptBotPriv(stored: string): Promise<string> {
  if (!isBotPrivEncrypted(stored)) {
    // legacy en clair (déploiements antérieurs à la Vague 5)
    return stored;
  }
  // format : `enc:v1:<iv b64url>:<ct b64url>` — on retire le préfixe puis on
  // sépare iv/ciphertext (le b64url ne contient pas de « : », split sûr)
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  const ivB64 = parts[0];
  const ctB64 = parts[1];
  if (!ivB64 || !ctB64) {
    throw new Error("botPriv chiffré malformé");
  }
  const key = await deriveKeyMaterial();
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: b64urlToBytes(ivB64) as unknown as BufferSource },
      key,
      b64urlToBytes(ctB64) as unknown as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error(
      "botPriv indéchiffrable (MBOTE_BOT_KEY/SEED_SECRET a-t-il changé ? relancez /api/seed)"
    );
  }
}
