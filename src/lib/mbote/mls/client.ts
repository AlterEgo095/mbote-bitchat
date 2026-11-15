"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  mls/client — flux MLS côté client (ts-mls 1.6.4, RFC 9420) pour les
 *  groupes privés C4
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le module ts-mls est importé PARESSEUSEMENT (dynamic import) — le bundle
 *  principal ne paie pas les ~238 Ko gzip ; seuls les utilisateurs de groupes
 *  le chargent (C4-prerequisites.md §2).
 *
 *  RÔLES :
 *   • key packages : publication à l'avance (3 frais) avec clés privées
 *     locales CACHÉES dans le coffre IDB (le welcome consommé par un invité
 *     exige SA clé privée du key package consommé — persistée pour survivre
 *     aux rechargements) ;
 *   • création : groupe local + UN commit multi-adds + UN welcome (l'arbre
 *     voyage DANS le welcome via ratchetTreeExtension — joinGroup l'extraie
 *     lui-même, le serveur ne voit que du binaire MLS opaque) ;
 *   • handshakes : commits broadcast + welcomes ciblés, traités DANS L'ORDRE
 *     (chaque commit avance l'epoch — hors ordre = refus ratchet, preuve PoC) ;
 *   • messages : ciphertext MLS opaque via /api/groups/[id]/messages — le
 *     serveur ne voit JAMAIS de plaintext (invariant C4) ;
 *   • persistence : état scellé AES-GCM (ECDH-soi, clé NON-extractible) dans
 *     le coffre IndexedDB chiffré (store.ts) — dédoublonnage des enveloppes
 *     par id persisté.
 *
 *  IDENTITÉS MLS : credential.identity = bytes de la pubkey ECDSA de l'app —
 *  l'arbre TreeKEM est interrogeable par pubkey (leafIndexByPubkey).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ClientState } from "ts-mls";
import { signPayload } from "../crypto";
import { loadGroupState, saveGroupState, loadKpCache, saveKpCache, setStoreIdentity } from "./store";
import { decodeValue } from "./state-codec";

// ── chargement paresseux du module MLS ──────────────────────────────────────

type MlsModule = typeof import("ts-mls");
let mlsModule: Promise<MlsModule> | null = null;
function loadMls(): Promise<MlsModule> {
  mlsModule ??= import("ts-mls");
  return mlsModule;
}

let ciphersuite: Promise<import("ts-mls").CiphersuiteImpl> | null = null;
async function cs(): Promise<import("ts-mls").CiphersuiteImpl> {
  const m = await loadMls();
  ciphersuite ??= m.getCiphersuiteImpl(m.getCiphersuiteFromName("MLS_128_DHKEMP256_AES128GCM_SHA256_P256"));
  return ciphersuite;
}

// ── helpers wire ─────────────────────────────────────────────────────────────

function bytesToStdB64(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function stdB64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(u8: Uint8Array): string {
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function epochOf(state: ClientState): number {
  return Number(state.groupContext.epoch);
}

// ── session locale (identité) ────────────────────────────────────────────────

export interface MlsIdentity {
  pubkey: string;
  signPriv: CryptoKey;
  ecdhPriv: CryptoKey;
  ecdhPub: string;
}

let identity: MlsIdentity | null = null;

/** Injecté par l'UI (MboteApp) dès que l'identité est prête. */
export function setMlsIdentity(id: MlsIdentity | null): void {
  identity = id;
  // Défaut connexe #47 (vague G) : le store scelle le cache des key packages
  // avec l'identité ECDH-soi. SANS cet injecteur, loadKpCache/saveKpCache
  // étaient des no-ops de facto (setStoreIdentity jamais appelé) → le cache
  // KP n'a JAMAIS survécu à un rechargement — cause du « key package
  // correspondant absent (rechargé ? reconnectez-vous pour republier) » après
  // tout reload entre la publication et la jointure. Branchement : le cache
  // KP est désormais réellement persisté (scellé) et rechargé au reload.
  setStoreIdentity(() => (identity ? { ecdhPriv: identity.ecdhPriv, ecdhPub: identity.ecdhPub } : null));
}

function requireIdentity(): MlsIdentity {
  if (!identity) throw new Error("identité MLS non prête");
  return identity;
}

// ── preuves transport (même mécanique que les DM — proof.ts côté serveur) ────

async function authQuery(message: string): Promise<string> {
  const me = requireIdentity();
  const ts = Date.now();
  const signature = await signPayload(me.signPriv, `${message}|${ts}`);
  return `me=${encodeURIComponent(me.pubkey)}&ts=${ts}&signature=${encodeURIComponent(signature)}`;
}

/** POST authentifié générique : { me, ts, signature, ...body }.
 *  ⚠️ la signature couvre `${proofMessage}|${ts}` — le serveur vérifie la
 *  chaîne COMPLÈTE avec le timestamp (verifyGroupProof). */
async function authPost(url: string, proofMessage: string, body: Record<string, unknown>): Promise<Response> {
  const me = requireIdentity();
  const ts = Date.now();
  const signature = await signPayload(me.signPriv, `${proofMessage}|${ts}`);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: me.pubkey, ts, signature, ...body }),
  });
}

