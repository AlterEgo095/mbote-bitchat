import { BackendStatus } from "@/components/BackendStatus";
import { AdminAuthPanel } from "@/components/AdminAuthPanel";
import { getPanelSessionServer } from "@/lib/admin-backend";

// ─────────────────────────────────────────────────────────────────────────────
// Page du panneau ADM — Étape 3 : authentification vivante.
// L'état de session est calculé CÔTÉ SERVEUR (verify via l'app principale) et
// passé en prop — pas de effet de chargement côté client. Le health check
// (Étape 2) reste la vérification vivante de la liaison panneau → principale.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getPanelSessionServer().catch(() => null);
  const initial = session
    ? { authenticated: true, email: session.email, role: session.role, totpEnrolled: session.totpEnrolled }
    : { authenticated: false, email: "", role: "", totpEnrolled: false };
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
            Mbote Admin
          </h1>
          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
            auth — Étape 3+4
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
        <section
          aria-labelledby="auth-heading"
          className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <h2 id="auth-heading" className="text-base font-semibold text-zinc-900">
            Authentification
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Email + mot de passe + code TOTP (6 chiffres) — un seul round-trip.
            Toute échec est uniforme (aucune indication sur la cause).
          </p>
          <div className="mt-4">
            <AdminAuthPanel initial={initial} />
          </div>
        </section>

        <section
          aria-labelledby="status-heading"
          className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <h2 id="status-heading" className="text-base font-semibold text-zinc-900">
            État du service
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Vérification vivante de la liaison panneau → app principale
            (<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">BACKEND_INTERNAL_URL</code>).
          </p>
          <BackendStatus />
        </section>

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          Invariants : zéro accès DB direct depuis cette app · cookie de session
          dédié au domaine admin (HttpOnly, SameSite=Strict) · double contrôle
          token interne + acteur nominatif vers l&apos;app principale ·
          Cloudflare Access requis avant toute exposition
          (docs/specs/ADMIN-RBAC.md, preuves ADM-step3-4.md).
        </p>
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <p className="mx-auto w-full max-w-3xl px-4 text-xs text-zinc-500 sm:px-6">
          mbote-admin · port 3001 · publié uniquement sur 127.0.0.1 (réseau
          Docker interne)
        </p>
      </footer>
    </div>
  );
}
