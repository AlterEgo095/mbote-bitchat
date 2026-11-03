/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MeshTransport — orchestration BitChat côté application (mobile)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Fait le pont entre :
 *    • le module natif BLE (octets transportés, fragmentation radio)
 *    • le cœur du protocole TS (encodage, dédup LRU, TTL, gigue)
 *    • le TransportRouter (DORS, P1) : BLE → Internet → outbox
 *    • l'outbox durable (P2) : expo-sqlite, backoff 30 s → 15 min
 *
 *  Principe BitChat conservé : le natif livre un PAQUET COMPLET à JS ; JS
 *  décide — dédup → traitement → retransmission (TTL−1 après gigue).
 *  Le contenu sortant (posts, DM) passe par le routeur — BLE si ≥ 1 voisin
 *  (avec copie outbox), sinon pont VPS si la sonde RTT est OK, sinon outbox.
 *  La présence (announce) reste un geste local BLE.
 *
 *  P2 — la file d'attente du pont est DURABLE (fin du bug « je tue l'app,
 *  je perds 200 paquets ») et le flush est déclenché par :
 *    • paquet reçu (« un voisin = un canal », anti-rebond 3 s)
 *    • publication locale copiée en outbox
 *    • regain réseau (NetInfo) + invalidation de la sonde
 *    • retour au premier plan (AppState)
 *    • timer périodique 5 min
 *  La purge se fait par ack du pont (accepted/duplicate par paquet) ; les
 *  échecs reprogramment un backoff exponentiel 30 s → 15 min.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import NetInfo from "@react-native-community/netinfo";
import { AppState, type AppStateStatus } from "react-native";

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
import { AsyncFallbackOutboxStorage, DurableOutbox } from "./outbox-core";
import type { FlushOutcome } from "./outbox-core";
import {
  MobileFallbackOutboxStorage,
  SqliteOutboxStorage,
} from "./outbox-storage";
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
const BRIDGE_BATCH = 64;
/** Déclencheur « paquet reçu / publication » : anti-rebond avant flush. */
const FLUSH_DEBOUNCE_MS = 3000;
/** Déclencheur P2 : timer périodique de flush (spéc P2). */
const PERIODIC_FLUSH_MS = 5 * 60_000;

export class MeshTransport {
  private dedup = new DedupCache();
  private subs: { remove: () => void }[] = [];
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private identity: { pubkey: string; nickname: string; ecdhPub?: string } | null = null;
  private started = false;
  private lastBridgeUrl = "";

  /** transports + routeur DORS (P1) */
  readonly router: TransportRouter;
  private readonly ble: BleTransport;
  private readonly net: InternetTransport;

  /** outbox durable (P2) — les paquets survivent au kill de l'app */
  readonly outbox: DurableOutbox;
  private appStateEmitter: { remove: () => void } | null = null;
  private netUnsub: (() => void) | null = null;

  /** callbacks câblés par l'UI */
  onEvent?: (ev: MeshEvent, meta: MeshMeta) => void;
  onStateChange?: (state: MeshStateEvent["state"], detail?: string) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onLog?: (msg: string) => void;
  /** journal de décisions de routage (→ écran Mesh, panneau Routeur) */
  onRouteDecision?: (d: RouteDecision) => void;
  /** profondeur de l'outbox durable (→ UI, compteur réactif) */
  onOutboxChange?: (depth: number) => void;

