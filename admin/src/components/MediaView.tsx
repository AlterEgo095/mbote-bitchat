"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MediaView — annuaire des OBJETS MÉDIA E2EE (back-office 2026-11).
//
// INVARIANT §1.8 : aucune mutation locale — la liste est TOUJOURS remplacée
// par la réponse authentifiée du serveur. INVARIANT §1.4 : les médias sont
// chiffrés CÔTÉ CLIENT — seules des MÉTADONNÉES traversent cette vue
// (objectKey, tailles, statut, propriétaire, sha256 déclaré) ; le serveur ne
// peut ni déchiffrer ni reconstruire un média, rien à masquer ici.
//
// Lecture : support+. Actions (moderator+, RBAC ré-imposé par le backend —
// 403 propagé si le rôle ne suffit pas) :
//   - purge d'UN objet  → POST purge_media {id, justification §6 ≥ 20 car.} ;
//   - purge de MASSE    → POST purge_pending_expired {maxAgeHours 1..720
//     (défaut 24), justification §6}.
// Après chaque 2xx : liste rechargée depuis le serveur + `affected` affiché
// (deleted, bytesFreed). NB : fileDeleted:false → note discrète « objet bucket
// non supprimé (GC à prévoir) » — la ligne DB part, l'objet S3 reste jusqu'au
// ramasse-miettes.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { fmtBytes, fmtDate, fmtNum, shortKey } from "@/lib/admin-format";

// ── types du contrat backend (aucun any) ─────────────────────────────────────

export interface MediaItem {
  id: string;
  objectKey: string;
  ownerPubkey: string;
  mediaType: string;
  sizeBytes: number;
  plainBytes: number;
  sha256: string | null;
  status: "pending" | "finalized";
  createdAt: string;
  finalizedAt: string | null;
}

export interface MediaPayload {
  mode: "list" | "search";
  items: MediaItem[];
  nextCursor?: string | null;
  cursorReset?: boolean;
  totals: {
    count: number;
    bytes: number;
    pending: { count: number; bytes: number };
    pendingExpired24h: number;
  };
  e2ee: boolean;
}

