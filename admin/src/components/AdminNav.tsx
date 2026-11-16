"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// ─────────────────────────────────────────────────────────────────────────────
// AdminNav — navigation unique du panneau (back-office 2026-11).
//
//  Avant : chaque page répétait son bloc <nav> à la main — chaque nouvelle
//  section (DM, Groupes, Médias, Réseau, Sécurité, Infrastructure) aurait
//  multiplié les divergences. Un seul composant, partagé par les 12 pages
//  principales ; les fiches de détail (posts/[id], users/[id], groups/[id])
//  gardent leur nav contextuelle « ← retour ».
//
//  État actif : usePathname + aria-current="page" (accessibilité) — le lien
//  de la page courante est mis en évidence et n'est plus un simple devin.
//
//  Hiérarchie visuelle : pilotage (dashboard/queue) → annuaires (contenus,
//  users, DM, groupes, médias, réseau) → systèmes (sécurité, infra, audit)
//  → four-eyes (rouge — intentions en attente d'un second super-admin)
//  → retour auth.
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS: Array<{ href: string; label: string; kind?: "danger" }> = [
  { href: "/dashboard", label: "Tableau de bord" },
  { href: "/queue", label: "File de modération" },
  { href: "/posts", label: "Contenus" },
  { href: "/users", label: "Utilisateurs" },
  { href: "/dms", label: "DM" },
  { href: "/groups", label: "Groupes" },
  { href: "/media", label: "Médias" },
  { href: "/network", label: "Réseau" },
  { href: "/security", label: "Sécurité" },
  { href: "/infra", label: "Infrastructure" },
  { href: "/audit", label: "Audit" },
  { href: "/pending-actions", label: "Four-eyes", kind: "danger" },
];

function linkClasses(href: string, active: boolean, kind?: "danger"): string {
  const base =
    "rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2";
  if (kind === "danger") {
    return active
      ? `${base} border-red-400 bg-red-200 text-red-900 focus-visible:outline-red-500`
      : "border-red-200 bg-red-50 text-red-900 hover:bg-red-100 focus-visible:outline-red-500";
  }
  return active
    ? `${base} border-zinc-400 bg-zinc-200 text-zinc-900 focus-visible:outline-zinc-500`
    : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 focus-visible:outline-zinc-500";
}

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="Navigation panneau">
      {SECTIONS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={linkClasses(item.href, active, item.kind)}
          >
            {item.label}
          </Link>
        );
      })}
      <Link
        href="/"
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
      >
        Retour
      </Link>
    </nav>
  );
}
