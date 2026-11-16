import { redirect } from "next/navigation";
import { AuditView, type AuditLoadState, type AuditPayload } from "@/components/AuditView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";
import { AdminNav } from "@/components/AdminNav";

// ─────────────────────────────────────────────────────────────────────────────
// /audit — journal AdminAudit (ADM Étape 8). LECTURE SEULE.
//
//  Authentifiée : session panneau vérifiée CÔTÉ SERVEUR ; anonyme → /.
//  Rôle : auditor EXACT + super-admin (arbitrage §14.1 — porte exacte, PAS
//  une hiérarchie : support et moderator sont REÇUS avec une carte de refus ;
//  le BFF + l'app principale imposent 403 — défense en profondeur, testée).
//
//  Données INITIALES serveur : la page 1 est visible au premier rendu (pattern
//  É5/É6). Filtres, pagination et export passent par le BFF (/api/audit*).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const AUDIT_ROLES = new Set(["auditor", "super-admin"]);

async function initialAudit(actorId: number): Promise<AuditLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend("/api/internal/admin/audit", {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as AuditPayload;
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

export default async function AuditPage() {
  let session: PanelSession | null = null;
  let backendDown = false;
  try {
    session = await getPanelSessionServer();
  } catch {
    backendDown = true;
  }

  if (!session && !backendDown) redirect("/");

  const allowed = session ? AUDIT_ROLES.has(session.role) : false;

  const initial: AuditLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialAudit(session.adminUserId)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && session && !allowed;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Journal d&apos;audit
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
              Le rôle <strong>{session?.role ?? "inconnu"}</strong> n&apos;a pas accès
              au journal d&apos;audit : la porte est <strong>auditor</strong> exacte
              (+ super-admin) — arbitrage §14.1 : l&apos;auditeur est le plus
              restrictif de la matrice (lecture seule AdminAudit), et le journal
              n&apos;est pas l&apos;instrument de travail de support/moderator. La
              même règle est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="audit-heading" className="mb-4">
              <h2 id="audit-heading" className="text-base font-semibold text-zinc-900">
                Journal des actions administratives (append-only)
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Chaque login, action de modération et cycle four-eyes est tracé
                nominalement — aucune suppression ni modification possible
                (triggers SQLite). Tri décroissant, pagination cursor (20/page).
                Cible <code className="font-mono text-xs">user</code> → fiche
                utilisateur ; les autres types n&apos;ont pas de fiche admin.
              </p>
            </section>
            <AuditView initial={initial} />
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · journal d&apos;audit
          (ADM Étape 8) · lecture seule, export CSV ≤ 10 000 lignes.
        </div>
      </footer>
    </div>
  );
}
