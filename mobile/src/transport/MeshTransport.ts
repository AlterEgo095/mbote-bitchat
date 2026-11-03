/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MeshTransport — logique de routage BitChat côté application (mobile)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Fait le pont entre :
 *    • le module natif BLE (octets transportés, fragmentation radio)
 *    • le cœur du protocole TS (encodage, dédup LRU, TTL, gigue)
 *    • le pont VPS (/api/mesh/bridge) en store-and-forward
 *
 *  Principe BitChat : le natif livre un PAQUET COMPLET à JS ; JS décide —
 *  dédup → traitement → retransmission (TTL−1 après gigue 10–220 ms).
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
import { bytesToBase64, base64ToBytes } from "../../modules/mbote-ble/ble-base64";
import { BleMesh, type MeshStateEvent, type PeerInfo } from "../../modules/mbote-ble/index";

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

export class MeshTransport {
  private dedup = new DedupCache();
  private subs: { remove: () => void }[] = [];
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private identity: { pubkey: string; nickname: string; ecdhPub?: string } | null = null;
  private bridgeQueue: string[] = [];
  private started = false;

  /** callbacks câblés par l'UI */
  onEvent?: (ev: MeshEvent, meta: MeshMeta) => void;
  onStateChange?: (state: MeshStateEvent["state"], detail?: string) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onLog?: (msg: string) => void;

  get isStarted(): boolean {
    return this.started;
  }

  async start(identity: { pubkey: string; nickname: string; ecdhPub?: string }): Promise<void> {
    this.stop(); // idempotent
    this.identity = identity;

    this.subs = [
      BleMesh.onPacket((pkt) => this.handleNativePacket(pkt)),
      BleMesh.onPeerConnected(() => this.refreshPeers()),
      BleMesh.onPeerDisconnected(() => this.refreshPeers()),
      BleMesh.onStateChanged((e) => {
        this.onStateChange?.(e.state, e.detail);
        this.onLog?.(`état mesh : ${e.state}${e.detail ? ` (${e.detail})` : ""}`);
      }),
      BleMesh.onLog((e) => this.onLog?.(e.msg)),
    ];

    const perms = await BleMesh.requestPermissions();
    if (!perms.granted) {
      this.onStateChange?.("permission_needed", perms.missing.join(", "));
      this.onLog?.(`permissions manquantes : ${perms.missing.join(", ")}`);
      // on continue : l'utilisateur peut accorder puis redémarrer le mesh
    }

    await BleMesh.start();
    this.started = true;

    // annonce de présence initiale + périodique (§5 whitepaper)
    await this.announce();
    this.announceTimer = setInterval(() => {
      this.announce().catch(() => undefined);
    }, ANNOUNCE_INTERVAL_MS);
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    if (this.started) BleMesh.stop().catch(() => undefined);
    this.started = false;
    this.onStateChange?.("stopped");
  }

  /** Publie un événement social signé sur le mesh (post, DM…) */
  async publish(ev: MeshEvent, type: number = PKT_PUBLIC): Promise<void> {
    if (!this.identity) throw new Error("transport non démarré");
    const ttl = ttlForDensity(BleMesh.peers().length);
    const packet = buildPacket(type, this.identity.pubkey, ev, { ttl });
    // marqué comme vu : les échos de nos voisins seront ignorés
    this.dedup.checkAndRecord(packet);
    await BleMesh.send(packet);
  }

  /** Annonce de présence (nickname + clés publiques) */
  async announce(): Promise<void> {
    if (!this.identity) return;
    await this.publish(
      {
        kind: "announce",
        pubkey: this.identity.pubkey,
        nickname: this.identity.nickname,
        ecdhPub: this.identity.ecdhPub,
        ts: Date.now(),
      },
      PKT_ANNOUNCE
    );
  }

  // ───────────────────────── Réception ─────────────────────────

  private handleNativePacket(pkt: { base64: string; rssi: number; peerId: string }): void {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(pkt.base64);
    } catch {
      return;
    }
    if (!this.dedup.checkAndRecord(bytes)) return; // doublon (§4.2)

    let packet;
    try {
      packet = decodePacket(bytes);
    } catch {
      this.onLog?.(`paquet invalide ignoré depuis ${pkt.peerId.slice(0, 8)}`);
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

    const meta: MeshMeta = {
      peerId: pkt.peerId,
      rssi: pkt.rssi,
      hops: Math.max(0, 7 - packet.ttl),
      at: Date.now(),
    };

    if (ev) this.onEvent?.(ev, meta);

    // queue pour le pont VPS (store-and-forward)
    this.enqueueForBridge(pkt.base64);

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

  // ───────────────────────── Pont VPS (store-and-forward) ─────────────────────────

  private enqueueForBridge(base64: string): void {
    this.bridgeQueue.push(base64);
    if (this.bridgeQueue.length > BRIDGE_QUEUE_MAX) {
      this.bridgeQueue.splice(0, this.bridgeQueue.length - BRIDGE_QUEUE_MAX);
    }
  }

  get bridgeQueueSize(): number {
    return this.bridgeQueue.length;
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
