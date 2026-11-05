import { BackendStatus } from "@/components/BackendStatus";

// ─────────────────────────────────────────────────────────────────────────────
// Page stub du squelette ADM (Étape 1+2).
// Aucune donnée sensible : l'authentification arrive à l'Étape 3
// (docs/specs/ADM-breakdown.md E3). La seule fonctionnalité vivante est le
// health check qui reflète l'état réel de la liaison panneau → app principale.
// ─────────────────────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
            Mbote Admin
          </h1>
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">
            squelette — Étape 1+2
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
        <section
          aria-labelledby="status-heading"
          className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <h2 id="status-heading" className="text-base font-semibold text-zinc-900">
            État du service
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Vérification vivante de la liaison panneau → app principale
            (<code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">BACKEND_INTERNAL_URL</code>).
            Aucune donnée sensible n&apos;est exposée par cette page.
          </p>
          <BackendStatus />
        </section>

        <section
          aria-labelledby="skeleton-heading"
          className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <h2 id="skeleton-heading" className="text-base font-semibold text-zinc-900">
            Squelette ADM MVP
          </h2>
          <ul className="mt-3 list-inside space-y-2 text-sm text-zinc-700">
            <li className="flex gap-2">
              <span className="font-medium text-emerald-700">[fait]</span>
              Rupture <code className="rounded bg-zinc-100 px-1 text-xs">ADMIN_API_KEY</code>{" "}
              (Étape 0) — sessions, CSRF, rôles, audit append-only.
            </li>
            <li className="flex gap-2">
              <span className="font-medium text-amber-700">[Étape 3]</span>
              Authentification (login + TOTP + break-glass) — d&apos;ici là, cette
              page n&apos;expose rien et la surface admin API reste fermée aux
              humains en production (fail-safe volontaire).
            </li>
          </ul>
          <p className="mt-4 border-t border-zinc-100 pt-4 text-xs leading-relaxed text-zinc-500">
            Invariants : zéro accès DB direct depuis cette app · cookie de session
            dédié au domaine admin · Cloudflare Access requis avant toute
            exposition (docs/specs/ADMIN-RBAC.md).
          </p>
        </section>
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
