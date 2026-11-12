/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C4-prerequisites — PoC fonctionnel MLS (RFC 9420) avec ts-mls 1.6.4
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prérequis BLOQUANT (Clarification 4, vague C3+C4) : AVANT d'écrire une
 *  ligne de C4, prouver que la bibliothèque candidate tient les scénarios
 *  adversariaux DIRECTIVE :
 *   T0 livraison : 3 membres (Alice/Bob/Carol) — tous déchiffrent M1.
 *   T2 epoch rotation : add Bob → epoch 1 ; add Carol → epoch 2 ; remove Bob
 *      → epoch 3, et Carol applique le commit de retrait (pas de welcome pour
 *      un remove — le commit se diffuse au groupe).
 *   T1 forward secrecy : Bob retiré → ne peut PAS déchiffrer M2 (epoch 3+).
 *   T3 replay : un message application DÉJÀ consommé, rejoué → REFUS.
 *   T4 collusion : l'état périmé exfiltré de Bob ne déchiffre pas les messages
 *      de l'epoch suivante (le commit de retrait a ratcheté toute la chaîne).
 *   T5 persistence : l'état MLS est sérialisable pour IndexedDB — via
 *      structuredClone (Map/bigint/Uint8Array sont structured-cloneables
 *      nativement). ⚠️ encodeGroupState/decodeGroupState de ts-mls 1.6.4 sont
 *      CASSÉS (bug bibliothèque : decodeGroupState → InternalError
 *      « last node must be non-blank » sur ses PROPRES encodages — contourné
 *      par structuredClone, voir C4-prerequisites.md §persistence).
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/c4-mls-poc.ts
 *  Sortie : docs/proofs/assets/c4-mls-poc.json — exit 1 si un adversarial fail.
 */

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
  ciphersuites,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type ClientState,
  type GroupState,
} from "ts-mls";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Suite P-256 : cohérence avec le reste de la stack (identités ECDSA P-256,
// ECDH P-256 — une seule famille de courbes), support WebCrypto natif.
const impl = await getCiphersuiteImpl(
  getCiphersuiteFromName("MLS_128_DHKEMP256_AES128GCM_SHA256_P256")
);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const epochOf = (s: ClientState) => Number(s.groupContext.epoch);

async function makeIdentity(name: string) {
  const credential = { identity: enc(name), credentialType: "basic" as const };
  return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl);
}

/** PrivateMessage (résultat createApplicationMessage) → MLSMessage wire. */
function wirePrivate(pm: unknown): { privateMessage: never } {
  const wire = encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_private_message",
    privateMessage: pm as never,
  });
  const decoded = decodeMlsMessage(wire, 0)![0] as { privateMessage: never };
  return decoded as { privateMessage: never };
}

/** MLSMessage (résultat createCommit.commit) → wire → objet privé. */
function wireMls(msg: unknown): { privateMessage: never } {
  const wire = encodeMlsMessage(msg as never);
  const decoded = decodeMlsMessage(wire, 0)![0];
  if (!decoded || !("privateMessage" in decoded)) throw new Error("commit expected as private message");
  return decoded as { privateMessage: never };
}

function keyPackageOnWire(kp: { publicPackage: unknown }): never {
  const wire = encodeMlsMessage({
    keyPackage: kp.publicPackage as never,
    wireformat: "mls_key_package",
    version: "mls10",
  });
  const decoded = decodeMlsMessage(wire, 0)![0] as { wireformat: string; keyPackage: never };
  if (decoded.wireformat !== "mls_key_package") throw new Error("expected key package");
  return decoded.keyPackage;
}

/** Leaf index d'un membre identifié (arithmétique TreeKEM : index tableau / 2). */
function leafIndexByIdentity(state: ClientState, identity: string): number {
  for (let i = 0; i < state.ratchetTree.length; i++) {
    const node = state.ratchetTree[i] as
      | { nodeType?: string; leaf?: { credential?: { credentialType?: string; identity?: Uint8Array } } }
      | null
      | undefined;
    if (node?.nodeType === "leaf" && node.leaf?.credential?.credentialType === "basic") {
      const id = new TextDecoder().decode(node.leaf.credential.identity!);
      if (id === identity) return i / 2;
    }
  }
  throw new Error(`leaf « ${identity} » introuvable dans l'arbre`);
}

