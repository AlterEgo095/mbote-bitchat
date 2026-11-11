/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b2-publish-peer — publie l'identité du DESTINATAIRE de la preuve navigateur
 * ─────────────────────────────────────────────────────────────────────────────
 *  La capture navigateur montre l'EXPÉDITEUR (identité créée dans l'UI). Ce
 *  script publie un pair (ECDSA signature + clé ECDH publique) pour que la
 *  conversation soit « E2E actif » et que le dm2 média parte réellement.
 *
 *  Usage : BASE_URL=http://127.0.0.1:3103 bun scripts/b2-publish-peer.ts \
 *            [nickname]
 *  Sortie : JSON { pubkey, nickname, ecdhPub } (le runner le journalise).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const nickname = process.argv[2] ?? `B-dest-${Date.now() % 100000}`;

export {}; // module TS (top-level await)

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const signPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const ecdhPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const pubRaw = await crypto.subtle.exportKey("raw", signPair.publicKey);
const ecdhPubRaw = await crypto.subtle.exportKey("raw", ecdhPair.publicKey);
const pubkey = b64url(new Uint8Array(pubRaw));
const ecdhPub = b64url(new Uint8Array(ecdhPubRaw));

const ts = Date.now();
const message = `${pubkey}|identity|${nickname}||${ecdhPub}|${ts}`;
const signature = await crypto.subtle.sign(
  { name: "ECDSA", hash: { name: "SHA-256" } },
  signPair.privateKey,
  new TextEncoder().encode(message)
);

// bio vide ET signée vide — la chaîne canonique du serveur est
// `${pubkey}|identity|${nickname}|${bio}|${ecdhPub}|${ts}` : tout écart → 401.
const res = await fetch(`${BASE_URL}/api/identity`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pubkey,
    nickname,
    bio: "",
    ecdhPub,
    ts,
    signature: b64url(new Uint8Array(signature)),
  }),
});
if (!res.ok) {
  console.error(`[b2-publish-peer] FAIL — HTTP ${res.status} : ${await res.text()}`);
  process.exit(1);
}
const body = (await res.json()) as { user?: { pubkey?: string } };
console.log(JSON.stringify({ pubkey: body.user?.pubkey ?? pubkey, nickname, ecdhPub }));
