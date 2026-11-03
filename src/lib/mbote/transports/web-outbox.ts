/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Singleton outbox durable web (P2 pile hybride Mbote)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Une seule instance partagée : BitChatBridge enfile/observe, les
 *  déclencheurs §3.1 reflushent en tâche de fond :
 *    • event `online` du navigateur  (≈ regain réseau NetInfo côté mobile)
 *    • visibilitychange → visible    (≈ retour au premier plan / AppState)
 *    • timer périodique 5 min
 *  Le paquet reçu est un déclencheur mobile — côté web le tunnel relaie
 *  manuellement (bouton Transmettre), l'outbox est déjà dû à l'enfilement.
 *
 *  Stockage : IndexedDB d'abord, repli localStorage automatique. La profondeur
 *  est synchronisée au WebBridgeTransport (santé du panneau Routeur).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { bytesToHex, senderIdFromPubkey } from "@/lib/mbote/bitchat-protocol";
import { loadIdentityMeta } from "@/lib/mbote/identity";

import { AsyncFallbackOutboxStorage, DurableOutbox } from "./outbox-core";
import { getWebRouter } from "./web-router";
import { IndexedDbOutboxStorage, LocalStorageOutboxStorage } from "./web-outbox-storage";

const PERIODIC_FLUSH_MS = 5 * 60_000; // timer périodique §P2

/** Envoi de lot au pont VPS — statuts alignés sur le lot (contrat OutboxSender). */
async function webOutboxSend(base64Batch: string[]) {
  // F-06 : lecture publique seule — les clés privées restent dans le coffre
  const id = loadIdentityMeta();
  const gatewayId = bytesToHex(
    senderIdFromPubkey(id?.pubkey ?? "mbote-browser-gateway")
  ).toUpperCase();
  const res = await fetch("/api/mesh/bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      gatewayId,
      label: "passerelle navigateur · outbox durable",
      packets: base64Batch,
    }),
    // F-32 : un flush ne doit jamais rester suspendu indéfiniment
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`pont HTTP ${res.status}`);
  const json = (await res.json()) as { results?: { status: string; detail?: string }[] };
  return json.results ?? [];
}

let instance: DurableOutbox | null = null;
let indexedStorage: IndexedDbOutboxStorage | null = null;

export function getWebOutbox(): DurableOutbox {
  if (instance) return instance;

  indexedStorage = new IndexedDbOutboxStorage();
  const storage = new AsyncFallbackOutboxStorage(
    indexedStorage,
    new LocalStorageOutboxStorage()
  );
  instance = new DurableOutbox(storage, { send: webOutboxSend });
  void instance.ready();

  if (typeof window !== "undefined") {
    const { bridge } = getWebRouter();
    // la profondeur outbox alimente la santé du transport internet (panneau Routeur)
    instance.onChange((n) => bridge.setQueueDepth(n));

    // déclencheur 1 : regain réseau (event navigateur)
    window.addEventListener("online", () => {
      bridge.invalidateProbe();
      void instance
        ?.flush(true)
        .then((o) => {
          if (o.attempted > 0) {
            console.warn(
              `[outbox] flush réseau : ${o.accepted} accepté(s), ${o.duplicate} déjà connu(s), ${o.failed} en backoff`
            );
          }
        })
        .catch(() => undefined);
    });

    // déclencheur 2 : retour au premier plan (onglet revisité)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void instance?.flush(true).catch(() => undefined);
      }
    });

    // déclencheur 3 : timer périodique 5 min
    setInterval(() => {
      void instance?.flush(false).catch(() => undefined);
    }, PERIODIC_FLUSH_MS);
  }

  return instance;
}

/**
 * Ferme le singleton outbox (panic wipe F-11) : libère la connexion IndexedDB
 * pour que `deleteDatabase("mbote-outbox")` ne soit pas bloquée par l'onglet
 * courant. Un nouvel appel à getWebOutbox() recrée proprement l'instance.
 */
export function closeWebOutbox(): void {
  indexedStorage?.close();
  indexedStorage = null;
  instance = null;
}
