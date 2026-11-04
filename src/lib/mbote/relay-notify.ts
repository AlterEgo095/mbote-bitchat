/**
 * Helper serveur → relay : notifie le hub socket.io des nouvelles données.
 * Fire-and-forget : le temps réel ne doit JAMAIS bloquer ni faire échouer l'API.
 * Si le relay est éteint, l'application reste 100% fonctionnelle (polling fallback).
 *
 * F-51 (Vague 6) : le token d'émission vient de DEUX sources, par ordre :
 *  1. hub EMBARQUÉ (dev) : secret éphémère généré au boot du processus et
 *     posé sur globalThis par src/lib/mbote/embedded-relay.ts — in-process,
 *     jamais configurable depuis l'extérieur ;
 *  2. token d'environnement RELAY_EMIT_TOKEN (production Docker, partagé
 *     avec le conteneur relay).
 */

const RELAY_EMIT_URL = process.env.RELAY_EMIT_URL ?? "http://127.0.0.1:3031";
const EMIT_TOKEN = process.env.RELAY_EMIT_TOKEN ?? "";

declare global {
  var __MBOTE_EMIT_TOKEN: string | undefined;
}

export function relayNotify(
  event: string,
  payload: unknown,
  rooms?: string[]
): void {
  const token = globalThis.__MBOTE_EMIT_TOKEN ?? EMIT_TOKEN;
  void fetch(`${RELAY_EMIT_URL}/emit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-emit-token": token } : {}),
    },
    body: JSON.stringify({ event, payload, rooms }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {
    // relay injoignable : silencieux, le frontend retombe sur le polling
  });
}
