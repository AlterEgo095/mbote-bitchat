"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GroupDetailView — fiche d'un groupe MLS (back-office 2026-11, MÉTADONNÉES
// ONLY).
//
// INVARIANT NON NÉGOCIABLE (ADMIN-RBAC §1.4) : les contenus de groupe sont
// chiffrés MLS — cette fiche n'affiche que le shell (nom, mlsGroupId,
// créateur), l'annuaire des MEMBRES (join/leave) et les MÉTADONNÉES des
// derniers messages / enveloppes MLS (expéditeur, epoch, taille du payload).
// AUCUN ciphertext n'est transporté, donc rien à déchiffrer ici.
//
// INVARIANT §1.8 : la fiche est TOUJOURS rechargée depuis le serveur — zéro
// update optimiste. La purge des contenus chiffrés est JAMAIS en direct :
// intention four-eyes É9 POST /api/pending-actions
// {actionType:"purge_group_messages"} — super-admin UNIQUEMENT (bouton gated
// par rôle, ré-imposé côté serveur), approbation par un second admin distinct
// dans l'heure ; shell + membres CONSERVÉS, seuls les ciphertexts disparaissent.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-base";

// ── Catégories de justification §6 (enum fermé, miroir app principale) ──
const CATEGORIES = ["SPAM", "HARASSMENT", "SCAM", "CSAM", "OTHER"] as const;
type PurgeCategory = (typeof CATEGORIES)[number];

// ── Types (contrat backend /api/internal/admin/groups/[id]) ──

export interface GroupFiche {
  group: {
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
    updatedAt: string;
  };
  members: Array<{
    userKey: string;
    joinedAt: string;
    leftAt: string | null;
    mlsLeafIndex: number | null;
  }>;
  recentMessages: Array<{
    id: string;
    senderKey: string;
    mlsEpoch: number | string;
    createdAt: string;
    bytes: number;
  }>;
  recentEnvelopes: Array<{
    id: string;
    kind: "commit" | "welcome" | string;
    targetKey: string | null;
    createdAt: string;
    bytes: number;
  }>;
  e2ee: boolean;
}

export type GroupDetailLoadState =
  | { kind: "ready"; data: GroupFiche; fetchedAt: string }
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

/** Taille de ciphertext/payload LISIBLE — compteur, jamais de contenu. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} Go`;
}

/** Clé publique / identifiant tronqué (mono). */
function shortKey(k: string, max = 12): string {
  return k.length <= max ? k : `${k.slice(0, max)}…`;
}

