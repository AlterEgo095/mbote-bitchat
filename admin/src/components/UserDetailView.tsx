"use client";

// ─────────────────────────────────────────────────────────────────────────────
// UserDetailView — fiche utilisateur (ADM Étape 7).
//
// INVARIANT §1.8 : après CHAQUE action (2xx OU erreur), la fiche est REJETÉE
// depuis la réponse authentifiée du serveur — jamais d'état local déduit.
// Le formulaire affiche l'erreur serveur (422 justification, 400 duration)
// telle quelle.
//
// ACTIONS (directive Étape 7 + arbitrages §13 + Étape 9 four-eyes) :
//   - Avertir            : moderator+ (§13.1) — justification §6, note visible
//                          dans le profil de l'utilisateur (pas de DM, E2EE) ;
//   - Suspendre          : moderator+ — dropdown 24 h / 7 j / 30 j (§13.3) ;
//                          publication bloquée, DM possible (E2EE) ;
//   - Lever la suspension: moderator+ (§13.5) — visible uniquement si suspendu ;
//   - BAN DÉFINITIF      : Étape 9 four-eyes — bouton actif pour SUPER-ADMIN
//                          UNIQUEMENT (tranché 2026-11-06, matrice §4 #9-11
//                          réalignée) : il CRÉE une intention (ban_user) que
//                          un SECOND admin doit approuver dans l'heure (page
//                          /pending-actions). Jamais d'exécution directe ici.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";

const CATEGORIES = ["SPAM", "HARASSMENT", "SCAM", "CSAM", "OTHER"] as const;

export interface UserFiche {
  user: {
    pubkey: string;
    pseudo: string;
    bio: string | null;
    createdAt: string;
    status: "actif" | "suspendu" | "banni";
    suspendedAt: string | null;
    suspendedUntil: string | null;
    bannedAt: string | null;
  };
  counts: { posts: number; openReports: number; warnings: number; auditEntries: number };
  openReports: {
    items: Array<{
      id: string;
      reason: string;
      details: string | null;
      targetKind: string;
      targetId: string;
      createdAt: string;
      postSnippet: string | null;
      postHiddenAt: string | null;
    }>;
    hasMore: boolean;
  };
  audit: Array<{
    id: number;
    action: string;
    actorRole: string;
    justification: string | null;
    beforeJson: string | null;
    afterJson: string | null;
    createdAt: string;
  }>;
}

