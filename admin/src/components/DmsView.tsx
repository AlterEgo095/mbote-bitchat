"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DmsView — annuaire des paires DM (back-office 2026-11, MÉTADONNÉES ONLY).
//
// INVARIANT NON NÉGOCIABLE (ADMIN-RBAC §1.4) : les DM sont chiffrés E2EE côté
// client — le serveur ne stocke QUE du chiffré opaque. Cette vue n'affiche
// DONC AUCUN contenu : uniquement des métadonnées par paire (« qui parle à
// qui, combien, quand ») puis, au clic, la liste des ENVELOPPES de la paire
// (direction, taille, état lu) — jamais l'iv, jamais le ciphertext. Le bandeau
// E2EE rendu au-dessus de la liste est un rappel permanent de ce périmètre.
//
// INVARIANT §1.8 : aucune mutation locale — la liste est TOUJOURS remplacée
// par la réponse authentifiée du serveur (pagination cursor keyset 20/page,
// garde de vue cursorReset → retour page 1 signalé).
//
// Recherche : fragment de pubkey (≥ 3 caractères, LIKE serveur, limite 20) —
// soumise explicitement (Entrée ou bouton), jamais pendant la frappe.
// Purge : JAMAIS en direct — intention four-eyes É9 POST /api/pending-actions
// {actionType:"purge_dm_pair"} — super-admin UNIQUEMENT (bouton gated par
// rôle, ré-imposé côté serveur), approbation par un second admin distinct.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api-base";

// ── Catégories de justification §6 (enum fermé, miroir app principale) ──
const CATEGORIES = ["SPAM", "HARASSMENT", "SCAM", "CSAM", "OTHER"] as const;
type PurgeCategory = (typeof CATEGORIES)[number];

// ── Types (contrats backend /api/internal/admin/dms*) ──

export interface DmPairRow {
  pair: string;
  keyA: string;
  keyB: string;
  messageCount: number;
  unreadCount: number;
  bytes: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  legacyCount: number;
}

export interface DmsTotals {
  pairs: number;
  messages: number;
  unread: number;
  bytes: number;
  last24h: number;
}

export interface DmsPayload {
  mode: "list" | "search";
  items: DmPairRow[];
  nextCursor?: string | null;
  cursorReset?: boolean;
  /** mode search uniquement (limite 20, pas de cursor). */
  total?: number;
  totals: DmsTotals;
  e2ee: boolean;
  page: { size: number; status: string; period: string; q?: string | null };
}

