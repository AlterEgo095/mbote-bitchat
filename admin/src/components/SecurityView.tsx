"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SecurityView — tableau de bord SÉCURITÉ, READ-ONLY (back-office 2026-11).
//
// AUCUN bouton d'action : cette vue constate, elle n'agit pas. Elle assemble
// les gardes défensives du backend : clés de chiffrement vérifiées entre
// pairs (TOFU), blocs déclarés par les clients, gardes anti-rejeu (seq par
// émetteur), ingestion mesh par type, preuves de travail.
//
// INVARIANT §1.4 : tout ce qui traverse ici est de la MÉTADONNÉE de défense —
// compteurs, clés publiques, empreintes de paquets CHIFFRÉS. Aucun payload
// déchiffrable (DM/groupes) n'existe côté serveur : un message rejoué
// n'apparaît que comme entrée de garde, jamais comme texte.
//
// Zéro mutation locale : le bouton « Rafraîchir » remplace l'état par la
// réponse authentifiée du serveur (invariant §1.8).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { fmtDate, fmtNum, shortKey } from "@/lib/admin-format";

// ── types du contrat backend (aucun any) ─────────────────────────────────────

export interface TrustedKeyRow {
  ownerKey: string;
  peerKey: string;
  state: string; // unverified | verified | changed
  firstSeenAt: string;
  verifiedAt: string | null;
}

export interface PeerBlockRow {
  blockerKey: string;
  blockedKey: string;
  createdAt: string;
}

export interface ReplayCounterRow {
  key: string;
  senderKey: string;
  seq: number;
  updatedAt: string;
}

export interface MeshIngestRow {
  hash: string;
  gatewayId: string | null;
  type: number; // 1=announce 2=public 3=dm 4=gossip
  hops: number;
  createdAt: string;
}

export interface SecurityPayload {
  trustedKeys: {
    total: number;
    byState: { unverified: number; verified: number; changed: number };
    recent: TrustedKeyRow[];
  };
  peerBlocks: { total: number; last24h: number; recent: PeerBlockRow[] };
  replay: {
    guardEntries: number;
    activeGuardEntries: number;
    expiredGuardEntries: number;
    counters: Record<string, number>;
    recentCounters: ReplayCounterRow[];
  };
  meshIngest: {
    total: number;
    last24h: number;
    byType: { "1": number; "2": number; "3": number; "4": number };
    recent: MeshIngestRow[];
  };
  pow: { total: number; last24h: number };
  e2ee: boolean;
}

export type SecurityLoadState =
  | { kind: "ready"; data: SecurityPayload; fetchedAt: string }
  | {
      kind: "error";
      code: "backend-unreachable" | "forbidden" | "unauthorized" | "http";
      httpStatus?: number;
    };

// ── helpers locaux ───────────────────────────────────────────────────────────

function trustedBadge(state: string): { label: string; cls: string } {
  if (state === "verified")
    return { label: "verified", cls: "border-emerald-300 bg-emerald-50 text-emerald-800" };
  if (state === "changed")
    return { label: "changed", cls: "border-red-300 bg-red-50 text-red-800" };
  return { label: "unverified", cls: "border-amber-300 bg-amber-50 text-amber-800" };
}

const MESH_TYPE_LABEL: Record<number, string> = {
  1: "announce",
  2: "public",
  3: "dm",
  4: "gossip",
};

function meshTypeLabel(type: number): string {
  return MESH_TYPE_LABEL[type] ?? `type ${type}`;
}

function meshTypeBadge(type: number): string {
  // dm = chiffré de bout en bout (rouge = privé, non lisible côté serveur) ;
  // les autres types sont routés par le mesh, badge zinc.
  if (type === 3) return "border-red-300 bg-red-50 text-red-800";
  return "border-zinc-300 bg-zinc-50 text-zinc-700";
}

