/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  BleTransport — adaptateur du module natif mbote-ble vers le contrat
 *  Transport (P1 pile hybride). Priorité 0 : premier canal essayé.
 * ─────────────────────────────────────────────────────────────────────────────
 *  `send` remet le paquet à la radio (GATT write/notify natif) : le mesh BLE
 *  est une livraison « au mieux » — `delivered: true` signifie « remis à la
 *  radio », pas « acquitté par un pair » (d'où la copie outbox côté routeur).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { base64ToBytes } from "../../modules/mbote-ble/ble-base64";
import { BleMesh, type PeerInfo } from "../../modules/mbote-ble/index";

import type { PacketMeta, SendReceipt, Transport, TransportHealth } from "./types";

const RSSI_SENTINEL = 127; // valeur native « RSSI inconnu »

export class BleTransport implements Transport {
  readonly id = "ble" as const;
  readonly priority = 0;

  private radioReady = false;
  private detail = "radio arrêtée";

  /** Appelé par MeshTransport quand la radio démarre / s'arrête / perd ses perms. */
  setRadioState(ready: boolean, detail?: string): void {
    this.radioReady = ready;
    if (detail) this.detail = detail;
  }

  isAvailable(): boolean {
    return this.radioReady;
  }

  health(): TransportHealth {
    let peers: PeerInfo[] = [];
    try {
      peers = BleMesh.peers() ?? [];
    } catch {
      // module natif non monté (web, simulateur) : radio indisponible
    }
    const withRssi = peers.filter((p) => typeof p.rssi === "number" && p.rssi !== RSSI_SENTINEL);
    const avgRssi = withRssi.length
      ? Math.round(withRssi.reduce((a, p) => a + p.rssi, 0) / withRssi.length)
      : null;
    const neighbors = peers.length;
    return {
      id: this.id,
      available: this.radioReady,
      detail: !this.radioReady
        ? this.detail
        : neighbors > 0
          ? `GATT actif · ${neighbors} voisin${neighbors > 1 ? "s" : ""}`
          : "GATT actif · aucun voisin",
      neighbors,
      avgRssi,
      rttMs: null,
      queueDepth: 0,
      batteryPct: null, // TODO transversal : expo-battery → duty-cycle < 15 %
      checkedAt: Date.now(),
    };
  }

  async send(raw: Uint8Array): Promise<SendReceipt> {
    const at = Date.now();
    await BleMesh.send(raw);
    return { delivered: true, detail: "remis à la radio BLE", at };
  }

  onPacket(cb: (raw: Uint8Array, meta?: PacketMeta) => void): () => void {
    const sub = BleMesh.onPacket((pkt) => {
      try {
        cb(base64ToBytes(pkt.base64), { peerId: pkt.peerId, rssi: pkt.rssi });
      } catch {
        // base64 invalide : paquet ignoré (le natif ne devrait pas en émettre)
      }
    });
    return () => sub.remove();
  }
}
