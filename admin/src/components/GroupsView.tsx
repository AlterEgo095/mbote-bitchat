"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GroupsView — annuaire des groupes MLS (back-office 2026-11, MÉTADONNÉES
// ONLY).
//
// INVARIANT NON NÉGOCIABLE (ADMIN-RBAC §1.4) : les messages de groupe sont
// chiffrés MLS — le serveur ne stocke QUE du chiffré opaque. Cette vue
// n'affiche que le SHELL des groupes (nom, mlsGroupId, créateur, compteurs,
// timestamps) — jamais le contenu d'un message, jamais un secret de groupe.
//
// INVARIANT §1.8 : aucune mutation locale — la liste est TOUJOURS remplacée
// par la réponse authentifiée du serveur (pagination cursor keyset 20/page,
// garde de vue cursorReset → retour page 1 signalé).
//
// Recherche : LIKE name | mlsGroupId (serveur, 2..200 caractères, limite 20)
// — soumise explicitement (Entrée ou bouton). La fiche détaillée (membres,
// enveloppes MLS, purge four-eyes) vit sur /groups/[id].
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-base";

// ── Types (contrat backend /api/internal/admin/groups) ──

export interface GroupRow {
  id: string;
  name: string;
  mlsGroupId: string;
  creatorKey: string;
  memberCount: number;
  activeMemberCount: number;
  messageCount: number;
  envelopeCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface GroupsTotals {
  groups: number;
  members: number;
  messages: number;
  envelopes: number;
  last24hMessages: number;
}

export interface GroupsPayload {
  mode: "list" | "search";
  items: GroupRow[];
  nextCursor?: string | null;
  cursorReset?: boolean;
  totals: GroupsTotals;
  e2ee: boolean;
}

export type GroupsLoadState =
  | { kind: "ready"; data: GroupsPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

export interface GroupsFilters {
  period: "24h" | "7d" | "30d" | "all";
}

// ── Helpers ──

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return timeFmt.format(new Date(iso));
}

/** Identifiant tronqué (mono) — utile pour mlsGroupId / creatorKey / id. */
function shortKey(k: string, max = 12): string {
  return k.length <= max ? k : `${k.slice(0, max)}…`;
}

export function GroupsView({ initial }: { initial: GroupsLoadState }) {
  const [state, setState] = useState<GroupsLoadState>(initial);
  const [filters, setFilters] = useState<GroupsFilters>({ period: "all" });
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchActive, setSearchActive] = useState(false); // mode recherche ?

  const fetchList = useCallback(
    async (f: GroupsFilters, c: string | null) => {
      setRefreshing(true);
      setSearchActive(false);
      try {
        const qs = new URLSearchParams({ period: f.period });
        if (c) qs.set("cursor", c);
        const res = await apiFetch(`/api/groups?${qs.toString()}`, { cache: "no-store" });
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
        const data = (await res.json()) as GroupsPayload;
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
    if (q.length < 2) {
      setNotice("Recherche : entrez au moins 2 caractères (nom du groupe ou mlsGroupId).");
      return;
    }
    setRefreshing(true);
    setSearchActive(true);
    try {
      const res = await apiFetch(`/api/groups?q=${encodeURIComponent(q)}`, { cache: "no-store" });
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
      const data = (await res.json()) as GroupsPayload;
      if (!data || !Array.isArray(data.items)) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      setNotice(`Recherche « ${q} » — ${data.items.length} groupe(s) (limite 20).`);
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  function changeFilter(patch: Partial<GroupsFilters>) {
    const f = { ...filters, ...patch };
    setFilters(f);
    setCursor(null);
    setNotice(null);
    void fetchList(f, null);
  }

  const t = state.kind === "ready" ? state.data.totals : null;

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — l&apos;annuaire des groupes est indisponible.
                Réessayez après rétablissement de la liaison.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ne permet pas la consultation des groupes
                (support minimum — l&apos;auditor est limité à l&apos;audit, arbitrage §13.1).
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
          {/* ── cartes totals (aperçu GLOBAL, hors filtres) ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Groupes</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{t?.groups ?? 0}</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 shadow-sm">
              <p className="text-xs font-medium text-emerald-700">Membres actifs</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-emerald-900">{t?.members ?? 0}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Messages (ciphertexts)</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{t?.messages ?? 0}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Enveloppes MLS</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{t?.envelopes ?? 0}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Messages 24 h</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">
                {t?.last24hMessages ?? 0}
              </p>
            </div>
          </div>

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
                Recherche (nom ou mlsGroupId)
                <input
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  className="min-h-11 w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                  placeholder="ex. solidarité"
                  aria-label="Recherche par nom de groupe ou identifiant MLS"
                  maxLength={200}
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
              Période (création)
              <select
                value={filters.period}
                onChange={(e) => changeFilter({ period: e.target.value as GroupsFilters["period"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre période de création du groupe"
              >
                <option value="all">tout</option>
                <option value="24h">24 h</option>
                <option value="7d">7 j</option>
                <option value="30d">30 j</option>
              </select>
            </label>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                {state.data.mode === "search"
                  ? `${state.data.items.length} résultat(s)`
                  : `${state.data.items.length} groupe(s) affiché(s)`}
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
                ? "Résultats de recherche — aucun curseur (limite 20)."
                : `Page servie à ${fmt(state.fetchedAt)} — tri : activité décroissante.`)}
          </p>

          {/* ── tableau des groupes ── */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Groupes MLS — shell et métadonnées uniquement (contenus chiffrés E2EE)
              </caption>
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Groupe</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Membres</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Messages</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Enveloppes</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Dernier message</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Créé</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {state.data.items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-sm text-zinc-600">
                      {state.data.mode === "search"
                        ? "Aucun groupe ne correspond à cette recherche."
                        : "Aucun groupe pour ces filtres."}
                    </td>
                  </tr>
                )}
                {state.data.items.map((g) => (
                  <tr key={g.id} className="bg-white transition hover:bg-zinc-50/60">
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-zinc-900">{g.name}</span>
                      <span className="mt-0.5 flex flex-col gap-0.5">
                        <span className="font-mono text-[11px] text-zinc-400" title={g.id}>
                          id {shortKey(g.id)}
                        </span>
                        <span className="font-mono text-[11px] text-zinc-400" title={g.mlsGroupId}>
                          mls {shortKey(g.mlsGroupId)}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-800">
                      <span className="font-semibold text-emerald-800">{g.activeMemberCount}</span>
                      <span className="text-zinc-400"> / {g.memberCount}</span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-800">{g.messageCount}</td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-600">{g.envelopeCount}</td>
                    <td className="px-3 py-2.5 text-zinc-600">{fmt(g.lastMessageAt)}</td>
                    <td className="px-3 py-2.5 text-zinc-600">{fmt(g.createdAt)}</td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/groups/${encodeURIComponent(g.id)}`}
                        className="inline-block min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
                        aria-label={`Ouvrir la fiche du groupe ${g.name}`}
                      >
                        Fiche →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── pagination cursor ── */}
          {state.data.mode === "list" && (
            <div className="flex items-center justify-center gap-3">
              {state.data.nextCursor ? (
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => {
                    const c = state.data.nextCursor ?? null;
                    setCursor(c);
                    void fetchList(filters, c);
                  }}
                  className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
                >
                  {refreshing ? "Chargement…" : "Charger la page suivante"}
                </button>
              ) : (
                <span className="text-xs text-zinc-500">Fin de la liste (20/page).</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
