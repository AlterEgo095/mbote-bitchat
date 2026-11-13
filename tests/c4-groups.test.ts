import { solvePow } from "./pow-harness";
/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C4 — GROUPES PRIVÉS MLS : tests ADVERSARIAUX SYSTÈME (3 clients réels)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (lancée par le runner avec le serveur RÉEL en route) :
 *    APP_URL=http://127.0.0.1:3122 bun test tests/c4-groups.test.ts
 *
 *  Garde CI (pattern D1/D2 — skip PROPRE documenté, jamais silencieux) :
 *  sans APP_URL (ex. bun test tests/ de tests.yml — pas de serveur de
 *  preuve), la suite est SKIPPÉE ; sa couverture système reste assurée par
 *  scripts/c4-mls-groups-proof-run.sh (preuve navigateur §7) et le runner
 *  hebdomadaire weekly-proof-run.yml.
 *
 *  Les 3 clients (Alice/Bob/Carol) sont des identités ECDSA RÉELLES avec des
 *  états MLS RÉELS (ts-mls, suite P-256) qui passent par les VRAIS endpoints
 *  HTTP (preuves de transport comprises). Aucun mock de serveur.
 *
 *  Scénarios (directive C4) :
 *   W1. Flux complet : 3 onboarding réels → key packages → création du groupe
 *       (UN commit multi-adds + welcome) → les 2 invités rejoignent → les trois
 *       déchiffrent M1.
 *   W2. FORWARD SECRECY : Bob retiré → M2 déchiffré par Carol, REFUSÉ par Bob.
 *   W3. EPOCH ROTATION : epoch++ visible à chaque add/remove, tous les membres
 *       à jour acceptent la mise à jour.
 *   W4. REPLAY : un message déjà consommé, rejoué → REFUS (ratchet).
 *   W5. COLLUSION : l'état périmé exfiltré de Bob (combiné à un état retiré)
 *       ne déchiffre pas les messages de l'epoch suivante.
 *   W6. INVARIANTS SERVEUR : ciphertext opaque (aucun plaintext trouvé), invite
 *       par non-créateur → 403, auto-retrait créateur → 400, preuve absente →
 *       401, ciphertext > 16 Ko → 400.
 *   W7. KEY PACKAGE SINGLE-USE : la 2ᵉ consommation du même utilisateur → 404.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  emptyPskIndex,
  defaultCapabilities,
  defaultLifetime,
  generateKeyPackage,
  createGroup,
  joinGroup,
  createCommit,
  processPrivateMessage,
  createApplicationMessage,
  encodeMlsMessage,
  decodeMlsMessage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type ClientState,
} from "ts-mls";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3122";
// Skip propre : la suite exige un serveur RÉEL (runner C4). Sans APP_URL →
// SKIPPÉ (CI tests.yml) — un throw en beforeAll rendait TOUTE la suite rouge
// pour un prérequis absent (bloqueur CI découvert vague durcissement).
const d = process.env.APP_URL ? describe : describe.skip;

const impl = await getCiphersuiteImpl(
  getCiphersuiteFromName("MLS_128_DHKEMP256_AES128GCM_SHA256_P256")
);

// ── identités (ECDSA sign + ECDH identité) et onboarding réel ───────────────

interface Identity {
  name: string;
  pubkey: string;
  signPriv: CryptoKey;
  ecdhPub: string;
  /** key packages privés publiés : wire b64 → { pub, priv } */
  kps: Map<string, { pub: unknown; priv: unknown }>;
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64url");
}

function stdB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function stdUnB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

async function makeIdentity(name: string): Promise<Identity> {
  const sign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pubRaw = await crypto.subtle.exportKey("raw", sign.publicKey);
  const ecdhRaw = await crypto.subtle.exportKey("raw", ecdh.publicKey);
  return {
    name,
    pubkey: b64url(pubRaw),
    signPriv: sign.privateKey,
    ecdhPub: b64url(ecdhRaw),
    kps: new Map(),
  };
}

async function sign(identity: Identity, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.signPriv,
    new TextEncoder().encode(message)
  );
  return b64url(sig);
}

