/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WebBridgeTransport — transport Internet du navigateur (P1 pile hybride)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le web n'a pas de radio BLE : côté PWA, ce transport est le seul candidat
 *  du routeur. Il porte les paquets BitChat (binaires opaques base64) au pont
 *  VPS /api/mesh/bridge — exactement comme une passerelle native.
 *
 *  Disponibilité : fast-path `navigator.onLine` + sonde RTT légère (HEAD sur
 *  la racine, cache 30 s, stale-while-revalidate) — §3.1 règle 2 du plan.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  bytesToBase64,
  bytesToHex,
  senderIdFromPubkey,
} from "@/lib/mbote/bitchat-protocol";
import { loadIdentity } from "@/lib/mbote/identity";

import type {
  PacketMeta,
  SendReceipt,
  Transport,
  TransportHealth,
} from "./types";

const PROBE_TTL_MS = 30_000; // sonde en cache 30 s (§3.1)
const PROBE_TIMEOUT_MS = 4000;

interface ProbeState {
  ok: boolean;
  rttMs: number | null;
  at: number;
  detail: string;
}

export class WebBridgeTransport implements Transport {
  readonly id = "internet" as const;
  readonly priority = 10;

  private probe: ProbeState = { ok: false, rttMs: null, at: 0, detail: "sonde non lancée" };
  private probing = false;
  private queueDepth = 0;

  /** Profondeur de la file locale (outbox mémoire du navigateur, P2 : durable). */
  setQueueDepth(n: number): void {
    this.queueDepth = n;
  }

  /** Force une nouvelle sonde au prochain check (retour en ligne, etc.). */
  invalidateProbe(): void {
    this.probe = { ...this.probe, at: 0 };
  }

  isAvailable(): boolean {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    this.refreshProbeIfNeeded();
    return this.probe.ok;
  }

  health(): TransportHealth {
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    this.refreshProbeIfNeeded();
    const fresh = Date.now() - this.probe.at < PROBE_TTL_MS;
    return {
      id: this.id,
      available: this.probe.ok,
      detail: !online
        ? "navigateur hors ligne"
        : this.probe.ok
          ? `pont VPS joignable (sonde ${Math.round(this.probe.rttMs ?? 0)} ms)`
          : fresh
            ? `pont VPS injoignable (${this.probe.detail})`
            : "sonde en cours…",
      neighbors: null,
      avgRssi: null,
      rttMs: this.probe.rttMs,
      queueDepth: this.queueDepth,
      batteryPct: null,
      checkedAt: Date.now(),
    };
  }

  async send(raw: Uint8Array): Promise<SendReceipt> {
    const at = Date.now();
    const res = await fetch("/api/mesh/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gatewayId: this.gatewayId(),
        label: "passerelle navigateur (DORS)",
        packets: [bytesToBase64(raw)],
      }),
    });
    if (!res.ok) throw new Error(`pont HTTP ${res.status}`);
    const json = (await res.json()) as { results?: { status: string; detail?: string }[] };
    const status = json.results?.[0]?.status ?? "invalid";
    const delivered = status === "accepted" || status === "duplicate";
    return {
      delivered,
      detail: status === "duplicate" ? "accepté (déjà connu du pont)" : status,
      at,
    };
  }

  /** Le navigateur ne capte pas de paquets BLE : flux entrant vide (contrat). */
  onPacket(_cb: (raw: Uint8Array, meta?: PacketMeta) => void): () => void {
    return () => undefined;
  }

  /** ID de passerelle : identité réelle si disponible, sinon éphémère stable. */
  private gatewayId(): string {
    const id = loadIdentity();
    return bytesToHex(senderIdFromPubkey(id?.pubkey ?? "mbote-browser-gateway")).toUpperCase();
  }

  /** Sonde HEAD sur la racine — jamais bloquante, résultat en cache 30 s. */
  private refreshProbeIfNeeded(): void {
    if (this.probing) return;
    if (Date.now() - this.probe.at < PROBE_TTL_MS) return;
    this.probing = true;
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    fetch("/", { method: "HEAD", cache: "no-store", signal: controller.signal })
      .then((r) => {
        this.probe = {
          ok: r.ok,
          rttMs: Math.round(performance.now() - t0),
          at: Date.now(),
          detail: r.ok ? "ok" : `HTTP ${r.status}`,
        };
      })
      .catch((e: unknown) => {
        this.probe = {
          ok: false,
          rttMs: null,
          at: Date.now(),
          detail:
            e instanceof Error && e.name === "AbortError" ? "délai dépassé" : "réseau injoignable",
        };
      })
      .finally(() => {
        clearTimeout(timer);
        this.probing = false;
      });
  }
}