export type DmsLoadState =
  | { kind: "ready"; data: DmsPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

export interface DmsFilters {
  status: "all" | "unread";
  period: "24h" | "7d" | "30d" | "all";
}

export interface DmMessageRow {
  id: string;
  senderKey: string;
  recipientKey: string;
  direction: "a_to_b" | "b_to_a";
  msgId: string | null;
  seq: number | null;
  legacy: boolean;
  createdAt: string;
  readAt: string | null;
  bytes: number;
}

export interface DmMessagesPayload {
  pair: { keyA: string; keyB: string };
  items: DmMessageRow[];
  nextCursor?: string | null;
  cursorReset?: boolean;
  pairTotals: { messages: number; unread: number; bytes: number; legacy: number };
  e2ee: boolean;
}

export type DmMessagesLoadState =
  | { kind: "ready"; data: DmMessagesPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

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

/** Taille de ciphertext LISIBLE — affichage de compteur, jamais de contenu. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} Go`;
}

/** Clé publique tronquée (mono) — identifiant, pas un secret exploitable. */
function shortKey(k: string, max = 12): string {
  return k.length <= max ? k : `${k.slice(0, max)}…`;
}

const ERROR_PANEL_CLASS =
  "rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800";

function ErrorPanel({ code, httpStatus }: { code: string; httpStatus?: number }) {
  return (
    <div role="alert" className={ERROR_PANEL_CLASS}>
      {code === "backend-unreachable" && (
        <>
          <p className="font-semibold">Backend injoignable</p>
          <p className="mt-1">
            L&apos;app principale ne répond pas — l&apos;annuaire des DM est indisponible.
            Réessayez après rétablissement de la liaison.
          </p>
        </>
      )}
      {code === "forbidden" && (
        <>
          <p className="font-semibold">Accès refusé</p>
          <p className="mt-1">
            Votre rôle ne permet pas la consultation des métadonnées DM
            (support minimum — l&apos;auditor est limité à l&apos;audit, arbitrage §13.1).
          </p>
        </>
      )}
      {code === "unauthorized" && (
        <>
          <p className="font-semibold">Session expirée</p>
          <p className="mt-1">Reconnectez-vous depuis la page d&apos;authentification.</p>
        </>
      )}
      {code === "http" && (
        <>
          <p className="font-semibold">Erreur inattendue</p>
          <p className="mt-1">HTTP {httpStatus} — réessayez.</p>
        </>
      )}
    </div>
  );
}

// ── Composant ──

export function DmsView({
  role,
  csrfToken,
  initial,
}: {
  role: string;
  csrfToken: string;
  initial: DmsLoadState;
}) {
  const [state, setState] = useState<DmsLoadState>(initial);
  const [filters, setFilters] = useState<DmsFilters>({ status: "all", period: "all" });
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchActive, setSearchActive] = useState(false); // mode recherche ?
  const [detail, setDetail] = useState<{ pair: string; state: DmMessagesLoadState } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // four-eyes : formulaire de justification pour la paire ouverte (super-admin)
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeText, setPurgeText] = useState("");
  const [purgeCategory, setPurgeCategory] = useState<PurgeCategory>("SPAM");
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeSuccess, setPurgeSuccess] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  const canFourEyes = role === "super-admin";

  const fetchList = useCallback(
    async (f: DmsFilters, c: string | null) => {
      setRefreshing(true);
      setSearchActive(false);
      try {
        const qs = new URLSearchParams({ status: f.status, period: f.period });
        if (c) qs.set("cursor", c);
        const res = await apiFetch(`/api/dms?${qs.toString()}`, { cache: "no-store" });
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
        const data = (await res.json()) as DmsPayload;
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
    if (q.length < 3) {
      setNotice("Recherche : entrez un fragment de clé publique (≥ 3 caractères).");
      return;
    }
    setRefreshing(true);
    setSearchActive(true);
    try {
      const res = await apiFetch(`/api/dms?q=${encodeURIComponent(q)}`, { cache: "no-store" });
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
      const data = (await res.json()) as DmsPayload;
      if (!data || !Array.isArray(data.items)) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      setNotice(
        `Recherche « ${q} » — ${typeof data.total === "number" ? data.total : data.items.length} paire(s) (limite 20).`
      );
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  function changeFilter(patch: Partial<DmsFilters>) {
    const f = { ...filters, ...patch };
    setFilters(f);
    setCursor(null);
    setNotice(null);
    void fetchList(f, null);
  }

  // ── Détail d'une paire (inline) — enveloppes, métadonnées uniquement ──

  const fetchMessages = useCallback(async (pair: string, c: string | null, append: boolean) => {
    setDetailLoading(true);
    try {
      const qs = new URLSearchParams({ pair });
      if (c) qs.set("cursor", c);
      const res = await apiFetch(`/api/dms/messages?${qs.toString()}`, { cache: "no-store" });
      if (res.status === 401) {
        setDetail({ pair, state: { kind: "error", code: "unauthorized", httpStatus: res.status } });
        return;
      }
      if (res.status === 403) {
        setDetail({ pair, state: { kind: "error", code: "forbidden", httpStatus: res.status } });
        return;
      }
      if (res.status === 502) {
        setDetail({ pair, state: { kind: "error", code: "backend-unreachable", httpStatus: res.status } });
        return;
      }
      if (!res.ok) {
        setDetail({ pair, state: { kind: "error", code: "http", httpStatus: res.status } });
        return;
      }
      const data = (await res.json()) as DmMessagesPayload;
      if (!data || !Array.isArray(data.items)) {
        setDetail({ pair, state: { kind: "error", code: "http", httpStatus: res.status } });
        return;
      }
      setDetail((prev) => {
        const prevState =
          append && prev && prev.pair === pair && prev.state.kind === "ready" ? prev.state : null;
        const merged: DmMessagesPayload = prevState
          ? {
              ...data,
              items: [...prevState.data.items, ...data.items],
              // le curseur SUIVANT vient toujours de la dernière réponse
            }
          : data;
        return {
          pair,
          state: { kind: "ready", data: merged, fetchedAt: new Date().toISOString() },
        };
      });
      if (data.cursorReset) {
        setNotice("La conversation a changé depuis votre dernière page — retour au début.");
      }
    } catch {
      setDetail({ pair, state: { kind: "error", code: "backend-unreachable" } });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function openDetail(row: DmPairRow) {
    setPurgeSuccess(null);
    setPurgeError(null);
    setPurgeOpen(false);
    setDetail({ pair: row.pair, state: { kind: "error", code: "http" } });
    void fetchMessages(row.pair, null, false);
  }

  // ── Four-eyes : intention de purge de la paire (super-admin uniquement) ──

  async function submitPurge() {
    if (!detail) return;
    setPurging(true);
    setPurgeError(null);
    try {
      const res = await apiFetch("/api/pending-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify({
          actionType: "purge_dm_pair",
          targetId: detail.pair,
          category: purgeCategory,
          justification: purgeText.trim(),
        }),
      });
      const respBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        pendingAction?: { id: number; expiresAt: string; status: string };
      };
      if ((res.status === 200 || res.status === 201) && respBody.pendingAction) {
        setPurgeSuccess(
          `Intention de purge #${respBody.pendingAction.id} CRÉÉE (four-eyes) — statut ${respBody.pendingAction.status}, expires ${fmt(respBody.pendingAction.expiresAt)}. Elle attend l'approbation d'un SECOND admin distinct (page Four-eyes) ; les ciphertexts de la paire restent en base jusqu'à exécution.`
        );
        setPurgeOpen(false);
        setPurgeText("");
        return;
      }
      // erreurs backend affichées VERBATIM (400 / 404 / 409 / 422 / 5xx)
      setPurgeError(respBody.error ?? `Erreur HTTP ${res.status} — réessayez.`);
    } catch {
      setPurgeError("Backend injoignable — intention non créée, réessayez.");
    } finally {
      setPurging(false);
    }
  }

  const t = state.kind === "ready" ? state.data.totals : null;

  return (
    <div className="flex flex-col gap-4">
      {/* ── BANDEAU E2EE — rappel permanent du périmètre (invariant §1.4) ── */}
      <div
        role="note"
        className="rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-3 text-sm font-medium text-zinc-800"
      >
        Chiffré E2EE — l&apos;admin ne voit <strong>AUCUN contenu</strong>, uniquement
        des métadonnées (invariant §1.4). Les messages restent illisibles côté
        serveur : cette vue ne transporte ni l&apos;iv ni le ciphertext.
      </div>

      {state.kind === "error" && <ErrorPanel code={state.code} httpStatus={state.httpStatus} />}

      {state.kind === "ready" && (
        <>
          {/* ── cartes totals (aperçu GLOBAL, hors filtres) ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Paires DM</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{t?.pairs ?? 0}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Messages (ciphertexts)</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{t?.messages ?? 0}</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 shadow-sm">
              <p className="text-xs font-medium text-amber-700">Non-lus</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-amber-900">{t?.unread ?? 0}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Octets chiffrés</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">
                {t ? fmtBytes(t.bytes) : "0 o"}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-medium text-zinc-500">Dernières 24 h</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{t?.last24h ?? 0}</p>
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
                Recherche par fragment de clé
                <input
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  className="min-h-11 w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm text-zinc-800"
                  placeholder="fragment de pubkey (≥ 3 car.)"
                  aria-label="Recherche par fragment de clé publique dans les paires DM"
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
              Statut
              <select
                value={filters.status}
                onChange={(e) => changeFilter({ status: e.target.value as DmsFilters["status"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre statut des paires DM"
              >
                <option value="all">toutes</option>
                <option value="unread">avec non-lus</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Période
              <select
                value={filters.period}
                onChange={(e) => changeFilter({ period: e.target.value as DmsFilters["period"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre période d'activité des paires DM"
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
                  ? `${typeof state.data.total === "number" ? state.data.total : state.data.items.length} résultat(s)`
                  : `${state.data.items.length} paire(s) affichée(s)`}
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
                : `Page servie à ${fmt(state.fetchedAt)} — tri : dernier message décroissant.`)}
          </p>

          {/* ── tableau des paires ── */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Paires DM — métadonnées uniquement (compteurs, tailles chiffrées, timestamps)
              </caption>
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Paire</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Messages</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Non-lus</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Octets</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Dernier message</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {state.data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-sm text-zinc-600">
                      {state.data.mode === "search"
                        ? "Aucune paire ne correspond à cette recherche."
                        : "Aucune paire DM pour ces filtres."}
                    </td>
                  </tr>
                )}
                {state.data.items.map((row) => (
                  <tr
                    key={row.pair}
                    className={
                      detail?.pair === row.pair
                        ? "bg-zinc-50/80"
                        : "bg-white transition hover:bg-zinc-50/60"
                    }
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs text-zinc-800" title={row.pair}>
                        {shortKey(row.keyA)} ⇄ {shortKey(row.keyB)}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
                          E2EE — métadonnées
                        </span>
                        {row.legacyCount > 0 && (
                          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            {row.legacyCount} legacy
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-800">{row.messageCount}</td>
                    <td className="px-3 py-2.5">
                      {row.unreadCount > 0 ? (
                        <span className="inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-800">
                          {row.unreadCount}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-600">{fmtBytes(row.bytes)}</td>
                    <td className="px-3 py-2.5 text-zinc-600">{fmt(row.lastMessageAt)}</td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => openDetail(row)}
                        className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
                        aria-expanded={detail?.pair === row.pair}
                        aria-label={`Ouvrir le détail des enveloppes de la paire ${row.pair}`}
                      >
                        {detail?.pair === row.pair ? "Masquer le détail" : "Détail →"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── pagination cursor de la LISTE ── */}
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

          {/* ── détail inline de la paire sélectionnée ── */}
          {detail && (
            <section
              aria-labelledby="dm-pair-detail-heading"
              className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 id="dm-pair-detail-heading" className="text-sm font-semibold text-zinc-900">
                    Enveloppes de la paire
                  </h3>
                  <p className="mt-1 break-all font-mono text-xs text-zinc-600" title={detail.pair}>
                    {detail.pair}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDetail(null);
                    setPurgeOpen(false);
                    setPurgeSuccess(null);
                    setPurgeError(null);
                  }}
                  className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
                  aria-label="Fermer le détail de la paire"
                >
                  Fermer ✕
                </button>
              </div>

              {detail.state.kind === "error" && (
                <div className="mt-3">
                  <ErrorPanel code={detail.state.code} httpStatus={detail.state.httpStatus} />
                </div>
              )}

              {detail.state.kind === "ready" && (
                <>
                  {/* ── pairTotals ── */}
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5">
                      <p className="text-xs text-zinc-500">Messages</p>
                      <p className="text-base font-semibold tabular-nums text-zinc-900">
                        {detail.state.data.pairTotals.messages}
                      </p>
                    </div>
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5">
                      <p className="text-xs text-amber-700">Non-lus</p>
                      <p className="text-base font-semibold tabular-nums text-amber-900">
                        {detail.state.data.pairTotals.unread}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5">
                      <p className="text-xs text-zinc-500">Octets chiffrés</p>
                      <p className="text-base font-semibold tabular-nums text-zinc-900">
                        {fmtBytes(detail.state.data.pairTotals.bytes)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5">
                      <p className="text-xs text-zinc-500">Legacy (pré-A1)</p>
                      <p className="text-base font-semibold tabular-nums text-zinc-900">
                        {detail.state.data.pairTotals.legacy}
                      </p>
                    </div>
                  </div>

                  {/* ── purge four-eyes (super-admin UNIQUEMENT) ── */}
                  <div className="mt-3">
                    {canFourEyes ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPurgeOpen((v) => !v);
                          setPurgeError(null);
                        }}
                        className="min-h-11 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100"
                      >
                        Purger la paire (four-eyes)
                      </button>
                    ) : (
                      <span className="inline-flex items-center text-xs text-zinc-500">
                        purge : réservée super-admin via four-eyes (É9)
                      </span>
                    )}
                    {purgeSuccess && (
                      <p
                        className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"
                        role="status"
                      >
                        {purgeSuccess}
                      </p>
                    )}
                    {purgeOpen && canFourEyes && (
                      <div className="mt-2 rounded-md border border-zinc-300 bg-zinc-50 p-3">
                        <p className="text-xs font-semibold text-zinc-700">
                          Purge de la paire — justification obligatoire (ADMIN-RBAC §6)
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Action IRRÉVERSIBLE sous four-eyes : destruction des ciphertexts de la
                          paire (jamais exécutée avant l&apos;approbation d&apos;un second admin
                          distinct, dans l&apos;heure).
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <label className="grid gap-1 text-xs text-zinc-600">
                            Catégorie
                            <select
                              value={purgeCategory}
                              onChange={(e) => setPurgeCategory(e.target.value as PurgeCategory)}
                              className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              aria-label="Catégorie de justification de la purge de la paire"
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <textarea
                          value={purgeText}
                          onChange={(e) => setPurgeText(e.target.value)}
                          rows={3}
                          maxLength={500}
                          placeholder="Justification (≥ 20 caractères) — figée dans l'intention four-eyes"
                          className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
                          aria-label="Texte de justification de la purge de la paire"
                        />
                        {purgeError && (
                          <p className="mt-1 text-sm text-red-700" role="alert">
                            {purgeError}
                          </p>
                        )}
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void submitPurge()}
                            disabled={purging || purgeText.trim().length < 20}
                            className="min-h-11 rounded-md bg-red-900 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {purging ? "Envoi…" : "Créer l'intention (attend le serveur)"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPurgeOpen(false);
                              setPurgeError(null);
                              setPurgeText("");
                            }}
                            disabled={purging}
                            className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                          >
                            Annuler
                          </button>
                          <span className="text-xs text-zinc-500">{purgeText.trim().length}/20 min</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── liste des enveloppes (métadonnées uniquement) ── */}
                  <p className="mt-4 text-xs text-zinc-500" aria-live="polite">
                    {detailLoading
                      ? "Chargement des enveloppes…"
                      : `Enveloppes servies à ${fmt(detail.state.fetchedAt)} — ${detail.state.data.items.length} affichée(s).`}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {detail.state.data.items.length === 0 && (
                      <li className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
                        Aucune enveloppe pour cette paire.
                      </li>
                    )}
                    {detail.state.data.items.map((m) => (
                      <li
                        key={m.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs"
                      >
                        {/* direction : expéditeur → destinataire (clés tronquées) */}
                        <span className="font-mono text-zinc-700">
                          {shortKey(m.senderKey)} → {shortKey(m.recipientKey)}
                        </span>
                        {/* état lu / non-lu — point coloré (ambre = non-lu) */}
                        {m.readAt ? (
                          <span
                            className="inline-flex items-center gap-1 text-emerald-700"
                            aria-label="lu"
                            title={`lu ${fmt(m.readAt)}`}
                          >
                            <span aria-hidden="true" className="text-emerald-600">●</span> lu
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 font-medium text-amber-800"
                            aria-label="non lu"
                          >
                            <span aria-hidden="true" className="text-amber-500">●</span> non-lu
                          </span>
                        )}
                        <span className="text-zinc-500">{fmt(m.createdAt)}</span>
                        <span className="tabular-nums text-zinc-500">{fmtBytes(m.bytes)}</span>
                        <span className="ml-auto flex items-center gap-2">
                          {m.legacy || m.msgId === null ? (
                            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                              legacy
                            </span>
                          ) : (
                            <span className="font-mono text-zinc-400" title={m.msgId ?? undefined}>
                              msg {shortKey(m.msgId)}
                              {m.seq !== null ? ` · seq ${m.seq}` : ""}
                            </span>
                          )}
                          <span className="font-mono text-zinc-300" title={m.id}>
                            #{shortKey(m.id, 8)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* ── pagination cursor du détail ── */}
                  {detail.state.data.nextCursor ? (
                    <div className="mt-3 flex justify-center">
                      <button
                        type="button"
                        disabled={detailLoading}
                        onClick={() => {
                          const c = detail.state.kind === "ready" ? detail.state.data.nextCursor ?? null : null;
                          void fetchMessages(detail.pair, c, true);
                        }}
                        className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {detailLoading ? "Chargement…" : "Charger plus d'enveloppes"}
                      </button>
                    </div>
                  ) : (
                    detail.state.data.items.length > 0 && (
                      <p className="mt-2 text-center text-xs text-zinc-500">
                        Fin de la liste des enveloppes.
                      </p>
                    )
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
