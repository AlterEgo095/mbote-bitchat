"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PendingActionsView — file des intentions four-eyes (ADM Étape 9).
//
// INVARIANT §1.8 : les boutons « Approuver » / « Annuler » attendent la
// réponse serveur (2xx OU erreur) puis la liste est REJETÉE depuis la réponse
// authentifiée — aucun état local déduit, aucune ligne retirée avant 2xx.
//
// TIMEOUT VISUEL (tranché) : expiré = évalué PARESSEUSEMENT — le backend
// marque `expired` (audité) au premier GET qui constate le dépassement, et
// l'UI grise déjà localement toute ligne dont expiresAt < now (le rejeu du
// GET la fait disparaître du statut pending). Pas de cron séparé.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-base";

export interface PendingActionItem {
  id: number;
  actionType: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown> | null;
  justification: string;
  status: string;
  requestedBy: { id: number; email: string };
  approvedBy: { id: number; email: string } | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  canApprove: boolean;
  canCancel: boolean;
  expiredNow: boolean;
}

export type PendingLoadState =
  | { kind: "ready"; items: PendingActionItem[]; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

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
  hour: "2-digit",
  minute: "2-digit",
});

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return timeFmt.format(new Date(iso));
}

/** « expire dans 42 min » — le compte à rebours visuel de l'intention. */
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expirée";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `expire dans ${mins} min`;
  return `expire dans ${Math.floor(mins / 60)} h ${mins % 60} min`;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "border-amber-300 bg-amber-50 text-amber-800",
  executed: "border-emerald-300 bg-emerald-50 text-emerald-800",
  cancelled: "border-zinc-300 bg-zinc-50 text-zinc-600",
  expired: "border-zinc-300 bg-zinc-100 text-zinc-500",
};

