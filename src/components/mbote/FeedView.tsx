"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Globe,
  KeyRound,
  Loader2,
  MapPin,
  Radio,
  Search,
  ShieldCheck,
  Users,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiFetchFeed, apiGetPost, describeApiError, type FeedScope } from "@/lib/mbote/api";
import { useI18n } from "@/lib/mbote/i18n";
import type { ActiveChannel, PendingPost, PostWithMeta } from "@/lib/mbote/types";
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
  onLike: (postId: string, liked: boolean) => boolean | Promise<boolean> | void;
  onReply: (parentId: string, content: string) => Promise<void>;
  forceOffline: boolean;
  submitting: boolean;
  pendingPosts: PendingPost[];
  onDismissPending: (clientRef: string) => void;
  /** F-49 : texte partagé via share_target (brouillon initial du composer) */
  draft?: string | null;
  /** D1 : post ciblé depuis la recherche (scroll/flash, fetch isolé si absent du fil) */
  focusPostId?: string | null;
  /** D1 : consommé quand la cible a été affichée/flashée (ou introuvable). */
  onFocusPostConsumed?: () => void;
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
  draft,
  focusPostId,
  onFocusPostConsumed,
}: FeedViewProps) {
  const { t, fmt } = useI18n();

  // F-12.3 : portée du fil global — « Tous » ou « Abonnements » (scope
  // "following" du backend, consommé ici pour la première fois).
  const [feedScope, setFeedScope] = useState<"global" | "following">("global");

  // Scope effectif : en canal → "channel" ; en global, le toggle (retombée
  // sur "global" si « Abonnements » sans identité — bouton désactivé).
  const scope: FeedScope = activeChannel
    ? "channel"
    : feedScope === "following" && myPub
      ? "following"
      : "global";

  // F-13 : pagination par curseur (useInfiniteQuery) — `before` = curseur
  // base64url renvoyé par la page précédente (nextCursor). Le queryKey inclut
  // le scope : changer de canal ou de portée remet la pagination à zéro.
  const feed = useInfiniteQuery({
    queryKey: [
      "feed",
      activeChannel?.geohash ?? "global",
      activeChannel?.precision ?? null,
      myPub,
      scope,
    ],
    queryFn: ({ pageParam }) =>
      activeChannel
        ? apiFetchFeed({
            scope: "channel",
            geohash: activeChannel.geohash,
            precision: activeChannel.precision,
            myPub: myPub ?? undefined,
            before: pageParam,
          })
        : apiFetchFeed({
            scope: scope === "following" ? "following" : "global",
            myPub: myPub ?? undefined,
            before: pageParam,
          }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: forceOffline ? false : 20000, // fallback : le hub socket.io pousse en direct
  });

  // Aplat des pages + déduplication par id : un refetch de la page 1 après
  // l'arrivée de nouveaux posts peut faire chevaucher les fenêtres de curseur.
  const posts = useMemo(() => {
    const seen = new Set<string>();
    const flat: PostWithMeta[] = [];
    for (const page of feed.data?.pages ?? []) {
      for (const p of page.posts) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        flat.push(p);
      }
    }
    return flat;
  }, [feed.data]);

  // F-13 : sentinelle IntersectionObserver — précharge la page suivante
  // ~400 px avant d'atteindre le bas de la liste.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, posts.length]);

  const visiblePending = pendingPosts.filter(
    (p) => !activeChannel || p.geohash === activeChannel.geohash
  );

  // ── D1 : navigation depuis la recherche ───────────────────────────────────
  // Si le post est dans le fil → scroll + flash direct. Sinon → fetch isolé
  // (GET /api/posts/[id], mêmes filtres de visibilité que le fil) et carte
  // « Résultat de recherche » épinglée en haut du fil.
  const [focusPost, setFocusPost] = useState<PostWithMeta | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);

  const flashPost = useCallback((id: string) => {
    const el = document.querySelector(`[data-post-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-primary", "ring-offset-2");
    setTimeout(() => el.classList.remove("ring-2", "ring-primary", "ring-offset-2"), 2500);
    return true;
  }, []);

  useEffect(() => {
    if (!focusPostId) return;
    // post présent dans le fil → scroll + flash direct (pas de carte dédiée :
    // l'affichage de la carte est DÉRIVÉ au rendu — pas de setState synchrone)
    if (posts.some((p) => p.id === focusPostId)) {
      if (flashPost(focusPostId)) onFocusPostConsumed?.();
      return;
    }
    let cancelled = false;
    void apiGetPost(focusPostId)
      .then((r) => {
        if (cancelled) return;
        setFocusPost(r.post);
        // flash au prochain rendu (la carte vient d'être montée)
        setTimeout(() => {
          if (flashPost(focusPostId)) return;
          document
            .querySelector(`[data-search-focus="${CSS.escape(focusPostId)}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
        onFocusPostConsumed?.();
      })
      .catch(() => {
        if (!cancelled) {
          setFocusMissing(true);
          onFocusPostConsumed?.();
        }
      });
    return () => {
      cancelled = true;
    };
    // posts en dep : permet le flash direct dès que le post apparaît dans le fil
  }, [focusPostId, posts, flashPost, onFocusPostConsumed]);

  // carte « Résultat de recherche » : montrée SEULEMENT si le post n'a pas
  // (encore) rejoint le fil — dérivé, aucune synchronisation d'état requise
  const showFocusCard =
    focusPost && !posts.some((p) => p.id === focusPost.id) ? focusPost : null;

  return (
    <div className="space-y-5">
      {/* Bannière (fil global uniquement) */}
      {!activeChannel && (
        <Card className="relative overflow-hidden border-0 p-0">
          <div
            className="relative flex h-44 flex-col justify-end p-5 md:h-52"
            role="img"
            aria-label={t("feed.heroAria")}
          >
            {/* F-54 : hero priorisé via next/image (LCP) au lieu d'un background-image CSS */}
            <Image
              src="/mbote/hero.png"
              alt=""
              fill
              priority
              sizes="(max-width: 768px) 100vw, 896px"
              className="object-cover object-center"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
            <div className="relative">
              <h1 className="text-xl font-bold tracking-tight md:text-2xl">
                Mbote Mesh
              </h1>
              <p className="mt-0.5 max-w-md text-xs text-muted-foreground md:text-sm">
                {t("feed.tagline")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge className="gap-1 bg-primary/90 text-[10px]">
                  <ShieldCheck className="size-3" aria-hidden="true" /> {t("feed.badgeSignature")}
                </Badge>
                <Badge className="gap-1 bg-amber-500/90 text-[10px] text-amber-950">
                  <MapPin className="size-3" aria-hidden="true" /> {t("feed.badgeGeohash")}
                </Badge>
                <Badge className="gap-1 bg-primary/90 text-[10px]">
                  <WifiOff className="size-3" aria-hidden="true" /> {t("feed.badgeOffline")}
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* F-12.3 : bascule Tous / Abonnements (fil global uniquement) */}
      {!activeChannel && (
        <div role="group" aria-label={t("feed.scopeAria")} className="flex items-center">
          <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
            <Button
              size="sm"
              variant={scope === "global" ? "default" : "ghost"}
              aria-pressed={scope === "global"}
              onClick={() => setFeedScope("global")}
              className="min-h-11 rounded-md px-3 text-xs"
            >
              <Globe className="size-3.5" aria-hidden="true" />
              {t("feed.scopeAll")}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                {myPub ? (
                  <Button
                    size="sm"
                    variant={scope === "following" ? "default" : "ghost"}
                    aria-pressed={scope === "following"}
                    // a11y (2.5.3) : le nom contient le texte visible « Abonnements »
                    aria-label={t("feed.scopeFollowingAria")}
                    onClick={() => setFeedScope("following")}
                    className="min-h-11 rounded-md px-3 text-xs"
                  >
                    <UsersRound className="size-3.5" aria-hidden="true" />
                    {t("feed.scopeFollowing")}
                  </Button>
                ) : (
                  <span tabIndex={0} className="inline-flex rounded-md">
                    <Button
                      size="sm"
                      variant={scope === "following" ? "default" : "ghost"}
                      disabled
                      aria-label={t("feed.scopeFollowingDisabledAria")}
                      className="min-h-11 rounded-md px-3 text-xs"
                    >
                      <UsersRound className="size-3.5" aria-hidden="true" />
                      {t("feed.scopeFollowing")}
                    </Button>
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent>
                {myPub
                  ? t("feed.scopeFollowingTooltip")
                  : t("feed.scopeFollowingTooltipOff")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Barre de canal actif */}
      {activeChannel && (
        <div
          className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
          aria-label={t("feed.channelAria")}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <MapPin className="size-4.5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              {/* a11y : en mode canal le hero (h1) est masqué → le titre du
                  canal devient le h1 de la page (page-has-heading-one) */}
              <h1 className="truncate text-sm font-semibold">{activeChannel.label}</h1>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {t("feed.channelMeta", {
                  geohash: activeChannel.geohash,
                  precision: fmt.fmtNumber(activeChannel.precision),
                })}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearChannel}
            aria-label={t("feed.leaveChannelAria")}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Composer / CTA */}
      {hasIdentity ? (
        <Composer
          key={draft ?? "composer"}
          initialText={draft ?? undefined}
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
              <p className="text-sm font-semibold">{t("feed.ctaTitle")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("feed.ctaBody")}
              </p>
            </div>
            <Button size="sm" onClick={onOpenOnboarding}>
              {t("feed.ctaButton")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* File d'attente locale */}
      {focusMissing && (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
          {t("feed.focusMissing")}
        </p>
      )}
      {focusPost && !showFocusCard && (
        /* le post a rejoint le fil (refetch) : la carte dédiée s'efface d'elle-même */
        <span className="hidden" aria-hidden="true" data-search-focus={focusPost.id} />
      )}
      {showFocusCard && (
        <section aria-label={t("feed.searchResult")} className="space-y-1">
          <div data-search-focus={showFocusCard.id} className="space-y-1">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <Search className="size-3" aria-hidden="true" /> {t("feed.searchResult")}
            </p>
            <PostCard
              post={showFocusCard}
              myPub={myPub}
              forceOffline={forceOffline}
              onLike={onLike}
              onReply={onReply}
            />
          </div>
        </section>
      )}
      {visiblePending.length > 0 && (
        <section aria-label={t("feed.queueAria")} className="space-y-2">
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
        <div className="space-y-3" aria-label={t("feed.loadingAria")}>
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
      ) : feed.isError ? (
        // F #15 — état d'erreur HONNÊTE : un échec réseau n'est plus déguisé
        // en « fil vide » (mensonge d'état vide). Réessayer → refetch.
        <Card className="border-red-300 bg-red-50" data-testid="feed-error">
          <CardContent className="flex flex-col items-start gap-3 p-6" role="alert">
            <p className="text-sm font-semibold text-red-900">
              {t("feed.errorTitle")}
            </p>
            <p className="text-sm text-red-800">
              {t("feed.errorDetail", { error: describeApiError(feed.error) })}
            </p>
            <Button
              size="sm"
              className="h-11 bg-red-700 text-white hover:bg-red-800"
              onClick={() => void feed.refetch()}
            >
              {t("common.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : posts.length === 0 && visiblePending.length === 0 ? (
        scope === "following" ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
              <UsersRound className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-semibold">{t("feed.emptyFollowingTitle")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t("feed.emptyFollowingBody")}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
              {activeChannel ? (
                <Radio className="size-8 text-muted-foreground" aria-hidden="true" />
              ) : (
                <Users className="size-8 text-muted-foreground" aria-hidden="true" />
              )}
              <p className="text-sm font-semibold">
                {activeChannel
                  ? t("feed.emptyChannelTitle", { geohash: activeChannel.geohash })
                  : t("feed.emptyGlobalTitle")}
              </p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {activeChannel
                  ? t("feed.emptyChannelBody")
                  : t("feed.emptyGlobalBody")}
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <div key={p.id} data-post-id={p.id}>
              <PostCard
                post={p}
                myPub={myPub}
                forceOffline={forceOffline}
                onLike={onLike}
                onReply={onReply}
              />
            </div>
          ))}
          {feed.isFetching && !feed.isLoading && !feed.isFetchingNextPage && (
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {t("feed.syncing")}
            </div>
          )}
          {/* F-13 : pied de pagination — spinner, fallback clavier, fin de fil */}
          {feed.isFetchingNextPage ? (
            <div
              className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {t("feed.loadingMore")}
            </div>
          ) : feed.hasNextPage ? (
            <div className="flex justify-center pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void feed.fetchNextPage()}
                aria-label={t("feed.loadMoreAria")}
              >
                {t("feed.loadMore")}
              </Button>
            </div>
          ) : (
            posts.length > 0 && (
              <p className="pt-1 text-center text-[11px] text-muted-foreground">
                {t("feed.endOfFeed")}
              </p>
            )
          )}
          {/* Sentinelle du scroll infini (F-13) */}
          <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
        </div>
      )}
    </div>
  );
}
