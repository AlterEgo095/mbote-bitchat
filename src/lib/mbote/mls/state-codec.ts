/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  mls/state-codec — sérialisation déterministe de l'état MLS (ts-mls)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Contraintes prouvées (C4-prerequisites.md §5) :
 *   (a) encodeGroupState/decodeGroupState de ts-mls 1.6.4 sont CASSÉS
 *       (InternalError au décodage de ses propres octets) — encoders TLS
 *       inutilisables ;
 *   (b) clientConfig.authService porte une fonction (non clonable) — le
 *       GroupState SEUL est sérialisé, la config est ré-attachée au chargement ;
 *   (c) structuredClone de bun est bugué ([a,b] FAIL / node conforme OK) — ce
 *       codec est le chemin déterministe, runtime-agnostique. Dans le
 *       navigateur, IndexedDB structured clone serait aussi viable, mais le
 *       codec donne un format stable versionnable (migrations d'état possibles).
 *
 *  Types traités : Uint8Array → {__t:"u8"} · bigint → {__t:"big"} ·
 *  Map → {__t:"map"} · Set → {__t:"set"} · undefined → {__t:"undef"}.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type CodedRecord = Record<string, unknown>;

function b64enc(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  // base64 standard (pas btoa — le codec doit marcher hors DOM)
  return stdB64(bin);
}

function stdB64(bin: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bin.length; i += 3) {
    const b0 = bin.charCodeAt(i);
    const b1 = i + 1 < bin.length ? bin.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < bin.length ? bin.charCodeAt(i + 2) : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bin.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bin.length ? chars[b2 & 63] : "=";
  }
  return out;
}

function stdUnB64(s: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bin = "";
  for (let i = 0; i < s.length; i += 4) {
    const n0 = chars.indexOf(s[i]);
    const n1 = chars.indexOf(s[i + 1]);
    const n2 = chars.indexOf(s[i + 2]);
    const n3 = chars.indexOf(s[i + 3]);
    bin += String.fromCharCode((n0 << 2) | (n1 >> 4));
    if (n2 !== -1 && s[i + 2] !== "=") bin += String.fromCharCode(((n1 & 15) << 4) | (n2 >> 2));
    if (n3 !== -1 && s[i + 3] !== "=") bin += String.fromCharCode(((n2 & 3) << 6) | n3);
  }
  return bin;
}

function b64dec(s: string): Uint8Array {
  const bin = stdUnB64(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode une valeur MLS en structure JSON-safe (récursif). */
export function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __t: "u8", d: b64enc(v) };
  if (typeof v === "bigint") return { __t: "big", d: String(v) };
  if (v === undefined) return { __t: "undef" };
  if (v instanceof Map) {
    return { __t: "map", d: Array.from(v).map(([mk, mv]) => ({ k: encodeValue(mk), v: encodeValue(mv) })) };
  }
  if (v instanceof Set) {
    return { __t: "set", d: Array.from(v).map((sv) => encodeValue(sv)) };
  }
  if (Array.isArray(v)) return v.map((sv) => encodeValue(sv));
  if (v && typeof v === "object") {
    const out: CodedRecord = {};
    for (const [k, sv] of Object.entries(v as CodedRecord)) {
      out[k] = encodeValue(sv);
    }
    return out;
  }
  return v;
}

/** Décode la structure JSON-safe (inverse exact — y compris les trous de Map). */
export function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((sv) => decodeValue(sv));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.__t === "string") {
      if (o.__t === "u8") return b64dec(o.d as string);
      if (o.__t === "big") return BigInt(o.d as string);
      if (o.__t === "undef") return undefined;
      if (o.__t === "map") {
        const entries = (o.d as Array<{ k: unknown; v: unknown }>).map((e) => [
          decodeValue(e.k),
          decodeValue(e.v),
        ]) as Array<[unknown, unknown]>;
        return new Map(entries);
      }
      if (o.__t === "set") {
        return new Set((o.d as unknown[]).map((sv) => decodeValue(sv)));
      }
    }
    const out: CodedRecord = {};
    for (const [k, sv] of Object.entries(o)) {
      out[k] = decodeValue(sv);
    }
    return out;
  }
  return v;
}

/** Sérialise le GroupState complet en chaîne JSON compacte. */
export function serializeGroupState(state: Record<string, unknown>): string {
  return JSON.stringify(encodeValue(state));
}

/** Désérialise une chaîne JSON en structure d'état (prototypes à ré-attacher). */
export function deserializeGroupState(json: string): Record<string, unknown> {
  return decodeValue(JSON.parse(json)) as Record<string, unknown>;
}