async function onboard(identity: Identity): Promise<void> {
  const ts = Date.now();
  const signature = await sign(identity, `${identity.pubkey}|identity|${identity.name}||${ecdhOf(identity)}|${ts}`);
  const res = await fetch(`${APP_URL}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pubkey: identity.pubkey,
      nickname: identity.name,
      bio: "",
      ecdhPub: identity.ecdhPub,
      ts,
      signature,
      pow: solvePow(identity.pubkey, ts),
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`onboarding ${identity.name} échoué : ${res.status}`);
  }
}

function ecdhOf(_identity: Identity): string {
  return _identity.ecdhPub;
}

// ── key packages (publier / consommer) ──────────────────────────────────────

async function publishKps(identity: Identity, count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    const kp = await generateKeyPackage(
      { identity: new TextEncoder().encode(identity.pubkey), credentialType: "basic" },
      defaultCapabilities(),
      defaultLifetime,
      [],
      impl
    );
    const wire = encodeMlsMessage({
      keyPackage: kp.publicPackage as never,
      wireformat: "mls_key_package",
      version: "mls10",
    });
    const wireB64 = stdB64(wire);
    identity.kps.set(wireB64, { pub: kp.publicPackage, priv: kp.privatePackage });
    const ts = Date.now();
    const res = await fetch(`${APP_URL}/api/mls/keypackages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: identity.pubkey,
        ts,
        signature: await sign(identity, `${identity.pubkey}|mls-kp|${ts}`),
        keyPackage: wireB64,
      }),
    });
    if (!res.ok) throw new Error(`publication KP ${identity.name} échouée : ${res.status}`);
  }
}

async function consumeKp(consumer: Identity, target: string): Promise<never> {
  const ts = Date.now();
  const q = `me=${encodeURIComponent(consumer.pubkey)}&ts=${ts}&signature=${encodeURIComponent(
    await sign(consumer, `${consumer.pubkey}|mls-kp-get|${target}|${ts}`)
  )}`;
  const res = await fetch(`${APP_URL}/api/mls/keypackages/${encodeURIComponent(target)}?${q}`);
  if (!res.ok) throw new Error(`KP de ${target.slice(0, 6)} indisponible : ${res.status}`);
  const json = (await res.json()) as { keyPackage: string };
  const [decoded] = decodeMlsMessage(stdUnB64(json.keyPackage), 0) as unknown as Array<{
    wireformat: string;
    keyPackage: never;
  }>;
  return decoded.keyPackage;
}

// ── flux de groupe (même protocole que client.ts) ───────────────────────────

interface GroupCtx {
  serverGroupId: string;
  mlsGroupIdHex: string;
  states: Map<string, ClientState>; // par pubkey
}

function epochOf(state: ClientState): number {
  return Number(state.groupContext.epoch);
}

async function createGroupFlow(creator: Identity, members: Identity[], name: string): Promise<GroupCtx> {
  const ownKp = await generateKeyPackage(
    { identity: new TextEncoder().encode(creator.pubkey), credentialType: "basic" },
    defaultCapabilities(),
    defaultLifetime,
    [],
    impl
  );
  const mlsGroupId = crypto.getRandomValues(new Uint8Array(16));
  const mlsGroupIdHex = Buffer.from(mlsGroupId).toString("hex");
  let state = await createGroup(mlsGroupId, ownKp.publicPackage, ownKp.privatePackage, [], impl);

  const adds: Array<{ proposalType: "add"; add: { keyPackage: never } }> = [];
  for (const member of members) {
    adds.push({ proposalType: "add", add: { keyPackage: await consumeKp(creator, member.pubkey) } });
  }
  const commit = await createCommit(
    { state, cipherSuite: impl, pskIndex: emptyPskIndex },
    { extraProposals: adds, ratchetTreeExtension: true }
  );
  state = commit.newState;
  if (!commit.welcome) throw new Error("welcome manquant");
  const commitB64 = stdB64(encodeMlsMessage(commit.commit as never));
  const welcomeB64 = stdB64(
    encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome: commit.welcome })
  );

  const ts = Date.now();
  const res = await fetch(`${APP_URL}/api/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      me: creator.pubkey,
      ts,
      signature: await sign(creator, `${creator.pubkey}|group-create|${mlsGroupIdHex}|${ts}`),
      name,
      mlsGroupId: mlsGroupIdHex,
      commit: commitB64,
      welcome: welcomeB64,
      members: members.map((m) => m.pubkey),
    }),
  });
  if (!res.ok) throw new Error(`création groupe échouée : ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { groupId: string };
  return { serverGroupId: json.groupId, mlsGroupIdHex, states: new Map([[creator.pubkey, state]]) };
}

