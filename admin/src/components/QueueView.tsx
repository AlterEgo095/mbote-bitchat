"use client";

// ─────────────────────────────────────────────────────────────────────────────
// QueueView — file de modération (ADM Étape 6). Instrument, pas vitrine.
//
// INVARIANT NON NÉGOCIABLE (ADMIN-RBAC.md §1.8, directive clarification 1) :
// « toute mutation UI reflète le retour serveur 2xx — pas d'optimistic update
// avant confirmation ». ICI : aucune action ne retire quoi que ce soit de la
// liste localement. Après CHAQUE action (2xx OU erreur), la page courante est
// REJETÉE depuis la réponse authentifiée du serveur — l'état affiché est
// TOUJOURS celui que le serveur vient de décrire. Le bug fondateur de la
// classe (logout sans vérifier res.ok — ADM-step5.md §6.2) est le contre-
// exemple permanent.
//
// Auth : session panneau (cookie HttpOnly) + CSRF mémoire (passé par la page
// serveur, issu de verify). Rôles : dismiss/warn = support+ · hide/unhide/
// suspend = moderator+ · ban/purge = four-eyes Étape 9 → boutons désactivés
// avec tooltip « approbation requise » (directive Étape 6).
//
// Dégradations : 502 backend-unreachable → bandeau (PAS « session expirée ») ;
// 401 → session expirée ; 403 → accès refusé (auditor strict) ; 422 → erreur
// de justification affichée dans le formulaire ; 409 → déjà traité.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";

const CATEGORIES = ["SPAM", "HARASSMENT", "SCAM", "CSAM", "OTHER"] as const;

export interface QueueItem {
  id: string;
  reporter: { pseudo: string | null };
  targetKind: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
  weight: number;
  context:
    | {
        exists: true;
        snippet: string;
        postCreatedAt: string | null;
        hiddenAt: string | null;
        author: { pseudo: string | null; pubkey: string | null; suspendedAt: string | null };
      }
    | { exists: false; note: string };
}

export interface QueuePayload {
  items: QueueItem[];
  nextCursor: string | null;
  cursorReset: boolean;
  openTotal: number;
  page: { size: number; status: string; period: string; type: string };
}

export type QueueLoadState =
  | { kind: "ready"; data: QueuePayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

export interface QueueFilters {
  period: "24h" | "7d" | "30d" | "all";
  type: "post" | "comment" | "all";
  status: "open" | "all";
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
  hour: "2-digit",
  minute: "2-digit",
});

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return timeFmt.format(new Date(iso));
}

/** Label d'action — affiché sur le bouton qui ouvre le formulaire. */
type MutableAction = "hide" | "unhide" | "dismiss" | "warn" | "suspend";

const ACTION_LABEL: Record<MutableAction, string> = {
  hide: "Masquer le contenu",
  unhide: "Réafficher",
  dismiss: "Classer sans suite",
  warn: "Avertir l'auteur",
  suspend: "Suspendre l'auteur",
};

