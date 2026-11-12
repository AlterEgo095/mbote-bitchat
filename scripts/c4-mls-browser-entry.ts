/**
 * Entrée BROWSEUR uniquement — bundlée en ESM autonome (bun build
 * --target=browser) et chargée par c4-browser-probe.ts. EXCLUT toute
 * dépendance node (fs/path) : ts-mls + @hpke/core utilisent uniquement
 * WebCrypto natif — c'est exactement ce qu'on prouve ici.
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
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export async function runMlsBrowserProbe(): Promise<{
  ok: boolean;
  steps: Record<string, string>;
  error?: string;
}> {
  const steps: Record<string, string> = {};
  try {
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMP256_AES128GCM_SHA256_P256")
    );
    steps.ciphersuite = "P256 OK (WebCrypto natif)";

    const aliceKp = await generateKeyPackage(
      { identity: enc("alice-browser"), credentialType: "basic" },
      defaultCapabilities(),
      defaultLifetime,
      [],
      impl
    );
    let alice = await createGroup(new Uint8Array(16).fill(2), aliceKp.publicPackage, aliceKp.privatePackage, [], impl);
    steps.groupCreated = "epoch " + Number(alice.groupContext.epoch);

    const bobKp = await generateKeyPackage(
      { identity: enc("bob-browser"), credentialType: "basic" },
      defaultCapabilities(),
      defaultLifetime,
      [],
      impl
    );
    const wire = encodeMlsMessage({
      keyPackage: bobKp.publicPackage as never,
      wireformat: "mls_key_package",
      version: "mls10",
    });
    const decodedKp = (decodeMlsMessage(wire, 0) as unknown as Array<{ keyPackage: never }>)[0];
    const commit = await createCommit(
      { state: alice, cipherSuite: impl },
      { extraProposals: [{ proposalType: "add" as const, add: { keyPackage: decodedKp.keyPackage } }] }
    );
    alice = commit.newState;
    const bob = await joinGroup(
      (commit.welcome as never),
      bobKp.publicPackage,
      bobKp.privatePackage,
      emptyPskIndex,
      impl,
      alice.ratchetTree
    );
    steps.bobJoined = "epoch " + Number(bob.groupContext.epoch);

    const app = await createApplicationMessage(alice, enc("hello-from-browser"), impl);
    const appWire = encodeMlsMessage({
      version: "mls10",
      wireformat: "mls_private_message",
      privateMessage: app.privateMessage as never,
    });
    const appDecoded = (decodeMlsMessage(appWire, 0) as unknown as Array<{ privateMessage: never }>)[0];
    const bobRead = await processPrivateMessage(bob, appDecoded.privateMessage, emptyPskIndex, impl);
    steps.bobReads =
      bobRead.kind === "applicationMessage" ? dec(bobRead.message) : `kind=${bobRead.kind}`;

    return {
      ok: steps.bobReads === "hello-from-browser",
      steps,
    };
  } catch (e) {
    return { ok: false, steps, error: String(e).slice(0, 300) };
  }
}
