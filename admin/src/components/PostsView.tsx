"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PostsView — annuaire GLOBAL des contenus publics (back-office 2026-11).
// Instrument, pas vitrine. Différence avec la queue : TOUT le fil public
// (signalé ou non, masqué ou non) — l'admin navigue et agit hors d'un report.
//
// INVARIANT NON NÉGOCIABLE (ADMIN-RBAC.md §1.8) : aucune mutation locale —
// la liste est TOUJOURS remplacée par la réponse authentifiée du serveur.
// Les actions (masquer / démasquer / purge) vivent sur la FICHE du contenu
// (/posts/[id]) — pas ici : la liste reste une surface de lecture.
//
// Recherche : LIKE contenu (serveur, limite 20) — soumise explicitement
// (Entrée ou bouton), jamais pendant la frappe. Liste : cursor keyset
// 20/page (createdAt DESC, id DESC) + filtres statut / type / période.
// Périmètre : fil public UNIQUEMENT — les DM et groupes MLS sont E2EE
// (invariant §1.4 ADMIN-RBAC.md) : aucun contenu privé ne traverse ici.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-base";

export interface PostRow {
  id: string;
  content: string;
  createdAt: string;
  origin: string; // web | mesh
  geohash: string | null;
  likeCount: number;
  replyCount: number;
  parentId: string | null;
  isReply: boolean;
  hiddenAt: string | null;
  authorPubkey: string;
  authorNickname: string;
  openReports: number;
}

export interface PostsPayload {
  mode: "list" | "search";
  items: PostRow[];
  nextCursor?: string | null;
  cursorReset?: boolean;
  total?: number;
  page: { size: number; status: string; kind: string; period: string; author?: string | null; q?: string };
}

export type PostsLoadState =
  | { kind: "ready"; data: PostsPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

export interface PostsFilters {
  status: "all" | "visible" | "hidden" | "reported";
  kind: "all" | "post" | "comment";
  period: "24h" | "7d" | "30d" | "all";
}

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

/** Snippet d'affichage liste (le détail affiche le contenu intégral). */
function snippet(content: string, max = 60): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function PostsView({ initial }: { initial: PostsLoadState }) {
  const [state, setState] = useState<PostsLoadState>(initial);
  const [filters, setFilters] = useState<PostsFilters>({ status: "all", kind: "all", period: "all" });
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchActive, setSearchActive] = useState(false); // mode recherche ?

  const fetchList = useCallback(
    async (f: PostsFilters, c: string | null) => {
      setRefreshing(true);
      setSearchActive(false);
      try {
        const qs = new URLSearchParams({ status: f.status, kind: f.kind, period: f.period });
        if (c) qs.set("cursor", c);
        const res = await apiFetch(`/api/posts?${qs.toString()}`, { cache: "no-store" });
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
        const data = (await res.json()) as PostsPayload;
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
      setNotice("Recherche vide — entrez un texte (la liste complète reprend au filtre ci-dessous).");
      return;
    }
    setRefreshing(true);
    setSearchActive(true);
    try {
      const res = await apiFetch(`/api/posts?q=${encodeURIComponent(q)}`, { cache: "no-store" });
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
      const data = (await res.json()) as PostsPayload;
      if (!data || !Array.isArray(data.items)) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      setNotice(`Recherche « ${q} » — ${data.items.length} résultat(s) (limite 20).`);
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  function changeFilter(patch: Partial<PostsFilters>) {
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
                L&apos;app principale ne répond pas — l&apos;annuaire des contenus est indisponible.
                Réessayez après rétablissement de la liaison.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ne permet pas la consultation des contenus
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
                Recherche par texte
                <input
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  className="min-h-11 w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                  placeholder="ex. solidarité"
                  aria-label="Recherche par texte du contenu"
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
                onChange={(e) => changeFilter({ status: e.target.value as PostsFilters["status"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre statut du contenu"
              >
                <option value="all">tous</option>
                <option value="visible">visibles</option>
                <option value="hidden">masqués</option>
                <option value="reported">signalés (ouverts)</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Type
              <select
                value={filters.kind}
                onChange={(e) => changeFilter({ kind: e.target.value as PostsFilters["kind"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre type de contenu"
              >
                <option value="all">tous</option>
                <option value="post">publications</option>
                <option value="comment">commentaires</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Période
              <select
                value={filters.period}
                onChange={(e) => changeFilter({ period: e.target.value as PostsFilters["period"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre période de publication"
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
                  : `${state.data.items.length} contenu(s) affiché(s)`}
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
                : `Page servie à ${fmt(state.fetchedAt)} — tri : publication décroissante.`)}
          </p>

          {/* ── liste des contenus ── */}
          <div className="flex flex-col gap-3">
            {state.data.items.length === 0 && (
              <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-600">
                {state.data.mode === "search"
                  ? "Aucun contenu ne correspond à cette recherche."
                  : "Aucun contenu pour ces filtres."}
              </div>
            )}
            {state.data.items.map((p) => (
              <article
                key={p.id}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition hover:bg-zinc-50/60"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-zinc-900">{p.authorNickname}</span>
                  <span className="font-mono text-zinc-400" title={p.authorPubkey}>
                    {p.authorPubkey.slice(0, 10)}…
                  </span>
                  <span className="text-zinc-500">{fmt(p.createdAt)}</span>
                  {p.isReply && (
                    <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 font-medium text-zinc-600">
                      commentaire
                    </span>
                  )}
                  {p.origin === "mesh" && (
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                      mesh
                    </span>
                  )}
                  {p.hiddenAt && (
                    <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 font-medium text-red-800">
                      masqué
                    </span>
                  )}
                  {p.openReports > 0 && (
                    <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 font-medium text-red-800">
                      {p.openReports} signalement{p.openReports > 1 ? "s" : ""}
                    </span>
                  )}
                  <span className="text-zinc-500">
                    {p.likeCount} j&apos;aime · {p.replyCount} réponse{p.replyCount > 1 ? "s" : ""}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-800">
                  {snippet(p.content, 160)}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-zinc-400">
                    {p.geohash ? `canal ${p.geohash}` : ""}
                  </span>
                  <Link
                    href={`/posts/${encodeURIComponent(p.id)}`}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
                  >
                    Voir / agir →
                  </Link>
                </div>
              </article>
            ))}
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
