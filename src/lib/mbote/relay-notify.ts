/**
 * Helper serveur → relay : notifie le hub socket.io des nouvelles données.
 * Fire-and-forget : le temps réel ne doit JAMAIS bloquer ni faire échouer l'API.
 * Si le relay est éteint, l'application reste 100% fonctionnelle (polling fallback).
 */

const RELAY_EMIT_URL = process.env.RELAY_EMIT_URL ?? "http://127.0.0.1:3031";

export function relayNotify(
  event: string,
  payload: unknown,
  rooms?: string[]
): void {
  void fetch(`${RELAY_EMIT_URL}/emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, payload, rooms }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {
    // relay injoignable : silencieux, le frontend retombe sur le polling
  });
}
