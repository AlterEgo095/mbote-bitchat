(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push(["chunks/_197n5k3la57q9._.js",
"[project]/admin/node_modules/next/dist/esm/build/templates/edge-wrapper.js { MODULE => \"[project]/src/instrumentation.ts [instrumentation-edge] (ecmascript)\" } [instrumentation-edge] (ecmascript)", ((__turbopack_context__, module, exports) => {

// The wrapped module could be an async module, we handle that with the proxy
// here. The comma expression makes sure we don't call the function with the
// module as the "this" arg.
// Turn exports into functions that are also a thenable. This way you can await the whole object
// or  exports (e.g. for Components) or call them directly as though they are async functions
// (e.g. edge functions/middleware, this is what the Edge Runtime does).
// Catch promise to prevent UnhandledPromiseRejectionWarning, this will be propagated through
// the awaited export(s) anyway.
self._ENTRIES ||= {};
const modProm = Promise.resolve().then(()=>__turbopack_context__.i("[project]/src/instrumentation.ts [instrumentation-edge] (ecmascript)"));
modProm.catch(()=>{});
self._ENTRIES["middleware_instrumentation"] = new Proxy(modProm, {
    get (innerModProm, name) {
        if (name === 'then') {
            return (res, rej)=>innerModProm.then(res, rej);
        }
        let result = (...args)=>innerModProm.then((mod)=>(0, mod[name])(...args));
        result.then = (res, rej)=>innerModProm.then((mod)=>mod[name]).then(res, rej);
        return result;
    }
});
}),
"[project]/src/instrumentation.ts [instrumentation-edge] (ecmascript)", ((__turbopack_context__) => {
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
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
}
}),
]);

//# sourceMappingURL=_197n5k3la57q9._.js.map