export function QueueView({
  role,
  csrfToken,
  initial,
}: {
  role: string;
  csrfToken: string;
  initial: QueueLoadState;
}) {
  const [state, setState] = useState<QueueLoadState>(initial);
  const [filters, setFilters] = useState<QueueFilters>({ period: "all", type: "all", status: "open" });
  const [cursor, setCursor] = useState<string | null>(null); // page courante
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null); // item en cours d'action
  const [notice, setNotice] = useState<string | null>(null); // aria-live : résultats serveur
  // formulaire de justification ouvert : item + action choisie
  const [form, setForm] = useState<{ item: QueueItem; action: MutableAction } | null>(null);
  const [formCategory, setFormCategory] = useState<(typeof CATEGORIES)[number]>("SPAM");
  const [formText, setFormText] = useState("");
  const [formDuration, setFormDuration] = useState<"24h" | "7d" | "indefinite">("24h");
  const [formError, setFormError] = useState<string | null>(null);

  const level = ROLE_LEVEL[role] ?? 0;
  const canSupport = level >= ROLE_LEVEL.support; // dismiss + warn
  const canModerate = level >= ROLE_LEVEL.moderator; // hide/unhide/suspend

  const fetchPage = useCallback(
    async (f: QueueFilters, c: string | null) => {
      setRefreshing(true);
      try {
        const qs = new URLSearchParams({ period: f.period, type: f.type, status: f.status });
        if (c) qs.set("cursor", c);
        const res = await fetch(`/api/queue?${qs.toString()}`, { cache: "no-store" });
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
        const data = (await res.json()) as QueuePayload;
        if (!data || !Array.isArray(data.items)) {
          setState({ kind: "error", code: "http", httpStatus: res.status });
          return;
        }
        setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
        if (data.cursorReset) {
          setNotice("La file a changé depuis votre dernière page (signalements clos) — retour à la page 1.");
        }
      } catch {
        setState({ kind: "error", code: "backend-unreachable" });
      } finally {
        setRefreshing(false);
      }
    },
    []
  );

  /** Filtre changé → page 1 (le curseur d'une autre vue n'a pas de sens). */
  function changeFilter(patch: Partial<QueueFilters>) {
    const f = { ...filters, ...patch };
    setFilters(f);
    setCursor(null);
    setForm(null);
    void fetchPage(f, null);
  }

  /**
   * MUTATION — invariant §1.8 : on envoie, on attend la réponse, PUIS on
   * reflète : 2xx → notice + refetch de la page courante (la vérité serveur
   * remplace la liste) ; erreur → message + refetch AUSSI (l'état a pu
   * changer côté serveur). Aucune modification locale avant réponse.
   */
  async function submitAction() {
    if (!form) return;
    const { item, action } = form;
    setFormError(null);
    setActingId(item.id);
    try {
      // cible selon l'action : dismiss → le report lui-même ; warn/suspend →
      // l'auteur du contenu (pubkey opératoire) ; hide/unhide → le post.
      let targetKind: string;
      let targetId: string | null;
      if (action === "dismiss") {
        targetKind = "report";
        targetId = item.id;
      } else if (action === "warn" || action === "suspend") {
        targetKind = "user";
        targetId = item.context.exists ? item.context.author.pubkey : null;
      } else {
        targetKind = "post";
        targetId = item.targetId;
      }
      const body: Record<string, unknown> = {
        action,
        targetKind,
        targetId,
        category: formCategory,
        justification: formText,
      };
      if (action === "suspend") body.duration = formDuration;
      if (targetId == null) {
        setFormError("Cible introuvable (auteur inconnu) — rechargez la file.");
        return;
      }
      const res = await fetch("/api/admin/moderation/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as { error?: string; affected?: { reportsClosed?: number } };
      if (res.status === 200) {
        const closed = respBody.affected?.reportsClosed ?? 0;
        setNotice(
          `${ACTION_LABEL[action]} — OK (2xx).${closed > 0 ? ` ${closed} signalement(s) clos par le serveur.` : ""} Liste rejetée depuis le serveur.`
        );
        setForm(null);
        setFormText("");
        await fetchPage(filters, cursor);
        return;
      }
      if (res.status === 422) setFormError(respBody.error ?? "Justification invalide (≥ 20 caractères).");
      else if (res.status === 409) setFormError(respBody.error ?? "Signalement déjà traité — liste rejetée.");
      else if (res.status === 502) setFormError("Backend injoignable — action non appliquée, réessayez.");
      else if (res.status === 401 || res.status === 403)
        setFormError("Refusé par le serveur (401/403) — vérifiez la session et le rôle.");
      else setFormError(respBody.error ?? `Erreur HTTP ${res.status}.`);
      // même sur erreur : refetch — invariant §1.8 (l'état affiché suit le serveur)
      await fetchPage(filters, cursor);
    } catch {
      setFormError("App principale injoignable — action non appliquée.");
      await fetchPage(filters, cursor);
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — la file est indisponible.
                Réessayez après rétablissement de la liaison.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ({role}) ne permet pas la consultation de la file
                (support minimum — l&apos;auditor est limité à l&apos;audit,
                arbitrage §12.17).
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
          {/* ── barre d'outils : filtres + compteurs ── */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4">
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Période
              <select
                value={filters.period}
                onChange={(e) => changeFilter({ period: e.target.value as QueueFilters["period"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre période"
              >
                <option value="all">tout</option>
                <option value="24h">24 h</option>
                <option value="7d">7 j</option>
                <option value="30d">30 j</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Type
              <select
                value={filters.type}
                onChange={(e) => changeFilter({ type: e.target.value as QueueFilters["type"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre type"
              >
                <option value="all">tout</option>
                <option value="post">posts</option>
                <option value="comment">commentaires</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-zinc-600">
              Statut
              <select
                value={filters.status}
                onChange={(e) => changeFilter({ status: e.target.value as QueueFilters["status"] })}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800"
                aria-label="Filtre statut"
              >
                <option value="open">ouverts</option>
                <option value="all">tous</option>
              </select>
            </label>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                {state.data.openTotal} signalement(s) ouvert(s) au total
              </span>
              <button
                type="button"
                onClick={() => void fetchPage(filters, cursor)}
                disabled={refreshing}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                {refreshing ? "Chargement…" : "Rafraîchir"}
              </button>
            </div>
          </div>

          <p className="text-xs text-zinc-500" aria-live="polite">
            {notice ?? `Page servie à ${fmt(state.fetchedAt)} — tri : poids décroissant, puis ancienneté croissante.`}
          </p>

          {/* ── items ── */}
          <ul className="flex flex-col gap-3">
            {state.data.items.length === 0 && (
              <li className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
                Aucun signalement pour ces filtres.
              </li>
            )}
            {state.data.items.map((item) => (
              <li key={item.id} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="weight-badge"
                    className={`inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${
                      item.weight >= 5
                        ? "border-red-300 bg-red-50 text-red-800"
                        : item.weight > 1
                          ? "border-amber-300 bg-amber-50 text-amber-800"
                          : "border-zinc-300 bg-zinc-50 text-zinc-700"
                    }`}
                  >
                    poids {item.weight}
                  </span>
                  <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-700">
                    {item.targetKind === "comment" ? "commentaire" : "post"}
                  </span>
                  {item.status !== "open" && (
                    <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-500">
                      {item.status}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    signalé {fmt(item.createdAt)} par {item.reporter.pseudo ?? "inconnu"} · motif {item.reason}
                  </span>
                </div>

                <p className="mt-2 text-sm text-zinc-900">
                  {item.context.exists ? (
                    <>
                      «{item.context.snippet}
                      {item.context.snippet.length >= 60 ? "…" : ""}»
                      {item.context.hiddenAt && (
                        <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
                          déjà masqué
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-zinc-500">{item.context.note}</span>
                  )}
                </p>
                {item.context.exists && (
                  <p className="mt-1 text-xs text-zinc-500">
                    auteur : {item.context.author.pseudo ?? "inconnu"}
                    {item.context.author.suspendedAt && " (suspendu)"}
                    {item.context.postCreatedAt ? ` · publié ${fmt(item.context.postCreatedAt)}` : ""}
                  </p>
                )}

                {/* ── actions (rôles matrice §4 ; zéro optimisme) ── */}
                {item.status === "open" && item.context.exists && (
                  <ItemActions
                    item={item}
                    ctx={item.context}
                    canSupport={canSupport}
                    canModerate={canModerate}
                    busy={actingId === item.id}
                    formOpenFor={form?.item.id ?? null}
                    onOpen={openForm}
                  />
                )}

                {/* ── formulaire de justification (§6) ── */}
                {form?.item.id === item.id && (
                  <div className="mt-3 rounded-md border border-zinc-300 bg-zinc-50 p-3" data-testid="justification-form">
                    <p className="text-xs font-semibold text-zinc-700">
                      {ACTION_LABEL[form.action]} — justification obligatoire (ADMIN-RBAC §6)
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="grid gap-1 text-xs text-zinc-600">
                        Catégorie
                        <select
                          value={formCategory}
                          onChange={(e) => setFormCategory(e.target.value as (typeof CATEGORIES)[number])}
                          className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      {form.action === "suspend" && (
                        <label className="grid gap-1 text-xs text-zinc-600">
                          Durée
                          <select
                            value={formDuration}
                            onChange={(e) => setFormDuration(e.target.value as typeof formDuration)}
                            className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                          >
                            <option value="24h">24 h</option>
                            <option value="7d">7 j</option>
                            <option value="indefinite">illimitée</option>
                          </select>
                        </label>
                      )}
                    </div>
                    <textarea
                      value={formText}
                      onChange={(e) => setFormText(e.target.value)}
                      rows={3}
                      maxLength={500}
                      placeholder="Justification (≥ 20 caractères) — elle sera stockée « CATÉGORIE: texte » dans l'audit append-only"
                      className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
                      aria-label="Texte de justification"
                    />
                    {formError && (
                      <p className="mt-1 text-sm text-red-700" role="alert">
                        {formError}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void submitAction()}
                        disabled={actingId === item.id || formText.trim().length < 20}
                        className="min-h-11 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {actingId === item.id ? "Envoi…" : "Confirmer (attend le serveur)"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setForm(null);
                          setFormError(null);
                          setFormText("");
                        }}
                        disabled={actingId === item.id}
                        className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                      >
                        Annuler
                      </button>
                      <span className="text-xs text-zinc-500">{formText.trim().length}/20 min</span>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* ── pagination cursor-based ── */}
          <div className="flex items-center gap-3 border-t border-zinc-100 pt-3">
            <button
              type="button"
              disabled={!state.data.nextCursor || refreshing}
              onClick={() => {
                setCursor(state.data.nextCursor);
                void fetchPage(filters, state.data.nextCursor);
              }}
              className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Page suivante →
            </button>
            {cursor && (
              <button
                type="button"
                disabled={refreshing}
                onClick={() => {
                  setCursor(null);
                  void fetchPage(filters, null);
                }}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
              >
                ← Retour page 1
              </button>
            )}
            <span className="text-xs text-zinc-500">
              {state.data.items.length} item(s) — {state.data.nextCursor ? "page suivante disponible" : "fin de file"}
            </span>
          </div>
        </>
      )}
    </div>
  );

  function openForm(item: QueueItem, action: MutableAction) {
    setForm({ item, action });
    setFormError(null);
    setFormText("");
    setFormCategory("SPAM");
    setFormDuration("24h");
  }

  function ActionBtn({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "…" : label}
      </button>
    );
  }

  /**
   * Boutons d'action d'un item — le contexte NARROWED (exists: true) est
   * passé par la prop `ctx` : le narrowing TS ne survit pas aux callbacks
   * JSX sur des chemins de propriétés (d'où ce sous-composant).
   */
  function ItemActions(props: {
    item: QueueItem;
    ctx: Extract<QueueItem["context"], { exists: true }>;
    canSupport: boolean;
    canModerate: boolean;
    busy: boolean;
    formOpenFor: string | null;
    onOpen: (item: QueueItem, action: MutableAction) => void;
  }) {
    const { item, ctx, canSupport, canModerate, busy, onOpen } = props;
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        {canModerate && (
          <ActionBtn
            label={ctx.hiddenAt ? ACTION_LABEL.unhide : ACTION_LABEL.hide}
            busy={busy}
            onClick={() => onOpen(item, ctx.hiddenAt ? "unhide" : "hide")}
          />
        )}
        {canSupport && (
          <ActionBtn label={ACTION_LABEL.dismiss} busy={busy} onClick={() => onOpen(item, "dismiss")} />
        )}
        {canSupport && (
          <ActionBtn label={ACTION_LABEL.warn} busy={busy} onClick={() => onOpen(item, "warn")} />
        )}
        {canModerate && (
          <ActionBtn label={ACTION_LABEL.suspend} busy={busy} onClick={() => onOpen(item, "suspend")} />
        )}
        {/* four-eyes Étape 9 — directive : désactivé + tooltip « approbation requise » */}
        <button
          type="button"
          disabled
          title="approbation requise"
          aria-disabled="true"
          data-testid="four-eyes-disabled"
          className="min-h-11 cursor-not-allowed rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-400"
        >
          Bannir + purger (four-eyes)
        </button>
      </div>
    );
  }
}