/**
 * clientConfig par défaut — assembled depuis les exports réels de ts-mls
 * (defaultClientConfig n'est PAS exporté par l'index 1.6.4). L'authService
 * accepte tout en MVP : les identités MLS sont déjà authentifiées par les
 * preuves ECDSA de l'app sur le transport.
 */
function defaultConfig(m: MlsModule): import("ts-mls").ClientConfig {
  return {
    keyRetentionConfig: m.defaultKeyRetentionConfig,
    lifetimeConfig: m.defaultLifetimeConfig,
    keyPackageEqualityConfig: m.defaultKeyPackageEqualityConfig,
    paddingConfig: m.defaultPaddingConfig,
    authService: m.defaultAuthenticationService,
  };
}

// ── état par groupe (cache mémoire + persistence scellée) ────────────────────

interface GroupRuntime {
  state: ClientState | null;
  /** enveloppes déjà traitées (anti-replay transport) */
  processed: Set<string>;
  /** messages déjà appliqués (dédoublonnage polling/socket) */
  appliedMessages: Set<string>;
}
const runtimes = new Map<string, GroupRuntime>();

function newRuntime(state: ClientState | null): GroupRuntime {
  return { state, processed: new Set(), appliedMessages: new Set() };
}

async function runtimeFor(serverGroupId: string): Promise<GroupRuntime> {
  const existing = runtimes.get(serverGroupId);
  if (existing) return existing;
  const me = requireIdentity();
  const raw = await loadGroupState(serverGroupId, me.ecdhPriv, me.ecdhPub);
  let state: ClientState | null = null;
  if (raw) {
    const m = await loadMls();
    state = { ...(decodeValue(raw) as unknown as ClientState), clientConfig: defaultConfig(m) };
  }
  const rt = newRuntime(state);
  runtimes.set(serverGroupId, rt);
  return rt;
}

async function persistRuntime(serverGroupId: string, rt: GroupRuntime, mlsGroupIdHex: string): Promise<void> {
  if (!rt.state) return;
  const me = requireIdentity();
  // GroupState SANS clientConfig (fonction non clonable — contrainte §5b)
  const { clientConfig: _cfg, ...groupState } = rt.state as unknown as Record<string, unknown>;
  await saveGroupState(serverGroupId, mlsGroupIdHex, groupState, me.ecdhPriv, me.ecdhPub);
}

export function forgetRuntime(serverGroupId: string): void {
  runtimes.delete(serverGroupId);
}

// ── key packages : cache privé + registry serveur ────────────────────────────

interface CachedKp {
  wire: string; // b64 du key package PUBLIC (ce que le serveur stocke)
  pub: unknown;
  priv: unknown;
}

/** cache mémoire + IDB (survit aux rechargements entre publication et join) */
let kpCache: CachedKp[] | null = null;

