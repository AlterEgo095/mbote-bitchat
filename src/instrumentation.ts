/**
 * Instrumentation Next.js — appelée UNE FOIS au démarrage du serveur.
 * Démarre les tâches de fond du Palier 0 (purge périodique de la dédup mesh…)
 * sans jamais bloquer le démarrage ni polluer l'edge runtime.
 *
 * Vague 6 : en dev/sandbox, embarque le hub temps réel (socket.io 3030 +
 * /emit 3031) dans CE processus — pas de service séparé à superviser (le
 * conteneur dédié mini-services/relay-service reste le mode production).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundTasks } = await import("@/lib/mbote/state-store");
    startBackgroundTasks();

    if (process.env.NODE_ENV !== "production" && process.env.MBOTE_EMBED_RELAY !== "0") {
      const { startEmbeddedRelay } = await import("@/lib/mbote/embedded-relay");
      startEmbeddedRelay();
    }
  }
}