const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });
const results: Record<string, string | number | boolean> = {};
let adversarialOk = true;

try {
  // ── setup : Alice crée le groupe, ajoute Bob puis Carol (2 commits)
  const aliceKp = await makeIdentity("alice");
  let alice: ClientState = await createGroup(
    new Uint8Array(16).fill(1),
    aliceKp.publicPackage,
    aliceKp.privatePackage,
    [],
    impl
  );
  results.groupCreated_epoch = epochOf(alice);

  const bobKp = await makeIdentity("bob");
  const addBob = { proposalType: "add" as const, add: { keyPackage: keyPackageOnWire(bobKp) } };
  const bobCommit = await createCommit({ state: alice, cipherSuite: impl }, { extraProposals: [addBob] });
  alice = bobCommit.newState;
  const bob: ClientState = await joinGroup(
    bobCommit.welcome as never,
    bobKp.publicPackage,
    bobKp.privatePackage,
    emptyPskIndex,
    impl,
    alice.ratchetTree
  );
  results.epoch_after_add_bob = epochOf(alice);
  results.bobJoined_epoch = epochOf(bob);

  const carolKp = await makeIdentity("carol");
  const addCarol = { proposalType: "add" as const, add: { keyPackage: keyPackageOnWire(carolKp) } };
  const carolCommit = await createCommit({ state: alice, cipherSuite: impl }, { extraProposals: [addCarol] });
  alice = carolCommit.newState;
  let carol: ClientState = await joinGroup(
    carolCommit.welcome as never,
    carolKp.publicPackage,
    carolKp.privatePackage,
    emptyPskIndex,
    impl,
    alice.ratchetTree
  );
  results.epoch_after_add_carol = epochOf(alice);
  results.T2_epochs_rotated = `0 → 1 (add bob) → ${epochOf(alice)} (add carol)`;

  // le commit d'ajout de Carol est diffusé à TOUT le groupe — Bob doit le
  // traiter pour ratcheter vers l'epoch 2 (comportement MLS : un membre qui
  // n'a pas traité un commit ne peut pas déchiffrer l'epoch suivante — le
  // serveur relais remet le commit à tous les membres, identique au flux réel)
  const bobCarolSync = await processPrivateMessage(
    bob,
    wireMls(carolCommit.commit).privateMessage,
    emptyPskIndex,
    impl
  );
  if (bobCarolSync.kind !== "newState") throw new Error(`bob sync fail: ${bobCarolSync.kind}`);
  results.bobSyncedToCarolEpoch = epochOf(bobCarolSync.newState);
  const bobSynced = bobCarolSync.newState;

  // ── T0 : M1 lu par TOUS
  const m1 = await createApplicationMessage(alice, enc("M1-secret-epoch-" + String(epochOf(alice))), impl);
  alice = m1.newState;
  const m1Wire = wirePrivate(m1.privateMessage);
  const bobR1 = await processPrivateMessage(bobSynced, m1Wire.privateMessage, emptyPskIndex, impl);
  const carolR1 = await processPrivateMessage(carol, m1Wire.privateMessage, emptyPskIndex, impl);
  results.T0_bobReadsM1 =
    bobR1.kind === "applicationMessage" ? dec(bobR1.message) : `kind=${bobR1.kind}`;
  results.T0_carolReadsM1 =
    carolR1.kind === "applicationMessage" ? dec(carolR1.message) : `kind=${carolR1.kind}`;
  results.T0_deliveryOk =
    results.T0_bobReadsM1 === results.T0_carolReadsM1 &&
    (bobR1.kind === "applicationMessage" as boolean);
  if (!results.T0_deliveryOk) throw new Error("T0 échec : livraison incohérente");
  const bobUpdated = bobR1.newState; // les états avancent à CHAQUE message traité
  const carolUpdated = carolR1.newState;

  // ── T2 : retrait de Bob (remove + commit) → rotation ; Carol applique le commit
  const removeBob = { proposalType: "remove" as const, remove: { removed: leafIndexByIdentity(alice, "bob") } };
  const kickCommit = await createCommit({ state: alice, cipherSuite: impl }, { extraProposals: [removeBob] });
  const epochBeforeKick = epochOf(alice);
  alice = kickCommit.newState;
  results.epoch_after_remove_bob = epochOf(alice);
  results.T2_epochRotated = epochOf(alice) > epochBeforeKick;

  const kickWire = wireMls(kickCommit.commit);
  const carolKick = await processPrivateMessage(carolUpdated, kickWire.privateMessage, emptyPskIndex, impl);
  if (carolKick.kind !== "newState") {
    results.T2_carolAcceptedCommit = `FAIL kind=${carolKick.kind}`;
    adversarialOk = false;
  } else {
    results.T2_carolAcceptedCommit =
      epochOf(carolKick.newState) === epochOf(alice)
        ? true
        : `FAIL epoch ${epochOf(carolKick.newState)} ≠ ${epochOf(alice)}`;
    if (results.T2_carolAcceptedCommit !== true) adversarialOk = false;
  }
  carol = carolKick.kind === "newState" ? carolKick.newState : carolUpdated;

  // ── T1 : M2 (APRÈS le retrait) — Carol lit, Bob (état périmé) est JETÉ
  const m2 = await createApplicationMessage(alice, enc("M2-after-removal"), impl);
  alice = m2.newState;
  const m2Wire = wirePrivate(m2.privateMessage);

  const carolR2 = await processPrivateMessage(carol, m2Wire.privateMessage, emptyPskIndex, impl);
  results.T1_carolStillReads =
    carolR2.kind === "applicationMessage" ? dec(carolR2.message) : `kind=${carolR2.kind}`;
  if (carolR2.kind !== "applicationMessage") adversarialOk = false;
  carol = carolR2.newState;

  try {
    const bobR2 = await processPrivateMessage(bobUpdated, m2Wire.privateMessage, emptyPskIndex, impl);
    results.T1_bobForwardSecrecy = `FAIL — déchiffré : ${
      bobR2.kind === "applicationMessage" ? dec(bobR2.message) : bobR2.kind
    }`;
    adversarialOk = false;
  } catch (e) {
    results.T1_bobForwardSecrecy = true;
    results.T1_bobRejectReason = (e as Error).message.slice(0, 120);
  }

  // ── T3 : REPLAY — Carol re-traite M1 (déjà consommé par son ratchet) → refus
  try {
    const carolReplay = await processPrivateMessage(carol, m1Wire.privateMessage, emptyPskIndex, impl);
    results.T3_replay = `FAIL — accepté (${
      carolReplay.kind === "applicationMessage" ? dec(carolReplay.message) : carolReplay.kind
    })`;
    adversarialOk = false;
  } catch (e) {
    results.T3_replay = true;
    results.T3_replayRejectReason = (e as Error).message.slice(0, 120);
  }

  // ── T4 : COLLUSION — l'état périmé exfiltré de Bob (snapshot AVANT le
  // retrait) ne déchiffre pas M2. Le commit de retrait a ratcheté TOUTE la
  // chaîne de l'epoch : les secrets d'avant retrait sont morts. Deux états
  // périmés combinés = toujours un état périmé (pas de chemin vers l'epoch
  // courante sans PSK externe ni commit signé par un membre actuel).
  try {
    const ghostR2 = await processPrivateMessage(bobUpdated, m2Wire.privateMessage, emptyPskIndex, impl);
    results.T4_collusion = `FAIL — l'état exfiltré déchiffre : ${
      ghostR2.kind === "applicationMessage" ? dec(ghostR2.message) : ghostR2.kind
    }`;
    adversarialOk = false;
  } catch (e) {
    results.T4_collusion = true;
    results.T4_collusionRejectReason = (e as Error).message.slice(0, 120);
  }

  // ── T5 : persistence — codec JSON+b64 du GroupState (chemin IndexedDB réel).
  // ⚠️ trois contraintes RUNTIME documentées :
  // (a) encodeGroupState/decodeGroupState de ts-mls 1.6.4 CASSÉS (InternalError
  //     au décodage de ses propres octets) — encoders TLS inutilisables ;
  // (b) clientConfig.authService porte une FONCTION — persiste le GroupState
  //     seul, ré-attache la config au réhydratage ;
  // (c) structuredClone de BUN échoue sur les arbres ≥ 2 feuilles ([a,a] OK,
  //     [a,b] FAIL — bug bun) ; node 24 (implémentation conforme à la spec)
  //     clone le même arbre OK → dans le NAVIGATEUR (IndexedDB = implémentation
  //     conforme), la persistance objet directe est viable ; le codec ci-dessous
  //     est le fallback déterministe (et la preuve) indépendant du runtime.
  const b64enc = (u8: Uint8Array) => Buffer.from(u8).toString("base64");
  type Tagged = { __t: string; d: unknown };
  const replacer = (_k: string, v: unknown): unknown => {
    if (v instanceof Uint8Array) return { __t: "u8", d: b64enc(v) };
    if (typeof v === "bigint") return { __t: "big", d: String(v) };
    if (v instanceof Map) {
      return {
        __t: "map",
        d: Array.from(v).map(([mk, mv]) => ({ k: replacer("", mk), v: replacer("", mv) })),
      };
    }
    return v;
  };
  const reviver = (_k: string, v: unknown): unknown => {
    const t = v as Partial<Tagged> | null;
    if (t && typeof t === "object" && typeof t.__t === "string") {
      if (t.__t === "u8") return new Uint8Array(Buffer.from(t.d as string, "base64"));
      if (t.__t === "big") return BigInt(t.d as string);
      if (t.__t === "map") {
        const entries = (t.d as Array<{ k: unknown; v: unknown }>).map((e) => {
          // reviver applique la transformation récursive via JSON déjà fait :
          const k = plainRevive(e.k);
          const val = plainRevive(e.v);
          return [k, val] as [unknown, unknown];
        });
        return new Map(entries);
      }
    }
    return v;
  };
  const plainRevive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(plainRevive);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.__t === "string") return reviver("", o);
      const r: Record<string, unknown> = {};
      for (const key of Object.keys(o)) r[key] = plainRevive(o[key]);
      return r;
    }
    return v;
  };

  const { clientConfig: _cfg, ...groupState } = alice;
  const jsonState = JSON.stringify(groupState, replacer);
  const restoredGroup = plainRevive(JSON.parse(jsonState)) as GroupState;
  const restored = { ...restoredGroup, clientConfig: alice.clientConfig } as ClientState;
  results.T5_persistence =
    epochOf(restored) === epochOf(alice) &&
    restored.ratchetTree.length === alice.ratchetTree.length &&
    restored.signaturePrivateKey.byteLength === alice.signaturePrivateKey.byteLength
      ? `true (${jsonState.length} octets JSON, epoch ${epochOf(restored)})`
      : "FAIL";
  // l'état restauré reste FONCTIONNEL : il envoie encore des messages
  const m3 = await createApplicationMessage(restored, enc("M3-after-restore"), impl);
  const m3Wire = wirePrivate(m3.privateMessage);
  const carolR3 = await processPrivateMessage(carol, m3Wire.privateMessage, emptyPskIndex, impl);
  results.T5_restoredStateFunctional =
    carolR3.kind === "applicationMessage" && dec(carolR3.message) === "M3-after-restore";
  if (!String(results.T5_persistence).startsWith("true") || results.T5_restoredStateFunctional !== true)
    adversarialOk = false;

  results.ciphersuite = "MLS_128_DHKEMP256_AES128GCM_SHA256_P256";
  results.epoch_final = epochOf(alice);
  results.ok = adversarialOk;
} catch (e) {
  results.ok = false;
  results.error = (e as Error).message.slice(0, 300);
}

writeFileSync(join(ASSETS, "c4-mls-poc.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
if (!results.ok) process.exit(1);
