/**
 * Test de charge Mbote — cible audit §15.4 : « montée à ~100 posts/min via
 * pont (rate limits + N+1 channels), FragmentAssembler sous flood de
 * fragments orphelins ».
 *
 * Phases :
 *   A. Montée en charge soutenue — 100 publications/min signées via le pont
 *      (10 identités ECDSA réelles, lots de 10 toutes les 6 s pendant 60 s)
 *      → latences p50/p95, comptage accepted/invalid.
 *   B. Burst au-delà des limites — 130 lots sur la MÊME passerelle
 *      (plafond 120 lots/min/passerelle) → 429 + Retry-After attendus.
 *   C. Flood de fragments orphelins — 300 fragments sans suite (borne
 *      assembler = 256 IDs actifs, LRU) puis réassembly légitime → le
 *      serveur doit rester sain et assembler un vrai paquet fragmenté.
 *   D. Burst /api/posts multi-clés — 120 publications signées (20 clés × 6)
 *      → 429 par IP attendu (plafond 60/min/IP) + Retry-After.
 *   E. Santé post-charge — latence /api/stats et /api/channels (contrôle
 *      N+1 canaux) — à comparer aux latences à vide de la phase 0.
 *
 * Usage : bun tests/load-bridge.ts   (serveur dev sur :3000)
 * Durée : ~90 s. Exit 0 = toutes les assertions passent.
 */
import {
  PROTOCOL_VERSION,
  PKT_PUBLIC,
  TTL_MAX,
  PAYLOAD_MAX_BYTES,
  bytesToBase64,
  encodePacket,
  fragmentPayload,
  fnv64,
  senderIdFromPubkey,
  utf8Encode,
  type MeshEvent,
} from "../src/lib/mbote/bitchat-protocol.ts";

const VPS = "http://127.0.0.1:3000";
const RUN = Date.now().toString(36);

// ───────────────────────── utilitaires ─────────────────────────

const subtle = globalThis.crypto.subtle;

interface Identity {
  pubkey: string;
  priv: CryptoKey;
}

async function makeIdentity(_nickname: string): Promise<Identity> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pubkey: Buffer.from(pubRaw).toString("base64url"), priv: pair.privateKey };
}

/** signature ECDSA P-256 SHA-256 base64url d'une chaîne canonique */
async function sign(priv: CryptoKey, message: string): Promise<string> {
  const sig = await subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    priv,
    new TextEncoder().encode(message)
  );
  return Buffer.from(new Uint8Array(sig)).toString("base64url");
}

async function signPost(id: Identity, content: string, ts: number): Promise<string> {
  return sign(id.priv, `${id.pubkey}|${content}|${ts}`);
}

/** paquet(s) base64 d'un événement post (fragmente si > 452 o, miroir F-03) */
function eventToPackets(ev: MeshEvent, tsSec: number): string[] {
  const payload = utf8Encode(JSON.stringify(ev));
  const fragId = parseInt(fnv64(utf8Encode(String(ev.clientRef))).slice(0, 4), 16);
  const chunks =
    payload.length <= PAYLOAD_MAX_BYTES ? [payload] : fragmentPayload(payload, fragId);
  return chunks.map((chunk) =>
    bytesToBase64(
      encodePacket({
        version: PROTOCOL_VERSION,
        type: PKT_PUBLIC,
        ttl: TTL_MAX,
        senderId: senderIdFromPubkey(ev.pubkey),
        timestamp: tsSec,
        payloadLen: chunk.length,
        payload: chunk,
      })
    )
  );
}

const latencies: number[] = [];
async function timed<T>(fn: () => Promise<T>): Promise<{ res: T; ms: number }> {
  const t0 = performance.now();
  const res = await fn();
  const ms = performance.now() - t0;
  latencies.push(ms);
  return { res, ms };
}

function percentile(p: number): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function resetLat(): void {
  latencies.length = 0;
}