async function loadKpCacheOnce(): Promise<CachedKp[]> {
  if (kpCache) return kpCache;
  const raw = await loadKpCache();
  kpCache = raw ?? [];
  return kpCache;
}

async function persistKpCache(): Promise<void> {
  if (kpCache) await saveKpCache(kpCache);
}

/** Génère + publie des key packages frais (appelé à l'ouverture de session et
 *  quand le stock serveur s'épuise). Les clés privées restent LOCALES. */
export async function publishKeyPackages(count = 3): Promise<void> {
  const m = await loadMls();
  const impl = await cs();
  const me = requireIdentity();
  const cache = await loadKpCacheOnce();
  for (let i = 0; i < count; i++) {
    const kp = await m.generateKeyPackage(
      { identity: new TextEncoder().encode(me.pubkey), credentialType: "basic" },
      m.defaultCapabilities(),
      m.defaultLifetime,
      [],
      impl
    );
    const wire = m.encodeMlsMessage({
      keyPackage: kp.publicPackage as never,
      wireformat: "mls_key_package",
      version: "mls10",
    });
    const wireB64 = bytesToStdB64(wire);
    cache.push({ wire: wireB64, pub: kp.publicPackage, priv: kp.privatePackage });
    const ok = await authPost("/api/mls/keypackages", `${me.pubkey}|mls-kp`, { keyPackage: wireB64 });
    if (!ok.ok) throw new Error(`publication key package refusée (${ok.status})`);
  }
  await persistKpCache();
}

/** Consomme UN key package frais d'un pair (single-use côté serveur). */
async function fetchKeyPackageFor(userKey: string): Promise<never> {
  const m = await loadMls();
  const me = requireIdentity();
  const q = await authQuery(`${me.pubkey}|mls-kp-get|${userKey}`);
  const res = await fetch(`/api/mls/keypackages/${encodeURIComponent(userKey)}?${q}`);
  if (!res.ok) {
    throw new Error(`key package indisponible (${res.status}) — ce contact doit se connecter une fois pour en publier`);
  }
  const json = (await res.json()) as { keyPackage: string };
  const wire = stdB64ToBytes(json.keyPackage);
  const [decoded] = m.decodeMlsMessage(wire, 0) as unknown as Array<{ wireformat: string; keyPackage: never }>;
  if (decoded.wireformat !== "mls_key_package") throw new Error("key package illisible");
  return decoded.keyPackage;
}

// ── création de groupe ───────────────────────────────────────────────────────

export interface CreatedGroup {
  serverGroupId: string;
  name: string;
  members: string[]; // pubkeys invitées
}

/** Crée un groupe : UN commit multi-adds + UN welcome (l'arbre voyage DANS le
 *  welcome via ratchetTreeExtension — le serveur ne voit que du binaire MLS). */
export async function createGroupMls(name: string, memberKeys: string[]): Promise<CreatedGroup> {
  const m = await loadMls();
  const impl = await cs();
  const me = requireIdentity();
  if (memberKeys.length === 0) throw new Error("un groupe requiert au moins un membre");

  // le créateur génère SON key package localement (jamais publié)
  const ownKp = await m.generateKeyPackage(
    { identity: new TextEncoder().encode(me.pubkey), credentialType: "basic" },
    m.defaultCapabilities(),
    m.defaultLifetime,
    [],
    impl
  );
  const mlsGroupId = crypto.getRandomValues(new Uint8Array(16));
  let state = await m.createGroup(mlsGroupId, ownKp.publicPackage, ownKp.privatePackage, [], impl);

  const adds: Array<{ proposalType: "add"; add: { keyPackage: never } }> = [];
  for (const key of memberKeys) {
    const kp = await fetchKeyPackageFor(key);
    adds.push({ proposalType: "add", add: { keyPackage: kp } });
  }

  const commit = await m.createCommit(
    { state, cipherSuite: impl, pskIndex: m.emptyPskIndex },
    { extraProposals: adds, ratchetTreeExtension: true }
  );
  state = commit.newState;
  const commitWire = m.encodeMlsMessage(commit.commit as never);
  if (!commit.welcome) throw new Error("welcome manquant (adds pourtant présents)");
  const welcomeWire = m.encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_welcome",
    welcome: commit.welcome,
  });

  const res = await authPost("/api/groups", `${me.pubkey}|group-create|${bytesToHex(mlsGroupId)}`, {
    name,
    mlsGroupId: bytesToHex(mlsGroupId),
    commit: bytesToStdB64(commitWire),
    welcome: bytesToStdB64(welcomeWire),
    members: memberKeys,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `création refusée (${res.status})`);
  }
  const json = (await res.json()) as { groupId: string };

  const rt = newRuntime(state);
  runtimes.set(json.groupId, rt);
  await persistRuntime(json.groupId, rt, bytesToHex(mlsGroupId));
  return { serverGroupId: json.groupId, name, members: memberKeys };
}

