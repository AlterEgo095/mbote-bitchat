"use client";

// ─────────────────────────────────────────────────────────────────────────────
// UsersView — annuaire des utilisateurs (ADM Étape 7). Instrument, pas vitrine.
//
// INVARIANT NON NÉGOCIABLE (ADMIN-RBAC.md §1.8) : « toute mutation UI reflète
// le retour serveur 2xx — pas d'optimistic update avant confirmation ». ICI
// la liste n'est jamais modifiée localement : chaque fetch remplace l'état
// par la réponse authentifiée du serveur (recherche ET pagination).
//
// Recherche : LIKE pseudo (serveur, limite 20) — soumise explicitement
// (Entrée ou bouton), jamais pendant la frappe (chaître tape = coût serveur).
// Liste : cursor keyset 20/page (inscription | reports) + filtres statut /
// période. Statut banni = filtre accepté, 0 ligne avant Étape 9 (§13.7).
//
// Auth : support minimum (arbitrage §13.1 — auditor STRICT 403) ; la page
// serveur a déjà refusé l'auditor, le BFF + le backend ré-imposent (défense
// en profondeur). Dégradations : 502 bandeau ≠ 401 session ≠ 403 refus.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-base";

export interface UserRow {
  pubkey: string;
  pseudo: string;
  createdAt: string;
  postCount: number;
  openReports: number;
  warningCount: number;
  suspendedAt: string | null;
  suspendedUntil: string | null;
  status: "actif" | "suspendu";
}

export interface UsersPayload {
  mode: "list" | "search";
  items: UserRow[];
  nextCursor?: string | null;
  cursorReset?: boolean;
  totalUsers?: number;
  total?: number;
  page: { size: number; sort: string; status: string; period: string; q?: string };
}

export type UsersLoadState =
  | { kind: "ready"; data: UsersPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

export interface UsersFilters {
  status: "all" | "actif" | "suspendu" | "banni";
  period: "24h" | "7d" | "30d" | "all";
  sort: "inscription" | "reports";
}

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return timeFmt.format(new Date(iso));
}

