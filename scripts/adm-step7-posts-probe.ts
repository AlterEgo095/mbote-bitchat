/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step7-posts-probe — preuve « suspension bloque la publication » (E7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Signe un post RÉEL avec la clé privée JWK de la cible (exportée par
 *  adm-step7-proof-seed.ts) et POST /api/posts. Le runner appelle ce probe
 *  AVANT la suspension (attendu 200) et APRÈS (attendu 403).
 *
 *  Usage : bun scripts/adm-step7-posts-probe.ts <BASE_URL_MAIN>
 */

export {}; // module (top-level await — typecheck next build)

const base = process.argv[2] ?? "http://127.0.0.1:3101";
const secrets = JSON.parse(await Bun.file("db/adm-step7-secrets.json").text());
const { pubkey, privJwk } = secrets.suspTarget as { pubkey: string; privJwk: JsonWebKey };

const content = `Probe publication E7 — ${Date.now()}`;
const ts = Date.now();
const key = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const sig = await crypto.subtle.sign(
  { name: "ECDSA", hash: { name: "SHA-256" } },
  key,
  new TextEncoder().encode(`${pubkey}|${content}|${ts}`)
);
const signature = Buffer.from(sig).toString("base64url");

const res = await fetch(`${base}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pubkey, content, ts, signature }),
});
const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
console.log(JSON.stringify({ status: res.status, error: body.error ?? null }));
if (res.status !== 200 && res.status !== 403) {
  console.error(`probe : statut inattendu ${res.status}`);
  process.exit(1);
}
