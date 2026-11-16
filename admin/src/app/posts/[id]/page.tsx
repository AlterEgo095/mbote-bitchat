import Link from "next/link";
import { redirect } from "next/navigation";
import { PostDetailView, type PostDetailLoadState, type PostFiche } from "@/components/PostDetailView";
import { ADMIN_COOKIE, callBackend, getPanelSessionServer, type PanelSession } from "@/lib/admin-backend";

// ─────────────────────────────────────────────────────────────────────────────
// /posts/[id] — fiche d'un contenu public (back-office 2026-11). [id] = id
// Post (cuid — cible des traces ModerationAction/AdminAudit).
//
//  Authentifiée (support minimum pour la lecture — arbitrage §13.1) ; anonyme
//  → /. Auditor → carte de refus rendue serveur (403 imposé aussi par le BFF
//  + le backend). Les MUTATIONS sont gated côté client PAR RÔLE (masquer =
//  moderator+, purge = super-admin via four-eyes) et ré-imposées côté serveur
//  (RBAC par action /api/moderation/action + PendingAction É9).
//
//  Données INITIALES calculées serveur (pattern fiche utilisateur) : fiche
//  visible au premier rendu ; rechargée depuis le serveur après chaque action
//  (invariant §1.8 — zéro update optimiste).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ROLE_LEVEL: Record<string, number> = {
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

/** État initial de la fiche — jamais de throw. */
async function initialFiche(actorId: number, postId: string): Promise<PostDetailLoadState> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  try {
    const r = await callBackend(`/api/internal/admin/posts/${encodeURIComponent(postId)}`, {
      method: "GET",
      sessionToken: token,
      actorId,
    });
    if (r.status === 200) {
      const data = r.body as unknown as PostFiche;
      if (data && data.post && typeof data.post.id === "string") {
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

export default async function PostDetailPage({
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

  const initial: PostDetailLoadState = backendDown
    ? { kind: "error", code: "backend-unreachable" }
    : session && allowed
      ? await initialFiche(session.adminUserId, id)
      : { kind: "error", code: session ? "forbidden" : "unauthorized" };

  const showRefusal = !backendDown && (!session || !allowed);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Fiche contenu
            </h1>
            <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {session ? `${session.email} · ${session.role}` : "liaison app principale perdue"}
            </span>
          </div>
          <nav className="flex flex-wrap items-center gap-2" aria-label="Navigation panneau">
            <Link
              href="/posts"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              ← Contenus
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
              consultation de l&apos;audit. La fiche d&apos;un contenu exige{" "}
              <strong>support</strong> minimum (arbitrage §13.1) — la même règle
              est appliquée par l&apos;API (403), défense en profondeur.
            </p>
          </section>
        ) : (
          <PostDetailView
            role={session?.role ?? "inconnu"}
            csrfToken={session?.csrfToken ?? ""}
            postId={id}
            initial={initial}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-4xl px-4 pt-4 text-xs text-zinc-500 sm:px-6">
          Mbote Mesh — panneau d&apos;administration · fiche contenu public ·
          actions tracées ModerationAction + AdminAudit (append-only).
        </div>
      </footer>
    </div>
  );
}
