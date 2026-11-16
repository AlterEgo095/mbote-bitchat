"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PostDetailView — fiche d'un contenu public (back-office 2026-11).
//
// INVARIANT §1.8 (ADMIN-RBAC.md) : toute action attend le retour serveur 2xx
// puis RECHARGE la fiche depuis le backend — zéro update optimiste.
//
// Actions (mêmes sémantiques que la queue — UNE seule définition côté serveur) :
//   - masquer / démasquer → POST /api/admin/moderation/action (BFF Étape 6)
//     {action, targetKind:"post", targetId, category, justification §6}
//     — RBAC par action côté app principale (hide/unhide = moderator) ;
//   - PURGE (irréversible) → JAMAIS en direct : intention four-eyes É9
//     POST /api/pending-actions {actionType:"purge_post", …} — super-admin
//     UNIQUEMENT, approbation par un second admin DISTINCT (id + session).
//
// Périmètre : fil public UNIQUEMENT — DM/groupes MLS E2EE (invariant §1.4).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-base";

export interface PostFiche {
  post: {
    id: string;
    content: string;
    geohash: string | null;
    precision: number | null;
    parentId: string | null;
    origin: string;
    meshHops: number;
    likeCount: number;
    replyCount: number;
    hiddenAt: string | null;
    hiddenById: number | null;
    createdAt: string;
    hasSignature: boolean;
  };
  author: {
    pubkey: string;
    nickname: string;
    createdAt: string;
    suspendedAt: string | null;
    suspendedUntil: string | null;
    bannedAt: string | null;
    reputationScore: number;
    flaggedCount: number;
  };
  parent: {
    id: string;
    content: string;
    hiddenAt: string | null;
    createdAt: string;
    author: { pubkey: string; nickname: string };
  } | null;
  reports: Array<{
    id: string;
    reporterKey: string;
    reason: string;
    details: string | null;
    status: string;
    createdAt: string;
    handledAt: string | null;
  }>;
  openReports: number;
  replies: Array<{
    id: string;
    content: string;
    createdAt: string;
    hiddenAt: string | null;
    author: { pubkey: string; nickname: string };
  }>;
  moderationActions: Array<{
    id: number;
    action: string;
    actorLabel: string;
    reason: string | null;
    meta: string | null;
    createdAt: string;
  }>;
}

export type PostDetailLoadState =
  | { kind: "ready"; data: PostFiche; fetchedAt: string }
  | {
      kind: "error";
      code:
        | "backend-unreachable"
        | "forbidden"
        | "unauthorized"
        | "http"
        | "notfound";
      httpStatus?: number;
    };

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

const CATEGORIES = ["SPAM", "HARASSMENT", "SCAM", "CSAM", "OTHER"] as const;

type ContentAction = "hide" | "unhide" | "purge";