export type UserDetailLoadState =
  | { kind: "ready"; data: UserFiche; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http" | "notfound";
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

type DetailAction = "warn" | "suspend" | "unsuspend" | "ban_user";

const ACTION_LABEL: Record<DetailAction, string> = {
  warn: "Avertir",
  suspend: "Suspendre",
  unsuspend: "Lever la suspension",
  ban_user: "Demander un ban définitif (four-eyes)",
};

export function UserDetailView({
  role,
  csrfToken,
  initial,
}: {
  role: string;
  csrfToken: string;
  initial: UserDetailLoadState;
}) {
  const [state, setState] = useState<UserDetailLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<DetailAction | null>(null);
  const [formCategory, setFormCategory] = useState<(typeof CATEGORIES)[number]>("SPAM");
  const [formText, setFormText] = useState("");
  const [formDuration, setFormDuration] = useState<"24h" | "7d" | "30d">("24h");
  const [formError, setFormError] = useState<string | null>(null);

  const level = ROLE_LEVEL[role] ?? 0;
  const canModerate = level >= ROLE_LEVEL.moderator;
  // É9 four-eyes : SUPER-ADMIN UNIQUEMENT (tranché 2026-11-06 — la directive
  // É9 dit « Rôle super-admin requis » pour créer ET approuver ; matrice §4
  // #9-11 réalignée dans ADMIN-RBAC.md §15).
  const canRequestFourEyes = level >= ROLE_LEVEL["super-admin"];

  const refetch = useCallback(async (pubkey: string) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(pubkey)}`, { cache: "no-store" });
      if (res.status === 404) {
        setState({ kind: "error", code: "notfound", httpStatus: res.status });
        return;
      }
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
      const data = (await res.json()) as UserFiche;
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
    } catch {
      setState({ kind: "error", code: "backend-unreachable" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  /**
   * MUTATION four-eyes (É9) — invariant §1.8 : la demande attend le 201 du
   * serveur ; AUCUN état « intention posée » n'est affiché avant. La fiche est
   * ensuite rejetée (le statut banni n'arrive qu'après EXÉCUTION par un second
   * admin — refetch montre l'historique `pendingaction_created`).
   */
  async function submitFourEyesRequest() {
    if (!form || form !== "ban_user" || state.kind !== "ready") return;
    const pubkey = state.data.user.pubkey;
    setFormError(null);
    setActing(true);
    try {
      const res = await fetch("/api/pending-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify({
          actionType: "ban_user",
          targetId: pubkey,
          category: formCategory,
          justification: formText,
        }),
      });
      const respBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        pendingAction?: { id: number; expiresAt: string };
      };
      if (res.status === 201 && respBody.pendingAction) {
        const exp = respBody.pendingAction.expiresAt
          ? new Date(respBody.pendingAction.expiresAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
          : "";
        setNotice(
          `Intention #${respBody.pendingAction.id} enregistrée — en attente d'approbation par un SECOND super-admin (expire à ${exp}). Aucun ban appliqué tant que le four-eyes n'est pas complété.`
        );
        setForm(null);
        setFormText("");
        await refetch(pubkey);
        return;
      }
      if (res.status === 422) setFormError(respBody.error ?? "Justification invalide (≥ 20 caractères).");
      else if (res.status === 409) setFormError(respBody.error ?? "Intention déjà en attente ou utilisateur déjà banni.");
      else if (res.status === 400) setFormError(respBody.error ?? "Paramètre invalide.");
      else if (res.status === 502) setFormError("Backend injoignable — intention non enregistrée, réessayez.");
      else if (res.status === 401 || res.status === 403)
        setFormError("Refusé par le serveur (401/403) — le four-eyes exige super-admin (et un second admin pour approuver).");
      else setFormError(respBody.error ?? `Erreur HTTP ${res.status}.`);
      await refetch(pubkey); // même sur erreur : l'état suit le serveur
    } catch {
      setFormError("App principale injoignable — intention non enregistrée.");
      await refetch(pubkey);
    } finally {
      setActing(false);
    }
  }

  /** MUTATION — invariant §1.8 : attendre le serveur, PUIS refléter. */
  async function submitAction() {
    if (!form || state.kind !== "ready") return;
    if (form === "ban_user") return submitFourEyesRequest();
    const pubkey = state.data.user.pubkey;
    setFormError(null);
    setActing(true);
    try {
      const body: Record<string, unknown> = {
        category: formCategory,
        justification: formText,
      };
      if (form === "suspend") body.duration = formDuration;
      const res = await fetch(`/api/users/${encodeURIComponent(pubkey)}/${form}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 200) {
        setNotice(`${ACTION_LABEL[form]} — OK (2xx). Fiche rejetée depuis le serveur.`);
        setForm(null);
        setFormText("");
        await refetch(pubkey);
        return;
      }
      if (res.status === 422) setFormError(respBody.error ?? "Justification invalide (≥ 20 caractères).");
      else if (res.status === 400) setFormError(respBody.error ?? "Paramètre invalide.");
      else if (res.status === 502) setFormError("Backend injoignable — action non appliquée, réessayez.");
      else if (res.status === 401 || res.status === 403)
        setFormError("Refusé par le serveur (401/403) — vérifiez la session et le rôle (moderator requis).");
      else setFormError(respBody.error ?? `Erreur HTTP ${res.status}.`);
      await refetch(pubkey); // même sur erreur : l'état suit le serveur
    } catch {
      setFormError("App principale injoignable — action non appliquée.");
      await refetch(pubkey);
    } finally {
      setActing(false);
    }
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
        {state.code === "notfound" && (
          <>
            <p className="font-semibold">Utilisateur introuvable</p>
            <p className="mt-1">Ce compte n&apos;existe pas (ou plus) sur le réseau.</p>
          </>
        )}
        {state.code === "backend-unreachable" && (
          <>
            <p className="font-semibold">Backend injoignable</p>
            <p className="mt-1">L&apos;app principale ne répond pas — fiche indisponible.</p>
          </>
        )}
        {state.code === "forbidden" && (
          <>
            <p className="font-semibold">Accès refusé</p>
            <p className="mt-1">
              Votre rôle ({role}) ne permet pas la consultation des fiches (support
              minimum — arbitrage §12.17).
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
    );
  }

  const f = state.data;

  return (
    <div className="flex flex-col gap-4">
      {/* ── entête : identité publique + statut ── */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-zinc-900" data-testid="fiche-pseudo">
            {f.user.pseudo}
          </h2>
          {f.user.status === "banni" ? (
            <span
              data-testid="fiche-statut"
              className="inline-flex min-h-6 items-center rounded-full border border-red-400 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900"
            >
              banni définitivement {f.user.bannedAt ? `— depuis ${fmt(f.user.bannedAt)}` : ""} · four-eyes
            </span>
          ) : f.user.status === "suspendu" ? (
            <span
              data-testid="fiche-statut"
              className="inline-flex min-h-6 items-center rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-800"
            >
              suspendu {f.user.suspendedUntil ? `— jusqu'au ${fmt(f.user.suspendedUntil)}` : "— levée manuelle"}
            </span>
          ) : (
            <span
              data-testid="fiche-statut"
              className="inline-flex min-h-6 items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800"
            >
              actif
            </span>
          )}
          <span className="ml-auto font-mono text-[11px] text-zinc-400" title="Pubkey (identité publique)">
            {f.user.pubkey.slice(0, 16)}…
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-600">{f.user.bio ?? "Aucune bio publique."}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4" data-testid="fiche-compteurs">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
            <dt className="text-zinc-500">Inscrit le</dt>
            <dd className="mt-0.5 font-semibold text-zinc-800">{fmt(f.user.createdAt)}</dd>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
            <dt className="text-zinc-500">Posts publiés</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-zinc-800">{f.counts.posts}</dd>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
            <dt className="text-zinc-500">Reports ouverts</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-zinc-800">{f.counts.openReports}</dd>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
            <dt className="text-zinc-500">Avertissements</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-zinc-800">{f.counts.warnings}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-zinc-400">
          Données strictement publiques ou opératoires — aucun email, aucune IP,
          aucun contenu de message privé (invariants §1, directive Étape 7).
        </p>
      </div>

      <p className="text-xs text-zinc-500" aria-live="polite" data-testid="fiche-notice">
        {refreshing
          ? "Rejet en cours depuis le serveur…"
          : (notice ?? `Fiche servie à ${fmt(state.fetchedAt)} — toute action reflète le retour serveur (invariant §1.8).`)}
      </p>

      {/* ── actions (moderator+) ── */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm" data-testid="fiche-actions">
        <h3 className="text-sm font-semibold text-zinc-900">Actions de modération</h3>
        {!canModerate && (
          <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600">
            Votre rôle ({role}) est en lecture seule sur cette fiche — warn/suspend
            exigent moderator (arbitrage §13.1, directive Étape 7).
          </p>
        )}
        {canModerate && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setForm("warn");
                setFormError(null);
              }}
              disabled={acting}
              className="min-h-11 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              data-testid="btn-warn"
            >
              Avertir
            </button>
            <button
              type="button"
              onClick={() => {
                setForm("suspend");
                setFormError(null);
              }}
              disabled={acting}
              className="min-h-11 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900 hover:bg-orange-100 disabled:opacity-50"
              data-testid="btn-suspend"
            >
              Suspendre…
            </button>
            {f.user.status === "suspendu" && (
              <button
                type="button"
                onClick={() => {
                  setForm("unsuspend");
                  setFormError(null);
                }}
                disabled={acting}
                className="min-h-11 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                data-testid="btn-unsuspend"
              >
                Lever la suspension
              </button>
            )}
            {/* É9 four-eyes — ACTIF pour super-admin : crée une INTENTION
                (jamais d'exécution directe). Pour un non-super-admin : grisé. */}
            {canRequestFourEyes && f.user.status !== "banni" ? (
              <button
                type="button"
                onClick={() => {
                  setForm("ban_user");
                  setFormError(null);
                }}
                disabled={acting}
                title="Crée une intention — un SECOND super-admin doit approuver dans l'heure"
                className="min-h-11 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
                data-testid="btn-ban"
              >
                Ban définitif…
              </button>
            ) : (
              <button
                type="button"
                disabled
                aria-disabled="true"
                title={
                  f.user.status === "banni"
                    ? "Compte déjà banni définitivement — pas de unban UI (§5)"
                    : "four-eyes : création ET approbation réservées au super-admin"
                }
                className="min-h-11 cursor-not-allowed rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 opacity-50"
                data-testid="btn-ban"
              >
                Ban définitif…
              </button>
            )}
            <span className="text-[11px] text-zinc-500">
              {canRequestFourEyes
                ? "Ban définitif : INTENTION créée ici — approuvée par un second super-admin sur /pending-actions (1 h)."
                : "Ban définitif : réservé au super-admin — four-eyes Étape 9."}
            </span>
          </div>
        )}

        {form && (canModerate || (form === "ban_user" && canRequestFourEyes)) && (
          <div className="mt-3 rounded-md border border-zinc-300 bg-zinc-50 p-3" data-testid="justification-form">
            <p className="text-xs font-semibold text-zinc-700">
              {form === "ban_user"
                ? "Demander un ban — justification ≥ 20 caractères (l'intention sera approvée par un second super-admin — four-eyes É9)"
                : `${ACTION_LABEL[form]} — justification obligatoire (ADMIN-RBAC §6)`}
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
              {form === "suspend" && (
                <label className="grid gap-1 text-xs text-zinc-600">
                  Durée
                  <select
                    value={formDuration}
                    onChange={(e) => setFormDuration(e.target.value as typeof formDuration)}
                    className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  >
                    <option value="24h">24 h</option>
                    <option value="7d">7 j</option>
                    <option value="30d">30 j</option>
                  </select>
                </label>
              )}
            </div>
            <textarea
              value={formText}
              onChange={(e) => setFormText(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Texte de justification (≥ 20 caractères) — sert la décision ET la notification utilisateur pour warn"
              className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              aria-label="Texte de justification"
            />
            {formError && (
              <p className="mt-2 text-xs font-medium text-red-700" role="alert" data-testid="form-error">
                {formError}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                disabled={acting}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void submitAction()}
                disabled={acting || formText.trim().length < 20}
                className="min-h-11 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
                data-testid="btn-confirm-action"
              >
                {acting
                  ? "En attente du serveur…"
                  : form === "ban_user"
                    ? "Enregistrer l'intention (attend le serveur)"
                    : "Confirmer (attend le serveur)"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── reports ouverts (lien queue) ── */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">
            Reports ouverts reçus ({f.counts.openReports})
          </h3>
          <Link href="/queue" className="text-xs font-medium text-zinc-600 underline hover:text-zinc-900">
            Traiter dans la file →
          </Link>
        </div>
        {f.openReports.items.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-500">Aucun report ouvert sur les contenus de ce compte.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {f.openReports.items.map((r) => (
              <li key={r.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 font-medium text-zinc-700">
                    {r.targetKind === "comment" ? "commentaire" : "post"}
                  </span>
                  <span className="font-medium text-zinc-800">motif {r.reason}</span>
                  <span className="text-zinc-500">{fmt(r.createdAt)}</span>
                  {r.postHiddenAt && (
                    <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-800">
                      déjà masqué
                    </span>
                  )}
                </div>
                {r.postSnippet && <p className="mt-1 text-zinc-700">«{r.postSnippet}»</p>}
                {r.details && <p className="mt-1 italic text-zinc-500">contexte : {r.details}</p>}
              </li>
            ))}
            {f.openReports.hasMore && (
              <li className="text-xs text-zinc-500">
                … et d&apos;autres — voir la file (10 affichés).
              </li>
            )}
          </ul>
        )}
      </div>

      {/* ── historique admin (AdminAudit targetType='user') ── */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm" data-testid="fiche-audit">
        <h3 className="text-sm font-semibold text-zinc-900">
          Historique des actions admin ({f.counts.auditEntries})
        </h3>
        {f.audit.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-500">Aucune action admin sur ce compte.</p>
        ) : (
          <ul className="mt-2 flex max-h-96 flex-col gap-2 overflow-y-auto scrollbar-thin">
            {f.audit.map((a) => (
              <li key={a.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 font-mono font-medium text-zinc-800">
                    {a.action}
                  </span>
                  <span className="text-zinc-500">par {a.actorRole}</span>
                  <span className="text-zinc-500">{fmt(a.createdAt)}</span>
                </div>
                {a.justification && <p className="mt-1 text-zinc-700">{a.justification}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
