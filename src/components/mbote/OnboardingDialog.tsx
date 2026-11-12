"use client";

import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck, WifiOff, Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function OnboardingDialog({
  open,
  creating,
  powProgress,
  onCreate,
  onOpenChange,
}: {
  open: boolean;
  creating: boolean;
  /** D2 — progression du PoW (0..1) pendant la publication serveur de la
   *  création ; null = pas de calcul en cours (création locale seule). */
  powProgress: number | null;
  onCreate: (nickname: string, bio: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [nickname, setNickname] = useState("");
  const [bio, setBio] = useState("");
  const valid = nickname.trim().length >= 2;
  const powPct = powProgress != null ? Math.round(Math.min(1, Math.max(0, powProgress)) * 100) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div
          className="h-28 w-full bg-cover bg-center"
          style={{ backgroundImage: "url(/mbote/hero.png)" }}
          role="img"
          aria-label="Bannière réseau mesh au-dessus d'une ville africaine"
        />
        <div className="p-6 pt-4">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 text-xl">
              <KeyRound className="size-5 text-primary" aria-hidden="true" />
              Crée ton identité locale
            </DialogTitle>
            <DialogDescription className="pt-1 text-sm leading-relaxed">
              Aucun email, aucun numéro, aucun serveur d&apos;inscription. Une paire de
              clés est générée <strong>sur ton appareil</strong> : ECDSA P-256 pour signer
              tes publications, ECDH P-256 pour chiffrer tes messages privés de bout en bout.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="onb-nick">Pseudo visible</Label>
              <Input
                id="onb-nick"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="ex. Mapendo"
                maxLength={32}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="onb-bio">
                Bio <span className="text-muted-foreground">(optionnel)</span>
              </Label>
              <Textarea
                id="onb-bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Qui es-tu ? Quel canal géohash animes-tu ?"
                rows={2}
                maxLength={240}
              />
            </div>
          </div>

          <DialogFooter className="mt-5 flex-col gap-2 sm:flex-col">
            {powPct != null && (
              <div
                className="w-full rounded-lg border border-border bg-muted/40 p-3"
                data-testid="pow-progress"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-center justify-between text-xs font-medium text-foreground">
                  <span className="inline-flex items-center gap-1.5" data-testid="pow-progress-label">
                    <Hammer className="size-3.5 text-primary" aria-hidden="true" />
                    Préparation du compte… {powPct}%
                  </span>
                </div>
                <div
                  className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={powPct}
                  aria-label="Progression de la preuve de travail"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200 ease-linear"
                    style={{ width: `${powPct}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                  Preuve de travail anti-spam (20 bits) : un petit calcul sur ton
                  appareil qui rend la création de faux comptes coûteuse pour les
                  fermes à spambots — pas pour toi.
                </p>
              </div>
            )}
            <Button
              className="w-full"
              disabled={!valid || creating}
              onClick={async () => {
                await onCreate(nickname.trim(), bio.trim());
              }}
            >
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Génération des clés…
                </>
              ) : (
                "Générer mes clés et entrer"
              )}
            </Button>
            <div className="flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
                Clés privées jamais envoyées
              </span>
              <span className="inline-flex items-center gap-1">
                <WifiOff className="size-3.5 text-amber-500" aria-hidden="true" />
                Fonctionne hors-ligne
              </span>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
