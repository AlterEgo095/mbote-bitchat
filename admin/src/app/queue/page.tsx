import Link from "next/link";
import { redirect } from "next/navigation";
import { QueueView, type QueueLoadState, type QueuePayload } from "@/components/QueueView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";

// ─────────────────────────────────────────────────────────────────────────────
// /queue — file de modération (ADM Étape 6). Instrument de travail quotidien.
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR (verify via l'app
//  principale) ; anonyme → redirection vers /.
//
//  Rôle : support minimum (arbitrage §12.17 — auditor STRICT, lecture seule
//  AdminAudit) : l'auditor reçoit une carte de refus rendue serveur ; le BFF
//  + l'app principale imposent 403 (défense en profondeur, testée).
//
//  Données INITIALES calculées serveur : la page 1 est visible au premier
//  rendu, sans attendre l'hydratation (pattern dashboard Étape 5). Filtres,
//  pagination cursor et actions passent par le BFF (/api/queue et
//  /api/admin/moderation/action). Toute mutation reflète le retour serveur
//  (invariant §1.8 — pas d'optimistic update).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de la file (session validée, rôle suffisant) — jamais de throw. */
async function initialQueue(actorId: number): Promise<QueueLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/queue", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as QueuePayload;
      if (data && Array.isArray(data.items)) {
        return { kind: "ready", data, fetchedAt: data.page ? new Date().toISOString() : new Date().toISOString() };
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

export default async function QueuePage() {
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

  const initial: QueueLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialQueue(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              File de modération
            </h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {session ? `${session.email} · ${session.role}` : "liaison app principale perdue"}
            </span>
          </div>
          <nav className="flex items-center gap-2" aria-label="Navigation panneau">
            <Link
              href="/dashboard"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              Tableau de bord
            </Link>
            <Link
              href="/"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              Retour
            </Link>
          </nav>
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
              consultation de l&apos;audit. La file de modération exige{" "}
              <strong>support</strong> minimum (arbitrage §12.17 — auditor strict) —
              la même règle est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="queue-heading" className="mb-4">
              <h2 id="queue-heading" className="text-base font-semibold text-zinc-900">
                Signalements du fil public
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Un item = un signalement (handledById vide). Poids = nombre de
                signalements ouverts sur la même cible (badge rouge ≥ 5).
                Pagination cursor-based, 20 par page. Aucune modération DM
                (E2EE par conception). Les actions exigent une justification
                (catégorie + 20 caractères minimum — ADMIN-RBAC §6) et sont
                auditées en append-only.
              </p>
            </section>
            <QueueView
              role={session?.role ?? "inconnu"}
              csrfToken={session?.csrfToken ?? ""}
              initial={initial}
            />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · file de modération
          (ADM Étape 6) · actions reflétées depuis le serveur uniquement.
        </div>
      </footer>
    </div>
  );
}