async function bridgeBatch(
  gatewayId: string,
  packets: string[]
): Promise<{ status: number; retryAfter: string | null; json: Record<string, unknown> }> {
  const r = await fetch(`${VPS}/api/mesh/bridge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gatewayId, packets }),
  });
  return {
    status: r.status,
    retryAfter: r.headers.get("retry-after"),
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const results: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note: string): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${note}`);
}

// ───────────────────────── phase 0 : baseline ─────────────────────────

console.log(`\n=== Mbote charge — run ${RUN} — ${new Date().toISOString()} ===\n`);

resetLat();
for (let i = 0; i < 5; i++) {
  await timed(async () => {
    const r = await fetch(`${VPS}/api/stats`, { cache: "no-store" });
    await r.json();
  });
}
const baseStatsP95 = percentile(95);
console.log(`phase 0 — baseline /api/stats p95 : ${baseStatsP95.toFixed(0)} ms\n`);

// ───────────────────────── phase A : 100 posts/min via pont ─────────────────────────

console.log("phase A — montée soutenue 100 posts/min (60 s, 10 identités)…");
const idsA: Identity[] = [];
for (let i = 0; i < 10; i++) idsA.push(await makeIdentity(`Load-${i}`));

resetLat();
let aAccepted = 0;
let aInvalid = 0;
let aPosts = 0;
let aRequests = 0;
const phaseAStart = Date.now();
let batch = 0;
while (Date.now() - phaseAStart < 60_000) {
  const packets: string[] = [];
  const ts = Date.now();
  for (let i = 0; i < 10; i++) {
    const id = idsA[i % idsA.length];
    const content = `Mbote charge ${RUN} #${batch * 10 + i} — message de montée en charge du pont mesh.`;
    const signature = await signPost(id, content, ts);
    const ev: MeshEvent = {
      kind: "post",
      clientRef: `load-${RUN}-${batch}-${i}`,
      pubkey: id.pubkey,
      nickname: `Load-${i % idsA.length}`,
      content,
      geohash: "kdx0v",
      precision: 5,
      signature,
      ts,
    };
    packets.push(...eventToPackets(ev, Math.floor(ts / 1000)));
  }
  const { res } = await timed(() => bridgeBatch("GW-LOAD-A", packets));
  aRequests++;
  if (res.status === 200) {
    aAccepted += Number(res.json.accepted ?? 0);
    aInvalid += Number(res.json.invalid ?? 0);
    aPosts += Array.isArray(res.json.posts) ? res.json.posts.length : 0;
  }
  batch++;
  const elapsed = Date.now() - phaseAStart;
  const wait = Math.max(0, (batch * 6_000) - elapsed);
  if (wait > 0 && Date.now() - phaseAStart < 60_000) await new Promise((r) => setTimeout(r, wait));
}
console.log(
  `phase A — ${aRequests} lots · ${aAccepted} acceptés · ${aInvalid} invalides · ${aPosts} posts créés · p50 ${percentile(50).toFixed(0)} ms · p95 ${percentile(95).toFixed(0)} ms`
);
check("A — montée 100 posts/min", aAccepted >= 95 && aInvalid === 0 && aPosts >= 95,
  `${aAccepted} acceptés, ${aPosts} posts, ${aInvalid} invalides (attendu : ≥95 / ≥95 / 0)`);

// ───────────────────────── phase B : burst au-delà du plafond passerelle ─────────────────────────

