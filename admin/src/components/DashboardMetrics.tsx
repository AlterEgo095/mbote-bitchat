"use client";

import { useCallback, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// DashboardMetrics — les 4 métriques du pilotage (Étape 5).
//
//  - les données INITIALES sont calculées CÔTÉ SERVEUR (page /dashboard —
//    même pattern que la page d'accueil : pas d'effet de chargement au premier
//    rendu, valeurs visibles immédiatement, y compris si l'hydratation
//    échouait) ;
//  - le rafraîchissement MANUEL (bouton — pas de polling : le dashboard est
//    une photo instantanée, directive Étape 5) passe par le BFF
//    /api/dashboard et met à jour l'état ;
//  - dégradation : 502 backend-unreachable → bandeau « backend injoignable »
//    au lieu de crasher ; 403 → accès refusé ; 401 → session expirée ;
//  - valeur + horodatage + couleur (vert/orange/rouge — seuils calculés côté
//    app principale, src/lib/mbote/dashboard-stats.ts).
// ─────────────────────────────────────────────────────────────────────────────

type MetricColor = "green" | "orange" | "red";

export interface DashboardPayload {
  generatedAt: string;
  activeUsers: { h24: number; d7: number; status: MetricColor; updatedAt: string };
  openReports: { value: number; status: MetricColor; updatedAt: string };
  uptime: { seconds: number; status: MetricColor; updatedAt: string };
  backup: {
    state: "ok" | "stale" | "failed" | "not-configured";
    at: string | null;
    ageHours: number | null;
    status: MetricColor;
    detail: string;
    updatedAt: string;
  };
}

/** État initial calculé côté serveur, puis entretenu par le bouton Rafraîchir. */
export type DashboardLoadState =
  | { kind: "ready"; data: DashboardPayload; fetchedAt: string }
  | { kind: "error"; code: "backend-unreachable" | "forbidden" | "unauthorized" | "http"; httpStatus?: number };

const DOT: Record<MetricColor, string> = {
  green: "bg-emerald-500",
  orange: "bg-amber-500",
  red: "bg-red-500",
};

const CHIP: Record<MetricColor, string> = {
  green: "border-emerald-300 bg-emerald-50 text-emerald-800",
  orange: "border-amber-300 bg-amber-50 text-amber-800",
  red: "border-red-300 bg-red-50 text-red-800",
};

const LABEL_FR: Record<MetricColor, string> = {
  green: "OK",
  orange: "vigilance",
  red: "critique",
};

/** secondes → « 3 j 4 h » / « 2 h 15 min » / « 42 s » (affichage uniquement). */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${seconds} s`;
}

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function hhmmss(iso: string): string {
  return timeFmt.format(new Date(iso));
}

const BACKUP_LABEL: Record<DashboardPayload["backup"]["state"], string> = {
  ok: "backup récent",
  stale: "backup ancien",
  failed: "backup en échec",
  "not-configured": "non configuré",
};

function MetricCard(props: {
  label: string;
  value: string;
  sub: string;
  status: MetricColor;
  updatedAt: string;
  threshold: string;
}) {
  return (
    <section
      aria-label={props.label}
      className="flex flex-col justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-600">{props.label}</h3>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP[props.status]}`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[props.status]}`} />
          {LABEL_FR[props.status]}
        </span>
      </div>
      <div>
        <p className="text-3xl font-semibold tracking-tight text-zinc-900">{props.value}</p>
        <p className="mt-1 text-sm text-zinc-600">{props.sub}</p>
      </div>
      <div className="text-xs text-zinc-500">
        <p>
          Mise à jour :{" "}
          <time dateTime={props.updatedAt}>{hhmmss(props.updatedAt)}</time>
        </p>
        <p className="mt-0.5">{props.threshold}</p>
      </div>
    </section>
  );
}

export function DashboardMetrics({ role, initial }: { role: string; initial: DashboardLoadState }) {
  const [state, setState] = useState<DashboardLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  // F #59 — dégradation honnête : les dernières valeurs connues restent
  // affichées (grisées + horodatage) au lieu d'une page vide + bandeau seul.
  const lastDataRef = useRef<DashboardPayload | null>(initial.kind === "ready" ? initial.data : null);
  const lastFetchedRef = useRef<string | null>(initial.kind === "ready" ? initial.fetchedAt : null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (res.status === 502) {
        setState({ kind: "error", code: "backend-unreachable", httpStatus: res.status });
        return;
      }
      if (res.status === 403) {
        setState({ kind: "error", code: "forbidden", httpStatus: res.status });
        return;
      }
      if (res.status === 401) {
        setState({ kind: "error", code: "unauthorized", httpStatus: res.status });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      const data = (await res.json()) as DashboardPayload;
      // garde : les 4 clés attendues (directive Étape 5)
      if (!data || !data.activeUsers || !data.openReports || !data.uptime || !data.backup) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      const fetchedAt = new Date().toISOString();
      lastDataRef.current = data;
      lastFetchedRef.current = fetchedAt;
      setState({ kind: "ready", data, fetchedAt });
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && lastDataRef.current && lastFetchedRef.current && (
        // F #59 — les cartes restent rendues (grisées, horodatées) au lieu de
        // disparaître : l'admin garde la dernière valeur connue.
        <section aria-label="Dernières valeurs connues (figées)">
          <p className="text-xs font-medium text-zinc-600">
            Dernières valeurs connues — figées au{" "}
            <time dateTime={lastFetchedRef.current}>{hhmmss(lastFetchedRef.current)}</time>{" "}
            jusqu&apos;au retour de l&apos;app principale :
          </p>
          <div className="mt-2 grid grid-cols-1 gap-4 opacity-60 grayscale sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Utilisateurs actifs"
              value={`${lastDataRef.current.activeUsers.h24} / ${lastDataRef.current.activeUsers.d7}`}
              sub="24 h / 7 j (post ou DM)"
              status={lastDataRef.current.activeUsers.status}
              updatedAt={lastDataRef.current.activeUsers.updatedAt}
              threshold="vert ≥ 5 · orange 1–4 · rouge 0"
            />
            <MetricCard
              label="Reports ouverts"
              value={String(lastDataRef.current.openReports.value)}
              sub="non pris en charge (handledById vide)"
              status={lastDataRef.current.openReports.status}
              updatedAt={lastDataRef.current.openReports.updatedAt}
              threshold="vert ≤ 10 · orange 11–50 · rouge > 50"
            />
            <MetricCard
              label="Uptime conteneur"
              value={formatUptime(lastDataRef.current.uptime.seconds)}
              sub={`(${lastDataRef.current.uptime.seconds.toLocaleString("fr-FR")} s)`}
              status={lastDataRef.current.uptime.status}
              updatedAt={lastDataRef.current.uptime.updatedAt}
              threshold="vert ≥ 24 h · orange 1–24 h · rouge < 1 h"
            />
            <MetricCard
              label="Dernier backup"
              value={BACKUP_LABEL[lastDataRef.current.backup.state]}
              sub={
                lastDataRef.current.backup.ageHours !== null
                  ? `il y a ${lastDataRef.current.backup.ageHours} h — ${lastDataRef.current.backup.detail}`
                  : lastDataRef.current.backup.detail
              }
              status={lastDataRef.current.backup.status}
              updatedAt={lastDataRef.current.backup.updatedAt}
              threshold="vert < 24 h · orange > 24 h / non configuré · rouge échec"
            />
          </div>
        </section>
      )}

      {state.kind === "error" && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — métriques indisponibles. Le
                reste du panneau reste inutile tant que la liaison n&apos;est pas
                rétablie. Réessayez avec le bouton Rafraîchir.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ({role}) ne permet pas l&apos;accès aux statistiques
                (support minimum — l&apos;auditor est limité à l&apos;audit).
              </p>
            </>
          )}
          {state.code === "unauthorized" && (
            <>
              <p className="font-semibold">Session expirée</p>
              <p className="mt-1">
                Reconnectez-vous depuis la page d&apos;authentification.
              </p>
            </>
          )}
          {state.code === "http" && (
            <>
              <p className="font-semibold">Erreur inattendue</p>
              <p className="mt-1">HTTP {state.httpStatus} — réessayez.</p>
            </>
          )}
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Utilisateurs actifs"
              value={`${state.data.activeUsers.h24} / ${state.data.activeUsers.d7}`}
              sub="24 h / 7 j (post ou DM)"
              status={state.data.activeUsers.status}
              updatedAt={state.data.activeUsers.updatedAt}
              threshold="vert ≥ 5 · orange 1–4 · rouge 0"
            />
            <MetricCard
              label="Reports ouverts"
              value={String(state.data.openReports.value)}
              sub="non pris en charge (handledById vide)"
              status={state.data.openReports.status}
              updatedAt={state.data.openReports.updatedAt}
              threshold="vert ≤ 10 · orange 11–50 · rouge > 50"
            />
            <MetricCard
              label="Uptime conteneur"
              value={formatUptime(state.data.uptime.seconds)}
              sub={`(${state.data.uptime.seconds.toLocaleString("fr-FR")} s)`}
              status={state.data.uptime.status}
              updatedAt={state.data.uptime.updatedAt}
              threshold="vert ≥ 24 h · orange 1–24 h · rouge < 1 h"
            />
            <MetricCard
              label="Dernier backup"
              value={BACKUP_LABEL[state.data.backup.state]}
              sub={
                state.data.backup.ageHours !== null
                  ? `il y a ${state.data.backup.ageHours} h — ${state.data.backup.detail}`
                  : state.data.backup.detail
              }
              status={state.data.backup.status}
              updatedAt={state.data.backup.updatedAt}
              threshold="vert < 24 h · orange > 24 h / non configuré · rouge échec"
            />
          </div>
          <p className="text-xs text-zinc-500">
            Photo instantanée au{" "}
            <time dateTime={state.data.generatedAt}>{hhmmss(state.data.generatedAt)}</time>{" "}
            (pas d&apos;historique, pas d&apos;alerte automatique — Étape 8).
          </p>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm transition hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${refreshing ? "animate-pulse bg-zinc-400" : "bg-zinc-300"}`}
          />
          {refreshing ? "Rafraîchissement…" : "Rafraîchir"}
        </button>
        <span aria-live="polite" className="text-xs text-zinc-500">
          {state.kind === "ready" && `Dernier rafraîchissement : ${hhmmss(state.fetchedAt)}`}
        </span>
      </div>
    </div>
  );
}