export function UsersView({
  role,
  initial,
}: {
  role: string;
  initial: UsersLoadState;
}) {
  const [state, setState] = useState<UsersLoadState>(initial);
  const [filters, setFilters] = useState<UsersFilters>({ status: "all", period: "all", sort: "inscription" });
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchActive, setSearchActive] = useState(false); // mode recherche ?

  const level = ROLE_LEVEL[role] ?? 0;
  void level; // la liste est lecture seule — les mutations vivent sur la fiche

  const fetchList = useCallback(
    async (f: UsersFilters, c: string | null) => {
      setRefreshing(true);
      setSearchActive(false);
      try {
        const qs = new URLSearchParams({ status: f.status, period: f.period, sort: f.sort });
        if (c) qs.set("cursor", c);
        const res = await apiFetch(`/api/users?${qs.toString()}`, { cache: "no-store" });
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
        const data = (await res.json()) as UsersPayload;
        if (!data || !Array.isArray(data.items)) {
          setState({ kind: "error", code: "http", httpStatus: res.status });
          return;
        }
        setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
        if (data.cursorReset) {
          setNotice("L'annuaire a changé depuis votre dernière page — retour à la page 1.");
        }
      } catch {
        setState({ kind: "error", code: "backend-unreachable" });
      } finally {
        setRefreshing(false);
      }
    },
    []
  );

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length === 0) {
      setNotice("Recherche vide — entrez un pseudo (la liste complète est sous l'annuaire).");
      return;
    }
    setRefreshing(true);
    setSearchActive(true);
    try {
      const res = await apiFetch(`/api/users?q=${encodeURIComponent(q)}`, { cache: "no-store" });
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
      const data = (await res.json()) as UsersPayload;
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      setNotice(`Recherche « ${q} » — ${data.items.length} résultat(s) (limite 20).`);
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  function changeFilter(patch: Partial<UsersFilters>) {
    const f = { ...filters, ...patch };
    setFilters(f);
    setCursor(null);
    setNotice(null);
    void fetchList(f, null);
  }

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — l&apos;annuaire est indisponible.
                Réessayez après rétablissement de la liaison.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ({role}) ne permet pas la consultation de l&apos;annuaire
                (support minimum — l&apos;auditor est limité à l&apos;audit, arbitrage §12.17).
              </p>
            </>
          )}
          {state.code === "unauthorized" && (
            <>
              <p className="font-semibold">Session expirée</p>
              <p className="mt-1">Reconnectez-vous depuis la page d&apos;authentification.</p>
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
          {/* ── barre d'outils : recherche + filtres ── */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch(searchDraft);
              }}
            >
              <label className="grid gap-1 text-xs font-medium text-zinc-600">
                Recherche par pseudo
                <input
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  className="min-h-11 w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                  placeholder="ex. alice"
                  aria-label="Recherche par pseudo"
                  maxLength={100}
                />
              </label>
              <button
                type="submit"
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                Rechercher
              </button>
              {searchActive && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchActive(false);
                    setSearchDraft("");
                    setCursor(null);
                    void fetchList(filters, null);
                  }}
                  className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  ← Annuaire complet
                </button>
              )}
            </form>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Statut
              <select
                value={filters.status}
                onChange={(e) => changeFilter({ status: e.target.value as UsersFilters["status"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre statut"
              >
                <option value="all">tous</option>
                <option value="actif">actifs</option>
                <option value="suspendu">suspendus</option>
                <option value="banni">bannis (Étape 9)</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Période d&apos;inscription
              <select
                value={filters.period}
                onChange={(e) => changeFilter({ period: e.target.value as UsersFilters["period"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre période d'inscription"
              >
                <option value="all">tout</option>
                <option value="24h">24 h</option>
                <option value="7d">7 j</option>
                <option value="30d">30 j</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Tri
              <select
                value={filters.sort}
                onChange={(e) => changeFilter({ sort: e.target.value as UsersFilters["sort"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Tri de l'annuaire"
              >
                <option value="inscription">inscription (récent d&apos;abord)</option>
                <option value="reports">reports reçus (ouverts)</option>
              </select>
            </label>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                {state.data.mode === "search"
                  ? `${state.data.items.length} résultat(s)`
                  : `${state.data.totalUsers ?? "?"} compte(s) au total`}
              </span>
              <button
                type="button"
                onClick={() => (searchActive ? void runSearch(searchDraft) : void fetchList(filters, cursor))}
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                {refreshing ? "Chargement…" : "Rafraîchir"}
              </button>
            </div>
          </div>

          <p className="text-xs text-zinc-500" aria-live="polite">
            {notice ??
              (state.data.mode === "search"
                ? "Résultats de recherche — aucun curseur (limite 20, arbitrage §13.10)."
                : "Page servie à " + fmt(state.fetchedAt) + " — " + (filters.sort === "reports" ? "tri : reports ouverts décroissants, puis ancienneté." : "tri : inscription décroissante."))}
          </p>

          {/* ── table des comptes ── */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Pseudo</th>
                  <th className="px-4 py-2.5 font-medium">Inscrit le</th>
                  <th className="px-4 py-2.5 font-medium">Posts</th>
                  <th className="px-4 py-2.5 font-medium">Reports reçus</th>
                  <th className="px-4 py-2.5 font-medium">Statut</th>
                  <th className="px-4 py-2.5 font-medium" aria-label="Fiche">
                    <span className="sr-only">Fiche</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-zinc-600">
                      {state.data.mode === "search"
                        ? "Aucun compte ne correspond à cette recherche."
                        : "Aucun compte pour ces filtres (banni : aucun avant Étape 9)."}
                    </td>
                  </tr>
                )}
                {state.data.items.map((u) => (
                  <tr key={u.pubkey} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                    <td className="px-4 py-2.5 font-medium text-zinc-900">{u.pseudo}</td>
                    <td className="px-4 py-2.5 text-zinc-600">{fmt(u.createdAt)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-zinc-700">{u.postCount}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${
                          u.openReports >= 5
                            ? "border-red-300 bg-red-50 text-red-800"
                            : u.openReports > 0
                              ? "border-amber-300 bg-amber-50 text-amber-800"
                              : "border-zinc-300 bg-zinc-50 text-zinc-700"
                        }`}
                      >
                        {u.openReports}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {u.status === "suspendu" ? (
                        <span className="inline-flex flex-col">
                          <span className="inline-flex min-h-6 w-fit items-center rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-800">
                            suspendu
                          </span>
                          <span className="mt-0.5 text-[11px] text-zinc-500">
                            jusqu&apos;à {u.suspendedUntil ? fmt(u.suspendedUntil) : "levée manuelle"}
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex min-h-6 items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                          actif
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link
                        href={`/users/${encodeURIComponent(u.pubkey)}`}
                        className="inline-flex min-h-11 items-center rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
                      >
                        Fiche →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── pagination (mode liste uniquement) ── */}
          {state.data.mode === "list" && (
            <div className="flex items-center justify-between" data-testid="users-pagination">
              <span className="text-xs text-zinc-500">
                {cursor ? "Page 2+ (curseur actif)" : "Page 1"} — 20 comptes/page
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!cursor || refreshing}
                  onClick={() => {
                    setCursor(null);
                    void fetchList(filters, null);
                  }}
                  className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-40"
                >
                  ← Retour page 1
                </button>
                <button
                  type="button"
                  disabled={!state.data.nextCursor || refreshing}
                  onClick={() => {
                    const c = state.data.nextCursor ?? null;
                    setCursor(c);
                    void fetchList(filters, c);
                  }}
                  className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-40"
                >
                  Page suivante →
                </button>
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-zinc-500">
            Périmètre : aucune donnée privée (pas d&apos;email, pas d&apos;IP, pas de
            DM — invariants §1). Les actions (avertir, suspendre) vivent sur la
            fiche de chaque compte ; ban définitif = four-eyes Étape 9.
          </p>
        </>
      )}
    </div>
  );
}
