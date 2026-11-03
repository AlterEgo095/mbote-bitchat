/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Singleton routeur web — une seule instance partagée entre les composants :
 *  BitChatBridge soumet ses paquets, RouteurPanel observe les décisions.
 *  (extrait de index.ts au P2 pour éviter tout import circulaire avec
 *  l'outbox durable)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { TransportRouter } from "./router";
import { WebBridgeTransport } from "./web-bridge-transport";

export interface WebRouterBundle {
  router: TransportRouter;
  bridge: WebBridgeTransport;
}

let instance: WebRouterBundle | null = null;

export function getWebRouter(): WebRouterBundle {
  if (!instance) {
    const bridge = new WebBridgeTransport();
    const router = new TransportRouter({ sendTimeoutMs: 8000 });
    // Côté web, un seul canal : l'Internet (le BLE est le transport natif de
    // l'app mobile — voir mobile/src/transport/ble-transport.ts).
    router.register(bridge);
    instance = { router, bridge };
  }
  return instance;
}
