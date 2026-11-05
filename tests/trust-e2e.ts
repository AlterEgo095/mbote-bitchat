/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  E2E A2 — authentification des clés contre l'API RÉELLE (serveur dev :3000)
 * ─────────────────────────────────────────────────────────────────────────────
 *  S1. identités réelles enregistrées (Alice, Bob — ECDSA P-256)
 *  S2. premier contact : GET /api/trust → yellow / unverified + numéro
 *  S3. substitution APRÈS établissement : Bob PUBLIE une nouvelle ecdhPub
 *      (identité re-signée — scénario « nouvel appareil » ET « attaque », le
 *      protocole ne peut pas les distinguer, c'est le rôle de la vérification
 *      hors-bande) → GET /api/trust → changed + keyChanged=true
 *  S4. re-vérification : POST /api/trust/verify avec le NOUVEAU numéro →
 *      verified / green (et la substitution suivante re-déclenche l'alerte)
 *  S5. preuve invalide → 401 (aucun état de confiance accessible sans clé)
 *
 *  Usage : bun tests/trust-e2e.ts   (serveur dev sur :3000)
 * ─────────────────────────────────────────────────────────────────────────────
 */

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

interface Identity {
  pubkey: string;
  ecdhPub: string;
  signPriv: CryptoKey;
}

async function makeIdentity(nickname: string, ecdhPub?: string): Promise<Identity> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  let pub: string;
  if (ecdhPub) {
    pub = ecdhPub; // rotation : l'ecdhPub est fourni par l'appelant
  } else {
    const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    pub = b64url(new Uint8Array(await subtle.exportKey("raw", ecdh.publicKey)));
  }
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const ts = Date.now();
  const signature = await sign(pair.privateKey, `${pubkey}|identity|${nickname}||${pub}|${ts}`);
  const r = await jsonFetch("/api/identity", {
    method: "POST",
    body: JSON.stringify({ pubkey, nickname, ecdhPub: pub, ts, signature }),
  });
  if (r.status !== 200) throw new Error(`identité ${nickname} refusée : ${r.status}`);
  return { pubkey, ecdhPub: pub, signPriv: pair.privateKey };
}

async function getTrust(me: Identity, peerPub: string) {
  const ts = Date.now();
  const signature = await sign(me.signPriv, `${me.pubkey}|trust|${peerPub}|${ts}`);
  const r = await jsonFetch(`/api/trust?me=${encodeURIComponent(me.pubkey)}&peer=${encodeURIComponent(peerPub)}&ts=${ts}&signature=${encodeURIComponent(signature)}`);
  return { status: r.status, trust: r.body.trust as Record<string, unknown> | undefined };
}

console.log("── S1 : identités réelles ──");
const alice = await makeIdentity(`A2-Alice-${Date.now() % 100000}`);
const bobFirstEcdh = undefined;
const bob = await makeIdentity(`A2-Bob-${Date.now() % 100000}`, bobFirstEcdh);
check("2 identités enregistrées", !!alice.pubkey && !!bob.pubkey);

console.log("── S2 : premier contact ──");
const s2 = await getTrust(alice, bob.pubkey);
check("S2 état initial unverified/yellow + numéro 60 chiffres",
  s2.status === 200 &&
  String((s2.trust?.state as string)) === "unverified" &&
  String((s2.trust?.safetyNumber as string)).replace(/ /g, "").length === 60,
  `status=${s2.status} ${JSON.stringify(s2.trust ?? s2.body).slice(0, 160)}`);

console.log("── S3 : substitution / nouvel appareil (rotation d'ecdhPub) ──");
// réutilise la MÊME identité ECDSA (même pubkey) avec une NOUVELLE ecdhPub —
// le protocole ne distingue pas « nouvel appareil » et « attaque » : c'est le
// rôle de la vérification hors-bande du numéro de sécurité de trancher.
const bobRotatedEcdh = b64url(new Uint8Array(await subtle.exportKey("raw", (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])).publicKey)));
{
  const nickname2 = `A2-Bob-rot-${Date.now() % 100000}`;
  const ts = Date.now();
  const signature = await sign(bob.signPriv, `${bob.pubkey}|identity|${nickname2}||${bobRotatedEcdh}|${ts}`);
  const r = await jsonFetch("/api/identity", {
    method: "POST",
    body: JSON.stringify({ pubkey: bob.pubkey, nickname: nickname2, ecdhPub: bobRotatedEcdh, ts, signature }),
  });
  check("S3a rotation d'ecdhPub acceptée (identité re-signée)", r.status === 200, `status=${r.status}`);
}
const s3 = await getTrust(alice, bob.pubkey);
check("S3b après rotation → changed + keyChanged (alerte rouge)",
  s3.status === 200 && String((s3.trust?.state as string)) === "changed" && s3.trust?.keyChanged === true,
  `status=${s3.status} ${JSON.stringify(s3.trust ?? s3.body).slice(0, 200)}`);

console.log("── S4 : re-vérification (flux nouvel appareil légitime) ──");
const newNumber = String(s3.trust?.safetyNumber ?? "");
{
  const ts = Date.now();
  const signature = await sign(alice.signPriv, `${alice.pubkey}|trust-verify|${bob.pubkey}|${newNumber}|${ts}`);
  const r = await jsonFetch("/api/trust/verify", {
    method: "POST",
    body: JSON.stringify({ me: alice.pubkey, peer: bob.pubkey, safetyNumber: newNumber, ts, signature }),
  });
  const trust = r.body.trust as Record<string, unknown> | undefined;
  check("S4a re-vérification → verified/green sur la nouvelle clé",
    r.status === 200 && String(trust?.state) === "verified" && trust?.keyChanged === false,
    `status=${r.status} ${JSON.stringify(trust ?? r.body).slice(0, 160)}`);
}
// et une NOUVELLE rotation re-déclenche l'alerte
const bobRotated2 = b64url(new Uint8Array(await subtle.exportKey("raw", (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])).publicKey)));
{
  const nickname3 = `A2-Bob-rot2-${Date.now() % 100000}`;
  const ts = Date.now();
  const signature = await sign(bob.signPriv, `${bob.pubkey}|identity|${nickname3}||${bobRotated2}|${ts}`);
  await jsonFetch("/api/identity", {
    method: "POST",
    body: JSON.stringify({ pubkey: bob.pubkey, nickname: nickname3, ecdhPub: bobRotated2, ts, signature }),
  });
}
const s4b = await getTrust(alice, bob.pubkey);
check("S4b nouvelle rotation → alerte rouge re-déclenchée",
  s4b.trust?.keyChanged === true && String((s4b.trust?.state as string)) === "changed",
  JSON.stringify(s4b.trust).slice(0, 160));

console.log("── S5 : accès sans preuve valide ──");
{
  const ts = Date.now();
  const badSig = await sign(alice.signPriv, `${alice.pubkey}|trust|autre-chose|${ts}`);
  const r = await jsonFetch(`/api/trust?me=${encodeURIComponent(alice.pubkey)}&peer=${encodeURIComponent(bob.pubkey)}&ts=${ts}&signature=${encodeURIComponent(badSig)}`);
  check("S5 preuve invalide → 401", r.status === 401, `status=${r.status}`);
}

console.log("");
if (failures > 0) {
  console.error(`E2E A2 : ${failures} échec(s).`);
  process.exit(1);
}
console.log("E2E A2 : tous les scénarios PASS.");
