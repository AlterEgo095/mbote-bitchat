import { redirect } from "next/navigation";
import { PendingActionsView, type PendingLoadState, type PendingActionItem } from "@/components/PendingActionsView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /pending-actions — file des intentions FOUR-EYES (ADM Étape 9).
//
//  Directive : « Sur /pending-actions (nouvelle page), liste des actions en
//  attente : action, cible, demandeur, justification, expires dans X minutes.
//  Bouton « Approuver » (si currentUser !== requestedBy) ou « Annuler » (si
//  currentUser === requestedBy). »
//
//  Porte : moderator minimum (les super-admins agissent, les moderators
//  voient) — support/auditor → 403 (testé E9·RBAC). Anonyme → /.
//  Données INITIALES serveur (pattern users/queue) ; invariant §1.8 :
//  approuver/annuler attendent la réponse serveur puis refetch.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

async function initialList(actorId: number): Promise<PendingLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/pending-actions", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as { items?: PendingActionItem[] };
      if (data && Array.isArray(data.items)) {
        return { kind: "ready", items: data.items, fetchedAt: new Date().toISOString() };
      }
      return { kind: "error", code: "http", httpStatus: 200 };
    }
    if (r.status === 403) return { kind: "error", code: "forbidden" };
    if (r.status === 401) return { kind: "error", code: "unauthorized" };
    return { kind: "error", code: "http", httpStatus: r.status };
  } catch {
    return { kind: "error", code: "backend-unreachable" };
  }
}

export default async function PendingActionsPage() {
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
  const allowed = session ? level >= ROLE_LEVEL.moderator : false;

  const initial: PendingLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialList(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Intentions four-eyes
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
              La file four-eyes exige <strong>moderator</strong> minimum
              (directive Étape 9 — support et auditor sont refusés, testé E9·RBAC).
            </p>
          </section>
        ) : (
          <PendingActionsView
            role={session?.role ?? "inconnu"}
            myEmail={session?.email ?? null}
            csrfToken={session?.csrfToken ?? ""}
            initial={initial}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · four-eyes (ADM Étape 9) —
          ban définitif et purge : jamais un seul admin.
        </div>
      </footer>
    </div>
  );
}