/** Carte chiffre simple (valeur + libellé), teinte neutre zinc par défaut. */
function Stat({
  label,
  value,
  title,
  tone = "zinc",
}: {
  label: string;
  value: string;
  title?: string;
  tone?: "zinc" | "amber" | "red" | "emerald";
}) {
  const border =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : tone === "red"
        ? "border-red-200 bg-red-50 text-red-900"
        : tone === "emerald"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-zinc-200 bg-white text-zinc-900";
  const labelCls =
    tone === "amber"
      ? "text-amber-700"
      : tone === "red"
        ? "text-red-700"
        : tone === "emerald"
          ? "text-emerald-700"
          : "text-zinc-500";
  return (
    <div className={`rounded-lg border p-3 shadow-sm ${border}`}>
      <p className={`text-xs font-medium uppercase tracking-wide ${labelCls}`}>{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums" title={title}>
        {value}
      </p>
    </div>
  );
}

export function SecurityView({ initial }: { initial: SecurityLoadState }) {
  const [state, setState] = useState<SecurityLoadState>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch("/api/security", { cache: "no-store" });
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
      const data = (await res.json()) as SecurityPayload;
      if (!data || !data.trustedKeys || !data.replay) {
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

  return (
    <div className="flex flex-col gap-4">
      {state.kind === "error" && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {state.code === "backend-unreachable" && (
            <>
              <p className="font-semibold">Backend injoignable</p>
              <p className="mt-1">
                L&apos;app principale ne répond pas — la vue Sécurité est indisponible.
              </p>
            </>
          )}
          {state.code === "forbidden" && (
            <>
              <p className="font-semibold">Accès refusé</p>
              <p className="mt-1">
                Votre rôle ne permet pas la consultation des métriques de sécurité
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

          {/* ── TrustedKeys ── */}
          <section
            aria-labelledby="sec-trusted-heading"
            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="sec-trusted-heading" className="text-sm font-semibold text-zinc-900">
                Clés de chiffrement vérifiées (TOFU entre pairs)
              </h2>
              <span className="text-xs text-zinc-500">
                {fmtNum(state.data.trustedKeys.total)} entrée(s)
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Garde anti-usurpation : la clé d&apos;un pair, vue une première fois, est
              épinglée ; un CHANGEMENT (badge rouge) sans re-vérification est suspect.
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Stat label="unverified" value={fmtNum(state.data.trustedKeys.byState.unverified)} tone="amber" />
              <Stat label="verified" value={fmtNum(state.data.trustedKeys.byState.verified)} tone="emerald" />
              <Stat label="changed" value={fmtNum(state.data.trustedKeys.byState.changed)} tone="red" />
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[640px] text-left text-sm" aria-label="Clés récemment vues (10 dernières)">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <th scope="col" className="px-3 py-2 font-medium">Propriétaire</th>
                    <th scope="col" className="px-3 py-2 font-medium">Pair</th>
                    <th scope="col" className="px-3 py-2 font-medium">État</th>
                    <th scope="col" className="px-3 py-2 font-medium">Première vue</th>
                    <th scope="col" className="px-3 py-2 font-medium">Vérifiée le</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.trustedKeys.recent.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-zinc-600">
                        Aucune clé récente.
                      </td>
                    </tr>
                  )}
                  {state.data.trustedKeys.recent.map((k) => {
                    const badge = trustedBadge(k.state);
                    return (
                      <tr key={`${k.ownerKey}:${k.peerKey}`} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs text-zinc-800" title={k.ownerKey}>
                            {shortKey(k.ownerKey)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs text-zinc-600" title={k.peerKey}>
                            {shortKey(k.peerKey)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-600">{fmtDate(k.firstSeenAt)}</td>
                        <td className="px-3 py-2 text-xs text-zinc-600">{fmtDate(k.verifiedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── PeerBlocks ── */}
          <section
            aria-labelledby="sec-blocks-heading"
            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="sec-blocks-heading" className="text-sm font-semibold text-zinc-900">
                Blocs entre pairs
              </h2>
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span>{fmtNum(state.data.peerBlocks.total)} au total</span>
                <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 font-medium text-red-800">
                  {fmtNum(state.data.peerBlocks.last24h)} sur 24 h
                </span>
              </div>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Garde sociale côté client : un pair bloqué n&apos;est plus déchiffré ni
              affiché par le bloqueur — le serveur ne fait que comptabiliser ces
              déclarations, sans y accéder.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[520px] text-left text-sm" aria-label="Blocs récents">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <th scope="col" className="px-3 py-2 font-medium">Bloqueur</th>
                    <th scope="col" className="px-3 py-2 font-medium">Bloqué</th>
                    <th scope="col" className="px-3 py-2 font-medium">Déclaré le</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.peerBlocks.recent.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-zinc-600">
                        Aucun bloc récent.
                      </td>
                    </tr>
                  )}
                  {state.data.peerBlocks.recent.map((b) => (
                    <tr key={`${b.blockerKey}:${b.blockedKey}:${b.createdAt}`} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-zinc-800" title={b.blockerKey}>
                          {shortKey(b.blockerKey)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-red-700" title={b.blockedKey}>
                          {shortKey(b.blockedKey)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-600">{fmtDate(b.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Anti-replay ── */}
          <section
            aria-labelledby="sec-replay-heading"
            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="sec-replay-heading" className="text-sm font-semibold text-zinc-900">
                Gardes anti-rejeu
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800">
                  {fmtNum(state.data.replay.activeGuardEntries)} garde(s) active(s)
                </span>
                <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 font-medium text-zinc-600">
                  {fmtNum(state.data.replay.expiredGuardEntries)} expirée(s)
                </span>
                <span className="text-zinc-500">
                  {fmtNum(state.data.replay.guardEntries)} au total
                </span>
              </div>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Garde anti-rejeu : un numéro de séquence par (clé, émetteur) — un paquet
              rejoué (seq déjà vue) est abandonné AVANT déchiffrement.
            </p>
            {Object.keys(state.data.replay.counters).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(state.data.replay.counters)
                  .slice(0, 10)
                  .map(([name, value]) => (
                    <span
                      key={name}
                      className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-700"
                    >
                      {name} : {fmtNum(value)}
                    </span>
                  ))}
              </div>
            )}
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[640px] text-left text-sm" aria-label="Compteurs anti-rejeu récents">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <th scope="col" className="px-3 py-2 font-medium">Garde (clé)</th>
                    <th scope="col" className="px-3 py-2 font-medium">Émetteur</th>
                    <th scope="col" className="px-3 py-2 font-medium">Seq</th>
                    <th scope="col" className="px-3 py-2 font-medium">Mis à jour</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.replay.recentCounters.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-zinc-600">
                        Aucun compteur récent.
                      </td>
                    </tr>
                  )}
                  {state.data.replay.recentCounters.map((c) => (
                    <tr key={`${c.key}:${c.senderKey}`} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-zinc-800" title={c.key}>
                          {shortKey(c.key, 10, 6)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-zinc-600" title={c.senderKey}>
                          {shortKey(c.senderKey)}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-zinc-800">{fmtNum(c.seq)}</td>
                      <td className="px-3 py-2 text-xs text-zinc-600">{fmtDate(c.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── MeshIngest ── */}
          <section
            aria-labelledby="sec-mesh-heading"
            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="sec-mesh-heading" className="text-sm font-semibold text-zinc-900">
                Ingestion mesh
              </h2>
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span>{fmtNum(state.data.meshIngest.total)} paquet(s)</span>
                <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                  {fmtNum(state.data.meshIngest.last24h)} sur 24 h
                </span>
              </div>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Paquets reçus des passerelles mesh : routés SANS lecture possible — le
              contenu reste chiffré E2EE (type « dm » : privé, jamais déchiffrable côté serveur).
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["1", "2", "3", "4"] as const).map((t) => (
                <span
                  key={t}
                  className={`rounded-full border px-2 py-0.5 text-xs font-medium ${meshTypeBadge(Number(t))}`}
                >
                  {t} = {meshTypeLabel(Number(t))} : {fmtNum(state.data.meshIngest.byType[t] ?? 0)}
                </span>
              ))}
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[640px] text-left text-sm" aria-label="Paquets mesh récemment ingérés">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <th scope="col" className="px-3 py-2 font-medium">Empreinte</th>
                    <th scope="col" className="px-3 py-2 font-medium">Passerelle</th>
                    <th scope="col" className="px-3 py-2 font-medium">Type</th>
                    <th scope="col" className="px-3 py-2 font-medium">Sauts</th>
                    <th scope="col" className="px-3 py-2 font-medium">Ingesté le</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.meshIngest.recent.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-zinc-600">
                        Aucun paquet récent.
                      </td>
                    </tr>
                  )}
                  {state.data.meshIngest.recent.map((m) => (
                    <tr key={`${m.hash}:${m.createdAt}`} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60">
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-zinc-800" title={m.hash}>
                          {shortKey(m.hash, 10, 6)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-600">
                        {m.gatewayId ? (
                          <span className="font-mono">{m.gatewayId}</span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meshTypeBadge(m.type)}`}>
                          {meshTypeLabel(m.type)}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-zinc-800">{fmtNum(m.hops)}</td>
                      <td className="px-3 py-2 text-xs text-zinc-600">{fmtDate(m.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── PoW ── */}
          <section
            aria-labelledby="sec-pow-heading"
            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="sec-pow-heading" className="text-sm font-semibold text-zinc-900">
                Preuves de travail (PoW)
              </h2>
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span>{fmtNum(state.data.pow.total)} vérifiée(s)</span>
                <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 font-medium text-zinc-600">
                  {fmtNum(state.data.pow.last24h)} sur 24 h
                </span>
              </div>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Garde anti-spam : chaque publication coûte un calcul vérifié à
              l&apos;ingestion — le spam à coût marginal devient économiquement absurde.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
