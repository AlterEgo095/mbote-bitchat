/**
 * Page 404 (F-10) — alignée sur le style de l'app (min-h-screen flex-col,
 * conteneur max-w-6xl, carte sobre), texte entièrement en français.
 */

import Link from "next/link";
import { RadioTower } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <RadioTower className="size-6 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            404 — Page introuvable
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Ce fil n&apos;existe pas ou a été emporté par le mesh.
          </p>
          <div className="mt-6 flex justify-center">
            <Button asChild>
              <Link href="/">Retour au fil</Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