console.log("\nphase B — burst 130 lots sur GW-LOAD-B (plafond 120/min)…");
resetLat();
let b429 = 0;
let b200 = 0;
let bRetryAfter: string | null = null;
const burstPacket = (await (async () => {
  const id = idsA[0];
  const ts = Date.now();
  const content = `Mbote burst ${RUN} — paquet de burst au-delà du plafond.`;
  const signature = await signPost(id, content, ts);
  const ev: MeshEvent = {
    kind: "post",
    clientRef: `burst-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
    pubkey: id.pubkey,
    nickname: "Load-0",
    content,
    signature,
    ts,
  };
  return eventToPackets(ev, Math.floor(ts / 1000))[0];
})());

for (let i = 0; i < 130; i++) {
  const { res } = await timed(() => bridgeBatch("GW-LOAD-B", [`${burstPacket}`]));
  if (res.status === 429) {
    b429++;
    bRetryAfter ??= res.retryAfter;
  } else if (res.status === 200) b200++;
}
console.log(`phase B — 200:${b200} · 429:${b429} · Retry-After:${bRetryAfter ?? "absent"}`);
check("B — plafond passerelle (120/min)", b200 >= 100 && b429 >= 5 && !!bRetryAfter,
  `${b200} lots acceptés puis ${b429}×429, Retry-After=${bRetryAfter ?? "absent"}`);

// ───────────────────────── phase C : flood de fragments orphelins ─────────────────────────

console.log("\nphase C — flood 300 fragments orphelins (borne assembler : 256 IDs actifs)…");
resetLat();
let cPending = 0;
let cInvalid = 0;
for (let b = 0; b < 30; b++) {
  const packets: string[] = [];
  for (let i = 0; i < 10; i++) {
    const fragIdNum = 1000 + b * 10 + i;
    const payload = new Uint8Array(4 + 8);
    payload[0] = (fragIdNum >> 8) & 0xff;
    payload[1] = fragIdNum & 0xff;
    payload[2] = 0; // index 0
    payload[3] = 3; // total 3 — les fragments 1 et 2 n'arriveront JAMAIS
    packets.push(
      bytesToBase64(
        encodePacket({
          version: PROTOCOL_VERSION,
          type: PKT_PUBLIC,
          ttl: TTL_MAX,
          senderId: senderIdFromPubkey("Zm1vYnRlLXN0dWJzLWZyYWc="),
          timestamp: Math.floor(Date.now() / 1000),
          payloadLen: payload.length,
          payload,
        })
      )
    );
  }
  const { res } = await timed(() => bridgeBatch("GW-LOAD-FRAG", packets));
  if (res.status === 200) {
    const details = (res.json.results as { detail?: string }[] | undefined) ?? [];
    cPending += details.filter((d) => String(d.detail ?? "").includes("en attente")).length;
  } else cInvalid++;
}
console.log(`phase C — ${cPending} orphelins en attente · ${cInvalid} lots en échec`);

// réassembly légitime APRÈS le flood — le serveur doit assembler un vrai paquet
const idC = await makeIdentity("Load-Frag");
const tsC = Date.now();
const contentC = `Mbote ${RUN} — publication légitime fragmentée envoyée APRÈS un flood de 300 fragments orphelins. Elle doit être réassemblée puis ingérée normalement, preuve que les bornes LRU/TTL n'ont ni bloqué ni corrompu le trafic réel. `.repeat(4).slice(0, 500);
const signatureC = await signPost(idC, contentC, tsC);
const evC: MeshEvent = {
  kind: "post",
  clientRef: `frag-legit-${RUN}`,
  pubkey: idC.pubkey,
  nickname: "Load-Frag",
  content: contentC,
  geohash: "kdx0v",
  precision: 5,
  signature: signatureC,
  ts: tsC,
};
const legitPackets = eventToPackets(evC, Math.floor(tsC / 1000));
const rc = await bridgeBatch("GW-LOAD-FRAG", legitPackets);
const legitOk =
  rc.status === 200 &&
  Number(rc.json.accepted ?? 0) >= 1 &&
  Array.isArray(rc.json.posts) &&
  rc.json.posts.length >= 1;
console.log(`phase C — réassembly légitime post-flood : ${legitOk ? "OK" : "ÉCHEC"} (${legitPackets.length} fragments, HTTP ${rc.status})`);
check("C — flood fragments borné + réassembly légitime", legitOk && cInvalid === 0,
  `300 orphelins absorbés (${cPending} en attente), réassembly légitime ${legitOk ? "OK" : "ÉCHEC"}`);

// ───────────────────────── phase D : burst /api/posts multi-clés ─────────────────────────

console.log("\nphase D — enregistrement de 20 identités puis burst 120 POST /api/posts (plafond 60/min/IP)…");
resetLat();
const idsD: Identity[] = [];
for (let i = 0; i < 20; i++) idsD.push(await makeIdentity(`Direct-${i}`));

// les identités doivent EXISTER avant /api/posts (404 sinon) — preuve de
// possession F-01, plafond identity 30/min/IP → 20 enregistrements tiennent.
let dRegistered = 0;
for (const [i, id] of idsD.entries()) {
  const ts = Date.now();
  const nickname = `Direct-${i}`;
  const bio = "";
  const ecdh = "";
  const signature = await sign(id.priv, `${id.pubkey}|identity|${nickname}|${bio}|${ecdh}|${ts}`);
  const r = await fetch(`${VPS}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.pubkey, nickname, bio, ecdhPub: ecdh || undefined, ts, signature }),
  });
  if (r.ok) dRegistered++;
}
console.log(`phase D — ${dRegistered}/20 identités enregistrées`);

let d200 = 0;
let d429 = 0;
let dOther = 0;
let dRetryAfter: string | null = null;
for (let i = 0; i < 120; i++) {
  const id = idsD[i % 20];
  const ts = Date.now();
  const content = `Mbote direct ${RUN} #${i} — burst publications directes hors pont.`;
  const signature = await sign(id.priv, `${id.pubkey}|${content}|${ts}`);
  const { res } = await timed(async () =>
    fetch(`${VPS}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: id.pubkey, content, signature, ts }),
    })
  );
  if (res.status === 200 || res.status === 201) d200++;
  else if (res.status === 429) {
    d429++;
    dRetryAfter ??= res.headers.get("retry-after");
  } else dOther++;
}
console.log(`phase D — 200:${d200} · 429:${d429} · autres:${dOther} · Retry-After:${dRetryAfter ?? "absent"}`);
check("D — plafond IP /api/posts (60/min)", dRegistered === 20 && d200 >= 40 && d200 <= 80 && d429 >= 20 && dOther === 0 && !!dRetryAfter,
  `20/20 identités · ${d200} acceptées puis ${d429}×429 (IP), ${dOther} autres, Retry-After=${dRetryAfter ?? "absent"}`);

// ───────────────────────── phase E : santé post-charge ─────────────────────────

console.log("\nphase E — santé post-charge (latences /api/stats et /api/channels)…");
resetLat();
for (let i = 0; i < 5; i++) {
  await timed(async () => {
    const r = await fetch(`${VPS}/api/stats`, { cache: "no-store" });
    await r.json();
  });
}
const postStatsP95 = percentile(95);

resetLat();
for (let i = 0; i < 5; i++) {
  await timed(async () => {
    const r = await fetch(`${VPS}/api/channels`, { cache: "no-store" });
    await r.json();
  });
}
const channelsP95 = percentile(95);

console.log(
  `phase E — /api/stats p95 : ${baseStatsP95.toFixed(0)} ms (à vide) → ${postStatsP95.toFixed(0)} ms (après charge) · /api/channels p95 : ${channelsP95.toFixed(0)} ms`
);
check("E — santé post-charge (N+1 canaux)",
  postStatsP95 < Math.max(1500, baseStatsP95 * 4) && channelsP95 < 2000,
  `stats ${postStatsP95.toFixed(0)} ms, channels ${channelsP95.toFixed(0)} ms (seuils dev indulgents : 1,5 s / 2 s)`);

// ───────────────────────── verdict ─────────────────────────

const failed = results.filter((r) => !r.ok);
console.log("\n──────────── VERDICT CHARGE ────────────");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name} — ${r.note}`);
console.log("");
process.exit(failed.length === 0 ? 0 : 1);
