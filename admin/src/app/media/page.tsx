import { redirect } from "next/navigation";
import { MediaView, type MediaLoadState, type MediaPayload } from "@/components/MediaView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /media — annuaire des OBJETS MÉDIA E2EE (back-office 2026-11).
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR ; anonyme → /.
//  Rôle : support minimum (arbitrage §13.1 ; auditor strict → carte de refus
//  rendue serveur, le BFF + l'app principale imposent 403 en profondeur).
//
//  Les ACTIONS (purge unitaire, purge de masse des pending expirés) exigent
//  moderator+ : le rôle est passé à la vue client pour MASQUER les boutons,
//  et ré-imposé par l'app principale (403) — défense en profondeur.
//
//  Périmètre : MÉTADONNÉES uniquement (objectKey, tailles, statut, sha256
//  déclaré, propriétaire) — les médias sont chiffrés côté client (invariant
//  §1.4), aucun contenu déchiffrable n'existe côté serveur.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de l'annuaire média (session validée, rôle suffisant) — jamais de throw. */
async function initialMedia(actorId: number): Promise<MediaLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/media", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as MediaPayload;
      if (data && Array.isArray(data.items) && data.totals) {
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

export default async function MediaPage() {
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

  const initial: MediaLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialMedia(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Médias
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
              consultation de l&apos;audit. La vue Médias exige{" "}
              <strong>support</strong> minimum (arbitrage §13.1) — la même règle
              est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="media-heading" className="mb-4">
              <h2 id="media-heading" className="text-base font-semibold text-zinc-900">
                Objets média chiffrés (métadonnées)
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Stockage des médias publics : la vue n&apos;expose QUE des
                métadonnées — les contenus sont chiffrés côté client (E2EE,
                invariant §1.4), le serveur ne peut ni les lire ni les
                reconstruire. Liste paginée cursor (20/page, création
                décroissante), filtres statut / période / propriétaire (pubkey
                exacte). Purge unitaire et purge de masse des « pending »
                expirés : moderator+, justification §6 (≥ 20 caractères) et
                audit append-only — fileDeleted:false signale un objet bucket
                restant (GC à prévoir).
              </p>
            </section>
            <MediaView
              initial={initial}
              role={session?.role ?? "inconnu"}
              csrfToken={session?.csrfToken ?? ""}
            />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · stockage média E2EE
          (back-office 2026-11) · purges tracées AdminAudit (append-only).
        </div>
      </footer>
    </div>
  );
}
