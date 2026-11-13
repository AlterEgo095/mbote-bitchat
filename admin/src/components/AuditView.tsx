"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AuditView — journal AdminAudit (ADM Étape 8). LECTURE SEULE par construction.
//
// INVARIANT §1.8 : ici triviale — il n'existe AUCUNE mutation d'audit
// (append-only, triggers SQLite). Chaque filtre/pagination déclenche un fetch
// authentifié et l'état affiché EST la réponse serveur ; erreurs 502/401/403
// affichées, jamais interprétées localement.
//
// Export CSV : téléchargement DIRECT via <a href="/api/audit/export.csv?…">
// — le Content-Disposition: attachment du BFF fait le reste (aucun fetch JS :
// le navigateur gère le téléchargement). Le 422 (limite 10 000) est géré par
// un fetch préalable HEAD-less ? Non — arbitrage §14.7 : le bouton exporte ;
// si le backend répond 422 (JSON), la UI ne peut pas l'intercepter via <a>.
// SOLUTION : un fetch préalable sur /api/audit/export.csv avec
// `X-Export-Probe: 1` … COMPLEXE. Tranché SIMPLE : le bouton déclenche un
// fetch JS (pas <a>) ; 200 → blob téléchargé (nom depuis Content-
// Disposition) ; 422 → message affiché. Le fichier reste un vrai
// téléchargement (blob → a[download] — même mécanique que les médias B2).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";

export interface AuditItem {
  id: number;
  createdAt: string;
  actorId: number;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  justification: string | null;
}

export interface AuditFacets {
  actors: { id: number; email: string; role: string }[];
  actions: string[];
  targetTypes: string[];
}

export interface AuditPayload {
  items: AuditItem[];
  nextCursor: string | null;
  facets: AuditFacets;
  page: { size: number };
}

