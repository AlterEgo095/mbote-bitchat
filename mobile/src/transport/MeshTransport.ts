/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MeshTransport — orchestration BitChat côté application (mobile)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Fait le pont entre :
 *    • le module natif BLE (octets transportés, fragmentation radio)
 *    • le cœur du protocole TS (encodage, dédup LRU, TTL, gigue)
 *    • le TransportRouter (DORS, P1) : BLE → Internet → outbox
 *
 *  Principe BitChat conservé : le natif livre un PAQUET COMPLET à JS ; JS
 *  décide — dédup → traitement → retransmission (TTL−1 après gigue).
 *  Nouveauté P1 : le contenu sortant (posts, DM) passe par le routeur —
 *  BLE si ≥ 1 voisin (avec copie outbox), sinon pont VPS si la sonde RTT
 *  est OK, sinon outbox (spray-and-wait). La présence (announce) reste un
 *  geste local BLE : elle n'a pas de sens hors du mesh.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  DedupCache,
  PKT_ANNOUNCE,
  PKT_PUBLIC,
  buildPacket,
  decodeMeshEvent,
  decodePacket,
  forwardPacket,
  retransmitJitter,
  ttlForDensity,
  type MeshEvent,
} from "../core/bitchat-protocol";
import { bytesToBase64 } from "../../modules/mbote-ble/ble-base64";
import { BleMesh, type MeshStateEvent, type PeerInfo } from "../../modules/mbote-ble/index";

import { BleTransport } from "./ble-transport";
import { InternetTransport } from "./internet-transport";
import { TransportRouter } from "./transport-router";
import type { PacketMeta, RouteDecision } from "./types";

export interface MeshMeta {
  peerId: string;
  rssi: number;
  /** sauts mesh traversés (TTL_MAX − ttl reçu) */
  hops: number;
  at: number;
}

export interface BridgeResult {
  ok: boolean;
  accepted: number;
  duplicate: number;
  invalid: number;
  error?: string;
}

const ANNOUNCE_INTERVAL_MS = 30_000;
const BRIDGE_QUEUE_MAX = 200;
const BRIDGE_BATCH = 64;
/** Déclencheurs P1 du flush outbox : paquet reçu, publication locale. */
const FLUSH_DEBOUNCE_MS = 3000;

export class MeshTransport {
  private dedup = new DedupCache();
  private subs: { remove: () => void }[] = [];
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: { pubkey: string; nickname: string; ecdhPub?: string } | null = null;
  private bridgeQueue: string[] = [];
  private started = false;
  private lastBridgeUrl = "";

  /** transports + routeur DORS (P1) */
  readonly router: TransportRouter;
  private readonly ble: BleTransport;
  private readonly net: InternetTransport;

  /** callbacks câblés par l'UI */
  onEvent?: (ev: MeshEvent, meta: MeshMeta) => void;
  onStateChange?: (state: MeshStateEvent["state"], detail?: string) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onLog?: (msg: string) => void;
  /** journal de décisions de routage (→ écran Mesh, panneau Routeur) */
  onRouteDecision?: (d: RouteDecision) => void;

