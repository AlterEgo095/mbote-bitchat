"use client";

// ─────────────────────────────────────────────────────────────────────────────
// NetworkView — graphe SOCIAL (suivis, crédits) READ-ONLY (back-office 2026-11).
//
// AUCUN bouton d'action : cette vue constate, elle n'agit pas. Elle expose le
// graphe de suivis (total, paires mutuelles, top suivis) et les soldes de
// crédits — des MÉTADONNÉES sociales uniquement : les contenus eux-mêmes
// restent hors de portée (publics → /posts, privés → E2EE, invariant §1.4).
//
// Zéro mutation locale : le bouton « Rafraîchir » remplace l'état par la
// réponse authentifiée du serveur (invariant §1.8). Barres proportionnelles
// calculées à partir des données servies (rendu déterministe, pur).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { fmtDate, fmtNum, shortKey } from "@/lib/admin-format";

// ── types du contrat backend (aucun any) ─────────────────────────────────────

export interface FollowTopRow {
  pubkey: string;
  nickname: string | null;
  followers: number;
}

export interface FollowRecentRow {
  followerKey: string;
  followerNickname: string | null;
  followingKey: string;
  followingNickname: string | null;
  createdAt: string;
}

export interface NetworkPayload {
  follow: {
    total: number;
    mutualPairs: number;
    last24h: number;
    topFollowed: FollowTopRow[];
    recent: FollowRecentRow[];
  };
  credits: { total: number; sum: number };
  e2ee: boolean;
}

export type NetworkLoadState =
  | { kind: "ready"; data: NetworkPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

/** Nom affiché : nickname si connu, sinon extrait court de la clé. */
function displayName(nickname: string | null, key: string): string {
  if (nickname && nickname.trim().length > 0) return nickname;
  return shortKey(key);
}

export function NetworkView({ initial }: { initial: NetworkLoadState }) {
  const [state, setState] = useState<NetworkLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch("/api/network", { cache: "no-store" });
      if (res.status === 502) {
        setNotice("Backend injoignable — données non rafraîchies, réessayez.");
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
        setNotice(`Erreur HTTP ${res.status} — données non rafraîchies.`);
        return;
      }
      const data = (await res.json()) as NetworkPayload;
      if (!data || !data.follow || !data.credits) {
        setNotice("Réponse inattendue du serveur — données non rafraîchies.");
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      setNotice(null);
    } catch {
      setNotice("Backend injoignable — données non rafraîchies, réessayez.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const maxFollowers =
    state.kind === "ready"
      ? state.data.follow.topFollowed.reduce((m, t) => Math.max(m, t.followers), 0)
      : 0;

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — la vue Réseau social est indisponible.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ne permet pas la consultation du graphe social
                (support minimum — l&apos;auditor est limité à l&apos;audit).
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
          {/* ── cartes de synthèse ── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Liens de suivi
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">
                {fmtNum(state.data.follow.total)}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">
                Paires mutuelles
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-900">
                {fmtNum(state.data.follow.mutualPairs)}
              </p>
              <p className="text-xs text-emerald-700">abonnement réciproque (A↔B)</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
                Nouveaux suivis (24 h)
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-amber-900">
                {fmtNum(state.data.follow.last24h)}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Crédits (comptes · somme)
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">
                {fmtNum(state.data.credits.total)}
              </p>
              <p className="text-xs tabular-nums text-zinc-500">
                somme : {fmtNum(state.data.credits.sum)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-zinc-500" aria-live="polite">
              {notice ??
                `Instantané servi à ${fmtDate(state.fetchedAt)} — lecture seule, aucune action depuis cette vue.`}
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={refreshing}
              className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
            >
              {refreshing ? "Chargement…" : "Rafraîchir"}
            </button>
          </div>

          {/* ── top suivis ── */}
          <section aria-labelledby="net-top-heading" className="flex flex-col gap-2">
            <h2 id="net-top-heading" className="text-sm font-semibold text-zinc-900">
              Comptes les plus suivis (10 premiers)
            </h2>
            <p className="text-xs text-zinc-500">
              Indicateur d&apos;influence : barre proportionnelle au compte le plus
              suivi de l&apos;instantané — repère les comptes à surveiller (usurpation,
              spam à grande échelle).
            </p>
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <ul className="flex flex-col divide-y divide-zinc-100">
                {state.data.follow.topFollowed.length === 0 && (
                  <li className="p-6 text-center text-sm text-zinc-600">
                    Aucun lien de suivi enregistré.
                  </li>
                )}
                {state.data.follow.topFollowed.map((t) => {
                  const pct =
                    maxFollowers > 0 ? Math.max(2, Math.round((t.followers / maxFollowers) * 100)) : 0;
                  return (
                    <li key={t.pubkey} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex w-full max-w-xs flex-wrap items-baseline gap-2 sm:w-64 sm:flex-nowrap">
                        <span className="truncate text-sm font-medium text-zinc-900">
                          {displayName(t.nickname, t.pubkey)}
                        </span>
                        <span
                          className="shrink-0 font-mono text-xs text-zinc-400"
                          title={t.pubkey}
                        >
                          {shortKey(t.pubkey, 6, 4)}
                        </span>
                      </div>
                      <div
                        className="h-3 flex-1 overflow-hidden rounded-full bg-zinc-100"
                        role="img"
                        aria-label={`${t.nickname ?? shortKey(t.pubkey)} : ${fmtNum(t.followers)} abonné(s)`}
                      >
                        <div
                          className="h-full rounded-full bg-zinc-800"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-zinc-600">
                        {fmtNum(t.followers)} abonné{t.followers > 1 ? "s" : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          {/* ── suivis récents ── */}
          <section aria-labelledby="net-recent-heading" className="flex flex-col gap-2">
            <h2 id="net-recent-heading" className="text-sm font-semibold text-zinc-900">
              Suivis récents (10 derniers)
            </h2>
            <p className="text-xs text-zinc-500">
              Graphe d&apos;arrivée : qui suit qui, nicknames quand ils sont
              connus du serveur — le contenu partagé reste hors de cette vue.
            </p>
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <ul className="flex flex-col divide-y divide-zinc-100">
                {state.data.follow.recent.length === 0 && (
                  <li className="p-6 text-center text-sm text-zinc-600">
                    Aucun suivi récent.
                  </li>
                )}
                {state.data.follow.recent.map((r) => (
                  <li key={`${r.followerKey}:${r.followingKey}:${r.createdAt}`} className="p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-zinc-900">
                        {displayName(r.followerNickname, r.followerKey)}
                      </span>
                      <span
                        className="font-mono text-xs text-zinc-400"
                        title={r.followerKey}
                      >
                        {shortKey(r.followerKey)}
                      </span>
                      <span aria-hidden="true" className="text-zinc-400">
                        →
                      </span>
                      <span className="font-medium text-zinc-900">
                        {displayName(r.followingNickname, r.followingKey)}
                      </span>
                      <span
                        className="font-mono text-xs text-zinc-400"
                        title={r.followingKey}
                      >
                        {shortKey(r.followingKey)}
                      </span>
                      <span className="text-xs text-zinc-500">{fmtDate(r.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