export function PendingActionsView({
  role,
  myEmail,
  csrfToken,
  initial,
}: {
  role: string;
  /** F #72 — email de la session courante (donnée serveur vérifiée, passée
   *  par la page) : la branche « Vous êtes le demandeur » compare désormais
   *  une identité à une identité (l'ancien code comparait email === rôle —
   *  branche inatteignable, diagnostic faux). */
  myEmail: string | null;
  csrfToken: string;
  initial: PendingLoadState;
}) {
  const [state, setState] = useState<PendingLoadState>(initial);
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const level = ROLE_LEVEL[role] ?? 0;
  const isSuperAdmin = level >= ROLE_LEVEL["super-admin"];

  const refetch = useCallback(async () => {
    try {
      const res = await apiFetch("/api/pending-actions", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setState({ kind: "error", code: res.status === 403 ? "forbidden" : "unauthorized" });
        return;
      }
      if (res.status === 502) {
        setState({ kind: "error", code: "backend-unreachable" });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      const data = (await res.json()) as { items: PendingActionItem[] };
      setState({ kind: "ready", items: data.items ?? [], fetchedAt: new Date().toISOString() });
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    }
  }, []);

  /** Approuver (second admin distinct) — invariant §1.8 : attendre le serveur. */
  async function approve(id: number) {
    setActing(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/pending-actions/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 200) {
        setNotice(`Intention #${id} approuvée — action exécutée et auditée (cycle four-eyes complet).`);
      } else if (res.status === 410) {
        setActionError(body.error ?? "Intention expirée (1 h) — elle ne peut plus être approuvée.");
      } else if (res.status === 403) {
        setActionError("Refusé (403) — auto-approbation impossible ou rôle insuffisant.");
      } else if (res.status === 409) {
        setActionError(body.error ?? "Intention déjà traitée.");
      } else if (res.status === 502) {
        setActionError("Backend injoignable — rien n'a été exécuté.");
      } else {
        setActionError(body.error ?? `Erreur HTTP ${res.status}.`);
      }
      await refetch(); // refus OU succès : la liste suit le serveur
    } catch {
      setActionError("App principale injoignable — rien n'a été exécuté.");
      await refetch();
    } finally {
      setActing(false);
    }
  }

  /** Annuler (demandeur uniquement) — invariant §1.8. */
  async function cancel(id: number) {
    setActing(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/pending-actions/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 200) {
        setNotice(`Intention #${id} annulée — aucune mutation exécutée.`);
      } else if (res.status === 410) {
        setActionError(body.error ?? "Intention expirée — annulation impossible.");
      } else if (res.status === 403) {
        setActionError("Refusé (403) — seul le demandeur peut annuler.");
      } else if (res.status === 502) {
        setActionError("Backend injoignable — annulation non appliquée.");
      } else {
        setActionError(body.error ?? `Erreur HTTP ${res.status}.`);
      }
      await refetch();
    } catch {
      setActionError("App principale injoignable — annulation non appliquée.");
      await refetch();
    } finally {
      setActing(false);
    }
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
        {state.code === "forbidden" && (
          <>
            <p className="font-semibold">Accès refusé</p>
            <p className="mt-1">
              Votre rôle ({role}) ne permet pas de voir la file four-eyes
              (moderator minimum — support/auditor exclus, testé E9·RBAC).
            </p>
          </>
        )}
        {state.code === "unauthorized" && (
          <>
            <p className="font-semibold">Session expirée</p>
            <p className="mt-1">Reconnectez-vous depuis la page d&apos;authentification.</p>
          </>
        )}
        {state.code === "backend-unreachable" && (
          <>
            <p className="font-semibold">Backend injoignable</p>
            <p className="mt-1">L&apos;app principale ne répond pas — file indisponible.</p>
          </>
        )}
        {state.code === "http" && (
          <>
            <p className="font-semibold">Erreur inattendue</p>
            <p className="mt-1">HTTP {state.httpStatus} — réessayez.</p>
          </>
        )}
      </div>
    );
  }

  const pending = state.items.filter((i) => i.status === "pending");
  const other = state.items.filter((i) => i.status !== "pending");

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900" data-testid="pending-title">
            Intentions en attente d&apos;approbation ({pending.length})
          </h2>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={acting}
            className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            data-testid="btn-refresh-pending"
          >
            Rafraîchir (serveur)
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Four-eyes (É9) : ban définitif et purge exigent un DEMANDEUR + un
          APPROBATEUR distincts (super-admin, session distincte), dans l&apos;heure.
          Toute la chaîne est audité — le cycle nominal écrit 2 lignes AdminAudit
          (request + execute).
        </p>
        <p className="mt-2 text-xs text-zinc-500" aria-live="polite" data-testid="pending-notice">
          {notice ?? `File servie à ${fmt(state.fetchedAt)} — invariant §1.8 : aucun bouton n'agit avant la réponse serveur.`}
        </p>
        {actionError && (
          <p className="mt-2 text-xs font-medium text-red-700" role="alert" data-testid="pending-action-error">
            {actionError}
          </p>
        )}
      </div>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600 shadow-sm" data-testid="pending-empty">
          Aucune intention en attente.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((item) => {
            const greyed = item.expiredNow;
            return (
              <li
                key={item.id}
                className={`rounded-lg border bg-white p-4 shadow-sm ${
                  greyed ? "border-zinc-200 opacity-50" : "border-zinc-200"
                }`}
                data-testid={`pending-item-${item.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[item.status] ?? "border-zinc-300"}`}>
                    {item.status}
                  </span>
                  <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900">
                    {item.actionType === "ban_user" ? "BAN DÉFINITIF" : "PURGE DE POST"}
                  </span>
                  <span className="text-xs text-zinc-500" data-testid={`pending-expires-${item.id}`}>
                    {expiresIn(item.expiresAt)}
                  </span>
                  <span className="ml-auto text-[11px] text-zinc-600">#{item.id}</span>
                </div>
                <div className="mt-2 grid gap-1 text-xs text-zinc-700">
                  <p>
                    Cible :{" "}
                    <span className="font-mono" data-testid={`pending-target-${item.id}`}>
                      {item.targetType}:{item.targetId.length > 24 ? `${item.targetId.slice(0, 24)}…` : item.targetId}
                    </span>
                    {item.payload && typeof item.payload.nickname === "string"
                      ? ` (${item.payload.nickname})`
                      : ""}
                  </p>
                  <p>
                    Demandeur : <strong>{item.requestedBy.email}</strong> · {fmt(item.createdAt)}
                  </p>
                  <p className="font-medium">
                    Justification : <span data-testid={`pending-justif-${item.id}`}>{item.justification}</span>
                  </p>
                  {item.payload && typeof item.payload.snippet === "string" && (
                    <p className="italic text-zinc-500">«{item.payload.snippet}»</p>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.canApprove && isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => void approve(item.id)}
                      disabled={acting || greyed}
                      className="min-h-11 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                      data-testid={`btn-approve-${item.id}`}
                    >
                      {acting ? "En attente du serveur…" : "Approuver (exécute l'action)"}
                    </button>
                  )}
                  {item.canCancel && isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => void cancel(item.id)}
                      disabled={acting || greyed}
                      className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      data-testid={`btn-cancel-${item.id}`}
                    >
                      Annuler (demandeur)
                    </button>
                  )}
                  {!(item.canApprove && isSuperAdmin) && !(item.canCancel && isSuperAdmin) && (
                    // F #72 — comparaison IDENTITÉ vs IDENTITÉ (email de session)
                    // au lieu de email === rôle ; le diagnostic est aussi vrai
                    // pour un moderator (four-eyes réservé aux super-admins).
                    <span className="text-xs text-zinc-500" data-testid="four-eyes-note">
                      {myEmail !== null && item.requestedBy.email === myEmail
                        ? "Vous êtes le demandeur — un second admin doit approuver."
                        : isSuperAdmin
                          ? "En attente — vous n'êtes pas l'acteur de cette ligne (demandeur seul annule)."
                          : "En attente — approbation réservée aux super-admins (four-eyes)."}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {other.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-zinc-900">Historique récent</h3>
          <ul className="mt-2 flex max-h-96 flex-col gap-2 overflow-y-auto scrollbar-thin">
            {other.map((item) => (
              <li key={item.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 font-semibold ${STATUS_BADGE[item.status] ?? "border-zinc-300"}`}>
                    {item.status}
                  </span>
                  <span className="font-medium text-zinc-800">{item.actionType}</span>
                  <span className="font-mono text-zinc-500">
                    {item.targetType}:{item.targetId.length > 20 ? `${item.targetId.slice(0, 20)}…` : item.targetId}
                  </span>
                  <span className="text-zinc-500">
                    par {item.requestedBy.email}
                    {item.approvedBy ? ` · approuvé par ${item.approvedBy.email}` : ""}
                  </span>
                  <span className="text-zinc-600">{fmt(item.executedAt ?? item.createdAt)}</span>
                </div>
                <p className="mt-1 text-zinc-600">{item.justification}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-zinc-500">
        Les exécutions (ban/purge) sont tracées dans <Link href="/audit" className="underline">le journal d&apos;audit</Link>{" "}
        — action <code className="font-mono">pendingaction_created</code> + <code className="font-mono">ban|purge</code>.
      </p>
    </div>
  );
}
