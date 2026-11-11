module.exports = [
"[project]/src/instrumentation.ts [instrumentation] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Instrumentation Next.js — appelée UNE FOIS au démarrage du serveur.
 * Démarre les tâches de fond du Palier 0 (purge périodique de la dédup mesh…)
 * sans jamais bloquer le démarrage ni polluer l'edge runtime.
 *
 * Vague 6 : en dev/sandbox, embarque le hub temps réel (socket.io 3030 +
 * /emit 3031) dans CE processus — pas de service séparé à superviser (le
 * conteneur dédié mini-services/relay-service reste le mode production).
 */ __turbopack_context__.s([
    "register",
    ()=>register
]);
async function register() {
    if ("TURBOPACK compile-time truthy", 1) {
        const { startBackgroundTasks } = await Promise.resolve().then(()=>{
            const e = new Error("Cannot find module '@/lib/mbote/state-store'");
            e.code = 'MODULE_NOT_FOUND';
            throw e;
        });
        startBackgroundTasks();
        if (("TURBOPACK compile-time value", "development") !== "production" && process.env.MBOTE_EMBED_RELAY !== "0") {
            const { startEmbeddedRelay } = await Promise.resolve().then(()=>{
                const e = new Error("Cannot find module '@/lib/mbote/embedded-relay'");
                e.code = 'MODULE_NOT_FOUND';
                throw e;
            });
            startEmbeddedRelay();
        }
    }
}
}),
];

//# sourceMappingURL=src_instrumentation_ts_07j_8w1ivtswj._.js.map