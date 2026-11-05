import { NextResponse } from "next/server";
import { checkBackend } from "@/lib/backend";

// ─────────────────────────────────────────────────────────────────────────────
// Health check de l'app admin — 2 états réels, testés (preuve ADM-step1-2.md) :
//   UP       → 200 {"status":"ok",       "checks":{"backend":"up (200)"}}
//   DEGRADED → 503 {"status":"degraded","checks":{"backend":"unreachable"}}
// Le healthcheck Docker du conteneur admin interroge CE endpoint : un backend
// mort rend le conteneur visiblement unhealthy (docker ps) après 3 retries.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export async function GET() {
  const backend = await checkBackend();

  return NextResponse.json(
    {
      status: backend.reachable ? "ok" : "degraded",
      service: "mbote-admin",
      checks: {
        backend: backend.reachable
          ? `up (${backend.httpStatus})`
          : (backend.error ?? `http_${backend.httpStatus ?? "unknown"}`),
      },
      latencyMs: backend.latencyMs,
      timestamp: new Date().toISOString(),
    },
    {
      status: backend.reachable ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
