/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POLYFILLS React Native (Hermes) — Mbote BitChat
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le cœur du protocole (src/core/bitchat-protocol.ts) n'utilise que des APIs
 *  standards. Hermes n'en fournit pas toutes : ce fichier comble les manques
 *  AVANT tout autre import.
 *
 *  • TextEncoder / TextDecoder (implémentation UTF-8 manuelle, 100 % conforme)
 *  • crypto.getRandomValues (expo-crypto, natif, CSPRNG)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ---------- TextEncoder ----------

if (typeof globalThis.TextEncoder === "undefined") {
  class TextEncoderPolyfill {
    readonly encoding = "utf-8";

    encode(input = ""): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < input.length; i++) {
        let cp = input.codePointAt(i)!;
        if (cp > 0xffff) i++; // paire surrogate consommée
        if (cp < 0x80) {
          out.push(cp);
        } else if (cp < 0x800) {
          out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
          out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
        }
      }
      return new Uint8Array(out);
    }

    encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
      const bytes = this.encode(source);
      const written = Math.min(bytes.length, destination.length);
      destination.set(bytes.subarray(0, written));
      return { read: source.length, written };
    }
  }
  (globalThis as any).TextEncoder = TextEncoderPolyfill;
}

// ---------- TextDecoder ----------

if (typeof globalThis.TextDecoder === "undefined") {
  class TextDecoderPolyfill {
    readonly encoding = "utf-8";

    decode(bytes?: Uint8Array | ArrayBuffer | null): string {
      if (!bytes) return "";
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let out = "";
      let i = 0;
      while (i < view.length) {
        const b0 = view[i];
        let cp: number;
        let len: number;
        if (b0 < 0x80) {
          cp = b0;
          len = 1;
        } else if (b0 >> 5 === 0b110) {
          cp = b0 & 0x1f;
          len = 2;
        } else if (b0 >> 4 === 0b1110) {
          cp = b0 & 0x0f;
          len = 3;
        } else {
          cp = b0 & 0x07;
          len = 4;
        }
        if (i + len > view.length) break; // tronqué — on s'arrête proprement
        for (let k = 1; k < len; k++) {
          cp = (cp << 6) | (view[i + k] & 0x3f);
        }
        i += len;
        if (cp > 0xffff) {
          // plan supplémentaire → paire UTF-16
          const v = cp - 0x10000;
          out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
        } else {
          out += String.fromCharCode(cp);
        }
      }
      return out;
    }
  }
  (globalThis as any).TextDecoder = TextDecoderPolyfill;
}

// ---------- crypto.getRandomValues (CSPRNG natif via expo-crypto) ----------

import * as ExpoCrypto from "expo-crypto";

const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") {
  g.crypto.getRandomValues = (array: ArrayBufferView): ArrayBufferView => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const rnd = ExpoCrypto.getRandomValues(bytes.length);
    bytes.set(rnd);
    return array;
  };
}

export {};
