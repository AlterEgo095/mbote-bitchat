module.exports = [
"[externals]/crypto [external] (crypto, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("crypto", () => require("crypto"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-route-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-route-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/action-async-storage.external.js [external] (next/dist/server/app-render/action-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/app-render/action-async-storage.external.js", () => require("next/dist/server/app-render/action-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/runtime-reacts.external.js [external] (next/dist/server/runtime-reacts.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/server/runtime-reacts.external.js", () => require("next/dist/server/runtime-reacts.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[externals]/node:stream [external] (node:stream, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("node:stream", () => require("node:stream"));

module.exports = mod;
}),
"[externals]/path [external] (path, cjs)", ((__turbopack_context__, module, exports) => {

var mod = __turbopack_context__.x("path", () => require("path"));

module.exports = mod;
}),
"[project]/src/app/api/health/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GET",
    ()=>GET,
    "dynamic",
    ()=>dynamic
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$backend$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/backend.ts [app-route] (ecmascript)");
;
;
const dynamic = "force-dynamic";
async function GET() {
    const backend = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$backend$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["checkBackend"])();
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        status: backend.reachable ? "ok" : "degraded",
        service: "mbote-admin",
        checks: {
            backend: backend.reachable ? `up (${backend.httpStatus})` : backend.error ?? `http_${backend.httpStatus ?? "unknown"}`
        },
        latencyMs: backend.latencyMs,
        timestamp: new Date().toISOString()
    }, {
        status: backend.reachable ? 200 : 503,
        headers: {
            "Cache-Control": "no-store"
        }
    });
}
}),
"[project]/src/lib/backend.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Client HTTP interne vers l'app principale (mbote:3000).
// INVARIANT ARCHITECTURE (docs/specs/ADMIN-RBAC.md §1) : l'app admin n'a PAS
// de client DB — toute donnée passera par ces appels (réseau Docker interne).
// Le ping de santé utilise /api/stats : endpoint public existant, déjà
// utilisé par le healthcheck Docker du service mbote (compose, clôture
// 7d4afb0) — aucun nouvel endpoint n'est créé côté app principale à l'Étape 2.
// ─────────────────────────────────────────────────────────────────────────────
__turbopack_context__.s([
    "backendBase",
    ()=>backendBase,
    "checkBackend",
    ()=>checkBackend
]);
function backendBase() {
    return process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:3000";
}
async function checkBackend(timeoutMs = 3_000) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), timeoutMs);
    const started = Date.now();
    try {
        const res = await fetch(`${backendBase()}/api/stats`, {
            signal: controller.signal,
            cache: "no-store"
        });
        return {
            reachable: res.ok,
            httpStatus: res.status,
            latencyMs: Date.now() - started
        };
    } catch (e) {
        return {
            reachable: false,
            error: e instanceof Error ? e.name : "unknown",
            latencyMs: Date.now() - started
        };
    } finally{
        clearTimeout(timer);
    }
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0faed_hrxn915._.js.map