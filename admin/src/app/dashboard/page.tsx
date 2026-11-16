import { redirect } from "next/navigation";
import {
  DashboardMetrics,
  type DashboardLoadState,
  type DashboardPayload,
} from "@/components/DashboardMetrics";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /dashboard — instrument de pilotage (ADM Étape 5). 4 métriques, rien de plus.
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR (verify via l'app
//  principale) ; anonyme → redirection vers /.
//
//  DEUX dégradations maîtrisées (directive Étape 5 : « backend injoignable
//  au lieu de crasher ») :
//   1. verify RÉSEAU mort (app principale killée) ≠ session invalide — la
//      page RESTE le tableau de bord et rend le bandeau « Backend
//      injoignable » (une redirection vers / mentirait : « session expirée ») ;
//   2. stats injoignable au chargement (session OK, réseau coupé entre-temps)
//      → même bandeau via l'état initial.
//
//  Rôle : support minimum (directive) — l'auditor reçoit une carte de refus
//  rendue serveur ; le BFF + l'app principale imposent 403 (défense en
//  profondeur, testée).
//
//  Données INITIALES calculées serveur : les 4 valeurs sont visibles au
//  premier rendu, sans attendre l'hydratation. Le bouton Rafraîchir repasse
//  par le BFF /api/dashboard. Instrument, pas vitrine : pas d'historique, pas
//  de graphique, pas de polling.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial des métriques (session validée, rôle suffisant) — jamais de throw. */
async function initialMetrics(actorId: number): Promise<DashboardLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/stats", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as DashboardPayload;
      if (data?.activeUsers && data?.openReports && data?.uptime && data?.backup) {
        return { kind: "ready", data, fetchedAt: data.generatedAt };
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

export default async function DashboardPage() {
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

  const initial: DashboardLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialMetrics(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Tableau de bord
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
              consultation de l&apos;audit. Le tableau de bord (statistiques
              utilisateurs) exige <strong>support</strong> minimum — la même règle
              est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="metrics-heading" className="mb-4">
              <h2 id="metrics-heading" className="text-base font-semibold text-zinc-900">
                État du réseau
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                4 métriques, seuils documentés dans le code
                (lib/dashboard-stats.ts). Aucune donnée sensible : pas d&apos;email,
                pas d&apos;IP, pas de contenu de DM.
              </p>
            </section>
            <DashboardMetrics role={session?.role ?? "inconnu"} initial={initial} />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <p className="mx-auto w-full max-w-6xl px-4 text-xs text-zinc-500 sm:px-6">
          mbote-admin · conteneur 3001 · publié sur l&apos;hôte uniquement sur
          127.0.0.1:3392 (boucle locale — réseau Docker interne) · données
          agrégées uniquement (preuves ADM-step5.md)
        </p>
      </footer>
    </div>
  );
}
