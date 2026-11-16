import { redirect } from "next/navigation";
import { UsersView, type UsersLoadState, type UsersPayload } from "@/components/UsersView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /users — annuaire des comptes (ADM Étape 7). View/suspend/warn — pas de
// ban (four-eyes Étape 9).
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR (verify via l'app
//  principale) ; anonyme → redirection vers /.
//
//  Rôle : support minimum (arbitrage §13.1 — la matrice v1.0 disait auditor,
//  RE-TRANCHÉ par la directive Étape 7 ; auditor strict → carte de refus
//  rendue serveur, le BFF + l'app principale imposent 403 en profondeur).
//
//  Données INITIALES calculées serveur (pattern queue Étape 6) : la page 1
//  est visible au premier rendu. Recherche, filtres, tri et pagination par le
//  BFF (/api/users). Aucune donnée privée ne traverse ce panneau.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de l'annuaire (session validée, rôle suffisant) — jamais de throw. */
async function initialUsers(actorId: number): Promise<UsersLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/users", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as UsersPayload;
      if (data && Array.isArray(data.items)) {
        return { kind: "ready", data, fetchedAt: new Date().toISOString() };
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

export default async function UsersPage() {
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

  const initial: UsersLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialUsers(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Utilisateurs
            </h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {session ? `${session.email} · ${session.role}` : "liaison app principale perdue"}
            </span>
          </div>
          <AdminNav />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
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
              consultation de l&apos;audit. L&apos;annuaire des utilisateurs exige{" "}
              <strong>support</strong> minimum (directive Étape 7 — arbitrage §13.1) —
              la même règle est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="users-heading" className="mb-4">
              <h2 id="users-heading" className="text-base font-semibold text-zinc-900">
                Comptes du réseau
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Recherche par pseudo (LIKE, 20 max), liste paginée cursor (20/page),
                tri inscription/reports, filtres statut & période. Statuts : actif /
                suspendu (dates affichées) / banni — AUCUN bannissement avant
                Étape 9 (four-eyes). Périmètre strict : view · suspend · warn.
              </p>
            </section>
            <UsersView role={session?.role ?? "inconnu"} initial={initial} />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · gestion utilisateurs
          (ADM Étape 7) · données publiques uniquement, actions reflétées
          depuis le serveur.
        </div>
      </footer>
    </div>
  );
}
