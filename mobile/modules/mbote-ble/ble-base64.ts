/**
 * Base64 sans dépendance — utilisé par la facade pour échanger avec le natif.
 * (Réutilise l'alphabet standard du cœur, ici auto-contenu pour le module.)
 */
const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    out +=
      B64[b0 >> 2] +
      B64[((b0 & 0x03) << 4) | (b1 >> 4)] +
      (has1 ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=") +
      (has2 ? B64[b2 & 0x3f] : "=");
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) throw new Error("base64 invalide");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}
