"use client";

// ─────────────────────────────────────────────────────────────────────────────
// InfraView — INFRASTRUCTURE d'exécution (back-office 2026-11) : passerelles
// mesh (routage sans lecture) et abonnements push Web Push.
//
// INVARIANT §1.8 : aucune mutation locale — après chaque purge, les données
// sont RECHARGÉES depuis le serveur. INVARIANT §1.4 : les endpoints push sont
// servis TRONQUÉS et ne contiennent aucun token d'abonnement complet ; les
// passerelles ne voient que des paquets chiffrés.
//
// Lecture : support+. Action (moderator+, RBAC ré-imposé par le backend 403) :
//   - purge des abonnements push DÉSACTIVÉS (purge_disabled_push_subs,
//     maxAgeDays 1..365, défaut 30) — dialog justification §6 ≥ 20 caractères.
//
// Dates relatives calculées à l'INSTANTANÉ (fetchedAt) : rendu déterministe,
// pas d'horloge pendant le rendu (puren React).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { fmtDate, fmtNum, fmtRel, shortKey, truncate } from "@/lib/admin-format";

// ── types du contrat backend (aucun any) ─────────────────────────────────────

export interface GatewayRow {
  id: string;
  label: string | null;
  lastSeen: string;
  packetsIn: number;
  packetsOut: number;
}

export interface PushSubRow {
  id: string;
  userId: number;
  endpoint: string; // déjà tronqué par le backend (pas de token complet)
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  disabledAt: string | null;
}

export interface InfraPayload {
  gateways: GatewayRow[];
  pushSubs: {
    active: number;
    disabled: number;
    recent: PushSubRow[];
  };
  e2ee: boolean;
}

