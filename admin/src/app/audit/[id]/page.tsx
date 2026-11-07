import Link from "next/link";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer } from "@/lib/admin-backend";

// ─────────────────────────────────────────────────────────────────────────────
// /audit/[id] — détail d'une entrée d'audit (ADM Étape 8). LECTURE SEULE.
//
//  Tous les champs : actorId, actorRole, action, targetType, targetId,
//  beforeJson, afterJson, ip, userAgent, justification, createdAt.
//  beforeJson/afterJson : JSON pretty-print dans <details> REPLIÉS par défaut
//  (directive) — accordéon natif, sans JS, accessible.
//  Lien cible : targetType='user' → /users/<pubkey> (arbitrage §13.2 : les
//  traces écrivent la pubkey). Rôle : auditor exact + super-admin (§14.1).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const AUDIT_ROLES = new Set(["auditor", "super-admin"]);

interface AuditDetail {
  id: number;
  createdAt: string;
  actorId: number;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  beforeJson: string | null;
  afterJson: string | null;
  ip: string | null;
  userAgent: string | null;
  justification: string | null;
}

async function loadDetail(actorId: number, id: string): Promise<
  | { kind: "ready"; data: AuditDetail }
  | { kind: "error"; code: "backend-unreachable" | "forbidden" | "unauthorized" | "http" | "not-found"; httpStatus?: number }
> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend(`/api/internal/admin/audit/${encodeURIComponent(id)}`, {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as AuditDetail;
      if (data && typeof data.id === "number") return { kind: "ready", data };
      return { kind: "error", code: "http", httpStatus: 200 };
    }
    if (r.status === 404) return { kind: "error", code: "not-found", httpStatus: 404 };
    if (r.status === 403) return { kind: "error", code: "forbidden" };
    if (r.status === 401) return { kind: "error", code: "unauthorized" };
    return { kind: "error", code: "http", httpStatus: r.status };
  } catch {
    return { kind: "error", code: "backend-unreachable" };
  }
}

function JsonBlock({ label, raw }: { label: string; raw: string | null }) {
  let pretty = raw ?? "(absent)";
  try {
    if (raw) pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // raw n'est pas du JSON valide (legacy libre) — affiché tel quel
  }
  return (
    <details className="rounded-md border border-zinc-200 bg-zinc-50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100">
        {label} {raw ? `(${raw.length} o)` : ""}
      </summary>
      <pre className="overflow-x-auto px-3 pb-3 text-xs leading-relaxed text-zinc-800">
        {pretty}
      </pre>
    </details>
  );
}

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "full",
  timeStyle: "medium",
});

export default async function AuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let session = null;
  let backendDown = false;
  try {
    session = await getPanelSessionServer();
  } catch {
    backendDown = true;
  }
  if (!session && !backendDown) redirect("/");

  const allowed = session ? AUDIT_ROLES.has(session.role) : false;
  if (!allowed) {
    return (
      <div className="flex min-h-screen flex-col">
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
          <section className="rounded-lg border border-red-300 bg-red-50 p-6" role="alert">
            <h1 className="text-base font-semibold text-red-800">Accès refusé</h1>
            <p className="mt-1 text-sm text-red-700">
              Le journal d&apos;audit exige le rôle <strong>auditor</strong> exact
              (+ super-admin) — arbitrage §14.1.
            </p>
          </section>
          <Link href="/audit" className="mt-4 inline-block text-sm text-zinc-600 underline">
            ← Retour au journal
          </Link>
        </main>
      </div>
    );
  }

  // backendDown ⇒ erreur réseau affichée ; sinon session est garanti non-null
  // (le redirect « / » a déjà traité le cas !session && !backendDown, et le
  // bloc « Accès refusé » a déjà traité session null restant) — le narrowing
  // explicite remplace la non-null assertion (règle ESLint panneau).
  const loaded =
    backendDown || !session
      ? ({ kind: "error", code: "backend-unreachable" } as const)
      : await loadDetail(session.adminUserId, id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Entrée d&apos;audit #{id}
            </h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {session ? `${session.email} · ${session.role}` : "liaison perdue"}
            </span>
          </div>
          <Link
            href="/audit"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
          >
            ← Journal
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
        {loaded.kind === "error" ? (
          <section className="rounded-lg border border-red-300 bg-red-50 p-6" role="alert">
            <h2 className="text-base font-semibold text-red-800">
              {loaded.code === "not-found"
                ? "Entrée inconnue (404)"
                : loaded.code === "forbidden"
                  ? "Accès refusé (403)"
                  : loaded.code === "backend-unreachable"
                    ? "App principale injoignable (502)"
                    : `Erreur HTTP ${loaded.httpStatus ?? "?"}`}
            </h2>
          </section>
        ) : (
          <>
            <section className="rounded-lg border border-zinc-200 bg-white p-4">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Horodatage</dt>
                  <dd className="mt-0.5 tabular-nums text-zinc-900">
                    {timeFmt.format(new Date(loaded.data.createdAt))}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Action</dt>
                  <dd className="mt-0.5">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
                      {loaded.data.action}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Acteur</dt>
                  <dd className="mt-0.5 text-zinc-900">
                    {loaded.data.actorEmail}{" "}
                    <span className="text-xs text-zinc-500">(id {loaded.data.actorId})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Rôle (figé)</dt>
                  <dd className="mt-0.5 text-zinc-900">{loaded.data.actorRole}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cible</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-zinc-900">
                    {loaded.data.targetType}
                    {" : "}
                    {loaded.data.targetType === "user" ? (
                      <Link
                        href={`/users/${encodeURIComponent(loaded.data.targetId)}`}
                        className="text-blue-900 underline"
                        title="Fiche utilisateur"
                      >
                        {loaded.data.targetId}
                      </Link>
                    ) : (
                      loaded.data.targetId
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">IP / User-Agent</dt>
                  <dd className="mt-0.5 break-all text-xs text-zinc-700">
                    {loaded.data.ip ?? "—"} · {loaded.data.userAgent ?? "—"}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Justification</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap text-zinc-900">
                    {loaded.data.justification ?? "—"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="mt-4 space-y-2" aria-label="États avant / après">
              <JsonBlock label="beforeJson" raw={loaded.data.beforeJson} />
              <JsonBlock label="afterJson" raw={loaded.data.afterJson} />
            </section>

            <p className="mt-4 text-xs text-zinc-500">
              Append-only : cette entrée ne peut être ni modifiée ni supprimée
              (triggers SQLite, migration 0004).
            </p>
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · détail d&apos;audit
          (ADM Étape 8) · lecture seule.
        </div>
      </footer>
    </div>
  );
}
