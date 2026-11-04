"use client";

/**
 * Boundary d'erreur de segment (F-10) — remplace l'écran blanc Next.js
 * quand le rendu d'une vue plante. Reste dans le layout racine :
 * les tokens de thème (bg-background, text-foreground…) et les composants
 * shadcn/ui restent disponibles.
 */

import { useEffect } from "react";
import { Unplug } from "lucide-react";

import { Button } from "@/components/ui/button";

const MESSAGE_MAX_LENGTH = 140;

function truncateMessage(message: string): string {
  return message.length > MESSAGE_MAX_LENGTH
    ? `${message.slice(0, MESSAGE_MAX_LENGTH)}…`
    : message;
}

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    if (error.digest) {
      console.error("[Mbote] digest de l'erreur :", error.digest);
    }
  }, [error]);

  const details = error?.message
    ? truncateMessage(error.message)
    : "Le fil n'a pas pu être rendu. Vos messages sont en sécurité — réessayez ou rechargez la page.";

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div
        role="alert"
        className="w-full max-w-md rounded-lg border bg-card p-6 text-center shadow-sm"
      >
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          <Unplug className="size-6 text-primary" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">
          Une panne est survenue
        </h1>
        <p className="mt-2 break-words text-sm text-muted-foreground">
          {details}
        </p>
        {error?.digest ? (
          <p className="mt-1.5 text-xs text-muted-foreground/80">
            Référence de diagnostic : {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Button onClick={() => reset()}>Réessayer</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Recharger la page
          </Button>
        </div>
      </div>
    </div>
  );
}
