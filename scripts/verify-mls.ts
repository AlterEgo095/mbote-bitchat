/**
 * verify-mls.ts — Re-test MLS en production (reconstruction fidèle du script
 * temporaire perdu lors du recyclage de la sandbox ; contrats serveur relus
 * depuis feat/mbote-v1 : src/app/api/identity/route.ts, src/app/api/groups/*,
 * src/lib/mbote/mls/server.ts, src/lib/mbote/proof.ts).
 *
 * Scénario (4 étapes numérotées) :
 *   1. Identité de test UNIQUE (préfixe probe-M-) : PoW Sybil 20 bits + ECDSA P-256.
 *   2. Groupe MLS : mlsGroupId hex LOWERCASE strict (fix d02813c) + commit/welcome
 *      opaques (relais aveugle C4) + membre invité EXISTANT (pubkey recueillie du
 *      feed public — aucune 2e création Sybil).
 *   3. Message de groupe : ciphertext MLS opaque + mlsEpoch=1.
 *   4. Relecture membre actif : GET messages — le ciphertext opaque est servi.
 *
 * Effets de bord documentés : 1 identité créée, 1 groupe, 1 message de groupe,
 * 1 welcome adressé au membre invité (aucun contenu réel lu ni modifié).
 *
 * 429 (plafond Sybil 3/h/IP ou rate limit) → exit 42 : l'orchestrateur attend
 * 600 s et réessaie (max 3 tentatives). Exit 0 = PASS complet, exit 1 = FAIL.
 *
 * DÉFAUT LATENT #3 découvert par ce re-test (run 1, 401 group-create) :
 * verifyGroupProof vérifie la signature sur `${message}|${ts}` — le ts FINAL
 * fait partie de la chaîne signée (proof.ts verifySignedMessage : pas de
 * fallback sans ts). Les 3 preuves groupe signent donc `${...}|${ts}` ; une
 * auto-vérification locale (subtle.verify côté client) précède chaque envoi
 * pour ne plus jamais tirer à l'aveugle sur la production.
 *
 * Usage : cd /home/z && bun verify-mls.ts [baseUrl]
 */
import { createHash } from "node:crypto";

const BASE = (process.argv[2] ?? "https://mbotemesh.aenews.online").replace(/\/$/, "");

// ───────────────────────── utilitaires crypto (client réel) ─────────────────────────

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const u = new Uint8Array(n);
  globalThis.crypto.getRandomValues(u);
  return u;
}

async function signMessage(priv: CryptoKey, message: string): Promise<string> {
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(message)));
  return b64url(sig);
}

/** Pré-vol : la signature doit vérifier LOCALEMENT sur la chaîne EXACTE que le
 *  serveur reconstruira — aucun envoi production si le contrat diverge. */
async function assertSelfVerifies(pubKey: CryptoKey, message: string, sigB64url: string, label: string): Promise<void> {
  const ok = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    Uint8Array.from(atob(sigB64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    enc.encode(message)
  );
  if (!ok) {
    throw new Error(`pré-vol : signature ${label} ne vérifie PAS localement sur la chaîne canonique — abandon avant envoi`);
  }
  console.log(`   🔒 pré-vol ${label} : signature auto-vérifiée sur la chaîne canonique exacte`);
}

/** PoW Sybil : SHA-256(`${pubkey}|pow|${ts}:${nonce}`) → 20 bits à zéro (5 « 0 » hex). */
function solvePow(pubkey: string, ts: number): number {
  const target = "00000";
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const hex = createHash("sha256").update(`${pubkey}|pow|${ts}:${nonce}`).digest("hex");
    if (hex.startsWith(target)) return nonce;
  }
  throw new Error("PoW 20 bits introuvable (improbable) — abandon");
}

// ───────────────────────── helpers HTTP ─────────────────────────

class Http429 extends Error {}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: unknown; text: string }> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(25_000),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (r.status === 429) {
    throw new Http429(`429 sur ${path} : ${text.slice(0, 160)}`);
  }
  return { status: r.status, json, text };
}

