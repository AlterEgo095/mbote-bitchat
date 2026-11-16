"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-base";

// ─────────────────────────────────────────────────────────────────────────────
// Badge vivant de l'état backend, alimenté par /api/health (2 états réels :
// UP 200 / DEGRADED 503). Rafraîchissement 30 s. Aria-live pour les lecteurs
// d'écran. C'est la seule pièce dynamique du squelette — volontairement.
// ─────────────────────────────────────────────────────────────────────────────

type HealthState =
  | { kind: "checking" }
  | { kind: "up"; latencyMs: number }
  | { kind: "degraded"; detail: string };

interface HealthBody {
  status?: string;
  checks?: { backend?: string };
}

export function BackendStatus() {
  const [state, setState] = useState<HealthState>({ kind: "checking" });

  const check = useCallback(async () => {
    const started = Date.now();
    try {
      const res = await apiFetch("/api/health", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as HealthBody;
      if (res.ok) {
        setState({ kind: "up", latencyMs: Date.now() - started });
      } else {
        setState({
          kind: "degraded",
          detail: body?.checks?.backend ?? `HTTP ${res.status}`,
        });
      }
    } catch {
      setState({ kind: "degraded", detail: "health check injoignable" });
    }
  }, []);

  useEffect(() => {
    // Premier check différé (setTimeout = callback externe, conforme à la règle
    // react-hooks/set-state-in-effect) puis interrogation périodique 30 s.
    const initial = setTimeout(() => void check(), 0);
    const id = setInterval(() => void check(), 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [check]);

  return (
    <div className="mt-4 flex items-center gap-3" role="status" aria-live="polite">
      <span
        aria-hidden="true"
        className={
          state.kind === "up"
            ? "h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500"
            : state.kind === "degraded"
              ? "h-2.5 w-2.5 shrink-0 rounded-full bg-red-500"
              : "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-zinc-400"
        }
      />
      <span className="text-sm font-medium text-zinc-800">
        {state.kind === "checking" && "Vérification de l'app principale…"}
        {state.kind === "up" &&
          `App principale joignable (health 200 · ${state.latencyMs} ms)`}
        {state.kind === "degraded" && `App principale injoignable (${state.detail})`}
      </span>
    </div>
  );
}
