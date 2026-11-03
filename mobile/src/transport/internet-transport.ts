/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  InternetTransport — adaptateur du pont VPS (/api/mesh/bridge) vers le
 *  contrat Transport (P1 pile hybride). Priorité 10 : repli du mesh BLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Disponibilité : sonde RTT légère (HEAD sur la racine du pont) en cache
 *  30 s, stale-while-revalidate — jamais d'appel réseau bloquant dans
 *  isAvailable(). Le pont accuse réception par paquet (accepted/duplicate) :
 *  c'est un canal « confirmé » → pas de copie outbox pour un envoi direct.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { bytesToBase64 } from "../../modules/mbote-ble/ble-base64";

import type { PacketMeta, SendReceipt, Transport, TransportHealth } from "./types";

const PROBE_TTL_MS = 30_000; // sonde en cache 30 s (§3.1 règle 2)
const PROBE_TIMEOUT_MS = 4000;

export interface InternetTransportConfig {
  /** ID de passerelle courant (dérivé de l'identité). */
  gatewayId: () => string;
  /** Label lisible de la passerelle. */
  label: () => string;
  /** Profondeur de la file outbox locale (remontée dans la santé). */
  queueDepth?: () => number;
}

interface ProbeState {
  ok: boolean;
  rttMs: number | null;
  at: number;
  detail: string;
}

export class InternetTransport implements Transport {
  readonly id = "internet" as const;
  readonly priority = 10;

  private baseUrl = "";
  private readonly cfg: InternetTransportConfig;
  private probe: ProbeState = { ok: false, rttMs: null, at: 0, detail: "sonde non lancée" };
  private probing = false;

  constructor(cfg: InternetTransportConfig) {
    this.cfg = cfg;
  }

  /** Configure (ou reconfigure) l'URL du pont ; invalide la sonde si changée. */
  configure(baseUrl: string): void {
    const clean = baseUrl.replace(/\/+$/, "");
    if (clean !== this.baseUrl) {
      this.baseUrl = clean;
      this.probe = {
        ok: false,
        rttMs: null,
        at: 0,
        detail: clean ? "sonde non lancée" : "pont non configuré",
      };
    }
  }

  get url(): string {
    return this.baseUrl;
  }

  /** Force une nouvelle sonde au prochain check (après un échec réseau p.ex.). */
  invalidateProbe(): void {
    this.probe = { ...this.probe, at: 0 };
  }

  isAvailable(): boolean {
    if (!this.baseUrl) return false;
    this.refreshProbeIfNeeded();
    return this.probe.ok;
  }

  health(): TransportHealth {
    this.refreshProbeIfNeeded();
    const fresh = Date.now() - this.probe.at < PROBE_TTL_MS;
    return {
      id: this.id,
      available: Boolean(this.baseUrl && this.probe.ok),
      detail: !this.baseUrl
        ? "pont non configuré (onglet Profil)"
        : this.probe.ok
          ? `pont VPS joignable (sonde ${Math.round(this.probe.rttMs ?? 0)} ms)`
          : fresh
            ? `pont injoignable (${this.probe.detail})`
            : "sonde en cours…",
      neighbors: null,
      avgRssi: null,
      rttMs: this.probe.rttMs,
      queueDepth: this.cfg.queueDepth?.() ?? 0,
      batteryPct: null,
      checkedAt: Date.now(),
    };
  }

  async send(raw: Uint8Array): Promise<SendReceipt> {
    const at = Date.now();
    if (!this.baseUrl) throw new Error("pont non configuré");
    const res = await fetch(`${this.baseUrl}/api/mesh/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gatewayId: this.cfg.gatewayId(),
        label: this.cfg.label(),
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

  /** Le pont HTTP n'apporte pas de flux entrant push : abonnement vide (contrat). */
  onPacket(_cb: (raw: Uint8Array, meta?: PacketMeta) => void): () => void {
    return () => undefined;
  }

  /** Sonde HEAD sur la racine du pont — stale-while-revalidate, cache 30 s. */
  private refreshProbeIfNeeded(): void {
    if (this.probing || !this.baseUrl) return;
    if (Date.now() - this.probe.at < PROBE_TTL_MS) return;
    this.probing = true;
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    fetch(`${this.baseUrl}/`, { method: "HEAD", signal: controller.signal })
      .then((r) => {
        this.probe = {
          ok: r.ok,
          rttMs: Date.now() - t0,
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
