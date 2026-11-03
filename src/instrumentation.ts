/**
 * Instrumentation Next.js — appelée UNE FOIS au démarrage du serveur.
 * Démarre les tâches de fond du Palier 0 (purge périodique de la dédup mesh…)
 * sans jamais bloquer le démarrage ni polluer l'edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundTasks } = await import("@/lib/mbote/state-store");
    startBackgroundTasks();
  }
}
