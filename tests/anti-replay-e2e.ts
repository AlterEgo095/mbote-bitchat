/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  E2E A1 — anti-rejeu DM contre l'API RÉELLE (serveur dev :3000)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Preuve bout-en-bout sur le serveur vivant :
 *    S1. identités réelles (ECDSA P-256) enregistrées
 *    S2. DM v2 (msgId+seq signés dm2) → 200
 *    S3. rejeu verbatim +1 s → 409 outcome=duplicate
 *    S4. RÉ-EMBALLAGE HOSTILE : même (iv, ciphertext), NOUVEAU msgId+seq
 *        re-signés avec la VRAIE clé (signature valide !) → 409 duplicate
 *        — la garde est liée au PAYLOAD, pas aux métadonnées
 *    S5. nouveau DM seq=2 → 200 ; seq=1 (régression) → 409 seq_regression
 *    S6. enveloppe legacy (sans msgId) → 200 ; rejeu → 409
 *    S7. preuve de 8 jours → 401 (fraîcheur de preuve, vérifiée avant la garde)
 *    S8. pont mesh : le même DM dans 2 paquets DIFFÉRENTS (ré-emballage) →
 *        1er accepted, 2e duplicate — le contournement par nouveau paquet échoue
 *
 *  Usage : bun tests/anti-replay-e2e.ts   (serveur dev sur :3000)
 *  Sortie : PASS/FAIL par scénario, exit 1 au premier échec.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  PROTOCOL_VERSION,
  PKT_PRIVATE,
  TTL_MAX,
  bytesToBase64,
  encodePacket,
  senderIdFromPubkey,
  utf8Encode,
  type MeshEvent,
} from "../src/lib/mbote/bitchat-protocol.ts";