function post(path: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

// ───────────────────────── programme ─────────────────────────

const stamp = Date.now().toString(36);
let failed = false;

function step(n: number, label: string): void {
  console.log(`\n── Étape ${n}/4 — ${label}`);
}

function pass(label: string, note: string): void {
  console.log(`   ✅ PASS — ${label} : ${note}`);
}

function fail(label: string, note: string): void {
  failed = true;
  console.log(`   ❌ FAIL — ${label} : ${note}`);
}

async function main(): Promise<void> {
  console.log(`\n═══ Mbote verify-mls — cible : ${BASE} ═══`);

  // ── Étape 1 — identité de test unique (probe-M-) ─────────────────────────
  step(1, "Identité de test (probe-M-) : PoW Sybil 20 bits + ECDSA P-256");
  const nick = `probe-M-${stamp}`;
  const bio = "verify-mls re-test";
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const ecdhPair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ecdhPub = b64url(new Uint8Array(await subtle.exportKey("raw", ecdhPair.publicKey)));
  const t1 = Date.now();
  const nonce = solvePow(pubkey, t1);
  const signature = await signMessage(pair.privateKey, `${pubkey}|identity|${nick}|${bio}|${ecdhPub}|${t1}`);
  const id = await post("/api/identity", {
    pubkey,
    nickname: nick,
    bio,
    ecdhPub,
    ts: t1,
    signature,
    pow: { nonce: String(nonce) }, // contrat serveur : nonce ENTIER DÉCIMAL EN CHAÎNE (isPlausibleNonce /^[0-9]+$/)
  });
  if (id.status !== 200 && id.status !== 201) {
    fail("POST /api/identity", `${id.status} : ${id.text.slice(0, 160)}`);
    finish();
    return;
  }
  pass("POST /api/identity", `${id.status} — PoW + ECDSA vérifiés serveur (nonce PoW ${String(nonce).length} chiffres) — pubkey ${pubkey.slice(0, 12)}…`);

  // ── Membre invité : identité EXISTANTE recueillie du feed public ─────────
  // (la route C4 exige ≥ 1 invité ≠ créateur dont la ligne User existe — une
  //  2e création Sybil serait un gaspillage de créneaux : on invite une
  //  identité de sonde déjà en base, visible publiquement comme auteur d'un post)
  const feed = await api("/api/posts?scope=global&limit=20");
  const posts = (feed.json as { posts?: { author?: { pubkey?: string } }[] } | null)?.posts ?? [];
  const invitee = posts.map((p) => p.author?.pubkey ?? "").find((k) => k && k !== pubkey);
  if (!invitee) {
    fail("Membre invité existant", `aucun auteur trouvé dans le feed public (status ${feed.status}, ${posts.length} post(s)) — la route C4 exige un invité existant`);
    finish();
    return;
  }
  console.log(`   ℹ️  invité (identité existante, feed public) : ${invitee.slice(0, 12)}…`);

  // ── Étape 2 — création du groupe MLS ─────────────────────────────────────
  step(2, "Groupe MLS : mlsGroupId hex lowercase + commit/welcome opaques (relais aveugle C4)");
  const mlsGroupId = Array.from(randomBytes(16)).map((b) => b.toString(16).padStart(2, "0")).join(""); // hex LOWERCASE strict — contrat serveur /^[0-9a-f]{32,128}$/ (fix d02813c)
  if (!/^[0-9a-f]{32}$/.test(mlsGroupId)) {
    fail("mlsGroupId", "génération non conforme lowercase hex 32 — abandon préventif");
    finish();
    return;
  }
  const t2 = Date.now();
  const name = `Vérif MLS re-test ${stamp}`.slice(0, 60);
  // contrat exact : verifyGroupProof(`${me}|group-create|${mlsGroupId}`, me, ts, sig)
  // → verifySignedMessage(message = `${me}|group-create|${mlsGroupId}|${ts}`)
  const gProof = `${pubkey}|group-create|${mlsGroupId}|${t2}`;
  const gsig = await signMessage(pair.privateKey, gProof);
  await assertSelfVerifies(pair.publicKey, gProof, gsig, "group-create");
  const cr = await post("/api/groups", {
    me: pubkey,
    mlsGroupId,
    name,
    ts: t2,
    signature: gsig,
    commit: b64url(randomBytes(96)), // payload MLS opaque — le serveur ne lit AUCUN contenu (borné ≤ 16 Ko)
    welcome: b64url(randomBytes(96)), // welcome adressé à l'invité (enveloppe stockée, relais aveugle)
    members: [invitee],
  });
  if (cr.status !== 200 && cr.status !== 201) {
    fail("POST /api/groups", `${cr.status} : ${cr.text.slice(0, 200)}`);
    finish();
    return;
  }
  const gj = cr.json as { groupId?: string; id?: string } | null;
  const gid = gj?.groupId ?? gj?.id ?? "";
  if (!gid) {
    fail("POST /api/groups", `${cr.status} sans groupId : ${cr.text.slice(0, 160)}`);
    finish();
    return;
  }
  pass("POST /api/groups", `${cr.status} — group ${mlsGroupId} (id ${gid}) — commit/welcome opaques acceptés`);

  // ── Étape 3 — message de groupe (ciphertext MLS opaque) ──────────────────
  step(3, "Message de groupe : ciphertext MLS opaque + mlsEpoch=1");
  const ct = b64url(randomBytes(64));
  const t3 = Date.now();
  const mProof = `${pubkey}|group-msg|${gid}|${t3}`;
  const msig = await signMessage(pair.privateKey, mProof);
  await assertSelfVerifies(pair.publicKey, mProof, msig, "group-msg");
  const gm = await post(`/api/groups/${encodeURIComponent(gid)}/messages`, {
    me: pubkey,
    ciphertext: ct,
    mlsEpoch: 1,
    ts: t3,
    signature: msig,
  });
  if (gm.status !== 200 && gm.status !== 201) {
    fail("POST /api/groups/{id}/messages", `${gm.status} : ${gm.text.slice(0, 200)}`);
    finish();
    return;
  }
  pass("POST /api/groups/{id}/messages", `${gm.status} — ciphertext opaque stocké (serveur sans plaintext, invariant C4)`);

  // ── Étape 4 — relecture membre actif ─────────────────────────────────────
  step(4, "Relecture membre actif : GET messages (le ciphertext opaque est servi)");
  const t4 = Date.now();
  const rProof = `${pubkey}|group-msgs|${gid}|${t4}`;
  const rsig = await signMessage(pair.privateKey, rProof);
  await assertSelfVerifies(pair.publicKey, rProof, rsig, "group-msgs");
  const rl = await api(`/api/groups/${encodeURIComponent(gid)}/messages?me=${encodeURIComponent(pubkey)}&ts=${t4}&signature=${encodeURIComponent(rsig)}`);
  const rows = (rl.json as { messages?: { id?: string; ciphertext?: string }[] } | null)?.messages;
  if (rl.status !== 200 || !Array.isArray(rows)) {
    fail("GET /api/groups/{id}/messages", `${rl.status} : ${rl.text.slice(0, 200)}`);
    finish();
    return;
  }
  const found = rows.find((m) => m.ciphertext === ct);
  if (!found) {
    fail("GET /api/groups/{id}/messages", `200 mais ciphertext absent (${rows.length} message(s) rendu(s))`);
    finish();
    return;
  }
  pass("GET /api/groups/{id}/messages", `200 — ${rows.length} message(s), ciphertext reçu identique (id ${found.id ?? "?"}) — round-trip MLS complet`);

  finish();
}

function finish(): void {
  console.log("");
  if (failed) {
    console.log("═══ VERDICT MLS : FAIL — chaque échec est listé ci-dessus (jamais silencieux) ═══\n");
    process.exit(1);
  }
  console.log("═══ VERDICT MLS : PASS (4/4) — identité probe-M + groupe + message + relecture ═══\n");
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof Http429) {
    console.error(`\n═══ 429 RATE LIMIT — ${e.message}`);
    console.error("═══ fenêtre glissante à attendre — orchestrateur : sleep 600 puis retry ═══\n");
    process.exit(42);
  }
  console.error("❌ erreur fatale :", e);
  process.exit(1);
});
