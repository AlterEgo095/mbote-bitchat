"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Radio, ShieldCheck, Users, WifiOff, X, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetchFeed } from "@/lib/mbote/api";
import type { ActiveChannel, PendingPost } from "@/lib/mbote/types";
import { Composer } from "./Composer";
import { PendingPostCard, PostCard } from "./PostCard";

interface FeedViewProps {
  myPub: string | null;
  hasIdentity: boolean;
  activeChannel: ActiveChannel | null;
  onClearChannel: () => void;
  onOpenOnboarding: () => void;
  onPublish: (input: {
    content: string;
    geohash: string | null;
    precision: number | null;
    parentId?: string | null;
  }) => Promise<void>;
  onLike: (postId: string, liked: boolean) => void;
  onReply: (parentId: string, content: string) => Promise<void>;
  forceOffline: boolean;
  submitting: boolean;
  pendingPosts: PendingPost[];
  onDismissPending: (clientRef: string) => void;
}

export function FeedView({
  myPub,
  hasIdentity,
  activeChannel,
  onClearChannel,
  onOpenOnboarding,
  onPublish,
  onLike,
  onReply,
  forceOffline,
  submitting,
  pendingPosts,
  onDismissPending,
}: FeedViewProps) {
  const feed = useQuery({
    queryKey: ["feed", activeChannel?.geohash ?? "global", activeChannel?.precision ?? null, myPub],
    queryFn: () =>
      activeChannel
        ? apiFetchFeed({
            scope: "channel",
            geohash: activeChannel.geohash,
            precision: activeChannel.precision,
            myPub: myPub ?? undefined,
          })
        : apiFetchFeed({ scope: "global", myPub: myPub ?? undefined }),
    refetchInterval: forceOffline ? false : 20000, // fallback : le hub socket.io pousse en direct
  });

  const visiblePending = pendingPosts.filter(
    (p) => !activeChannel || p.geohash === activeChannel.geohash
  );

  return (
    <div className="space-y-5">
      {/* Bannière (fil global uniquement) */}
      {!activeChannel && (
        <Card className="relative overflow-hidden border-0 p-0">
          <div
            className="relative flex h-44 flex-col justify-end bg-cover bg-center p-5 md:h-52"
            style={{ backgroundImage: "url(/mbote/hero.png)" }}
            role="img"
            aria-label="Illustration : skyline africaine connectée par un réseau mesh lumineux"
          >
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
            <div className="relative">
              <h1 className="text-xl font-bold tracking-tight md:text-2xl">
                Mbote Mesh
              </h1>
              <p className="mt-0.5 max-w-md text-xs text-muted-foreground md:text-sm">
                Le réseau social qui survit aux coupures — sans compte, sans numéro.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge className="gap-1 bg-primary/90 text-[10px]">
                  <ShieldCheck className="size-3" aria-hidden="true" /> signature locale
                </Badge>
                <Badge className="gap-1 bg-amber-500/90 text-[10px] text-amber-950">
                  <MapPin className="size-3" aria-hidden="true" /> canaux géohash
                </Badge>
                <Badge className="gap-1 bg-primary/90 text-[10px]">
                  <WifiOff className="size-3" aria-hidden="true" /> file hors-ligne
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Barre de canal actif */}
      {activeChannel && (
        <div
          className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
          aria-label="Canal géographique actif"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <MapPin className="size-4.5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{activeChannel.label}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                #{activeChannel.geohash} · précision {activeChannel.precision}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearChannel}
            aria-label="Quitter le canal, revenir au fil global"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Composer / CTA */}
      {hasIdentity ? (
        <Composer
          canPost
          channelGeohash={activeChannel?.geohash ?? null}
          channelPrecision={activeChannel?.precision ?? null}
          channelLabel={activeChannel?.label ?? null}
          forceOffline={forceOffline}
          submitting={submitting}
          onSubmit={(content) =>
            onPublish({
              content,
              geohash: activeChannel?.geohash ?? null,
              precision: activeChannel?.precision ?? null,
            })
          }
        />
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <div className="flex size-11 items-center justify-center rounded-full bg-primary/10">
              <KeyRound className="size-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold">Crée ton identité locale pour publier</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Tes clés restent sur ton appareil — aucun email, aucun numéro.
              </p>
            </div>
            <Button size="sm" onClick={onOpenOnboarding}>
              Générer mes clés
            </Button>
          </CardContent>
        </Card>
      )}

      {/* File d'attente locale */}
      {visiblePending.length > 0 && (
        <section aria-label="File d'attente locale" className="space-y-2">
          {visiblePending.map((p) => (
            <PendingPostCard
              key={p.clientRef}
              content={p.content}
              geohash={p.geohash}
              precision={p.precision}
              onDismiss={() => onDismissPending(p.clientRef)}
            />
          ))}
        </section>
      )}

      {/* Fil */}
      {feed.isLoading ? (
        <div className="space-y-3" aria-label="Chargement du fil">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="flex gap-3 p-4">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="w-full space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-2/3" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (feed.data?.posts.length ?? 0) === 0 && visiblePending.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            {activeChannel ? (
              <Radio className="size-8 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Users className="size-8 text-muted-foreground" aria-hidden="true" />
            )}
            <p className="text-sm font-semibold">
              {activeChannel
                ? `Canal ${activeChannel.geohash} silencieux pour l'instant`
                : "Le fil global attend ton premier message"}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {activeChannel
                ? "Ouvre le bal : ton message deviendra l'historique du quartier, synchronisé entre voisins."
                : "Publie, like, répond — ou explore les canaux géohash pour trouver ta communauté locale."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {feed.data?.posts.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              myPub={myPub}
              forceOffline={forceOffline}
              onLike={onLike}
              onReply={onReply}
            />
          ))}
          {feed.isFetching && !feed.isLoading && (
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Synchronisation du fil…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
