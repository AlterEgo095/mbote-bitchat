"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { MapPin, Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetchChannels } from "@/lib/mbote/api";
import { CITY_PRESETS } from "@/lib/mbote/constants";
import { encodeGeohash, precisionLabel, precisionRadius } from "@/lib/mbote/geohash";
import type { ActiveChannel, ChannelAgg } from "@/lib/mbote/types";

const PRECISIONS = [7, 6, 5, 4, 2];

export function ChannelsView({
  onOpenChannel,
}: {
  onOpenChannel: (channel: ActiveChannel) => void;
}) {
  const [precisionFilter, setPrecisionFilter] = useState<number | null>(null);

  const channels = useQuery({
    queryKey: ["channels", precisionFilter],
    queryFn: () => apiFetchChannels(precisionFilter ?? undefined),
    refetchInterval: 10000,
  });

  // libellés lisibles pour les géohash connus (préréglages de villes)
  const labelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of CITY_PRESETS) {
      for (const p of PRECISIONS) {
        m.set(encodeGeohash(c.lat, c.lng, p), `${c.name} · ${precisionLabel(p).toLowerCase()}`);
      }
    }
    return m;
  }, []);

  const labelFor = (ch: ChannelAgg) =>
    labelMap.get(ch.geohash) ??
    (ch.precision <= 2 ? `Région #${ch.geohash}` : `Zone inconnue · #${ch.geohash}`);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Canaux géographiques</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Chaque cellule géohash est un salon public : bloc (~150 m), quartier (~1,2 km),
          ville (~5 km), province (~40 km), pays (~800 km) — comme chez BitChat.
        </p>
      </div>

      {/* Filtre précision */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrer par précision">
        <Button
          size="sm"
          variant={precisionFilter === null ? "default" : "outline"}
          onClick={() => setPrecisionFilter(null)}
          className="h-8"
        >
          Tous
        </Button>
        {PRECISIONS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={precisionFilter === p ? "default" : "outline"}
            onClick={() => setPrecisionFilter(p)}
            className="h-8 font-mono"
            aria-pressed={precisionFilter === p}
          >
            {p} · {precisionLabel(p)}
          </Button>
        ))}
      </div>

      {/* Créer un canal */}
      <CreateChannelCard onOpenChannel={onOpenChannel} />

      {/* Grille des canaux */}
      {channels.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Chargement des canaux">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (channels.data?.channels.length ?? 0) === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <MapPin className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-semibold">Aucun canal actif à cette précision</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Utilise le créateur de canal ci-dessus, puis publie le premier message — le canal
              naîtra instantanément.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(channels.data?.channels ?? []).map((ch) => {
            const open = () =>
              onOpenChannel({
                geohash: ch.geohash,
                precision: ch.precision,
                label: labelFor(ch),
              });
            return (
              // a11y (Vague 6) : la carte n'est PLUS un bouton — un seul
              // élément interactif par carte (le bouton « Ouvrir »), fini le
              // nested-interactive et le label/name divergents.
              <Card
                key={`${ch.geohash}-${ch.precision}`}
                className="group transition-colors hover:border-primary/40"
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{labelFor(ch)}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        #{ch.geohash}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0 border-primary/40 text-[10px] text-primary">
                      {precisionLabel(ch.precision)}
                    </Badge>
                  </div>

                  <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="size-3" aria-hidden="true" />
                      {precisionRadius(ch.precision)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3" aria-hidden="true" />
                      {ch.participantCount} voix
                    </span>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {ch.postCount} message{ch.postCount > 1 ? "s" : ""} · actif{" "}
                      {formatDistanceToNow(new Date(ch.lastAt), {
                        addSuffix: true,
                        locale: fr,
                      })}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-[11px]"
                      aria-label={`Ouvrir le canal ${labelFor(ch)} (#${ch.geohash})`}
                      onClick={open}
                    >
                      Ouvrir
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateChannelCard({ onOpenChannel }: { onOpenChannel: (c: ActiveChannel) => void }) {
  const [city, setCity] = useState<string>(CITY_PRESETS[0].name);
  const [precision, setPrecision] = useState<string>("5");

  const preset = CITY_PRESETS.find((c) => c.name === city) ?? CITY_PRESETS[0];
  const precisionNum = parseInt(precision, 10);
  const geohash = encodeGeohash(preset.lat, preset.lng, precisionNum);

  return (
    <Card className="border-primary/25 bg-primary/[0.04]">
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <Plus className="size-4 text-primary" aria-hidden="true" />
          <p className="text-sm font-semibold">Créer / rejoindre un canal</p>
        </div>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-[1fr_auto_auto]">
          <Select value={city} onValueChange={setCity}>
            <SelectTrigger aria-label="Choisir la ville" className="h-11">
              <SelectValue placeholder="Ville" />
            </SelectTrigger>
            <SelectContent>
              {CITY_PRESETS.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name} ({c.country})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={precision} onValueChange={setPrecision}>
            <SelectTrigger aria-label="Choisir la précision" className="h-11 w-full sm:w-40">
              <SelectValue placeholder="Précision" />
            </SelectTrigger>
            <SelectContent>
              {PRECISIONS.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {p} · {precisionLabel(p)} ({precisionRadius(p)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="h-11"
            onClick={() =>
              onOpenChannel({
                geohash,
                precision: precisionNum,
                label: `${preset.name} · ${precisionLabel(precisionNum).toLowerCase()}`,
              })
            }
          >
            Ouvrir <span className="font-mono">#{geohash}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