// ── jointure (invité) ────────────────────────────────────────────────────────

/** Traite UN welcome (invité) : essaie les key packages privés en cache — le
 *  bon est celui que l'invitant a consommé (match HPKE par référence). */
export async function joinFromWelcome(serverGroupId: string, welcomeB64: string): Promise<void> {
  const m = await loadMls();
  const impl = await cs();
  const rt = await runtimeFor(serverGroupId);
  if (rt.state) return; // déjà joint (dédoublonnage)

  const wire = stdB64ToBytes(welcomeB64);
  const [decoded] = m.decodeMlsMessage(wire, 0) as unknown as Array<{ wireformat: string; welcome: never }>;
  if (decoded.wireformat !== "mls_welcome") throw new Error("welcome illisible");

  const cache = await loadKpCacheOnce();
  let lastError: Error | null = null;
  for (let i = 0; i < cache.length; i++) {
    const kp = cache[i];
    try {
      const joined = await m.joinGroup(
        decoded.welcome,
        kp.pub as never,
        kp.priv as never,
        m.emptyPskIndex,
        impl,
        undefined, // l'arbre voyage DANS le welcome (ratchetTreeExtension)
        undefined
      );
      // succès : consommer le key package (single-use) et persister
      cache.splice(i, 1);
      await persistKpCache();
      rt.state = joined;
      await persistRuntime(serverGroupId, rt, bytesToHex(joined.groupContext.groupId));
      return;
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw new Error(
    lastError
      ? `welcome non joignable — key package correspondant absent (rechargé ? reconnectez-vous pour republier) : ${lastError.message.slice(0, 80)}`
      : "aucun key package en cache"
  );
}

// ── handshakes (commits) + enveloppes ────────────────────────────────────────

export interface Envelope {
  id: string;
  kind: "commit" | "welcome";
  targetKey: string | null;
  payload: string;
  createdAt: string;
}

/** Récupère et traite les enveloppes de handshake pendues (polling + socket).
 *  Les welcomes ciblés mènent à joinFromWelcome ; les commits font avancer
 *  l'epoch de tous. Traité DANS L'ORDRE (ordre serveur = ordre epochs). */
export async function syncGroupHandshakes(serverGroupId: string): Promise<number> {
  const me = requireIdentity();
  const q = await authQuery(`${me.pubkey}|group-env|${serverGroupId}`);
  const res = await fetch(`/api/groups/${serverGroupId}/envelopes?${q}`);
  if (!res.ok) return 0;
  const json = (await res.json()) as { envelopes: Envelope[] };
  const rt = await runtimeFor(serverGroupId);
  let applied = 0;
  const m = await loadMls();
  const impl = await cs();
  for (const env of json.envelopes) {
    if (rt.processed.has(env.id)) continue;
    try {
      if (env.kind === "welcome" && env.targetKey === me.pubkey) {
        await joinFromWelcome(serverGroupId, env.payload);
        rt.processed.add(env.id);
        applied += 1;
        continue;
      }
      if (!rt.state) {
        rt.processed.add(env.id);
        continue;
      }
      const wire = stdB64ToBytes(env.payload);
      const [decoded] = m.decodeMlsMessage(wire, 0) as unknown as Array<{ wireformat: string; privateMessage?: never }>;
      if (decoded.wireformat !== "mls_private_message" || !decoded.privateMessage) {
        rt.processed.add(env.id);
        continue;
      }
      const result = await m.processPrivateMessage(rt.state, decoded.privateMessage, m.emptyPskIndex, impl);
      if (result.kind === "newState") {
        rt.state = result.newState;
        applied += 1;
      }
      rt.processed.add(env.id);
    } catch {
      // enveloppe hors ordre / déjà ratchetée — marquée pour ne pas boucler
      rt.processed.add(env.id);
    }
  }
  if (rt.state) await persistRuntime(serverGroupId, rt, bytesToHex(rt.state.groupContext.groupId));
  return applied;
}

// ── messages de groupe ───────────────────────────────────────────────────────

export interface GroupMessageIn {
  id: string;
  senderKey: string;
  mlsEpoch: string;
  ciphertext: string;
  createdAt: string;
}

export interface DecryptedGroupMessage {
  id: string;
  senderKey: string;
  text: string;
  createdAt: string;
  epoch: number;
}

/** Envoie un message de groupe (ciphertext MLS opaque). */
export async function sendGroupMessage(serverGroupId: string, text: string): Promise<void> {
  const m = await loadMls();
  const impl = await cs();
  const me = requireIdentity();
  const rt = await runtimeFor(serverGroupId);
  if (!rt.state) throw new Error("groupe non joint");
  const app = await m.createApplicationMessage(rt.state, new TextEncoder().encode(text), impl);
  rt.state = app.newState;
  const wire = m.encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_private_message",
    privateMessage: app.privateMessage as never,
  });
  const res = await authPost(`/api/groups/${serverGroupId}/messages`, `${me.pubkey}|group-msg|${serverGroupId}`, {
    ciphertext: bytesToStdB64(wire),
    mlsEpoch: epochOf(app.newState),
  });
  if (!res.ok) throw new Error(`envoi refusé (${res.status})`);
  await persistRuntime(serverGroupId, rt, bytesToHex(rt.state.groupContext.groupId));
}