export function GroupDetailView({
  role,
  csrfToken,
  groupId,
  initial,
}: {
  role: string;
  csrfToken: string;
  groupId: string;
  initial: GroupDetailLoadState;
}) {
  const [state, setState] = useState<GroupDetailLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // four-eyes : formulaire de justification (super-admin uniquement)
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeText, setPurgeText] = useState("");
  const [purgeCategory, setPurgeCategory] = useState<PurgeCategory>("SPAM");
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  const canFourEyes = role === "super-admin";

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}`, { cache: "no-store" });
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
      const data = (await res.json()) as GroupFiche;
      if (!data || !data.group) {
        setError("Réponse inattendue du serveur — fiche non rafraîchie.");
        return;
      }
      setState({ kind: "ready", data, fetchedAt: new Date().toISOString() });
    } catch {
      setError("Backend injoignable — fiche non rafraîchie, réessayez.");
    } finally {
      setRefreshing(false);
    }
  }, [groupId]);

  async function submitPurge() {
    setPurging(true);
    setPurgeError(null);
    setError(null);
    try {
      const res = await apiFetch("/api/pending-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-csrf": csrfToken },
        body: JSON.stringify({
          actionType: "purge_group_messages",
          targetId: groupId,
          category: purgeCategory,
          justification: purgeText.trim(),
        }),
      });
      const respBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        pendingAction?: { id: number; expiresAt: string; status: string };
      };
      if ((res.status === 200 || res.status === 201) && respBody.pendingAction) {
        setNotice(
          `Intention de purge #${respBody.pendingAction.id} CRÉÉE (four-eyes) — statut ${respBody.pendingAction.status}, expires ${fmt(respBody.pendingAction.expiresAt)}. Elle attend l'approbation d'un SECOND admin distinct (page Four-eyes) ; le shell du groupe et ses membres sont CONSERVÉS, seuls les ciphertexts seront détruits à l'exécution.`
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

  return (
    <div className="flex flex-col gap-4">
      {/* ── BANDEAU E2EE — rappel permanent du périmètre (invariant §1.4) ── */}
      <div
        role="note"
        className="rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-3 text-sm font-medium text-zinc-800"
      >
        Chiffré E2EE — l&apos;admin ne voit <strong>AUCUN contenu</strong>, uniquement
        des métadonnées (invariant §1.4). Messages et enveloppes MLS restent
        illisibles côté serveur : cette fiche n&apos;expose que des compteurs et des
        tailles.
      </div>

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
              <p className="mt-1">Votre rôle ne permet pas la consultation des groupes (support minimum).</p>
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
              <p className="font-semibold">Groupe introuvable</p>
              <p className="mt-1">
                Le groupe n&apos;existe plus — les traces d&apos;administration restent dans l&apos;audit.
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
            {notice ?? error ?? `Fiche servie à ${fmt(state.fetchedAt)} — périmètre : métadonnées MLS uniquement.`}
          </p>

          {/* ── infos groupe ── */}
          <section aria-labelledby="group-info-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="group-info-heading" className="text-base font-semibold text-zinc-900">
                {state.data.group.name}
              </h2>
              <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600">
                groupe MLS
              </span>
              <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600">
                E2EE — métadonnées
              </span>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-zinc-500">mlsGroupId</dt>
              <dd className="break-all font-mono text-xs text-zinc-700" title={state.data.group.mlsGroupId}>
                {state.data.group.mlsGroupId}
              </dd>
              <dt className="text-zinc-500">Créateur</dt>
              <dd className="break-all font-mono text-xs text-zinc-700" title={state.data.group.creatorKey}>
                {state.data.group.creatorKey}
              </dd>
              <dt className="text-zinc-500">Membres</dt>
              <dd className="tabular-nums text-zinc-700">
                <span className="font-semibold text-emerald-800">{state.data.group.activeMemberCount}</span>
                <span className="text-zinc-400"> actifs / {state.data.group.memberCount} total</span>
              </dd>
              <dt className="text-zinc-500">Contenus chiffrés</dt>
              <dd className="tabular-nums text-zinc-700">
                {state.data.group.messageCount} message{state.data.group.messageCount > 1 ? "s" : ""} ·{" "}
                {state.data.group.envelopeCount} enveloppe{state.data.group.envelopeCount > 1 ? "s" : ""} MLS
              </dd>
              <dt className="text-zinc-500">Dernier message</dt>
              <dd className="text-zinc-700">{fmt(state.data.group.lastMessageAt)}</dd>
              <dt className="text-zinc-500">Créé</dt>
              <dd className="text-zinc-700">{fmt(state.data.group.createdAt)}</dd>
              <dt className="text-zinc-500">Mis à jour</dt>
              <dd className="text-zinc-700">{fmt(state.data.group.updatedAt)}</dd>
              <dt className="text-zinc-500">id interne</dt>
              <dd className="break-all font-mono text-xs text-zinc-500">{state.data.group.id}</dd>
            </dl>
          </section>

          {/* ── membres ── */}
          <section aria-labelledby="group-members-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="group-members-heading" className="text-base font-semibold text-zinc-900">
              Membres ({state.data.members.length} — annuaire join/leave)
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              L&apos;état TreeKEM réel vit côté client — mlsLeafIndex n&apos;est qu&apos;un
              diagnostic d&apos;ajout. leftAt vide = membre actif.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Membres du groupe — statut et dates d&apos;arrivée/départ</caption>
                <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Clé utilisateur</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Statut</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Arrivé</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Parti</th>
                    <th scope="col" className="py-2 font-medium">Leaf index</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {state.data.members.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-sm text-zinc-600">
                        Aucun membre enregistré.
                      </td>
                    </tr>
                  )}
                  {state.data.members.map((m) => (
                    <tr key={`${m.userKey}-${m.joinedAt}`} className="text-xs">
                      <td className="break-all py-2 pr-3 font-mono text-zinc-700" title={m.userKey}>
                        {shortKey(m.userKey, 16)}
                      </td>
                      <td className="py-2 pr-3">
                        {m.leftAt === null ? (
                          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800">
                            actif
                          </span>
                        ) : (
                          <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 font-medium text-zinc-500">
                            exclu / parti
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-zinc-600">{fmt(m.joinedAt)}</td>
                      <td className="py-2 pr-3 text-zinc-600">{m.leftAt ? fmt(m.leftAt) : "—"}</td>
                      <td className="tabular-nums py-2 text-zinc-500">
                        {m.mlsLeafIndex === null ? "—" : m.mlsLeafIndex}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 50 derniers messages (métadonnées uniquement) ── */}
          <section aria-labelledby="group-messages-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="group-messages-heading" className="text-base font-semibold text-zinc-900">
              Messages récents ({state.data.recentMessages.length} — 50 max, métadonnées)
            </h2>
            <ul className="mt-3 flex flex-col gap-1.5">
              {state.data.recentMessages.length === 0 && (
                <li className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
                  Aucun message chiffré sur ce groupe.
                </li>
              )}
              {state.data.recentMessages.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs"
                >
                  <span className="font-mono text-zinc-700" title={m.senderKey}>
                    {shortKey(m.senderKey)}
                  </span>
                  <span className="text-zinc-500">epoch {m.mlsEpoch}</span>
                  <span className="text-zinc-500">{fmt(m.createdAt)}</span>
                  <span className="tabular-nums text-zinc-500">{fmtBytes(m.bytes)}</span>
                  <span className="ml-auto font-mono text-zinc-400" title={m.id}>
                    {shortKey(m.id, 10)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* ── 20 dernières enveloppes MLS (handshake) ── */}
          <section aria-labelledby="group-envelopes-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="group-envelopes-heading" className="text-base font-semibold text-zinc-900">
              Enveloppes MLS ({state.data.recentEnvelopes.length} — 20 max)
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Handshake TreeKEM — commits (rotation de clés) et welcomes (ajouts).
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {state.data.recentEnvelopes.length === 0 && (
                <li className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
                  Aucune enveloppe MLS sur ce groupe.
                </li>
              )}
              {state.data.recentEnvelopes.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs"
                >
                  <span
                    className={`rounded-full border px-2 py-0.5 font-medium ${
                      e.kind === "commit"
                        ? "border-zinc-400 bg-zinc-100 text-zinc-700"
                        : "border-emerald-300 bg-emerald-50 text-emerald-800"
                    }`}
                  >
                    {e.kind}
                  </span>
                  {e.targetKey ? (
                    <span className="font-mono text-zinc-600" title={e.targetKey}>
                      cible {shortKey(e.targetKey, 12)}
                    </span>
                  ) : (
                    <span className="text-zinc-400">sans cible</span>
                  )}
                  <span className="text-zinc-500">{fmt(e.createdAt)}</span>
                  <span className="tabular-nums text-zinc-500">{fmtBytes(e.bytes)}</span>
                  <span className="ml-auto font-mono text-zinc-400" title={e.id}>
                    {shortKey(e.id, 10)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* ── actions ── */}
          <section aria-labelledby="group-actions-heading" className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 id="group-actions-heading" className="text-base font-semibold text-zinc-900">
              Actions
            </h2>
            {canFourEyes ? (
              <button
                type="button"
                onClick={() => {
                  setPurgeOpen((v) => !v);
                  setPurgeError(null);
                }}
                className="min-h-11 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100"
              >
                Purger les contenus chiffrés (four-eyes)
              </button>
            ) : (
              <p className="mt-1 text-sm text-zinc-600">
                Votre rôle ({role}) autorise la lecture seule des métadonnées —
                la purge est réservée <strong>super-admin</strong> via four-eyes
                (É9 ; la règle est ré-imposée par l&apos;app principale, 403).
              </p>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              Purge = suppression définitive des ciphertexts (messages + enveloppes
              MLS), IRRÉVERSIBLE, sous FOUR-EYES (É9) : intention créée ici, le
              shell du groupe et ses membres sont CONSERVÉS, exécution uniquement
              après approbation d&apos;un second admin distinct dans l&apos;heure.
            </p>

            {/* ── formulaire de justification (§6) ── */}
            {purgeOpen && canFourEyes && (
              <div className="mt-3 rounded-md border border-zinc-300 bg-zinc-50 p-3">
                <p className="text-xs font-semibold text-zinc-700">
                  Purge des contenus chiffrés — justification obligatoire (ADMIN-RBAC §6)
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="grid gap-1 text-xs text-zinc-600">
                    Catégorie
                    <select
                      value={purgeCategory}
                      onChange={(e) => setPurgeCategory(e.target.value as PurgeCategory)}
                      className="min-h-11 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      aria-label="Catégorie de justification de la purge du groupe"
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
                  aria-label="Texte de justification de la purge des contenus du groupe"
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
          </section>

          <div className="flex items-center justify-between">
            <Link
              href="/groups"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              ← Annuaire des groupes
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