export type MediaLoadState =
  | { kind: "ready"; data: MediaPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

interface MediaFilters {
  status: "all" | "pending" | "finalized";
  period: "24h" | "7d" | "30d" | "all";
  owner: string | null; // pubkey appliquée explicitement (mode recherche)
}

interface MediaActionResponse {
  ok?: boolean;
  affected?: { deleted: number; bytesFreed: number; fileDeleted?: boolean };
  error?: string;
}

type MediaDialog = { kind: "single"; item: MediaItem } | { kind: "expired" };

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

function statusBadge(status: MediaItem["status"]): { label: string; cls: string } {
  if (status === "pending")
    return { label: "pending", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  return { label: "finalized", cls: "border-emerald-300 bg-emerald-50 text-emerald-800" };
}

export function MediaView({
  initial,
  role,
  csrfToken,
}: {
  initial: MediaLoadState;
  role: string;
  csrfToken: string;
}) {
  const [state, setState] = useState<MediaLoadState>(initial);
  const [filters, setFilters] = useState<MediaFilters>({
    status: "all",
    period: "all",
    owner: null,
  });
  const [ownerDraft, setOwnerDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ── dialog de justification §6 — UNE seule action à la fois ──
  const [dialog, setDialog] = useState<MediaDialog | null>(null);
  const [justText, setJustText] = useState("");
  const [maxAgeDraft, setMaxAgeDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const level = ROLE_LEVEL[role] ?? 0;
  const canModerate = level >= ROLE_LEVEL.moderator;

  const fetchList = useCallback(async (f: MediaFilters, c: string | null) => {
    setRefreshing(true);
    try {
      const qs = new URLSearchParams({ status: f.status, period: f.period });
      if (f.owner) qs.set("owner", f.owner);
      if (c) qs.set("cursor", c);
      const res = await apiFetch(`/api/media?${qs.toString()}`, { cache: "no-store" });
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
      const data = (await res.json()) as MediaPayload;
      if (!data || !Array.isArray(data.items) || !data.totals) {
        setState({ kind: "error", code: "http", httpStatus: res.status });
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
      if (data.cursorReset) {
        setNotice("La liste a changé depuis votre dernière page — retour à la page 1.");
      }
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  function changeFilter(patch: Partial<MediaFilters>) {
    const f = { ...filters, ...patch };
    setFilters(f);
    setCursor(null);
    setNotice(null);
    void fetchList(f, null);
  }

  function applyOwner() {
    const owner = ownerDraft.trim();
    changeFilter({ owner: owner.length > 0 ? owner : null });
  }

  function clearOwner() {
    setOwnerDraft("");
    changeFilter({ owner: null });
  }

  function openDialog(d: MediaDialog) {
    setDialog(d);
    setJustText("");
    setMaxAgeDraft(d.kind === "expired" ? "24" : "");
    setFormError(null);
  }

  function closeDialog() {
    setDialog(null);
    setJustText("");
    setMaxAgeDraft("");
    setFormError(null);
  }

  async function submitDialog() {
    if (!dialog) return;
    const justification = justText.trim();
    if (justification.length < 20) return; // bouton déjà désactivé — double garde

    // purge_pending_expired : maxAgeHours optionnel (1..720, défaut backend 24)
    let maxAgeHours: number | undefined;
    if (dialog.kind === "expired") {
      const raw = maxAgeDraft.trim();
      if (raw.length > 0) {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 720) {
          setFormError("maxAgeHours doit être un entier entre 1 et 720 (vide = défaut 24).");
          return;
        }
        maxAgeHours = parsed;
      }
    }

    setActing(true);
    setFormError(null);
    try {
      const body =
        dialog.kind === "single"
          ? { action: "purge_media", id: dialog.item.id, justification }
          : {
              action: "purge_pending_expired",
              justification,
              ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
            };
      const res = await apiFetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as MediaActionResponse;
      if (res.status === 200) {
        const a = respBody.affected ?? { deleted: 0, bytesFreed: 0 };
        const bucketNote =
          a.fileDeleted === false ? " Objet bucket NON supprimé (GC à prévoir)." : "";
        setNotice(
          dialog.kind === "single"
            ? `Purge OK — ${fmtNum(a.deleted)} objet supprimé, ${fmtBytes(a.bytesFreed)} libérés.${bucketNote}`
            : `Purge de masse OK — ${fmtNum(a.deleted)} objet(s) supprimé(s), ${fmtBytes(a.bytesFreed)} libérés.${bucketNote}`
        );
        closeDialog();
        setCursor(null);
        await fetchList(filters, null); // invariant §1.8 : rechargé du serveur
        return;
      }
      if (res.status === 422)
        setFormError(respBody.error ?? "Justification invalide (≥ 20 caractères) ou âge hors bornes.");
      else if (res.status === 400)
        setFormError(respBody.error ?? "Requête invalide (action inconnue ou paramètre hors bornes).");
      else if (res.status === 404)
        setFormError(respBody.error ?? "Objet introuvable — déjà purgé ? Rechargez la liste.");
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

  const dialogHeadingId = "media-dialog-heading";

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — la vue Médias est indisponible.
                Réessayez après rétablissement de la liaison.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ne permet pas la consultation des médias
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
          {/* ── cartes de totaux (globales, servies par le backend) ── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Objets (total servi)
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">
                {fmtNum(state.data.totals.count)}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Octets chiffrés stockés
              </p>
              <p
                className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900"
                title={`${state.data.totals.bytes} octets`}
              >
                {fmtBytes(state.data.totals.bytes)}
              </p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
                En attente (pending)
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-amber-900">
                {fmtNum(state.data.totals.pending.count)}
              </p>
              <p className="text-xs text-amber-700" title={`${state.data.totals.pending.bytes} octets`}>
                {fmtBytes(state.data.totals.pending.bytes)}
              </p>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-red-700">
                Pending expirés ≤ 24 h
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-red-900">
                {fmtNum(state.data.totals.pendingExpired24h)}
              </p>
            </div>
          </div>

          {/* ── barre d'outils : filtres ── */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4">
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Statut
              <select
                value={filters.status}
                onChange={(e) => changeFilter({ status: e.target.value as MediaFilters["status"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre statut de l'objet média"
              >
                <option value="all">tous</option>
                <option value="pending">en attente</option>
                <option value="finalized">finalisés</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Période
              <select
                value={filters.period}
                onChange={(e) => changeFilter({ period: e.target.value as MediaFilters["period"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre période de création"
              >
                <option value="all">tout</option>
                <option value="24h">24 h</option>
                <option value="7d">7 j</option>
                <option value="30d">30 j</option>
              </select>
            </label>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyOwner();
              }}
            >
              <label className="grid gap-1 text-xs font-medium text-zinc-600">
                Propriétaire (pubkey)
                <input
                  value={ownerDraft}
                  onChange={(e) => setOwnerDraft(e.target.value)}
                  className="min-h-11 w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm text-zinc-800"
                  placeholder="pubkey exacte"
                  aria-label="Filtrer par pubkey propriétaire"
                  maxLength={100}
                />
              </label>
              <button
                type="submit"
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                Filtrer
              </button>
            </form>
            {filters.owner && (
              <button
                type="button"
                onClick={clearOwner}
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                ✕ Retirer le filtre propriétaire
              </button>
            )}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
              <span className="text-xs text-zinc-500">
                {state.data.mode === "search"
                  ? `${state.data.items.length} objet(s) — recherche par propriétaire`
                  : `${state.data.items.length} objet(s) affiché(s)`}
              </span>
              <button
                type="button"
                onClick={() => void fetchList(filters, cursor)}
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                {refreshing ? "Chargement…" : "Rafraîchir"}
              </button>
              {canModerate ? (
                <button
                  type="button"
                  onClick={() => openDialog({ kind: "expired" })}
                  disabled={refreshing || acting || state.data.totals.pendingExpired24h === 0}
                  title={
                    state.data.totals.pendingExpired24h === 0
                      ? "Aucun objet pending expiré ≤ 24 h"
                      : undefined
                  }
                  className="min-h-11 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Purger les pending expirés (&gt; 24 h)
                </button>
              ) : (
                <span className="text-xs text-zinc-500">
                  purges : réservées moderator (RBAC §4)
                </span>
              )}
            </div>
          </div>

          <p className="text-xs text-zinc-500" aria-live="polite">
            {notice ??
              (state.data.mode === "search"
                ? "Résultats filtrés par propriétaire — la purge de masse n'est PAS ciblée par ce filtre (elle opère sur tout le stockage)."
                : `Page servie à ${fmtDate(state.fetchedAt)} — tri : création décroissante. Totaux servis par le backend pour l'ensemble du stockage.`)}
          </p>

          {/* ── tableau des objets média ── */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
            <table className="w-full min-w-[900px] text-left text-sm" aria-label="Objets média chiffrés (métadonnées)">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <th scope="col" className="px-4 py-2.5 font-medium">Objet</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Propriétaire</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Type</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Taille</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Clair (déclaré)</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Statut</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Créé</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Finalisé</th>
                  {canModerate && <th scope="col" className="px-4 py-2.5 font-medium">Action</th>}
                </tr>
              </thead>
              <tbody>
                {state.data.items.length === 0 && (
                  <tr>
                    <td colSpan={canModerate ? 9 : 8} className="px-4 py-8 text-center text-zinc-600">
                      Aucun objet média pour ces filtres.
                    </td>
                  </tr>
                )}
                {state.data.items.map((o) => {
                  const badge = statusBadge(o.status);
                  return (
                    <tr key={o.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                      <td className="px-4 py-2.5">
                        <span className="break-all font-mono text-xs text-zinc-800" title={o.objectKey}>
                          {shortKey(o.objectKey, 14, 6)}
                        </span>
                        {o.sha256 && (
                          <span className="block font-mono text-[10px] text-zinc-400" title={`sha256 ${o.sha256}`}>
                            sha256 {shortKey(o.sha256, 6, 4)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs text-zinc-600" title={o.ownerPubkey}>
                          {shortKey(o.ownerPubkey, 8, 4)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-700">
                          {o.mediaType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-800" title={`${o.sizeBytes} octets`}>
                        {fmtBytes(o.sizeBytes)}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-zinc-500" title={`${o.plainBytes} octets (déclarés, non vérifiables côté serveur)`}>
                        {fmtBytes(o.plainBytes)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600">{fmtDate(o.createdAt)}</td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600">{fmtDate(o.finalizedAt)}</td>
                      {canModerate && (
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            onClick={() => openDialog({ kind: "single", item: o })}
                            disabled={acting}
                            className="min-h-10 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-900 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`Purger l'objet ${shortKey(o.objectKey, 14, 6)}`}
                          >
                            Purger
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── pagination cursor ── */}
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
                {refreshing ? "Chargement…" : "Charger plus"}
              </button>
            ) : (
              <span className="text-xs text-zinc-500">Fin de la liste (20/page).</span>
            )}
          </div>

          {!canModerate && (
            <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
              Votre rôle ({role}) autorise la lecture seule des métadonnées média —
              les purges exigent <strong>moderator</strong> minimum (RBAC §4 ;
              la règle est ré-imposée par l&apos;app principale, 403).
            </p>
          )}

          {/* ── dialog de justification §6 ── */}
          {dialog && (
            <section
              role="dialog"
              aria-modal="false"
              aria-labelledby={dialogHeadingId}
              data-testid="justification-form"
              className="rounded-md border border-zinc-300 bg-zinc-50 p-4"
            >
              <p id={dialogHeadingId} className="text-xs font-semibold text-zinc-700">
                {dialog.kind === "single"
                  ? "Purger cet objet média — justification obligatoire (ADMIN-RBAC §6)"
                  : "Purger les objets pending expirés — justification obligatoire (ADMIN-RBAC §6)"}
              </p>
              {dialog.kind === "single" ? (
                <p className="mt-1 text-sm text-zinc-700">
                  Cible : <span className="break-all font-mono text-xs">{shortKey(dialog.item.objectKey, 14, 6)}</span>{" "}
                  · {dialog.item.mediaType} · {fmtBytes(dialog.item.sizeBytes)} ·{" "}
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge(dialog.item.status).cls}`}>
                    {dialog.item.status}
                  </span>{" "}
                  · propriétaire <span className="font-mono text-xs">{shortKey(dialog.item.ownerPubkey, 8, 4)}</span>.
                  Suppression DÉFINITIVE de la ligne de métadonnées.
                </p>
              ) : (
                <p className="mt-1 text-sm text-zinc-700">
                  Cible : TOUS les objets pending dont l&apos;expiration dépasse la durée
                  choisie ({fmtNum(state.data.totals.pendingExpired24h)} objet(s) expiré(s) à 24 h
                  selon les totaux servis). Action de MASSE — irréversible.
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {dialog.kind === "expired" && (
                  <label className="grid gap-1 text-xs text-zinc-600">
                    Âge d&apos;expiration (heures, 1–720 — vide = défaut 24)
                    <input
                      type="number"
                      min={1}
                      max={720}
                      step={1}
                      value={maxAgeDraft}
                      onChange={(e) => setMaxAgeDraft(e.target.value)}
                      className="min-h-11 w-40 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      aria-label="Âge d'expiration en heures (1 à 720, défaut 24)"
                    />
                  </label>
                )}
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
                  onClick={() => void submitDialog()}
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
