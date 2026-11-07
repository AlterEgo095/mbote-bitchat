import Link from "next/link";
import { redirect } from "next/navigation";
import { UserDetailView, type UserDetailLoadState, type UserFiche } from "@/components/UserDetailView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";

// ─────────────────────────────────────────────────────────────────────────────
// /users/[id] — fiche utilisateur (ADM Étape 7). [id] = pubkey (arbitrage
// §13.2 : identité publique stable, cible des traces admin).
//
//  Authentifiée (support minimum — arbitrage §13.1) ; anonyme → /. Auditor →
//  carte de refus rendue serveur (403 imposé aussi par le BFF + le backend).
//
//  Données INITIALES calculées serveur (pattern queue/dashboard) : fiche
//  visible au premier rendu. Actions warn/suspend/unsuspend via BFF avec
//  justification §6 — invariant §1.8 (refetch serveur après chaque action).
//  Ban (É9) : bouton actif pour super-admin — crée une INTENTION four-eyes
//  (/pending-actions), jamais d'exécution directe.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de la fiche — jamais de throw. */
async function initialFiche(actorId: number, pubkey: string): Promise<UserDetailLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend(`/api/internal/admin/users/${encodeURIComponent(pubkey)}`, {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as UserFiche;
      if (data && data.user && typeof data.user.pubkey === "string") {
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

export default async function UserDetailPage({
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

  const initial: UserDetailLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialFiche(session.adminUserId, id)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Fiche utilisateur
            </h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {session ? `${session.email} · ${session.role}` : "liaison app principale perdue"}
            </span>
          </div>
          <nav className="flex items-center gap-2" aria-label="Navigation panneau">
            <Link
              href="/users"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              ← Annuaire
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
              consultation de l&apos;audit. Les fiches utilisateurs exigent{" "}
              <strong>support</strong> minimum (directive Étape 7 — arbitrage §13.1).
            </p>
          </section>
        ) : (
          <UserDetailView
            role={session?.role ?? "inconnu"}
            csrfToken={session?.csrfToken ?? ""}
            initial={initial}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · fiche utilisateur
          (ADM Étape 7) · données publiques uniquement · ban = four-eyes Étape 9.
        </div>
      </footer>
    </div>
  );
}
