import { redirect } from "next/navigation";
import { InfraView, type InfraLoadState, type InfraPayload } from "@/components/InfraView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /infra — vue INFRASTRUCTURE du panneau (back-office 2026-11) : passerelles
// mesh + abonnements push Web Push.
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR ; anonyme → /.
//  Rôle : support minimum pour la LECTURE (arbitrage §13.1 ; auditor strict →
//  carte de refus rendue serveur). La purge des abonnements désactivés exige
//  moderator+ : rôle passé à la vue pour masquer le bouton, ré-imposé par
//  l'app principale (403) — défense en profondeur.
//
//  Données INITIALES calculées serveur (pattern posts) : visible au premier
//  rendu, rechargées depuis le serveur après chaque action (invariant §1.8).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de la vue infrastructure (session validée, rôle suffisant) — jamais de throw. */
async function initialInfra(actorId: number): Promise<InfraLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/infra", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as InfraPayload;
      if (data && Array.isArray(data.gateways) && data.pushSubs) {
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

export default async function InfraPage() {
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

  const initial: InfraLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialInfra(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Infrastructure
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
              consultation de l&apos;audit. La vue Infrastructure exige{" "}
              <strong>support</strong> minimum (arbitrage §13.1) — la même règle
              est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="infra-heading" className="mb-4">
              <h2 id="infra-heading" className="text-base font-semibold text-zinc-900">
                Passerelles mesh &amp; abonnements push
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                État d&apos;exécution du réseau : passerelles mesh (paquets
                in/out, dernier contact — elles relaient du chiffré sans pouvoir
                le lire, invariant §1.4) et abonnements Web Push (endpoints
                tronqués, aucun token complet exposé). Purge des abonnements
                désactivés : moderator+, justification §6 (≥ 20 caractères) et
                audit append-only.
              </p>
            </section>
            <InfraView
              initial={initial}
              role={session?.role ?? "inconnu"}
              csrfToken={session?.csrfToken ?? ""}
            />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · infrastructure
          (back-office 2026-11) · purges tracées AdminAudit (append-only).
        </div>
      </footer>
    </div>
  );
}
