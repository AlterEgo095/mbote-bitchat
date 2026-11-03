"use client";

/**
 * Boundary d'erreur GLOBALE (F-10) — rendue quand le layout racine lui-même
 * a planté. Doit rester totalement autonome : pas de Providers, pas de
 * polices chargées par le layout, pas de composants ui. Uniquement du
 * Tailwind inline avec des tokens dark/light-safe, et ses propres
 * <html>/<body> (Next l'exige pour ce fichier).
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    if (error.digest) {
      console.error("[Mbote] digest de l'erreur globale :", error.digest);
    }
  }, [error]);

  return (
    <html lang="fr">
      <body className="bg-background text-foreground antialiased">
        <div className="flex min-h-screen items-center justify-center p-4">
          <div
            role="alert"
            className="w-full max-w-sm rounded-lg border p-6 text-center"
          >
            <h1 className="text-lg font-semibold">
              Une panne critique est survenue
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              L&apos;interface n&apos;a pas pu démarrer. Vos données locales
              ne sont pas perdues.
            </p>
            {error?.digest ? (
              <p className="mt-1.5 text-xs text-muted-foreground/80">
                Référence de diagnostic : {error.digest}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => reset()}
              className="mt-6 inline-flex h-11 min-w-32 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Réessayer
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