const ACTION_LABEL: Record<ContentAction, string> = {
  hide: "Masquer",
  unhide: "Démasquer",
  purge: "Demander la purge (four-eyes)",
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

function authorStatus(a: PostFiche["author"]): { label: string; cls: string } {
  if (a.bannedAt) return { label: "banni (É9)", cls: "border-red-300 bg-red-50 text-red-800" };
  const suspendedActive =
    a.suspendedAt !== null && (a.suspendedUntil === null || new Date(a.suspendedUntil).getTime() > Date.now());
  if (suspendedActive) return { label: "suspendu", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  return { label: "actif", cls: "border-emerald-300 bg-emerald-50 text-emerald-800" };
}

export function PostDetailView({
  role,
  csrfToken,
  postId,
  initial,
}: {
  role: string;
  csrfToken: string;
  postId: string;
  initial: PostDetailLoadState;
}) {
  const [state, setState] = useState<PostDetailLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ContentAction | null>(null);
  const [formCategory, setFormCategory] = useState<(typeof CATEGORIES)[number]>("SPAM");
  const [formText, setFormText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const level = ROLE_LEVEL[role] ?? 0;
  const canModerate = level >= ROLE_LEVEL.moderator;
  const canFourEyes = role === "super-admin";

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch(`/api/posts/${encodeURIComponent(postId)}`, { cache: "no-store" });
      if (res.status === 404) {
        setState({ kind: "error", code: "notfound" });
        return;
      }
      if (res.status === 401) {
        setState({ kind: "error", code: "unauthorized" });
        return;
      }
      if (res.status === 403) {
        setState({ kind: "error", code: "forbidden" });
        return;
      }
      if (res.status === 502 || !res.ok) {
        // fiche déjà chargée : on garde les données et on signale la dégradation
        setError("Backend injoignable — fiche non rafraîchie, réessayez.");
        return;
      }
      const data = (await res.json()) as PostFiche;
      if (!data || !data.post) {
        setError("Réponse inattendue du serveur — fiche non rafraîchie.");
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
    } catch {
      setError("Backend injoignable — fiche non rafraîchie, réessayez.");
    } finally {
      setRefreshing(false);
    }
  }, [postId]);

  function openForm(action: ContentAction) {
    setForm(action);
    setFormCategory("SPAM");
    setFormText("");
    setFormError(null);
  }

  async function submitAction() {
    if (!form) return;
    const action = form;
    setActing(true);
    setFormError(null);
    setError(null);
    try {
      const body =
        action === "purge"
          ? { actionType: "purge_post", targetId: postId, category: formCategory, justification: formText.trim() }
          : { action, targetKind: "post", targetId: postId, category: formCategory, justification: formText.trim() };
      const res = await apiFetch(
        action === "purge" ? "/api/pending-actions" : "/api/admin/moderation/action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
          body: JSON.stringify(body),
        }
      );
      const respBody = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 200 || res.status === 201) {
        if (action === "purge") {
          setNotice(
            "Intention de purge CRÉÉE (four-eyes) — elle attend l'approbation d'un SECOND admin distinct dans l'heure (page Four-eyes). Le contenu reste visible jusqu'à exécution."
          );
        } else {
          setNotice(
            `${ACTION_LABEL[action]} — OK (2xx). Fiche rechargée depuis le serveur ; l'action est tracée (ModerationAction + AdminAudit).`
          );
        }
        setForm(null);
        setFormText("");
        await reload();
        return;
      }
      if (res.status === 422) setFormError(respBody.error ?? "Justification invalide (catégorie + ≥ 20 caractères).");
      else if (res.status === 409) setFormError(respBody.error ?? "Conflit — le contenu a peut-être déjà été traité, rechargez.");
      else if (res.status === 410) setFormError(respBody.error ?? "Intention expirée — recréez-la.");
      else if (res.status === 502) setFormError("Backend injoignable — action non appliquée, réessayez.");
      else if (res.status === 401 || res.status === 403) setFormError("Refus du serveur (session ou rôle insuffisant pour cette action).");
      else setFormError(respBody.error ?? `Erreur HTTP ${res.status} — réessayez.`);
    } catch {
      setFormError("Backend injoignable — action non appliquée, réessayez.");
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">La fiche est indisponible — réessayez après rétablissement de la liaison.</p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">Votre rôle ne permet pas la consultation des contenus (support minimum).</p>
            </>
          )}
          {state.code === "unauthorized" && (
            <>
              <p className="font-semibold">Session expirée</p>
              <p className="mt-1">Reconnectez-vous depuis la page d&apos;authentification.</p>
            </>
          )}
          {state.code === "notfound" && (
            <>
              <p className="font-semibold">Contenu introuvable</p>
              <p className="mt-1">
                La ligne n&apos;existe plus (purge) — les traces restent dans l&apos;audit.
              </p>
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
          <p className="text-xs text-zinc-500" aria-live="polite">
            {notice ?? error ?? `Fiche servie à ${fmt(state.fetchedAt)} — périmètre : fil public uniquement (DM/groupes E2EE hors de portée, par conception).`}
          </p>

          {/* ── contenu ── */}
          <section aria-labelledby="post-content-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="post-content-heading" className="text-base font-semibold text-zinc-900">
                Contenu
              </h2>
              <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600">
                {state.data.post.parentId ? "commentaire" : "publication"}
              </span>
              <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600">
                origine {state.data.post.origin === "mesh" ? `mesh (${state.data.post.meshHops} saut(s))` : "web"}
              </span>
              {state.data.post.hiddenAt ? (
                <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
                  masqué {fmt(state.data.post.hiddenAt)}
                </span>
              ) : (
                <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
                  visible au fil public
                </span>
              )}
              {state.data.openReports > 0 && (
                <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
                  {state.data.openReports} signalement{state.data.openReports > 1 ? "s" : ""} ouvert{state.data.openReports > 1 ? "s" : ""}
                </span>
              )}
            </div>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm text-zinc-900">
              {state.data.post.content}
            </p>
            <p className="mt-3 text-xs text-zinc-500">
              id <span className="font-mono">{state.data.post.id}</span> · publié{" "}
              {fmt(state.data.post.createdAt)} · {state.data.post.likeCount} j&apos;aime ·{" "}
              {state.data.post.replyCount} réponse{state.data.post.replyCount > 1 ? "s" : ""}
              {state.data.post.geohash ? ` · canal ${state.data.post.geohash}` : ""}
              {state.data.post.hasSignature ? " · signature ECDSA présente" : " · sans signature"}
            </p>
          </section>

          {/* ── auteur ── */}
          <section aria-labelledby="post-author-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="post-author-heading" className="text-base font-semibold text-zinc-900">
              Auteur
            </h2>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-zinc-500">Pseudo</dt>
              <dd className="font-medium text-zinc-900">{state.data.author.nickname}</dd>
              <dt className="text-zinc-500">Pubkey</dt>
              <dd className="break-all font-mono text-xs text-zinc-700">{state.data.author.pubkey}</dd>
              <dt className="text-zinc-500">Statut</dt>
              <dd>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${authorStatus(state.data.author).cls}`}>
                  {authorStatus(state.data.author).label}
                </span>
              </dd>
              <dt className="text-zinc-500">Réputation (D2)</dt>
              <dd className="tabular-nums text-zinc-700">
                {state.data.author.reputationScore} · {state.data.author.flaggedCount} action(s) confirmée(s)
              </dd>
            </dl>
            <div className="mt-3">
              <Link
                href={`/users/${encodeURIComponent(state.data.author.pubkey)}`}
                className="inline-block rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
              >
                Ouvrir la fiche utilisateur →
              </Link>
            </div>
          </section>

          {/* ── parent (si commentaire) ── */}
          {state.data.parent && (
            <section aria-labelledby="post-parent-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
              <h2 id="post-parent-heading" className="text-base font-semibold text-zinc-900">
                En réponse à
              </h2>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-800">
                {state.data.parent.content}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                {state.data.parent.author.nickname} · {fmt(state.data.parent.createdAt)}
                {state.data.parent.hiddenAt ? " · (masqué)" : ""}
              </p>
              <div className="mt-3">
                <Link
                  href={`/posts/${encodeURIComponent(state.data.parent.id)}`}
                  className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900"
                >
                  Voir le contenu parent →
                </Link>
              </div>
            </section>
          )}

          {/* ── signalements ── */}
          <section aria-labelledby="post-reports-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="post-reports-heading" className="text-base font-semibold text-zinc-900">
              Signalements ({state.data.reports.length})
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Tous statuts — ouvert / traité (actioned) / clos sans action (dismissed).
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {state.data.reports.length === 0 && (
                <li className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
                  Aucun signalement sur ce contenu.
                </li>
              )}
              {state.data.reports.map((r) => (
                <li key={r.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`rounded-full border px-2 py-0.5 font-medium ${
                        r.status === "open"
                          ? "border-red-300 bg-red-50 text-red-800"
                          : "border-zinc-300 bg-white text-zinc-600"
                      }`}
                    >
                      {r.status}
                    </span>
                    <span className="font-medium text-zinc-800">motif : {r.reason}</span>
                    <span className="text-zinc-500">signalé {fmt(r.createdAt)}</span>
                    <span className="font-mono text-zinc-400" title={r.reporterKey}>
                      par {r.reporterKey.slice(0, 10)}…
                    </span>
                  </div>
                  {r.details && <p className="mt-1 text-xs text-zinc-600">{r.details}</p>}
                </li>
              ))}
            </ul>
          </section>

          {/* ── réponses ── */}
          <section aria-labelledby="post-replies-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="post-replies-heading" className="text-base font-semibold text-zinc-900">
              Réponses ({state.data.replies.length} — 50 max)
            </h2>
            <ul className="mt-3 flex flex-col gap-2">
              {state.data.replies.length === 0 && (
                <li className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
                  Aucune réponse.
                </li>
              )}
              {state.data.replies.map((r) => (
                <li key={r.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-zinc-800">{r.author.nickname}</span>
                    <span className="font-mono text-zinc-400" title={r.author.pubkey}>
                      {r.author.pubkey.slice(0, 10)}…
                    </span>
                    <span className="text-zinc-500">{fmt(r.createdAt)}</span>
                    {r.hiddenAt && (
                      <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 font-medium text-red-800">
                        masqué
                      </span>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-zinc-800">{r.content}</p>
                  <Link
                    href={`/posts/${encodeURIComponent(r.id)}`}
                    className="mt-1 inline-block text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                  >
                    Fiche du commentaire →
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          {/* ── historique de modération ── */}
          <section aria-labelledby="post-history-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="post-history-heading" className="text-base font-semibold text-zinc-900">
              Historique de modération ({state.data.moderationActions.length} — 20 derniers)
            </h2>
            <ul className="mt-3 flex flex-col gap-2">
              {state.data.moderationActions.length === 0 && (
                <li className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
                  Aucune action sur ce contenu.
                </li>
              )}
              {state.data.moderationActions.map((m) => (
                <li key={m.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 font-medium text-zinc-700">
                      {m.action}
                    </span>
                    <span className="font-medium text-zinc-800">{m.actorLabel}</span>
                    <span className="text-zinc-500">{fmt(m.createdAt)}</span>
                  </div>
                  {m.reason && <p className="mt-1 text-xs text-zinc-600">justification : {m.reason}</p>}
                </li>
              ))}
            </ul>
          </section>

          {/* ── actions ── */}
          <section aria-labelledby="post-actions-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="post-actions-heading" className="text-base font-semibold text-zinc-900">
              Actions
            </h2>
            {!canModerate ? (
              <p className="mt-2 text-sm text-zinc-600">
                Votre rôle ({role}) autorise la lecture seule des contenus —
                masquer / démasquer exige <strong>moderator</strong> minimum
                (RBAC §4 ; la règle est ré-imposée par l&apos;app principale, 403).
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => openForm("hide")}
                  disabled={state.data.post.hiddenAt !== null}
                  className="min-h-11 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Masquer du fil public
                </button>
                <button
                  type="button"
                  onClick={() => openForm("unhide")}
                  disabled={state.data.post.hiddenAt === null}
                  className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Démasquer
                </button>
                {canFourEyes ? (
                  <button
                    type="button"
                    onClick={() => openForm("purge")}
                    className="min-h-11 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100"
                  >
                    Demander la purge (four-eyes)
                  </button>
                ) : (
                  <span className="inline-flex items-center text-xs text-zinc-500">
                    purge : réservée super-admin via four-eyes (É9)
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              Masquer = disparition du fil public, contenu CONSERVÉ en base pour
              l&apos;audit. Purge = suppression définitive (cascade réponses + likes),
              réservée aux actions irréversibles sous FOUR-EYES (É9) : intention
              créée ici, exécution uniquement après approbation d&apos;un second
              admin distinct dans l&apos;heure.
            </p>

            {/* ── formulaire de justification (§6) ── */}
            {form && (
              <div className="mt-3 rounded-md border border-zinc-300 bg-zinc-50 p-3" data-testid="justification-form">
                <p className="text-xs font-semibold text-zinc-700">
                  {ACTION_LABEL[form]} — justification obligatoire (ADMIN-RBAC §6)
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
                </div>
                <textarea
                  value={formText}
                  onChange={(e) => setFormText(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder={
                    form === "purge"
                      ? "Justification (≥ 20 caractères) — figée dans l'intention four-eyes"
                      : "Justification (≥ 20 caractères) — stockée « CATÉGORIE: texte » dans l'audit append-only"
                  }
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
                    disabled={acting || formText.trim().length < 20}
                    className="min-h-11 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {acting ? "Envoi…" : "Confirmer (attend le serveur)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setForm(null);
                      setFormError(null);
                      setFormText("");
                    }}
                    disabled={acting}
                    className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    Annuler
                  </button>
                  <span className="text-xs text-zinc-500">{formText.trim().length}/20 min</span>
                </div>
              </div>
            )}
          </section>

          <div className="flex items-center justify-between">
            <Link
              href="/posts"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              ← Annuaire des contenus
            </Link>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={refreshing}
              className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
            >
              {refreshing ? "Chargement…" : "Rafraîchir la fiche"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
