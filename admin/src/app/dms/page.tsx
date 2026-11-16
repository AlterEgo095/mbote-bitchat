import { redirect } from "next/navigation";
import { DmsView, type DmsLoadState, type DmsPayload } from "@/components/DmsView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /dms — annuaire des paires DM, MÉTADONNÉES ONLY (back-office 2026-11).
//
//  INVARIANT ABSOLU (ADMIN-RBAC §1.4) : les DM sont chiffrés E2EE — le serveur
//  ne peut ni les lire ni exposer un contenu. Cette page n'affiche donc que
//  « qui parle à qui, combien, quand » (compteurs, tailles de ciphertext,
//  timestamps) ; le bandeau E2EE est rendu en tête de vue.
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR (verify via l'app
//  principale) ; anonyme → redirection vers /. Rôle : support minimum
//  (arbitrage §13.1, identique à l'annuaire posts ; auditor strict → carte de
//  refus rendue serveur, le BFF + l'app principale imposent 403 en profondeur).
//
//  Données INITIALES calculées serveur (pattern posts/users) : la page 1 est
//  visible au premier rendu. La purge d'une paire est une ACTION FOUR-EYES
//  (É9) super-admin uniquement, créée dans la vue, exécutée après approbation
//  d'un second admin distinct.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de l'annuaire (session validée, rôle suffisant) — jamais de throw. */
async function initialDms(actorId: number): Promise<DmsLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/dms", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as DmsPayload;
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

export default async function DmsPage() {
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

  const initial: DmsLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialDms(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Messages directs (métadonnées)
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
              consultation de l&apos;audit. L&apos;annuaire des DM (métadonnées)
              exige <strong>support</strong> minimum (arbitrage §13.1) — la même
              règle est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="dms-heading" className="mb-4">
              <h2 id="dms-heading" className="text-base font-semibold text-zinc-900">
                Paires DM — graphe social chiffré
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Liste paginée cursor (20/page, dernier message décroissant) des
                paires qui échangent des messages chiffrés E2EE : compteurs,
                non-lus, octets de ciphertext, période — recherche par fragment de
                clé publique (LIKE, ≥ 3 caractères, limite 20). La purge d&apos;une
                paire est irréversible et passe par le cycle four-eyes (É9).
              </p>
            </section>
            <DmsView role={session?.role ?? "inconnu"} csrfToken={session?.csrfToken ?? ""} initial={initial} />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · métadonnées DM (chiffrées
          E2EE, invariant §1.4) · purges sous four-eyes É9, tracées AdminAudit.
        </div>
      </footer>
    </div>
  );
}