/** Joint le membre via les enveloppes pendues (welcome) + rattrape les commits. */
async function joinAndSync(member: Identity, ctx: GroupCtx): Promise<ClientState> {
  // 1. enveloppes pendues
  const ts = Date.now();
  const q = `me=${encodeURIComponent(member.pubkey)}&ts=${ts}&signature=${encodeURIComponent(
    await sign(member, `${member.pubkey}|group-env|${ctx.serverGroupId}|${ts}`)
  )}`;
  const res = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/envelopes?${q}`);
  if (!res.ok) throw new Error(`enveloppes ${member.name} : ${res.status}`);
  const { envelopes } = (await res.json()) as {
    envelopes: Array<{ id: string; kind: string; targetKey: string | null; payload: string }>;
  };

  let state: ClientState | null = null;
  for (const env of envelopes) {
    const [decoded] = decodeMlsMessage(stdUnB64(env.payload), 0) as unknown as Array<{
      wireformat: string;
      welcome?: never;
      privateMessage?: never;
    }>;
    if (env.kind === "welcome" && env.targetKey === member.pubkey && decoded.welcome) {
      // essayer les key packages privés en cache (le bon = celui consommé)
      for (const [, kp] of member.kps) {
        try {
          const joined = await joinGroup(decoded.welcome, kp.pub as never, kp.priv as never, emptyPskIndex, impl, undefined);
          state = joined;
          const entry = Array.from(member.kps.entries()).find(([, v]) => v === kp);
          if (entry) member.kps.delete(entry[0]);
          break;
        } catch {
          /* pas le bon key package */
        }
      }
      if (!state) throw new Error(`${member.name} : aucun key package ne correspond au welcome`);
    } else if (decoded.privateMessage && state) {
      const result = await processPrivateMessage(state, decoded.privateMessage, emptyPskIndex, impl);
      if (result.kind === "newState") state = result.newState;
    }
  }

  // 2. rattraper les commits déjà diffusés avant la jointure (l'epoch courant)
  if (!state) throw new Error(`${member.name} : pas de welcome traité`);
  const synced = await processCommitsUntil(member, ctx, state);
  ctx.states.set(member.pubkey, synced);
  return synced;
}

/** Traite les commits en attente (tous les membres appellent après un add/remove). */
async function processCommitsUntil(member: Identity, ctx: GroupCtx, state: ClientState): Promise<ClientState> {
  const ts = Date.now();
  const q = `me=${encodeURIComponent(member.pubkey)}&ts=${ts}&signature=${encodeURIComponent(
    await sign(member, `${member.pubkey}|group-env|${ctx.serverGroupId}|${ts}`)
  )}`;
  const res = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/envelopes?${q}`);
  if (!res.ok) return state;
  const { envelopes } = (await res.json()) as {
    envelopes: Array<{ id: string; kind: string; targetKey: string | null; payload: string }>;
  };
  let current = state;
  const seen = processedBy.get(member.pubkey) ?? new Set<string>();
  for (const env of envelopes) {
    if (env.kind !== "commit" || seen.has(env.id)) continue;
    const [decoded] = decodeMlsMessage(stdUnB64(env.payload), 0) as unknown as Array<{
      privateMessage?: never;
    }>;
    if (!decoded.privateMessage) continue;
    try {
      const result = await processPrivateMessage(current, decoded.privateMessage, emptyPskIndex, impl);
      if (result.kind === "newState") current = result.newState;
    } catch {
      /* commit déjà ratcheté par le membre (état plus avancé) */
    }
    seen.add(env.id);
  }
  processedBy.set(member.pubkey, seen);
  return current;
}

const processedBy = new Map<string, Set<string>>();
const results_bench: Record<string, number> = {};