  constructor() {
    this.ble = new BleTransport();
    this.net = new InternetTransport({
      gatewayId: () => this.identity?.pubkey.slice(0, 16) ?? "mbote-mobile",
      label: () => `mobile ${this.identity?.nickname ?? ""}`.trim(),
      queueDepth: () => this.bridgeQueue.length,
    });
    this.router = new TransportRouter({ sendTimeoutMs: 8000 });
    this.router.register(this.ble);
    this.router.register(this.net);
    this.router.onDecision((d) => {
      const lat = d.latencyMs !== undefined ? ` · ${d.latencyMs} ms` : "";
      this.onLog?.(`route → ${d.action} · ${d.detail}${lat}`);
      this.onRouteDecision?.(d);
    });
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(identity: { pubkey: string; nickname: string; ecdhPub?: string }): Promise<void> {
    this.stop(); // idempotent
    this.identity = identity;

    this.subs = [
      // flux entrant : radio native → adaptateur BLE → protocole
      { remove: this.ble.onPacket((bytes, meta) => this.handleNativePacket(bytes, meta)) },
      BleMesh.onPeerConnected(() => this.refreshPeers()),
      BleMesh.onPeerDisconnected(() => this.refreshPeers()),
      BleMesh.onStateChanged((e) => {
        this.onStateChange?.(e.state, e.detail);
        this.ble.setRadioState(e.state === "running", `état mesh : ${e.state}`);
        this.onLog?.(`état mesh : ${e.state}${e.detail ? ` (${e.detail})` : ""}`);
      }),
      BleMesh.onLog((e) => this.onLog?.(e.msg)),
    ];

    const perms = await BleMesh.requestPermissions();
    if (!perms.granted) {
      this.ble.setRadioState(false, `permissions manquantes : ${perms.missing.join(", ")}`);
      this.onStateChange?.("permission_needed", perms.missing.join(", "));
      this.onLog?.(`permissions manquantes : ${perms.missing.join(", ")}`);
      // on continue : l'utilisateur peut accorder puis redémarrer le mesh
    }

    await BleMesh.start();
    this.started = true;
    this.ble.setRadioState(true, "GATT démarré");

    // annonce de présence initiale + périodique (§5 whitepaper)
    await this.announce();
    this.announceTimer = setInterval(() => {
      this.announce().catch(() => undefined);
    }, ANNOUNCE_INTERVAL_MS);
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    if (this.started) BleMesh.stop().catch(() => undefined);
    this.started = false;
    this.ble.setRadioState(false, "radio arrêtée");
    this.onStateChange?.("stopped");
  }

  /**
   * Publie un événement social signé via le routeur DORS (post, DM…).
   * Renvoie la décision de routage (affichable dans l'UI).
   */
  async publish(ev: MeshEvent, type: number = PKT_PUBLIC): Promise<RouteDecision> {
    if (!this.identity) throw new Error("transport non démarré");
    const ttl = ttlForDensity(BleMesh.peers().length);
    const packet = buildPacket(type, this.identity.pubkey, ev, { ttl });
    // marqué comme vu : les échos de nos voisins seront ignorés
    this.dedup.checkAndRecord(packet);
    const decision = await this.router.submit(packet, { trace: ev.kind });
    if (decision.copyToOutbox) {
      // §3.1 : copie outbox tant qu'aucun canal confirmé n'a porté le paquet
      this.enqueueForBridge(bytesToBase64(packet));
      this.scheduleBridgeFlush();
    }
    return decision;
  }

  /** Annonce de présence (nickname + clés publiques) — geste local BLE. */
  async announce(): Promise<void> {
    if (!this.identity || !this.started) return;
    const ttl = ttlForDensity(BleMesh.peers().length);
    const packet = buildPacket(
      PKT_ANNOUNCE,
      this.identity.pubkey,
      {
        kind: "announce",
        pubkey: this.identity.pubkey,
        nickname: this.identity.nickname,
        ecdhPub: this.identity.ecdhPub,
        ts: Date.now(),
      },
      { ttl }
    );
    this.dedup.checkAndRecord(packet);
    try {
      await BleMesh.send(packet);
    } catch {
      // radio occupée / absence de voisin : l'annonce périodique réessaiera
    }
  }

  // ───────────────────────── Réception ─────────────────────────

  private handleNativePacket(bytes: Uint8Array, meta?: PacketMeta): void {
    if (!this.dedup.checkAndRecord(bytes)) return; // doublon (§4.2)

    let packet;
    try {
      packet = decodePacket(bytes);
    } catch {
      this.onLog?.(`paquet invalide ignoré depuis ${(meta?.peerId ?? "?").slice(0, 8)}`);
      return;
    }

    let ev: MeshEvent | null = null;
    try {
      ev = decodeMeshEvent(packet.payload);
    } catch {
      // payload scellé/opaque (DM brut) — non interprétable sans la clé
    }

    if (this.identity && ev && "pubkey" in ev && ev.pubkey === this.identity.pubkey) {
      return; // écho de notre propre paquet revenu par un voisin
    }

    const meshMeta: MeshMeta = {
      peerId: meta?.peerId ?? "?",
      rssi: meta?.rssi ?? 0,
      hops: Math.max(0, 7 - packet.ttl),
      at: Date.now(),
    };

    if (ev) this.onEvent?.(ev, meshMeta);

    // queue pour le pont VPS (store-and-forward)
    this.enqueueForBridge(bytesToBase64(bytes));
    // §3.1 : un voisin = un canal → tentative de flush imminente
    this.scheduleBridgeFlush();

    // retransmission contrôlée : TTL−1 après gigue aléatoire (§3.2)
    const forwarded = forwardPacket(packet);
    if (forwarded) {
      setTimeout(() => {
        BleMesh.send(forwarded).catch(() => undefined);
      }, retransmitJitter());
    }
  }

  private refreshPeers(): void {
    this.onPeersChange?.(BleMesh.peers());
  }

  // ───────────────────────── Pont VPS (outbox + flush) ─────────────────────────

  private enqueueForBridge(base64: string): void {
    this.bridgeQueue.push(base64);
    if (this.bridgeQueue.length > BRIDGE_QUEUE_MAX) {
      this.bridgeQueue.splice(0, this.bridgeQueue.length - BRIDGE_QUEUE_MAX);
    }
  }

  get bridgeQueueSize(): number {
    return this.bridgeQueue.length;
  }

  /** Photo de santé de tous les transports (routeur ↔ UI, source unique). */
  healthSnapshot() {
    return this.router.healthSnapshot();
  }

  /**
   * Programme un flush de l'outbox (anti-rebond). Déclencheurs P1 : paquet
   * reçu (« un voisin = un canal ») et publication locale copiée en outbox.
   * P2 ajoutera regain réseau (NetInfo), foreground et timer périodique sur
   * l'outbox durable (expo-sqlite).
   */
  private scheduleBridgeFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.lastBridgeUrl || this.bridgeQueue.length === 0) return;
      this.syncBridge(this.lastBridgeUrl)
        .then((r) => {
          if (r.ok && (r.accepted > 0 || r.duplicate > 0)) {
            this.onLog?.(
              `flush outbox : ${r.accepted} accepté(s), ${r.duplicate} déjà connu(s)`
            );
          }
        })
        .catch(() => undefined);
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Remonte les paquets accumulés au pont VPS dès qu'une connectivité existe.
   * Les paquets acceptés ou déjà connus sont purgés de la file locale.
   */
  async syncBridge(baseUrl: string): Promise<BridgeResult> {
    if (!this.identity) {
      return { ok: false, accepted: 0, duplicate: 0, invalid: 0, error: "transport non démarré" };
    }
    const url = baseUrl.replace(/\/+$/, "");
    if (!url) return { ok: false, accepted: 0, duplicate: 0, invalid: 0, error: "URL du pont non configurée" };

    this.lastBridgeUrl = url;
    this.net.configure(url);

    let accepted = 0;
    let duplicate = 0;
    let invalid = 0;
    let remaining: string[] = [];

    try {
      while (this.bridgeQueue.length > 0) {
        const batch = this.bridgeQueue.slice(0, BRIDGE_BATCH);
        const res = await fetch(`${url}/api/mesh/bridge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gatewayId: this.identity.pubkey.slice(0, 16),
            label: `mobile ${this.identity.nickname}`,
            packets: batch,
          }),
        });
        if (!res.ok) {
          this.net.invalidateProbe();
          return {
            ok: false,
            accepted,
            duplicate,
            invalid,
            error: `pont HTTP ${res.status}`,
          };
        }
        const json = (await res.json()) as {
          results?: { status: string }[];
        };
        for (let i = 0; i < batch.length; i++) {
          const status = json.results?.[i]?.status;
          if (status === "accepted") accepted++;
          else if (status === "duplicate") duplicate++;
          else invalid++;
        }
        this.bridgeQueue.splice(0, batch.length);
      }
      remaining = this.bridgeQueue;
      return { ok: true, accepted, duplicate, invalid };
    } catch (t) {
      this.net.invalidateProbe();
      remaining = this.bridgeQueue;
      return {
        ok: false,
        accepted,
        duplicate,
        invalid,
        error: t instanceof Error ? t.message : "réseau injoignable",
      };
    } finally {
      if (remaining.length === 0) this.bridgeQueue = [];
    }
  }
}
