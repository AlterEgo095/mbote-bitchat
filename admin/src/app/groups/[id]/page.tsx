import { redirect } from "next/navigation";
import {
  GroupDetailView,
  type GroupDetailLoadState,
  type GroupFiche,
} from "@/components/GroupDetailView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /groups/[id] — fiche d'un groupe MLS, MÉTADONNÉES ONLY (back-office 2026-11).
// [id] = id Group (cible des intentions four-eyes purge_group_messages).
//
//  INVARIANT ABSOLU (ADMIN-RBAC §1.4) : les contenus de groupe sont chiffrés
//  MLS — la fiche n'expose que le shell, l'annuaire des membres et les
//  métadonnées (epoch, tailles) des derniers messages/enveloppes ; le bandeau
//  E2EE est rendu en tête de vue.
//
//  Authentifiée (support minimum pour la lecture — arbitrage §13.1) ; anonyme
//  → /. Auditor → carte de refus rendue serveur (403 imposé aussi par le BFF
//  + le backend). La PURGE est gated côté client PAR RÔLE (super-admin via
//  four-eyes É9) et ré-imposée côté serveur (PendingAction É9).
//
//  Données INITIALES calculées serveur (pattern fiche post) : fiche visible au
//  premier rendu ; rechargée depuis le serveur après action (invariant §1.8).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de la fiche — jamais de throw. */
async function initialFiche(actorId: number, groupId: string): Promise<GroupDetailLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend(`/api/internal/admin/groups/${encodeURIComponent(groupId)}`, {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as GroupFiche;
      if (data && data.group && typeof data.group.id === "string") {
        return { kind: "ready", data, fetchedAt: new Date().toISOString() };
      }
      return { kind: "error", code: "http", httpStatus: 200 };
    }
    if (r.status === 404) return { kind: "error", code: "notfound" };
    if (r.status === 403) return { kind: "error", code: "forbidden" };
    if (r.status === 401) return { kind: "error", code: "unauthorized" };
    return { kind: "error", code: "http", httpStatus: r.status };
  } catch {
    return { kind: "error", code: "backend-unreachable" };
  }
}

export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // verify : une ERREUR RÉSEAU (backend mort) n'est PAS une session invalide.
  let session: PanelSession | null = null;
  let backendDown = false;
  try {
    session = await getPanelSessionServer();
  } catch {
    backendDown = true;
  }

  if (!session && !backendDown) redirect("/");

  const level = session ? (ROLE_LEVEL[session.role] ?? 0) : 0;
  const allowed = session ? level >= ROLE_LEVEL.support : false;

  const initial: GroupDetailLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialFiche(session.adminUserId, id)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Fiche groupe
            </h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {session ? `${session.email} · ${session.role}` : "liaison app principale perdue"}
            </span>
          </div>
          <AdminNav />
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
        {showRefusal ? (
          <section
            aria-labelledby="refusal-heading"
            className="rounded-lg border border-red-300 bg-red-50 p-6"
            role="alert"
          >
            <h2 id="refusal-heading" className="text-base font-semibold text-red-800">
              Accès refusé
            </h2>
            <p className="mt-1 text-sm text-red-700">
              Le rôle <strong>{session?.role ?? "inconnu"}</strong> est limité à la
              consultation de l&apos;audit. La fiche d&apos;un groupe (métadonnées)
              exige <strong>support</strong> minimum (arbitrage §13.1) — la même
              règle est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <GroupDetailView
            role={session?.role ?? "inconnu"}
            csrfToken={session?.csrfToken ?? ""}
            groupId={id}
            initial={initial}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-4xl px-4 pt-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · fiche groupe MLS (contenus
          chiffrés, invariant §1.4) · purges sous four-eyes É9, tracées AdminAudit
          (append-only).
        </div>
      </footer>
    </div>
  );
}