  constructor() {
    this.ble = new BleTransport();
    this.net = new InternetTransport({
      gatewayId: () => this.identity?.pubkey.slice(0, 16) ?? "mbote-mobile",
      label: () => `mobile ${this.identity?.nickname ?? ""}`.trim(),
      queueDepth: () => this.outbox.count(),
    });
    this.router = new TransportRouter({ sendTimeoutMs: 8000 });
    this.router.register(this.ble);
    this.router.register(this.net);
    this.router.onDecision((d) => {
      const lat = d.latencyMs !== undefined ? ` · ${d.latencyMs} ms` : "";
      this.onLog?.(`route → ${d.action} · ${d.detail}${lat}`);
      this.onRouteDecision?.(d);
    });

    this.outbox = new DurableOutbox(
      new AsyncFallbackOutboxStorage(
        new SqliteOutboxStorage(),
        new MobileFallbackOutboxStorage()
      ),
      {
        batchSize: BRIDGE_BATCH,
        send: (batch) => this.sendBatchToBridge(batch),
        onLog: (msg) => this.onLog?.(msg),
      }
    );
    this.outbox.onChange((n) => this.onOutboxChange?.(n));
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

    // P2 : outbox durable — charge la file sqlite (paquets d'une session passée)
    void this.outbox.ready().then((/* depth loggée par l'outbox */) => {
      if (this.outbox.count() > 0 && this.lastBridgeUrl) this.flushOutbox(true);
    });

    // déclencheur P2 : regain réseau (NetInfo) — sonde invalidée + flush forcé
    this.netUnsub = NetInfo.addEventListener((state) => {
      if (state.isConnected) {
        this.net.invalidateProbe();
        this.onLog?.(`réseau : ${state.type} → flush outbox programmé`);
        this.flushOutbox(true);
      }
    });

    // déclencheur P2 : retour au premier plan (AppState)
    this.appStateEmitter = {
      remove: AppState.addEventListener("change", (s: AppStateStatus) => {
        if (s === "active") this.flushOutbox(false);
      }).remove,
    };

    // déclencheur P2 : timer périodique 5 min
    this.periodicTimer = setInterval(() => {
      this.flushOutbox(false);
    }, PERIODIC_FLUSH_MS);

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
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    this.netUnsub?.();
    this.netUnsub = null;
    this.appStateEmitter?.remove();
    this.appStateEmitter = null;
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
      // §3.1 : copie outbox durable tant qu'aucun canal confirmé n'a porté le paquet
      await this.outbox.enqueue(bytesToBase64(packet), { trace: ev.kind });
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

    // queue pour le pont VPS (store-and-forward) — durable depuis P2
    void this.outbox.enqueue(bytesToBase64(bytes), { trace: "relais" });
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

  // ───────────────────────── Pont VPS (outbox durable + flush) ─────────────────────────

  get bridgeQueueSize(): number {
    return this.outbox.count();
  }

  /** Photo de santé de tous les transports (routeur ↔ UI, source unique). */
  healthSnapshot() {
    return this.router.healthSnapshot();
  }

  /**
   * Programme un flush de l'outbox (anti-rebond). Déclencheurs :
   * paquet reçu (« un voisin = un canal ») et publication locale copiée en
   * outbox. Les autres déclencheurs P2 (NetInfo, AppState, timer) appellent
   * directement flushOutbox() sans anti-rebond.
   */
  private scheduleBridgeFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushOutbox(false);
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Flush réel de l'outbox durable vers le pont. `force` envoie aussi les
   * paquets en cours de backoff (regain réseau, sync manuelle).
   */
  private async flushOutbox(force: boolean): Promise<FlushOutcome | null> {
    if (!this.lastBridgeUrl || this.outbox.count() === 0) return null;
    this.net.configure(this.lastBridgeUrl);
    try {
      const o = await this.outbox.flush(force);
      if (o.attempted > 0) {
        const parts = [`${o.accepted} accepté(s)`, `${o.duplicate} déjà connu(s)`];
        if (o.failed > 0) parts.push(`${o.failed} en backoff`);
        this.onLog?.(`flush outbox : ${parts.join(", ")}`);
      }
      return o;
    } catch {
      return null; // l'outbox ne lève jamais ; ce catch est un filet
    }
  }

  /** Envoi d'un lot base64 au pont — contrat OutboxSender de l'outbox. */
  private async sendBatchToBridge(batch: string[]): Promise<{ status: string; detail?: string }[]> {
    const url = this.lastBridgeUrl.replace(/\/+$/, "");
    if (!url) throw new Error("URL du pont non configurée");
    const res = await fetch(`${url}/api/mesh/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gatewayId: this.identity?.pubkey.slice(0, 16) ?? "mbote-mobile",
        label: `mobile ${this.identity?.nickname ?? ""}`.trim(),
        packets: batch,
      }),
    });
    if (!res.ok) {
      this.net.invalidateProbe();
      throw new Error(`pont HTTP ${res.status}`);
    }
    const json = (await res.json()) as { results?: { status: string; detail?: string }[] };
    return json.results ?? [];
  }

  /**
   * Sync manuelle (bouton de l'écran Mesh / première configuration) :
   * enregistre l'URL du pont puis vide l'outbox durable (flush forcé).
   * Les paquets acceptés ou déjà connus sont purgés par ack ; les échecs
   * reprogramment le backoff exponentiel (30 s → 15 min).
   */
  async syncBridge(baseUrl: string): Promise<BridgeResult> {
    if (!this.identity) {
      return { ok: false, accepted: 0, duplicate: 0, invalid: 0, error: "transport non démarré" };
    }
    const url = baseUrl.replace(/\/+$/, "");
    if (!url) {
      return { ok: false, accepted: 0, duplicate: 0, invalid: 0, error: "URL du pont non configurée" };
    }

    this.lastBridgeUrl = url;
    this.net.configure(url);
    await this.outbox.ready();

    const o = await this.outbox.flush(true);
    if (o.error && o.attempted === 0) {
      return { ok: false, accepted: 0, duplicate: 0, invalid: 0, error: o.error };
    }
    return {
      ok: !o.error,
      accepted: o.accepted,
      duplicate: o.duplicate,
      invalid: o.invalid,
      error: o.error,
    };
  }
}
