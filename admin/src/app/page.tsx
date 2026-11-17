import Link from "next/link";
import { BackendStatus } from "@/components/BackendStatus";
import { AdminAuthPanel } from "@/components/AdminAuthPanel";
import { AdminNav } from "@/components/AdminNav";
import { getPanelSessionServer } from "@/lib/admin-backend";

// ─────────────────────────────────────────────────────────────────────────────
// Page d'accueil du panneau — hub du back-office.
//
//  Avant (oubli de la livraison back-office 2026-11) : cette page gardait ses
//  5 liens codés à la main (queue, four-eyes, users, posts, dashboard) pendant
//  que les 7 nouvelles sections (DM, groupes, médias, réseau, sécurité, infra,
//  audit) n'étaient joignables que depuis la nav partagée des autres pages.
//  Premier écran du panneau = impression d'un panneau incomplet.
//
//  Désormais : nav partagée AdminNav (12 sections) dans l'en-tête + hub
//  groupé (pilotage / annuaires / systèmes / four-eyes) avec une ligne de
//  description par section. Session calculée CÔTÉ SERVEUR, comme avant.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const HUB_GROUPS: Array<{
  title: string;
  hint: string;
  items: Array<{ href: string; label: string; desc: string; danger?: boolean }>;
}> = [
  {
    title: "Pilotage",
    hint: "Vue d'ensemble et décisions du jour",
    items: [
      {
        href: "/dashboard",
        label: "Tableau de bord",
        desc: "Métriques vivantes : comptes, contenus, DM, performances API.",
      },
      {
        href: "/queue",
        label: "File de modération",
        desc: "Signalements à traiter, décisions prises et justifications.",
      },
    ],
  },
  {
    title: "Annuaires — métadonnées",
    hint: "Tout ce que le serveur détient, jamais le contenu chiffré (invariant E2EE)",
    items: [
      {
        href: "/posts",
        label: "Contenus",
        desc: "Fil public : publications, masquage, purge four-eyes.",
      },
      {
        href: "/users",
        label: "Utilisateurs",
        desc: "Comptes, rôles, fiche détaillée par utilisateur.",
      },
      {
        href: "/dms",
        label: "DM",
        desc: "Paires privées : compteurs, non-lus, enveloppes — jamais iv/ciphertext.",
      },
      {
        href: "/groups",
        label: "Groupes",
        desc: "Shells MLS : membres, exclusions, messages (epoch, tailles).",
      },
      {
        href: "/media",
        label: "Médias",
        desc: "Objets chiffrés : inventaire, purge unitaire et par lot.",
      },
      {
        href: "/network",
        label: "Réseau",
        desc: "Graphe social : liens, paires mutuelles, top suivis.",
      },
    ],
  },
  {
    title: "Systèmes",
    hint: "Sécurité, infrastructure et traçabilité",
    items: [
      {
        href: "/security",
        label: "Sécurité",
        desc: "Clés de confiance, blocages, gardes anti-rejeu, PoW, ingestion mesh.",
      },
      {
        href: "/infra",
        label: "Infrastructure",
        desc: "Passerelles mesh, abonnements Web Push, purge des désactivés.",
      },
      {
        href: "/audit",
        label: "Audit",
        desc: "Journal complet des actions d'administration.",
      },
    ],
  },
  {
    title: "Four-eyes",
    hint: "Destruction sensible — jamais un seul admin",
    items: [
      {
        href: "/pending-actions",
        label: "Intentions en attente",
        desc: "Purge post / DM / groupe / média : demandée par un super-admin, exécutée par un second.",
        danger: true,
      },
    ],
  },
];

export default async function Home() {
  const session = await getPanelSessionServer().catch(() => null);
  const initial = session
    ? { authenticated: true, email: session.email, role: session.role, totpEnrolled: session.totpEnrolled }
    : { authenticated: false, email: "", role: "", totpEnrolled: false };
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">Mbote Admin</h1>
          {initial.authenticated && (
            <div className="mt-3">
              <AdminNav showBack={false} />
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
        {initial.authenticated && (
          <section aria-labelledby="hub-heading" className="mb-6">
            <h2 id="hub-heading" className="text-base font-semibold text-zinc-900">
              Back-office — 12 sections
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Le panneau couvre tous les modèles de données détenus par le serveur.
              Le contenu chiffré reste illisible : métadonnées uniquement.
            </p>
            <div className="mt-4 space-y-6">
              {HUB_GROUPS.map((group) => (
                <div key={group.title}>
                  <h3 className="text-sm font-semibold text-zinc-800">{group.title}</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">{group.hint}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={
                          item.danger
                            ? "block rounded-lg border border-red-200 bg-red-50 p-4 shadow-sm transition hover:border-red-300 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                            : "block rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
                        }
                      >
                        <span
                          className={
                            item.danger
                              ? "text-sm font-semibold text-red-900"
                              : "text-sm font-semibold text-zinc-900"
                          }
                        >
                          {item.label} →
                        </span>
                        <span
                          className={
                            item.danger
                              ? "mt-1 block text-xs leading-relaxed text-red-800"
                              : "mt-1 block text-xs leading-relaxed text-zinc-600"
                          }
                        >
                          {item.desc}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section
          aria-labelledby="auth-heading"
          className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <h2
            id="auth-heading"
            className="text-base font-semibold text-zinc-900"
          >
            Authentification
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Email + mot de passe + code TOTP (6 chiffres) — un seul round-trip.
            Tout échec est uniforme (aucune indication sur la cause).
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
          mbote-admin · conteneur 3001 · publié sur l&apos;hôte uniquement sur
          127.0.0.1:3392 (boucle locale — réseau Docker interne)
        </p>
      </footer>
    </div>
  );
}