/** Récupère + déchiffre les nouveaux messages de groupe (polling + socket). */
export async function syncGroupMessages(serverGroupId: string): Promise<DecryptedGroupMessage[]> {
  const m = await loadMls();
  const impl = await cs();
  const me = requireIdentity();
  const q = await authQuery(`${me.pubkey}|group-msgs|${serverGroupId}`);
  const res = await fetch(`/api/groups/${serverGroupId}/messages?${q}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { messages: GroupMessageIn[] };
  const rt = await runtimeFor(serverGroupId);
  const out: DecryptedGroupMessage[] = [];
  let stateDirty = false;
  for (const msg of json.messages) {
    if (rt.appliedMessages.has(msg.id)) continue;
    rt.appliedMessages.add(msg.id);
    if (msg.senderKey === me.pubkey) {
      // nos propres messages : contenu connu côté UI, pas de re-ratchet
      out.push({ id: msg.id, senderKey: msg.senderKey, text: "", createdAt: msg.createdAt, epoch: Number(msg.mlsEpoch) });
      continue;
    }
    if (!rt.state) continue;
    try {
      const wire = stdB64ToBytes(msg.ciphertext);
      const [decoded] = m.decodeMlsMessage(wire, 0) as unknown as Array<{ wireformat: string; privateMessage?: never }>;
      if (decoded.wireformat !== "mls_private_message" || !decoded.privateMessage) continue;
      const result = await m.processPrivateMessage(rt.state, decoded.privateMessage, m.emptyPskIndex, impl);
      if (result.kind === "applicationMessage") {
        rt.state = result.newState;
        stateDirty = true;
        out.push({
          id: msg.id,
          senderKey: msg.senderKey,
          text: new TextDecoder().decode(result.message),
          createdAt: msg.createdAt,
          epoch: Number(msg.mlsEpoch),
        });
      } else if (result.kind === "newState") {
        rt.state = result.newState; // un commit mélangé au fil
        stateDirty = true;
      }
    } catch {
      // message d'un epoch antérieur au nôtre (commit pas encore traité) —
      // ignoré : l'epoch rattrapera par les enveloppes
    }
  }
  if (rt.state && stateDirty) await persistRuntime(serverGroupId, rt, bytesToHex(rt.state.groupContext.groupId));
  return out;
}

// ── gestion des membres (admin MVP = créateur) ──────────────────────────────

/** Invite un membre : key package frais → add-commit + welcome ciblé. */
export async function inviteMember(serverGroupId: string, userKey: string): Promise<void> {
  const m = await loadMls();
  const impl = await cs();
  const me = requireIdentity();
  const rt = await runtimeFor(serverGroupId);
  if (!rt.state) throw new Error("groupe non joint");
  const kp = await fetchKeyPackageFor(userKey);
  const commit = await m.createCommit(
    { state: rt.state, cipherSuite: impl, pskIndex: m.emptyPskIndex },
    { extraProposals: [{ proposalType: "add", add: { keyPackage: kp } }], ratchetTreeExtension: true }
  );
  rt.state = commit.newState;
  if (!commit.welcome) throw new Error("welcome manquant");
  const commitWire = m.encodeMlsMessage(commit.commit as never);
  const welcomeWire = m.encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_welcome",
    welcome: commit.welcome,
  });
  const res = await authPost(`/api/groups/${serverGroupId}/invite`, `${me.pubkey}|group-invite|${serverGroupId}|${userKey}`, {
    userKey,
    commit: bytesToStdB64(commitWire),
    welcome: bytesToStdB64(welcomeWire),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `invitation refusée (${res.status})`);
  }
  await persistRuntime(serverGroupId, rt, bytesToHex(rt.state.groupContext.groupId));
}

/** Retire un membre (forward secrecy : nouvelle epoch, l'ex-membre est jeté). */
export async function removeMember(serverGroupId: string, userKey: string): Promise<void> {
  const m = await loadMls();
  const impl = await cs();
  const me = requireIdentity();
  const rt = await runtimeFor(serverGroupId);
  if (!rt.state) throw new Error("groupe non joint");
  const leaf = leafIndexByPubkey(rt.state, userKey);
  const commit = await m.createCommit(
    { state: rt.state, cipherSuite: impl, pskIndex: m.emptyPskIndex },
    { extraProposals: [{ proposalType: "remove", remove: { removed: leaf } }] }
  );
  rt.state = commit.newState;
  const commitWire = m.encodeMlsMessage(commit.commit as never);
  const res = await authPost(`/api/groups/${serverGroupId}/remove`, `${me.pubkey}|group-remove|${serverGroupId}|${userKey}`, {
    userKey,
    commit: bytesToStdB64(commitWire),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `retrait refusé (${res.status})`);
  }
  await persistRuntime(serverGroupId, rt, bytesToHex(rt.state.groupContext.groupId));
}

/** Leaf index d'un membre identifié par sa pubkey (arrayIndex/2 — TreeKEM). */
export function leafIndexByPubkey(state: ClientState, pubkey: string): number {
  for (let i = 0; i < state.ratchetTree.length; i++) {
    const node = state.ratchetTree[i] as
      | { nodeType?: string; leaf?: { credential?: { credentialType?: string; identity?: Uint8Array } } }
      | null
      | undefined;
    const identityBytes = node?.leaf?.credential;
    if (node?.nodeType === "leaf" && identityBytes?.credentialType === "basic" && identityBytes.identity instanceof Uint8Array) {
      const id = new TextDecoder().decode(identityBytes.identity);
      if (id === pubkey) return i / 2;
    }
  }
  throw new Error("membre introuvable dans l'arbre MLS");
}

/** Panique : tout l'état MLS disparaît (branché sur le wipe global). */
export async function wipeMls(): Promise<void> {
  const { clearAllGroupStates } = await import("./store");
  await clearAllGroupStates();
  runtimes.clear();
  kpCache = null;
  identity = null;
}