const BASE = process.env.MBOTE_BASE_URL ?? "http://127.0.0.1:3000";
const subtle = globalThis.crypto.subtle;
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sign = async (priv: CryptoKey, msg: string): Promise<string> =>
  b64url(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, priv, new TextEncoder().encode(msg))));

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function jsonFetch(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

// ── S1 : deux identités réelles ─────────────────────────────────────────────
async function makeIdentity(nickname: string) {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const ecdhPub = b64url(new Uint8Array(await subtle.exportKey("raw", ecdh.publicKey)));
  const ts = Date.now();
  const signature = await sign(
    pair.privateKey,
    `${pubkey}|identity|${nickname}||${ecdhPub}|${ts}`
  );
  const r = await jsonFetch("/api/identity", {
    method: "POST",
    body: JSON.stringify({ pubkey, nickname, ecdhPub, ts, signature }),
  });
  if (r.status !== 200) throw new Error(`identité ${nickname} refusée : ${r.status} ${JSON.stringify(r.body)}`);
  return { pubkey, ecdhPub, signPriv: pair.privateKey };
}

console.log("── S1 : identités réelles ──");
const alice = await makeIdentity(`A1-Alice-${Date.now() % 100000}`);
const bob = await makeIdentity(`A1-Bob-${Date.now() % 100000}`);
check("2 identités ECDSA enregistrées", !!alice.pubkey && !!bob.pubkey);

// ── helpers DM ───────────────────────────────────────────────────────────────
let seqCounter = 0;
async function sendDm(opts: {
  iv?: string;
  ciphertext?: string;
  msgId?: string | null;
  seq?: number | null;
  ts?: number;
}) {
  const iv = opts.iv ?? b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  const ciphertext = opts.ciphertext ?? b64url(globalThis.crypto.getRandomValues(new Uint8Array(64)));
  const msgId = opts.msgId === null ? undefined : (opts.msgId ?? `dm-${Date.now()}-${++seqCounter}`);
  const seq = opts.seq === null ? undefined : (opts.seq ?? seqCounter + 100);
  const ts = opts.ts ?? Date.now();
  const signature =
    msgId != null
      ? await sign(alice.signPriv, `${alice.pubkey}|dm2|${bob.pubkey}|${msgId}|${seq}|${iv}|${ciphertext}|${ts}`)
      : await sign(alice.signPriv, `${alice.pubkey}|dm|${bob.pubkey}|${iv}|${ciphertext}|${ts}`);
  return jsonFetch("/api/dms", {
    method: "POST",
    body: JSON.stringify({
      senderKey: alice.pubkey,
      recipientKey: bob.pubkey,
      iv,
      ciphertext,
      ...(msgId != null ? { msgId, seq } : {}),
      ts,
      signature,
    }),
  });
}

console.log("── S2–S7 : /api/dms (chaîne froide) ──");
// S2 : premier envoi
const s2 = await sendDm({ msgId: "e2e-dm-1", seq: 1 });
check("S2 DM v2 accepté (200)", s2.status === 200, `status=${s2.status} body=${JSON.stringify(s2.body).slice(0, 140)}`);

// S3 : rejeu verbatim — même requête, 1 s après
const s3 = await sendDm({ msgId: "e2e-dm-1", seq: 1, iv: (s2 as { body?: { message?: { iv?: string } } }).body?.message?.iv, ciphertext: (s2 as { body?: { message?: { ciphertext?: string } } }).body?.message?.ciphertext });
check("S3 rejeu verbatim → 409 duplicate", s3.status === 409 && s3.body.outcome === "duplicate", `status=${s3.status} outcome=${String(s3.body.outcome)}`);

// S4 : ré-emballage hostile — même PAYLOAD, nouveaux msgId/seq SIGNÉS (preuve valide)
const s4 = await sendDm({
  msgId: `forged-${Date.now()}`,
  seq: 999,
  iv: (s2 as { body?: { message?: { iv?: string } } }).body?.message?.iv,
  ciphertext: (s2 as { body?: { message?: { ciphertext?: string } } }).body?.message?.ciphertext,
});
check("S4 ré-emballage (même payload, métadonnées forgées signées) → 409 duplicate", s4.status === 409 && s4.body.outcome === "duplicate", `status=${s4.status} outcome=${String(s4.body.outcome)}`);

// S5 : progression monotone — nouveau DM seq=2 OK, puis régression seq=1
const iv2 = b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
const ct2 = b64url(globalThis.crypto.getRandomValues(new Uint8Array(64)));
const s5a = await sendDm({ msgId: "e2e-dm-2", seq: 2, iv: iv2, ciphertext: ct2 });
check("S5a nouveau DM seq=2 accepté", s5a.status === 200, `status=${s5a.status}`);
const s5b = await sendDm({ msgId: "e2e-dm-3", seq: 1, iv: b64url(globalThis.crypto.getRandomValues(new Uint8Array(12))), ciphertext: b64url(globalThis.crypto.getRandomValues(new Uint8Array(64))) });
check("S5b régression seq=1 → 409 seq_regression", s5b.status === 409 && s5b.body.outcome === "seq_regression", `status=${s5b.status} outcome=${String(s5b.body.outcome)}`);

// S6 : enveloppe legacy (sans msgId/seq) — acceptée puis rejeu
const legacyIv = b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
const legacyCt = b64url(globalThis.crypto.getRandomValues(new Uint8Array(64)));
const s6a = await sendDm({ msgId: null, seq: null, iv: legacyIv, ciphertext: legacyCt });
check("S6a enveloppe legacy acceptée", s6a.status === 200, `status=${s6a.status}`);
const s6b = await sendDm({ msgId: null, seq: null, iv: legacyIv, ciphertext: legacyCt });
check("S6b rejeu legacy → 409 duplicate", s6b.status === 409 && s6b.body.outcome === "duplicate", `status=${s6b.status} outcome=${String(s6b.body.outcome)}`);

// S7 : preuve de 8 jours → la fraîcheur de la preuve refuse AVANT la garde
const s7 = await sendDm({ msgId: "e2e-dm-old", seq: 50, ts: Date.now() - 8 * 24 * 3600 * 1000 });
check("S7 preuve de 8 jours → 401 (fraîcheur preuve)", s7.status === 401, `status=${s7.status}`);

console.log("── S8 : pont mesh (ré-emballage en paquets différents) ──");
const dmEv: MeshEvent = {
  kind: "dm",
  senderPub: alice.pubkey,
  recipientPub: bob.pubkey,
  iv: b64url(globalThis.crypto.getRandomValues(new Uint8Array(12))),
  ciphertext: b64url(globalThis.crypto.getRandomValues(new Uint8Array(64))),
  ts: Date.now(),
};
function bridgePacket(ev: MeshEvent, transportNonce: number): string {
  // deux paquets OCTETS DIFFÉRENTS portant le MÊME DM (ré-emballage) :
  // timestamp d'en-tête et payload JSON différents (msgId/seq ajoutés)
  const payload = utf8Encode(JSON.stringify({ ...ev, msgId: `mesh-${transportNonce}`, seq: transportNonce }));
  return bytesToBase64(
    encodePacket({
      version: PROTOCOL_VERSION,
      type: PKT_PRIVATE,
      ttl: TTL_MAX - transportNonce,
      senderId: senderIdFromPubkey(alice.pubkey),
      timestamp: Math.floor(Date.now() / 1000) + transportNonce,
      payloadLen: payload.length,
      payload,
    })
  );
}
const b1 = await jsonFetch("/api/mesh/bridge", {
  method: "POST",
  body: JSON.stringify({ gatewayId: "GW-A1-E2E", packets: [bridgePacket(dmEv, 1)] }),
});
const b2 = await jsonFetch("/api/mesh/bridge", {
  method: "POST",
  body: JSON.stringify({ gatewayId: "GW-A1-E2E", packets: [bridgePacket(dmEv, 2)] }),
});
const r1 = (b1.body as { results?: { status: string; detail?: string }[] }).results?.[0];
const r2 = (b2.body as { results?: { status: string; detail?: string }[] }).results?.[0];
check("S8a pont : 1er dépôt accepted", b1.status === 200 && r1?.status === "accepted", JSON.stringify(r1));
check("S8b pont : ré-emballage (paquet différent, même DM) → duplicate anti-rejeu", b2.status === 200 && r2?.status === "duplicate" && String(r2.detail).includes("anti-rejeu"), JSON.stringify(r2));

console.log("");
if (failures > 0) {
  console.error(`E2E A1 : ${failures} échec(s).`);
  process.exit(1);
}
console.log("E2E A1 : tous les scénarios adversariaux PASS.");
