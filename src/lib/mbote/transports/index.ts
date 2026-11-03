/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Point d'entrée des transports web (pile hybride Mbote)
 * ─────────────────────────────────────────────────────────────────────────────
 *  P1 : contrat Transport, TransportRouter (DORS), transport pont navigateur.
 *  P2 : outbox durable (IndexedDB + repli localStorage) + déclencheurs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export * from "./types";
export { TransportRouter } from "./router";
export { WebBridgeTransport } from "./web-bridge-transport";
export { getWebRouter, type WebRouterBundle } from "./web-router";

export * from "./outbox-core";
export {
  IndexedDbOutboxStorage,
  LocalStorageOutboxStorage,
} from "./web-outbox-storage";
export { getWebOutbox } from "./web-outbox";
