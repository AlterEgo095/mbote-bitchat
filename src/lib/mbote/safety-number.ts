/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  safety-number — numéro de sécurité 60 chiffres (A2, authentification des clés)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Implémentation de `docs/SAFETY-NUMBER-SPEC.md` — référence de conception :
 *  Signal fingerprint specification (hachage SHA-512 itéré 5200×, troncature
 *  30 octets, affichage 30 groupes de 5 chiffres = 60 chiffres).
 *
 *  Couvre les QUATRE clés des deux parties : (identité ECDSA, ECDH) × (A, B)
 *  — toute substitution d'ecdhPub (lacune L-3) change le numéro affiché.
 *
 *  Fichier ISOMORPHE : WebCrypto uniquement (client web, serveur, natif).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const VERSION = 0x00;
const ITERATIONS = 5200;
const FINGERPRINT_BYTES = 30;

async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto indisponible (safety-number)");
  const digest = await subtle.digest("SHA-512", data as unknown as BufferSource);
  return new Uint8Array(digest);
}

/** uint32 big-endian sur 4 octets (encodage documenté §1 de la spec) */
function uint32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** décode base64url → octets ; lève si invalide (clés malformées = refus) */
function b64urlToBytes(s: string): Uint8Array {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ordonnancement lexicographique des paires (sk‖id) → numéro symétrique */
function orderedPairs(
  a: { key: Uint8Array; id: Uint8Array },
  b: { key: Uint8Array; id: Uint8Array }
): { key: Uint8Array; id: Uint8Array }[] {
  const aFirst = compareBytes(concat(a.key, a.id), concat(b.key, b.id)) <= 0;
  return aFirst ? [a, b] : [b, a];
}

function compareBytes(x: Uint8Array, y: Uint8Array): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/**
 * Empreinte brute (30 octets) — exposée pour les tests et les usages binaires.
 * Structure conformément à la spec : SHA-512 initial sur
 * version‖iterations‖sk1‖id1‖sk2‖id2, puis 5200 itérations SHA-512(hash‖n).
 */
export async function fingerprintBytes(
  key1: string,
  id1: string,
  key2: string,
  id2: string
): Promise<Uint8Array> {
  const pairs = orderedPairs(
    { key: b64urlToBytes(key1), id: b64urlToBytes(id1) },
    { key: b64urlToBytes(key2), id: b64urlToBytes(id2) }
  );
  let hash = await sha512(
    concat(
      new Uint8Array([VERSION]),
      uint32be(ITERATIONS),
      pairs[0].key,
      pairs[0].id,
      pairs[1].key,
      pairs[1].id
    )
  );
  for (let n = 0; n < ITERATIONS; n++) {
    hash = await sha512(concat(hash, uint32be(n)));
  }
  return hash.slice(0, FINGERPRINT_BYTES);
}

/** Numéro de sécurité formaté : « 12345 67890 … » — 12 groupes de 5, 60 chiffres. */
export async function safetyNumber(
  key1: string,
  id1: string,
  key2: string,
  id2: string
): Promise<string> {
  const fp = await fingerprintBytes(key1, id1, key2, id2);
  // chaque octet → 2 chiffres (octet mod 100, format Signal) : 30 octets = 60 chiffres
  let digits = "";
  for (let i = 0; i < FINGERPRINT_BYTES; i++) {
    digits += String(fp[i] % 100).padStart(2, "0");
  }
  const display: string[] = [];
  for (let i = 0; i < digits.length; i += 5) display.push(digits.slice(i, i + 5));
  return display.join(" ");
}

/** Découpe un numéro de sécurité en 2 lignes de 6 groupes (présentation UI). */
export function safetyNumberLines(number: string): [string, string] {
  const g = number.split(" ");
  return [g.slice(0, 6).join(" "), g.slice(6, 12).join(" ")];
}