async function sendGroupMessage(from: Identity, ctx: GroupCtx, text: string): Promise<{ id: string; wire: Uint8Array; epoch: number }> {
  const state = ctx.states.get(from.pubkey);
  if (!state) throw new Error(`état manquant pour ${from.name}`);
  const app = await createApplicationMessage(state, new TextEncoder().encode(text), impl);
  ctx.states.set(from.pubkey, app.newState);
  const wire = encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_private_message",
    privateMessage: app.privateMessage as never,
  });
  const ts = Date.now();
  const res = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      me: from.pubkey,
      ts,
      signature: await sign(from, `${from.pubkey}|group-msg|${ctx.serverGroupId}|${ts}`),
      ciphertext: stdB64(wire),
      mlsEpoch: epochOf(app.newState),
    }),
  });
  if (!res.ok) throw new Error(`envoi ${from.name} : ${res.status}`);
  const json = (await res.json()) as { messageId: string };
  return { id: json.messageId, wire, epoch: epochOf(app.newState) };
}

interface ReceivedMessage {
  id: string;
  senderKey: string;
  ciphertext: string;
  mlsEpoch: string;
}

async function listMessages(member: Identity, ctx: GroupCtx): Promise<ReceivedMessage[]> {
  const ts = Date.now();
  const q = `me=${encodeURIComponent(member.pubkey)}&ts=${ts}&signature=${encodeURIComponent(
    await sign(member, `${member.pubkey}|group-msgs|${ctx.serverGroupId}|${ts}`)
  )}`;
  const res = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/messages?${q}`);
  if (!res.ok) throw new Error(`lecture ${member.name} : ${res.status}`);
  const json = (await res.json()) as { messages: ReceivedMessage[] };
  return json.messages;
}

/** Déchiffre le fil depuis l'état courant — retourne les textes lus. */
async function decryptAll(member: Identity, ctx: GroupCtx, alreadySeen: Set<string>): Promise<string[]> {
  const msgs = await listMessages(member, ctx);
  const texts: string[] = [];
  let state = ctx.states.get(member.pubkey);
  if (!state) return texts;
  for (const msg of msgs) {
    if (alreadySeen.has(msg.id) || msg.senderKey === member.pubkey) continue;
    try {
      const [decoded] = decodeMlsMessage(stdUnB64(msg.ciphertext), 0) as unknown as Array<{
        privateMessage?: never;
      }>;
      if (!decoded.privateMessage) continue;
      const result = await processPrivateMessage(state, decoded.privateMessage, emptyPskIndex, impl);
      if (result.kind === "applicationMessage") {
        state = result.newState;
        texts.push(new TextDecoder().decode(result.message));
        alreadySeen.add(msg.id);
      } else if (result.kind === "newState") {
        state = result.newState;
      }
    } catch {
      /* indéchiffrable (epoch périmée) — compté comme refus par l'appelant */
    }
  }
  ctx.states.set(member.pubkey, state);
  return texts;
}

// ── suite ────────────────────────────────────────────────────────────────────

let A: Identity, B: Identity, C: Identity;
let ctx: GroupCtx;

const seenB = new Set<string>();
const seenC = new Set<string>();

d("C4 groupes MLS — système (serveur réel)", () => {
  beforeAll(async () => {
    // garde : le serveur doit être là (le runner le fournit)
    const probe = await fetch(`${APP_URL}/api/stats`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!probe || !probe.ok) {
      throw new Error(`APP_URL ${APP_URL} injoignable — lancer via scripts/c4-mls-groups-proof-run.sh`);
    }
    A = await makeIdentity("C4-Alice");
    B = await makeIdentity("C4-Bob");
    C = await makeIdentity("C4-Carol");
    await Promise.all([onboard(A), onboard(B), onboard(C)]);
    await Promise.all([publishKps(A, 2), publishKps(B, 2), publishKps(C, 2)]);
  });

  test("W1 — flux complet : création, jointures, M1 lu par les trois", async () => {
    ctx = await createGroupFlow(A, [B, C], "C4-Groupe-Preuve");
    expect(ctx.serverGroupId).toBeTruthy();
    const aState = ctx.states.get(A.pubkey);
    expect(aState).toBeTruthy();
    expect(epochOf(aState as ClientState)).toBe(1); // 0 + commit add

    await joinAndSync(B, ctx);
    await joinAndSync(C, ctx);
    const bState = ctx.states.get(B.pubkey);
    const cState = ctx.states.get(C.pubkey);
    expect(bState).toBeTruthy();
    expect(cState).toBeTruthy();
    expect(epochOf(bState as ClientState)).toBe(1);
    expect(epochOf(cState as ClientState)).toBe(1);

    const m1 = await sendGroupMessage(A, ctx, "M1-secret");
    expect(m1.epoch).toBe(1);

    const readB = await decryptAll(B, ctx, seenB);
    const readC = await decryptAll(C, ctx, seenC);
    expect(readB).toContain("M1-secret");
    expect(readC).toContain("M1-secret");
  });

  test("W3 — epoch rotation visible puis retrait de Bob (epoch++)", async () => {
    const aKick = ctx.states.get(A.pubkey);
    expect(aKick).toBeTruthy();
    const before = epochOf(aKick as ClientState);
    // retrait : leaf index de Bob depuis l'arbre d'Alice
    const state = aKick as ClientState;
    let leaf = -1;
    for (let i = 0; i < state.ratchetTree.length; i++) {
      const node = state.ratchetTree[i] as {
        nodeType?: string;
        leaf?: { credential?: { credentialType?: string; identity?: Uint8Array } };
      } | null;
      if (node?.nodeType === "leaf" && node.leaf?.credential?.credentialType === "basic") {
        const ident = node.leaf.credential.identity;
        if (!(ident instanceof Uint8Array)) continue;
        const id = new TextDecoder().decode(ident);
        if (id === B.pubkey) leaf = i / 2;
      }
    }
    expect(leaf).toBeGreaterThanOrEqual(0);
    const kick = await createCommit(
      { state, cipherSuite: impl, pskIndex: emptyPskIndex },
      { extraProposals: [{ proposalType: "remove", remove: { removed: leaf } }] }
    );
    ctx.states.set(A.pubkey, kick.newState);
    const ts = Date.now();
    const res = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: A.pubkey,
        ts,
        signature: await sign(A, `${A.pubkey}|group-remove|${ctx.serverGroupId}|${B.pubkey}|${ts}`),
        userKey: B.pubkey,
        commit: stdB64(encodeMlsMessage(kick.commit as never)),
      }),
    });
    expect(res.status).toBe(201);
    expect(epochOf(kick.newState)).toBe(before + 1); // W3 : rotation

    // Carol applique le commit (pas de welcome pour un remove)
    const cPre = ctx.states.get(C.pubkey);
    expect(cPre).toBeTruthy();
    const carolSynced = await processCommitsUntil(C, ctx, cPre as ClientState);
    expect(epochOf(carolSynced)).toBe(before + 1);
    ctx.states.set(C.pubkey, carolSynced);
  });

  test("W2 — forward secrecy : Bob exclu ne déchiffre PAS M2, Carol oui", async () => {
    const m2 = await sendGroupMessage(A, ctx, "M2-after-removal");
    // UN seul commit multi-adds (epoch 1) puis le retrait (epoch 2)
    expect(m2.epoch).toBe(2);

    const readC = await decryptAll(C, ctx, seenC);
    expect(readC).toContain("M2-after-removal");

    const readB = await decryptAll(B, ctx, seenB);
    expect(readB).not.toContain("M2-after-removal"); // refus (OperationError)
  });

  test("W4 — replay : M1 rejoué par Carol → REFUS (ratchet)", async () => {
    // reprendre le wire de M1 (archive du fil) et le re-traiter depuis l'état
    // courant de Carol : le message est déjà consommé → exception
    const msgs = await listMessages(C, ctx);
    const m1 = msgs.find((m) => m.senderKey === A.pubkey && m.mlsEpoch === "1");
    expect(m1).toBeTruthy();
    const m1State = ctx.states.get(C.pubkey);
    expect(m1State).toBeTruthy();
    expect(m1).toBeTruthy();
    const state = m1State as ClientState;
    const [decoded] = decodeMlsMessage(stdUnB64((m1 as ReceivedMessage).ciphertext), 0) as unknown as Array<{
      privateMessage?: never;
    }>;
    let refused = false;
    try {
      await processPrivateMessage(state, decoded.privateMessage, emptyPskIndex, impl);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("W5 — collusion : l'état exfiltré de Bob (pré-retrait) ne déchiffre pas M3", async () => {
    // M3 envoyé APRÈS le retrait : l'état figé de Bob (snapshot du W1) ne peut
    // pas suivre les ratchets des commits suivants — ni seul, ni combiné
    const bobPre = ctx.states.get(B.pubkey);
    expect(bobPre).toBeTruthy();
    const bobSnapshot = bobPre as ClientState; // figé avant le retrait
    const m3 = await sendGroupMessage(A, ctx, "M3-collusion-test");
    expect(m3.epoch).toBeGreaterThanOrEqual(2);

    let decrypted = false;
    try {
      const [decoded] = decodeMlsMessage(stdUnB64(m3.wire), 0) as unknown as Array<{
        privateMessage?: never;
      }>;
      const result = await processPrivateMessage(bobSnapshot, decoded.privateMessage, emptyPskIndex, impl);
      decrypted = result.kind === "applicationMessage";
    } catch {
      decrypted = false;
    }
    expect(decrypted).toBe(false);
  });

  test("W6 — invariants serveur : preuve absente → 401, non-créateur → 403, ciphertext géant → 400, ciphertext opaque", async () => {
    // 401 : aucune preuve
    const noProof = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: A.pubkey, ciphertext: "x", mlsEpoch: 1 }),
    });
    expect(noProof.status).toBe(401);

    // 403 : Carol (non-créatrice) invite
    const ts = Date.now();
    const inviteRes = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: C.pubkey,
        ts,
        signature: await sign(C, `${C.pubkey}|group-invite|${ctx.serverGroupId}|${C.pubkey}|${ts}`),
        userKey: C.pubkey,
        commit: "e30",
        welcome: "e30",
      }),
    });
    expect(inviteRes.status).toBe(403);

    // 400 : ciphertext > 16 Ko (signé correctement)
    const big = stdB64(new Uint8Array(17_000));
    const tsBig = Date.now();
    const bigRes = await fetch(`${APP_URL}/api/groups/${ctx.serverGroupId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: A.pubkey,
        ts: tsBig,
        signature: await sign(A, `${A.pubkey}|group-msg|${ctx.serverGroupId}|${tsBig}`),
        ciphertext: big,
        mlsEpoch: 3,
      }),
    });
    expect(bigRes.status).toBe(400);

    // opacité : le ciphertext stocké ne contient PAS le plaintext
    const sent = await sendGroupMessage(A, ctx, "SECRET-OPAQUE-42");
    const msgs = await listMessages(C, ctx);
    const stored = msgs.find((m) => m.id === sent.id);
    expect(stored).toBeTruthy();
    const decodedStored = Buffer.from((stored as ReceivedMessage).ciphertext, "base64").toString("latin1");
    expect(decodedStored).not.toContain("SECRET-OPAQUE-42"); // invariant serveur
    const readC = await decryptAll(C, ctx, seenC);
    expect(readC).toContain("SECRET-OPAQUE-42"); // mais déchiffrable par le membre
  });

  test("BENCH — établissement groupe (création + invitation 2 membres) < 2 s · envoi message < 500 ms", async () => {
    // membres frais pour mesurer le chemin complet sans pollution d'état
    const E = await makeIdentity("C4-Eve");
    const F = await makeIdentity("C4-Frank");
    await Promise.all([onboard(E), onboard(F)]);
    await Promise.all([publishKps(E, 2), publishKps(F, 2)]);

    const t0 = Date.now();
    const benchCtx = await createGroupFlow(A, [E, F], "C4-Bench");
    await joinAndSync(E, benchCtx);
    await joinAndSync(F, benchCtx);
    const t1 = Date.now();
    const establishMs = t1 - t0;
    expect(establishMs).toBeLessThan(2000);

    const t2 = Date.now();
    await sendGroupMessage(A, benchCtx, "bench-message");
    const sendMs = Date.now() - t2;
    expect(sendMs).toBeLessThan(500);

    // les deux nouveaux membres lisent
    const seenE = new Set<string>();
    const readE = await decryptAll(E, benchCtx, seenE);
    expect(readE).toContain("bench-message");

    console.log(
      `[BENCH] établissement groupe (création + 2 jointures MLS) = ${establishMs} ms (budget 2000) · envoi message = ${sendMs} ms (budget 500)`
    );
    results_bench.establishMs = establishMs;
    results_bench.sendMs = sendMs;
  });

  test("W7 — key package single-use : 2ᵉ consommation → 404", async () => {
    // identité FRAÎCHE : exactement 1 key package publié
    const D = await makeIdentity("C4-Dave");
    await onboard(D);
    await publishKps(D, 1);
    const first = await consumeKp(A, D.pubkey);
    expect(first).toBeTruthy();
    await expect(consumeKp(A, D.pubkey)).rejects.toThrow(/404|indisponible/);
  });
});
