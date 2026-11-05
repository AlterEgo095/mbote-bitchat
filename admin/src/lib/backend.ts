// ─────────────────────────────────────────────────────────────────────────────
// Client HTTP interne vers l'app principale (mbote:3000).
// INVARIANT ARCHITECTURE (docs/specs/ADMIN-RBAC.md §1) : l'app admin n'a PAS
// de client DB — toute donnée passera par ces appels (réseau Docker interne).
// Le ping de santé utilise /api/stats : endpoint public existant, déjà
// utilisé par le healthcheck Docker du service mbote (compose, clôture
// 7d4afb0) — aucun nouvel endpoint n'est créé côté app principale à l'Étape 2.
// ─────────────────────────────────────────────────────────────────────────────

export function backendBase(): string {
  return process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:3000";
}

export interface BackendCheck {
  reachable: boolean;
  httpStatus?: number;
  error?: string;
  latencyMs: number;
}

export async function checkBackend(timeoutMs = 3_000): Promise<BackendCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${backendBase()}/api/stats`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return {
      reachable: res.ok,
      httpStatus: res.status,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      reachable: false,
      error: e instanceof Error ? e.name : "unknown",
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
