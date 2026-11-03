/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Contrat Transport isomorphe (DORS maison) — P1 de la pile hybride Mbote
 * ─────────────────────────────────────────────────────────────────────────────
 *  Copie synchronisée avec l'autre cible :
 *    • web    : src/lib/mbote/transports/types.ts   (ce fichier)
 *    • mobile : mobile/src/transport/types.ts
 *  Zéro import : le fichier doit rester compilable tel quel sur les deux
 *  plateformes (Next.js ↔ React Native). Toute évolution se fait des deux
 *  côtés en même temps.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Identifiant d'un canal de transport. */
export type TransportId = "ble" | "internet" | "lora";

/** Métadonnées radio optionnelles jointes à un paquet entrant. */
export interface PacketMeta {
  peerId?: string;
  rssi?: number;
}

/**
 * Santé instantanée d'un transport — une seule source de vérité partagée
 * entre le routeur (décision) et l'UI (panneau Routeur).
 */
export interface TransportHealth {
  id: TransportId;
  available: boolean;
  /** Raison courte et lisible, affichée telle quelle dans l'UI. */
  detail: string;
  /** BLE : voisins GATT connus · null si non applicable (internet, lora). */
  neighbors: number | null;
  /** BLE uniquement : RSSI moyen des voisins (sentinelle 127 exclue). */
  avgRssi: number | null;
  /** Internet uniquement : RTT de la dernière sonde légère (ms). */
  rttMs: number | null;
  /** Profondeur de la file locale (outbox) remontée par l'intégrateur. */
  queueDepth: number;
  /** TODO (transversal énergie) : expo-battery — duty-cycle BLE si < 15 %. */
  batteryPct: number | null;
  checkedAt: number;
}

/** Résultat d'une tentative d'envoi par un transport. */
export interface SendReceipt {
  delivered: boolean;
  /** Détail lisible : « accepté par le pont », « remis à la radio BLE »… */
  detail: string;
  at: number;
}

/** Action choisie par le routeur pour un paquet sortant. */
export type RouteAction = "ble" | "internet" | "queued";

/** Pourquoi le routeur a choisi cette action (journal DORS). */
export type RouteReason =
  | "mesh_voisins"
  | "mesh_sans_voisins"
  | "internet_sonde_ok"
  | "internet_hors_ligne"
  | "aucun_transport";

/**
 * Décision de routage journalisée — affichée en direct dans l'UI
 * (« ce message est parti en BLE, 2 voisins, RSSI −67 »).
 */
export interface RouteDecision {
  id: string;
  action: RouteAction;
  transport: TransportId | null;
  reason: RouteReason;
  detail: string;
  bytes: number;
  at: number;
  latencyMs?: number;
  delivered: boolean;
  /**
   * Politique §3.1 : le mesh est une livraison « au mieux », jamais acquittée
   * → le paquet garde une copie dans l'outbox jusqu'à ce qu'un canal confirmé
   * (pont VPS : statut accepted/duplicate) la purge. `queued` = aucun canal :
   * le paquet dort dans l'outbox (spray-and-wait) jusqu'au prochain flush.
   */
  copyToOutbox: boolean;
  /** Trace libre passée par l'appelant (type de paquet, clientRef…). */
  trace?: string;
}

/** Contrat qu'implémente tout canal de transport (BLE, Internet, LoRa…). */
export interface Transport {
  readonly id: TransportId;
  /** Priorité croissante : 0 = essayé en premier (BLE < Internet < LoRa). */
  readonly priority: number;
  /** Disponibilité rapide — cache court interne, jamais d'appel réseau bloquant. */
  isAvailable(): boolean;
  health(): TransportHealth;
  send(raw: Uint8Array): Promise<SendReceipt>;
  /**
   * Abonnement aux paquets entrants — renvoie la fonction de désabonnement.
   * `meta` est joint quand le medium radio l'expose (RSSI, pair source).
   */
  onPacket(cb: (raw: Uint8Array, meta?: PacketMeta) => void): () => void;
}
