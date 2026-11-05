module.exports = [
"[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

module.exports = __turbopack_context__.r("[project]/node_modules/next/dist/server/route-modules/app-page/module.compiled.js [app-ssr] (ecmascript)").vendored['react-ssr'].ReactJsxDevRuntime;
}),
"[project]/src/components/BackendStatus.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "BackendStatus",
    ()=>BackendStatus
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js [app-ssr] (ecmascript)");
"use client";
;
;
function BackendStatus() {
    const [state, setState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])({
        kind: "checking"
    });
    const check = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useCallback"])(async ()=>{
        const started = Date.now();
        try {
            const res = await fetch("/api/health", {
                cache: "no-store"
            });
            const body = await res.json().catch(()=>({}));
            if (res.ok) {
                setState({
                    kind: "up",
                    latencyMs: Date.now() - started
                });
            } else {
                setState({
                    kind: "degraded",
                    detail: body?.checks?.backend ?? `HTTP ${res.status}`
                });
            }
        } catch  {
            setState({
                kind: "degraded",
                detail: "health check injoignable"
            });
        }
    }, []);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"])(()=>{
        // Premier check différé (setTimeout = callback externe, conforme à la règle
        // react-hooks/set-state-in-effect) puis interrogation périodique 30 s.
        const initial = setTimeout(()=>void check(), 0);
        const id = setInterval(()=>void check(), 30_000);
        return ()=>{
            clearTimeout(initial);
            clearInterval(id);
        };
    }, [
        check
    ]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "mt-4 flex items-center gap-3",
        role: "status",
        "aria-live": "polite",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                "aria-hidden": "true",
                className: state.kind === "up" ? "h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" : state.kind === "degraded" ? "h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" : "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-zinc-400"
            }, void 0, false, {
                fileName: "[project]/src/components/BackendStatus.tsx",
                lineNumber: 55,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "text-sm font-medium text-zinc-800",
                children: [
                    state.kind === "checking" && "Vérification de l'app principale…",
                    state.kind === "up" && `App principale joignable (health 200 · ${state.latencyMs} ms)`,
                    state.kind === "degraded" && `App principale injoignable (${state.detail})`
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/BackendStatus.tsx",
                lineNumber: 65,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/BackendStatus.tsx",
        lineNumber: 54,
        columnNumber: 5
    }, this);
}
}),
];

//# sourceMappingURL=_0t3tvb9lenj7o._.js.map