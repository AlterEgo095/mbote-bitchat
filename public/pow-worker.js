// ─────────────────────────────────────────────────────────────────────────────
// pow-worker — Preuve de travail D2 (Sybil phase 0), calcul dans un Web Worker
// ─────────────────────────────────────────────────────────────────────────────
// Le POST /api/identity de CRÉATION exige un PoW SHA-256 itéré à 20 bits
// (≈ 2^19 itérations en moyenne, ~2-5 s mobile bas de gamme). Le calcul tourne
// ICI (hors thread principal) pour ne jamais bloquer l'UI ; la progression est
// postée toutes les 4096 itérations.
//
// Module volontairement AUTONOME (public/, non bundlé) : WebCrypto est
// disponible dans les workers en contexte sécurisé. La parité de la règle de
// difficulté avec le serveur (sybil.ts hashMeetsDifficultyHex) est validée de
// bout en bout par la preuve navigateur D2 (le PoW du worker est accepté par
// le serveur réel).
// ─────────────────────────────────────────────────────────────────────────────

const PROGRESS_EVERY = 4096;

/** Le tableau d'octets du digest commence-t-il par `bits` bits à zéro ? */
function meetsDifficulty(bytes, bits) {
  if (bits <= 0) return true;
  let remaining = bits;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (remaining <= 0) return true;
    if (b === 0) {
      remaining -= 8;
      continue;
    }
    let zeros = 0;
    for (let bit = 7; bit >= 0; bit--) {
      if ((b >> bit) & 1) break;
      zeros++;
    }
    return zeros >= remaining;
  }
  return remaining <= 0;
}

self.onmessage = async (e) => {
  const { challenge, difficultyBits } = e.data || {};
  if (typeof challenge !== "string" || typeof difficultyBits !== "number") {
    self.postMessage({ type: "error", message: "challenge/difficultyBits invalides" });
    return;
  }
  const t0 = performance.now();
  const enc = new TextEncoder();
  const prefix = challenge + ":";
  let n = 0;
  let sinceProgress = 0;
  const expected = Math.pow(2, difficultyBits);
  try {
    for (;;) {
      const buf = await crypto.subtle.digest("SHA-256", enc.encode(prefix + n));
      if (meetsDifficulty(new Uint8Array(buf), difficultyBits)) {
        self.postMessage({
          type: "done",
          nonce: String(n),
          iterations: n + 1,
          ms: performance.now() - t0,
          expected,
        });
        return;
      }
      n++;
      sinceProgress++;
      if (sinceProgress >= PROGRESS_EVERY) {
        sinceProgress = 0;
        self.postMessage({
          type: "progress",
          iterations: n,
          ms: performance.now() - t0,
          expected,
        });
      }
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
