import { redirect } from "next/navigation";
import { NetworkView, type NetworkLoadState, type NetworkPayload } from "@/components/NetworkView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /network — vue RÉSEAU SOCIAL du panneau (READ-ONLY, back-office 2026-11).
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR ; anonyme → /.
//  Rôle : support minimum (arbitrage §13.1 ; auditor strict → carte de refus
//  rendue serveur, le BFF + l'app principale imposent 403 en profondeur).
//
//  Strictement LECTURE : graphe de suivis (total, paires mutuelles, top
//  suivis) + soldes de crédits. Aucun contenu n'est affiché ici — les
//  publications publiques vivent dans /posts, les messages privés sont E2EE
//  et n'existent pas côté serveur (invariant §1.4).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de la vue réseau (session validée, rôle suffisant) — jamais de throw. */
async function initialNetwork(actorId: number): Promise<NetworkLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/network", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as NetworkPayload;
      if (data && data.follow && data.credits) {
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

export default async function NetworkPage() {
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

  const initial: NetworkLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialNetwork(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Réseau social
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
              consultation de l&apos;audit. La vue Réseau social exige{" "}
              <strong>support</strong> minimum (arbitrage §13.1) — la même règle
              est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="network-heading" className="mb-4">
              <h2 id="network-heading" className="text-base font-semibold text-zinc-900">
                Graphe de suivis &amp; crédits
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Vue de CONSTATATION — lecture seule. Liens de suivi (total,
                paires mutuelles, 24 h), comptes les plus suivis (barre
                proportionnelle) et soldes de crédits. Métadonnées sociales
                uniquement : aucun contenu n&apos;est affiché ici (public →
                Contenus, privé → E2EE, invariant §1.4).
              </p>
            </section>
            <NetworkView initial={initial} />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · graphe social
          (back-office 2026-11) · lecture seule, données agrégées.
        </div>
      </footer>
    </div>
  );
}
