/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  TransportRouter — le « DORS maison » (P1 de la pile hybride Mbote)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Politique de routage §3.1 (docs/HYBRID-TRANSPORT-STACK.md) :
 *    1. BLE avec ≥ 1 voisin → émission mesh immédiate + copie outbox
 *       (mesh = livraison « au mieux », jamais acquittée)
 *    2. sinon Internet si la sonde RTT est OK → envoi direct au pont
 *       (canal confirmé : le statut accepted/duplicate purge l'outbox)
 *    3. sinon le paquet dort dans l'outbox (spray-and-wait) — l'intégrateur
 *       programme le flush sur : regain réseau, foreground, timer, paquet reçu.
 *
 *  Chaque décision est journalisée (ring buffer) et poussée aux observateurs :
 *  la transparence du routage est un argument produit (« voir » pourquoi un
 *  message voyage). Aucune dépendance : TS pur, isomorphe web/mobile.
 *
 *  Copie synchronisée avec l'autre cible :
 *    • web    : src/lib/mbote/transports/router.ts
 *    • mobile : mobile/src/transport/transport-router.ts  (ce fichier)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  RouteDecision,
  RouteReason,
  SendReceipt,
  Transport,
  TransportHealth,
} from "./types";

export interface RouterOptions {
  /** Garde-fou par tentative d'envoi (ms). Défaut : 8000. */
  sendTimeoutMs?: number;
  /** Taille du ring buffer de décisions. Défaut : 50. */
  journalSize?: number;
}

const DEFAULT_SEND_TIMEOUT_MS = 8000;
const DEFAULT_JOURNAL_SIZE = 50;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} : délai dépassé (${ms} ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

function composeDetail(h: TransportHealth, receipt: SendReceipt): string {
  const parts: string[] = [];
  if (h.neighbors !== null) parts.push(`${h.neighbors} voisin${h.neighbors > 1 ? "s" : ""}`);
  if (h.avgRssi !== null) parts.push(`RSSI ${h.avgRssi} dBm`);
  if (h.rttMs !== null) parts.push(`RTT ${h.rttMs} ms`);
  if (receipt.detail) parts.push(receipt.detail);
  return parts.join(" · ");
}

export class TransportRouter {
  private transports = new Map<string, Transport>();
  private journal: RouteDecision[] = [];
  private journalSize: number;
  private sendTimeoutMs: number;
  private seq = 0;
  private decisionCbs = new Set<(d: RouteDecision) => void>();

  constructor(opts?: RouterOptions) {
    this.sendTimeoutMs = opts?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.journalSize = opts?.journalSize ?? DEFAULT_JOURNAL_SIZE;
  }

  /** Enregistre (ou remplace) un transport. */
  register(t: Transport): void {
    this.transports.set(t.id, t);
  }

  unregister(id: string): void {
    this.transports.delete(id);
  }

  /** Transports triés par priorité croissante (BLE d'abord). */
  list(): Transport[] {
    return [...this.transports.values()].sort((a, b) => a.priority - b.priority);
  }

  /** Journal des décisions, de la plus récente à la plus ancienne. */
  decisions(limit?: number): RouteDecision[] {
    return limit ? this.journal.slice(0, limit) : [...this.journal];
  }

  /** Abonnement aux décisions en direct (→ panneau Routeur de l'UI). */
  onDecision(cb: (d: RouteDecision) => void): () => void {
    this.decisionCbs.add(cb);
    return () => this.decisionCbs.delete(cb);
  }

  /** Photo de santé de tous les transports (routeur ↔ UI, source unique). */
  healthSnapshot(): TransportHealth[] {
    return this.list().map((t) => {
      try {
        return t.health();
      } catch (e) {
        return {
          id: t.id,
          available: false,
          detail: e instanceof Error ? e.message : "santé indisponible",
          neighbors: null,
          avgRssi: null,
          rttMs: null,
          queueDepth: 0,
          batteryPct: null,
          checkedAt: Date.now(),
        };
      }
    });
  }

  /**
   * Soumet un paquet sortant : évalue les transports par priorité, applique la
   * politique §3.1 et journalise la décision (succès, repli ou mise en attente).
   * Ne lève jamais — la décision rendue fait foi.
   */
  async submit(raw: Uint8Array, opts?: { trace?: string }): Promise<RouteDecision> {
    const bytes = raw.byteLength;
    const candidates = this.list();

    let sawBleBlocked = false; // BLE prêt mais 0 voisin à portée
    let sawInternetDown = false; // internet indisponible ou envoi raté
    let blockerDetail = "";

    for (const t of candidates) {
      let h: TransportHealth;
      try {
        h = t.health();
      } catch {
        continue;
      }

      // §3.1 règle 1 : le mesh n'est un canal QUE s'il y a au moins un voisin.
      if (t.id === "ble" && h.neighbors !== null && h.neighbors < 1) {
        sawBleBlocked = true;
        blockerDetail = "BLE prêt mais 0 voisin à portée";
        continue;
      }

      if (!h.available || !t.isAvailable()) {
        if (t.id === "internet") {
          sawInternetDown = true;
          blockerDetail = h.detail || "internet indisponible";
        }
        continue;
      }

      const t0 = Date.now();
      try {
        const receipt: SendReceipt = await withTimeout(t.send(raw), this.sendTimeoutMs, t.id);
        const decision: RouteDecision = {
          id: `${Date.now().toString(36)}-${this.seq++}`,
          action: t.id === "ble" ? "ble" : "internet",
          transport: t.id,
          reason: t.id === "ble" ? "mesh_voisins" : "internet_sonde_ok",
          detail: composeDetail(h, receipt),
          bytes,
          at: Date.now(),
          latencyMs: Date.now() - t0,
          delivered: receipt.delivered,
          // §3.1 règle d'or : mesh « au mieux » → copie outbox jusqu'à ce qu'un
          // canal confirmé (pont : accepted/duplicate) la purge.
          copyToOutbox: t.id === "ble",
          trace: opts?.trace,
        };
        this.record(decision);
        return decision;
      } catch (e) {
        if (t.id === "internet") sawInternetDown = true;
        blockerDetail = `${t.id} : ${e instanceof Error ? e.message : "envoi raté"}`;
      }
    }

    const reason: RouteReason =
      candidates.length === 0
        ? "aucun_transport"
        : sawBleBlocked && !sawInternetDown
          ? "mesh_sans_voisins"
          : "internet_hors_ligne";

    const parts: string[] = [];
    if (sawBleBlocked) parts.push("mesh sans voisin");
    parts.push(blockerDetail || "aucun canal disponible");

    const decision: RouteDecision = {
      id: `${Date.now().toString(36)}-${this.seq++}`,
      action: "queued",
      transport: null,
      reason,
      detail: parts.join(" · "),
      bytes,
      at: Date.now(),
      delivered: false,
      copyToOutbox: true, // dort dans l'outbox (spray-and-wait §3.1)
      trace: opts?.trace,
    };
    this.record(decision);
    return decision;
  }

  private record(d: RouteDecision): void {
    this.journal.unshift(d);
    if (this.journal.length > this.journalSize) this.journal.length = this.journalSize;
    for (const cb of this.decisionCbs) {
      try {
        cb(d);
      } catch {
        // un observateur fautif ne casse jamais le routeur
      }
    }
  }
}