export type AuditLoadState =
  | { kind: "ready"; data: AuditPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

export interface AuditFilters {
  actor: string; // adminUserId ou ""
  action: string;
  targetType: string;
  since: "24h" | "7d" | "30d" | "all";
  from: string; // yyyy-mm-dd ou ""
  to: string;
  target: string; // type:id ou sous-chaîne
}

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const JUST_TRUNC = 50;

function truncJust(j: string | null): string {
  if (!j) return "—";
  return j.length > JUST_TRUNC ? `${j.slice(0, JUST_TRUNC)}…` : j;
}

function filterQs(f: AuditFilters, cursor: string | null): string {
  const qs = new URLSearchParams();
  if (f.actor) qs.set("actor", f.actor);
  if (f.action) qs.set("action", f.action);
  if (f.targetType) qs.set("targetType", f.targetType);
  if (f.since !== "all") qs.set("since", f.since);
  if (f.from) qs.set("from", f.from);
  if (f.to) qs.set("to", f.to);
  if (f.target) qs.set("target", f.target);
  if (cursor) qs.set("cursor", cursor);
  return qs.toString();
}

/** Lien cible : targetType='user' → fiche /users/<pubkey> (arbitrage §14.5) ;
 *  post/report/AdminUser/AdminSession n'ont pas de fiche admin — texte brut. */
function TargetCell({ type, id }: { type: string; id: string }) {
  const short = id.length > 24 ? `${id.slice(0, 24)}…` : id;
  if (type === "user") {
    return (
      <Link
        href={`/users/${encodeURIComponent(id)}`}
        className="font-mono text-xs text-blue-900 underline decoration-blue-300 hover:decoration-blue-600"
        title={`Fiche utilisateur ${id}`}
      >
        {short}
      </Link>
    );
  }
  return (
    <span className="font-mono text-xs text-zinc-600" title={id}>
      {short}
    </span>
  );
}

export function AuditView({ initial }: { initial: AuditLoadState }) {
  const [state, setState] = useState<AuditLoadState>(initial);
  const [filters, setFilters] = useState<AuditFilters>({
    actor: "",
    action: "",
    targetType: "",
    since: "all",
    from: "",
    to: "",
    target: "",
  });
  const [nextCursor, setNextCursor] = useState<string | null>(
    initial.kind === "ready" ? initial.data.nextCursor : null
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const facets: AuditFacets =
    state.kind === "ready"
      ? state.data.facets
      : { actors: [], actions: [], targetTypes: [] };

  const fetchPage = useCallback(async (f: AuditFilters, cursor: string | null) => {
    setRefreshing(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/audit?${filterQs(f, cursor)}`, { cache: "no-store" });
      if (res.status === 502) {
        setState({ kind: "error", code: "backend-unreachable", httpStatus: res.status });
        return;
      }
      if (res.status === 401) {
        setState({ kind: "error", code: "unauthorized", httpStatus: res.status });
        return;
      }
      if (res.status === 403) {
        setState({ kind: "error", code: "forbidden", httpStatus: res.status });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      const data = (await res.json()) as AuditPayload;
      if (!data || !Array.isArray(data.items)) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      setNextCursor(data.nextCursor);
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  function changeFilter(patch: Partial<AuditFilters>) {
    const f = { ...filters, ...patch };
    setFilters(f);
    setNextCursor(null);
    void fetchPage(f, null);
  }

  /** Charger plus — items ACCUMULÉS depuis les réponses serveur (jamais
   *  déduits localement). */
  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/audit?${filterQs(filters, nextCursor)}`, { cache: "no-store" });
      if (!res.ok) {
        setNotice(
          res.status === 502
            ? "App principale injoignable — réessayez."
            : `Chargement impossible (HTTP ${res.status}).`
        );
        return;
      }
      const data = (await res.json()) as AuditPayload;
      if (!data || !Array.isArray(data.items)) {
        setNotice("Réponse illisible du serveur.");
        return;
      }
      if (state.kind === "ready") {
        const known = new Set(state.data.items.map((i) => i.id));
        const fresh = data.items.filter((i) => !known.has(i.id));
        setState({
          kind: "ready",
          data: {
            items: [...state.data.items, ...fresh],
            nextCursor: data.nextCursor,
            facets: state.data.facets,
            page: state.data.page,
          },
          fetchedAt: new Date().toISOString(),
        });
      }
      setNextCursor(data.nextCursor);
    } catch {
      setNotice("App principale injoignable — réessayez.");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Export CSV — fetch JS (arbitrage §14.7) : 200 → téléchargement blob ;
   *  422 → message clair (limite 10 000) ; 4xx → message. */
  async function exportCsv() {
    setExporting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/audit/export.csv?${filterQs(filters, null)}`, {
        cache: "no-store",
      });
      if (res.status === 422) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(body.error ?? "Export refusé (422).");
        return;
      }
      if (res.status === 403 || res.status === 401) {
        setNotice("Session expirée ou accès refusé — reconnectez-vous.");
        return;
      }
      if (!res.ok) {
        setNotice(`Export impossible (HTTP ${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(disposition);
      const name = m?.[1] ?? `audit-${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`Export téléchargé (${name}).`);
    } catch {
      setNotice("Export impossible — réseau.");
    } finally {
      setExporting(false);
    }
  }

  if (state.kind === "error") {
    const msg: Record<string, string> = {
      "backend-unreachable": "App principale injoignable (502) — le journal est indisponible, réessayez.",
      unauthorized: "Session expirée — reconnectez-vous.",
      forbidden: "Accès refusé — le journal exige le rôle auditor.",
      http: `Erreur HTTP ${state.httpStatus ?? "?"}.`,
    };
    return (
      <section className="rounded-lg border border-red-300 bg-red-50 p-6" role="alert">
        <h2 className="text-base font-semibold text-red-800">Journal indisponible</h2>
        <p className="mt-1 text-sm text-red-700">{msg[state.code]}</p>
        <button
          type="button"
          onClick={() => void fetchPage(filters, null)}
          className="mt-3 rounded-md border border-red-300 bg-white min-h-11 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Réessayer
        </button>
      </section>
    );
  }

  const items = state.data.items;

  return (
    <div className="space-y-4">
      {/* ── filtres ─────────────────────────────────────────────────────── */}
      <section
        aria-labelledby="audit-filters-heading"
        className="rounded-lg border border-zinc-200 bg-white p-4"
      >
        <h2 id="audit-filters-heading" className="mb-3 text-sm font-semibold text-zinc-900">
          Filtres
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs font-medium text-zinc-700">
            Acteur
            <select
              aria-label="Filtrer par acteur"
              value={filters.actor}
              onChange={(e) => changeFilter({ actor: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white min-h-11 px-2 py-2 text-sm text-zinc-900"
            >
              <option value="">Tous les acteurs</option>
              {facets.actors.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.email} ({a.role})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-zinc-700">
            Action
            <select
              aria-label="Filtrer par action"
              value={filters.action}
              onChange={(e) => changeFilter({ action: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white min-h-11 px-2 py-2 text-sm text-zinc-900"
            >
              <option value="">Toutes les actions</option>
              {facets.actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-zinc-700">
            Type de cible
            <select
              aria-label="Filtrer par type de cible"
              value={filters.targetType}
              onChange={(e) => changeFilter({ targetType: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white min-h-11 px-2 py-2 text-sm text-zinc-900"
            >
              <option value="">Tous les types</option>
              {facets.targetTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-zinc-700">
            Période
            <select
              aria-label="Filtrer par période"
              value={filters.since}
              onChange={(e) =>
                changeFilter({ since: e.target.value as AuditFilters["since"], from: "", to: "" })
              }
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white min-h-11 px-2 py-2 text-sm text-zinc-900"
            >
              <option value="all">Tout</option>
              <option value="24h">24 h</option>
              <option value="7d">7 jours</option>
              <option value="30d">30 jours</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-zinc-700">
            Plage custom (prime sur « Période »)
            <span className="mt-1 flex items-center gap-1">
              <input
                type="date"
                value={filters.from}
                onChange={(e) => changeFilter({ from: e.target.value })}
                className="w-full rounded-md border border-zinc-300 min-h-11 px-2 py-2 text-sm text-zinc-900"
                aria-label="Date de début"
              />
              <span aria-hidden="true">→</span>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => changeFilter({ to: e.target.value })}
                className="w-full rounded-md border border-zinc-300 min-h-11 px-2 py-2 text-sm text-zinc-900"
                aria-label="Date de fin"
              />
            </span>
          </label>
          <label className="block text-xs font-medium text-zinc-700">
            Cible (type:id ou sous-chaîne)
            <input
              type="text"
              value={filters.target}
              placeholder="user:<pubkey> · <cuid>"
              onChange={(e) => changeFilter({ target: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-300 min-h-11 px-2 py-2 font-mono text-sm text-zinc-900"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white min-h-11 px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
          >
            {exporting ? "Export en cours…" : "Exporter CSV"}
          </button>
          <span className="text-xs text-zinc-500">
            {items.length} ligne{items.length > 1 ? "s" : ""} affichée
            {items.length > 1 ? "s" : ""}
            {nextCursor ? " · pages suivantes disponibles" : ""}
          </span>
        </div>
        <p aria-live="polite" className="mt-2 text-sm text-amber-800">
          {notice}
        </p>
      </section>

      {/* ── table ───────────────────────────────────────────────────────── */}
      <section
        aria-labelledby="audit-table-heading"
        className="overflow-hidden rounded-lg border border-zinc-200 bg-white"
      >
        <h2 id="audit-table-heading" className="sr-only">
          Journal d&apos;audit
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50">
              <tr>
                {["Horodatage", "Acteur", "Rôle", "Action", "Cible", "Justification"].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-600"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-zinc-500">
                    Aucune entrée pour ces filtres.
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.id} className="hover:bg-zinc-50">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-700">
                      <Link
                        href={`/audit/${it.id}`}
                        className="tabular-nums underline decoration-zinc-300 hover:decoration-zinc-600"
                        title="Voir le détail complet"
                      >
                        {timeFmt.format(new Date(it.createdAt))}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-700">
                      <span title={`${it.actorEmail} (id ${it.actorId})`}>{it.actorEmail}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-600">{it.actorRole}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
                        {it.action}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="mr-1 text-xs text-zinc-500">{it.targetType}</span>
                      <TargetCell type={it.targetType} id={it.targetId} />
                    </td>
                    <td className="max-w-[16rem] px-3 py-2 text-xs text-zinc-700">
                      <span title={it.justification ?? ""}>{truncJust(it.justification)}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {nextCursor && (
          <div className="border-t border-zinc-200 p-3 text-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore || refreshing}
              className="rounded-md border border-zinc-300 bg-white min-h-11 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {loadingMore ? "Chargement…" : "Charger plus"}
            </button>
          </div>
        )}
      </section>
      <p className="text-xs text-zinc-500">
        Append-only par construction (triggers SQLite) — aucune mutation possible
        depuis cette interface. Export CSV : 10 000 lignes max, sans
        before/after JSON (arbitrage §14.2).
        {refreshing ? " · actualisation…" : ""}
      </p>
    </div>
  );
}