export type InfraLoadState =
  | { kind: "ready"; data: InfraPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

interface InfraActionResponse {
  ok?: boolean;
  affected?: { deleted: number };
  error?: string;
}

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

export function InfraView({
  initial,
  role,
  csrfToken,
}: {
  initial: InfraLoadState;
  role: string;
  csrfToken: string;
}) {
  const [state, setState] = useState<InfraLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ── dialog de justification §6 ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [justText, setJustText] = useState("");
  const [maxAgeDraft, setMaxAgeDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const level = ROLE_LEVEL[role] ?? 0;
  const canModerate = level >= ROLE_LEVEL.moderator;

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch("/api/infra", { cache: "no-store" });
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
      const data = (await res.json()) as InfraPayload;
      if (!data || !Array.isArray(data.gateways) || !data.pushSubs) {
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

  function openDialog() {
    setDialogOpen(true);
    setJustText("");
    setMaxAgeDraft("30");
    setFormError(null);
  }

  function closeDialog() {
    setDialogOpen(false);
    setJustText("");
    setMaxAgeDraft("");
    setFormError(null);
  }

  async function submitPurge() {
    const justification = justText.trim();
    if (justification.length < 20) return; // bouton déjà désactivé — double garde

    // maxAgeDays optionnel (1..365, défaut backend 30)
    let maxAgeDays: number | undefined;
    const raw = maxAgeDraft.trim();
    if (raw.length > 0) {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
        setFormError("maxAgeDays doit être un entier entre 1 et 365 (vide = défaut 30).");
        return;
      }
      maxAgeDays = parsed;
    }

    setActing(true);
    setFormError(null);
    try {
      const body = {
        action: "purge_disabled_push_subs",
        justification,
        ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
      };
      const res = await apiFetch("/api/infra", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as InfraActionResponse;
      if (res.status === 200) {
        const a = respBody.affected ?? { deleted: 0 };
        setNotice(
          `Purge OK — ${fmtNum(a.deleted)} abonnement(s) push désactivé(s) supprimé(s). Action tracée dans l'audit append-only.`
        );
        closeDialog();
        await reload(); // invariant §1.8 : rechargé du serveur
        return;
      }
      if (res.status === 422)
        setFormError(respBody.error ?? "Justification invalide (≥ 20 caractères) ou âge hors bornes.");
      else if (res.status === 400)
        setFormError(respBody.error ?? "Requête invalide (action inconnue ou paramètre hors bornes).");
      else if (res.status === 502)
        setFormError("Backend injoignable — action non appliquée, réessayez.");
      else if (res.status === 401 || res.status === 403)
        setFormError("Refus du serveur (session ou rôle insuffisant pour cette action).");
      else setFormError(respBody.error ?? `Erreur HTTP ${res.status} — réessayez.`);
    } catch {
      setFormError("Backend injoignable — action non appliquée, réessayez.");
    } finally {
      setActing(false);
    }
  }

  // Horloge de référence = l'instantané servi (rendu déterministe, pur).
  const snapMs = state.kind === "ready" ? new Date(state.fetchedAt).getTime() : 0;
  const dialogHeadingId = "infra-dialog-heading";

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — la vue Infrastructure est indisponible.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ne permet pas la consultation de l&apos;infrastructure
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
                Passerelles mesh
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">
                {fmtNum(state.data.gateways.length)}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">
                Vu à l&apos;instantané (5 min)
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-900">
                {fmtNum(
                  state.data.gateways.filter(
                    (g) => new Date(g.lastSeen).getTime() >= snapMs - 5 * 60_000
                  ).length
                )}
              </p>
              <p className="text-xs text-emerald-700">passerelle(s) récente(s)</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">
                Push actifs
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-900">
                {fmtNum(state.data.pushSubs.active)}
              </p>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-red-700">
                Push désactivés
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-red-900">
                {fmtNum(state.data.pushSubs.disabled)}
              </p>
            </div>
          </div>

          {/* ── barre d'outils ── */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4">
            <p className="text-xs text-zinc-500" aria-live="polite">
              {notice ??
                `Instantané servi à ${fmtDate(state.fetchedAt)} — dates relatives calculées à l'instantané.`}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void reload()}
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                {refreshing ? "Chargement…" : "Rafraîchir"}
              </button>
              {canModerate ? (
                <button
                  type="button"
                  onClick={openDialog}
                  disabled={refreshing || acting || state.data.pushSubs.disabled === 0}
                  title={
                    state.data.pushSubs.disabled === 0
                      ? "Aucun abonnement désactivé à purger"
                      : undefined
                  }
                  className="min-h-11 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Purger les abonnements désactivés (&gt; 30 j)
                </button>
              ) : (
                <span className="text-xs text-zinc-500">
                  purge : réservée moderator (RBAC §4)
                </span>
              )}
            </div>
          </div>

          {/* ── passerelles mesh ── */}
          <section aria-labelledby="infra-gateways-heading" className="flex flex-col gap-2">
            <h2 id="infra-gateways-heading" className="text-sm font-semibold text-zinc-900">
              Passerelles mesh
            </h2>
            <p className="text-xs text-zinc-500">
              Nœuds d&apos;entrée du réseau mesh : ils relaient des paquets
              CHIFFRÉS (announce/public/dm/gossip) sans jamais pouvoir les lire.
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
              <table className="w-full min-w-[640px] text-left text-sm" aria-label="Passerelles mesh connues">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <th scope="col" className="px-4 py-2.5 font-medium">Identifiant</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Libellé</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Vu</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Paquets in</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Paquets out</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.gateways.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-zinc-600">
                        Aucune passerelle enregistrée.
                      </td>
                    </tr>
                  )}
                  {state.data.gateways.map((g) => (
                    <tr key={g.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                      <td className="px-4 py-2.5">
                        <span className="break-all font-mono text-xs text-zinc-800" title={g.id}>
                          {shortKey(g.id, 12, 6)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-700">{g.label ?? <span className="text-zinc-400">—</span>}</td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600" title={fmtDate(g.lastSeen)}>
                        {fmtRel(g.lastSeen, snapMs)}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-800">{fmtNum(g.packetsIn)}</td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-800">{fmtNum(g.packetsOut)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── abonnements push ── */}
          <section aria-labelledby="infra-push-heading" className="flex flex-col gap-2">
            <h2 id="infra-push-heading" className="text-sm font-semibold text-zinc-900">
              Abonnements push (10 derniers)
            </h2>
            <p className="text-xs text-zinc-500">
              Web Push : l&apos;endpoint est tronqué par le backend (aucun token
              d&apos;abonnement complet ne quitte le serveur) — « désactivé » =
              rejets répétés du service push.
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
              <table className="w-full min-w-[820px] text-left text-sm" aria-label="Abonnements push récents">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <th scope="col" className="px-4 py-2.5 font-medium">Utilisateur</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Endpoint</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">User-Agent</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Créé</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Vu</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">État</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.pushSubs.recent.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-zinc-600">
                        Aucun abonnement push récent.
                      </td>
                    </tr>
                  )}
                  {state.data.pushSubs.recent.map((s) => (
                    <tr key={s.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                      <td className="px-4 py-2.5 tabular-nums text-zinc-800">
                        <span title={`utilisateur #${s.userId}`}>{fmtNum(s.userId)}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs text-zinc-700" title={s.endpoint}>
                          {truncate(s.endpoint, 36)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-500" title={s.userAgent ?? undefined}>
                        {s.userAgent ? truncate(s.userAgent, 28) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600">{fmtDate(s.createdAt)}</td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600" title={fmtDate(s.lastSeenAt)}>
                        {fmtRel(s.lastSeenAt, snapMs)}
                      </td>
                      <td className="px-4 py-2.5">
                        {s.disabledAt ? (
                          <span
                            className="inline-flex items-center rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800"
                            title={`désactivé ${fmtDate(s.disabledAt)}`}
                          >
                            désactivé {fmtDate(s.disabledAt)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
                            actif
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {!canModerate && (
            <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
              Votre rôle ({role}) autorise la lecture seule de l&apos;infrastructure —
              la purge des abonnements désactivés exige <strong>moderator</strong>{" "}
              minimum (RBAC §4 ; ré-imposé par l&apos;app principale, 403).
            </p>
          )}

          {/* ── dialog de justification §6 ── */}
          {dialogOpen && (
            <section
              role="dialog"
              aria-modal="false"
              aria-labelledby={dialogHeadingId}
              data-testid="justification-form"
              className="rounded-md border border-zinc-300 bg-zinc-50 p-4"
            >
              <p id={dialogHeadingId} className="text-xs font-semibold text-zinc-700">
                Purger les abonnements push désactivés — justification obligatoire (ADMIN-RBAC §6)
              </p>
              <p className="mt-1 text-sm text-zinc-700">
                Cible : les abonnements DÉSACTIVÉS depuis plus de N jours
                ({fmtNum(state.data.pushSubs.disabled)} désactivé(s) au total selon
                l&apos;instantané). Action de MASSE — irréversible, tracée dans
                l&apos;audit append-only.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="grid gap-1 text-xs text-zinc-600">
                  Ancienneté (jours, 1–365 — vide = défaut 30)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={maxAgeDraft}
                    onChange={(e) => setMaxAgeDraft(e.target.value)}
                    className="min-h-11 w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                    aria-label="Ancienneté en jours (1 à 365, défaut 30)"
                  />
                </label>
              </div>
              <textarea
                value={justText}
                onChange={(e) => setJustText(e.target.value)}
                rows={3}
                maxLength={500}
                autoFocus
                placeholder="Justification (≥ 20 caractères) — tracée dans l'audit append-only"
                className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
                aria-label="Texte de justification de la purge"
              />
              {formError && (
                <p className="mt-1 text-sm text-red-700" role="alert">
                  {formError}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void submitPurge()}
                  disabled={acting || justText.trim().length < 20}
                  className="min-h-11 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {acting ? "Envoi…" : "Confirmer (attend le serveur)"}
                </button>
                <button
                  type="button"
                  onClick={closeDialog}
                  disabled={acting}
                  className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  Annuler
                </button>
                <span className="text-xs text-zinc-500">{justText.trim().length}/20 min</span>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
