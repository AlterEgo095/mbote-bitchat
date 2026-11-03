"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  BadgeCheck,
  Bluetooth,
  Clock,
  CornerDownRight,
  Loader2,
  MapPin,
  MessageCircle,
  Send,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiFetchFeed } from "@/lib/mbote/api";
import { shortKey } from "@/lib/mbote/crypto";
import { precisionLabel } from "@/lib/mbote/geohash";
import type { PostWithMeta } from "@/lib/mbote/types";
import { MboteAvatar } from "./Avatar";

interface PostCardProps {
  post: PostWithMeta;
  myPub: string | null;
  forceOffline?: boolean;
  onLike: (postId: string, liked: boolean) => void;
  onReply?: (parentId: string, content: string) => Promise<void>;
  compact?: boolean;
}

export function PostCard({
  post,
  myPub,
  forceOffline = false,
  onLike,
  onReply,
  compact = false,
}: PostCardProps) {
  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [threadOpen, setThreadOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const qc = useQueryClient();

  const replies = useQuery({
    queryKey: ["feed", "replies", post.id, myPub],
    queryFn: () => apiFetchFeed({ scope: "replies", parentId: post.id, myPub: myPub ?? undefined }),
    enabled: threadOpen,
  });

  const isMine = myPub === post.author.pubkey;

  const handleLike = () => {
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => c + (next ? 1 : -1));
    onLike(post.id, next);
  };

  const handleReply = async () => {
    const text = replyText.trim();
    if (!text || !onReply) return;
    setReplying(true);
    try {
      await onReply(post.id, text);
      setReplyText("");
      await qc.invalidateQueries({ queryKey: ["feed", "replies", post.id] });
    } finally {
      setReplying(false);
    }
  };

  return (
    <article
      className={`rounded-xl border bg-card transition-colors hover:border-primary/30 ${
        compact ? "p-3" : "p-4"
      } ${isMine ? "border-primary/25" : "border-border"}`}
      aria-label={`Publication de ${post.author.nickname}`}
    >
      <div className="flex items-start gap-3">
        <MboteAvatar pubkey={post.author.pubkey} nickname={post.author.nickname} size={compact ? 32 : 40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold">{post.author.nickname}</span>
            {post.author.isBot && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                bot
              </Badge>
            )}
            {isMine && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-primary">
                toi
              </Badge>
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {shortKey(post.author.pubkey)}
            </span>
            {post.signature && (
              <span
                title="Publication signée côté appareil (ECDSA P-256)"
                className="inline-flex items-center gap-0.5 text-[11px] text-primary"
              >
                <BadgeCheck className="size-3.5" aria-hidden="true" />
                <span className="sr-only">signée</span>
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">·</span>
            <time
              dateTime={post.createdAt}
              className="text-[11px] text-muted-foreground"
              title={new Date(post.createdAt).toLocaleString("fr-FR")}
            >
              {formatDistanceToNow(new Date(post.createdAt), { addSuffix: true, locale: fr })}
            </time>
          </div>

          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {post.content}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {post.origin === "mesh" && (
              <Badge
                variant="outline"
                className="cursor-default gap-1 border-emerald-500/50 bg-emerald-500/5 text-[10px] text-emerald-500"
                title="Ce message a voyagé hors-ligne sur le mesh Bluetooth BitChat avant d'être remonté par une passerelle"
              >
                <Bluetooth className="size-3" aria-hidden="true" />
                via mesh · {post.meshHops ?? "?"} saut{(post.meshHops ?? 0) > 1 ? "s" : ""}
              </Badge>
            )}
            {post.geohash && (
              <Badge
                variant="outline"
                className="cursor-default gap-1 border-primary/40 bg-primary/5 font-mono text-[10px] text-primary"
              >
                <MapPin className="size-3" aria-hidden="true" />
                {post.geohash}
                <span className="font-sans text-muted-foreground">
                  · {precisionLabel(post.precision ?? 5).toLowerCase()}
                </span>
              </Badge>
            )}
          </div>

          <div className="mt-2.5 flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLike}
              aria-pressed={liked}
              aria-label={liked ? "Retirer mon j'aime" : "J'aime"}
              className={`h-8 gap-1.5 px-2 text-xs ${
                liked ? "text-amber-500 hover:text-amber-500" : "text-muted-foreground"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill={liked ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
              {likeCount}
            </Button>
            {!compact && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setThreadOpen((v) => !v)}
                aria-expanded={threadOpen}
                className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
              >
                <MessageCircle className="size-4" aria-hidden="true" />
                {post.replyCount > 0 ? post.replyCount : "Répondre"}
              </Button>
            )}
          </div>

          {threadOpen && !compact && (
            <div className="mt-3 space-y-2 rounded-lg border bg-background/60 p-3">
              {onReply && myPub && (
                <div className="flex items-end gap-2">
                  <Textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Répondre… (chiffré nulle part, signé partout)"
                    rows={2}
                    maxLength={500}
                    className="min-h-[44px] text-sm"
                    aria-label="Votre réponse"
                  />
                  <Button
                    size="sm"
                    onClick={handleReply}
                    disabled={!replyText.trim() || replying}
                    className="h-[44px] shrink-0"
                  >
                    {replying ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="size-4" aria-hidden="true" />
                    )}
                    <span className="sr-only">Envoyer la réponse</span>
                  </Button>
                </div>
              )}

              {replies.isLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  Chargement du fil…
                </div>
              ) : (replies.data?.posts.length ?? 0) === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">
                  Aucune réponse — sois le premier à réagir.
                </p>
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto scrollbar-thin">
                  {replies.data!.posts.map((r) => (
                    <li key={r.id} className="flex items-start gap-2">
                      <CornerDownRight
                        className="mt-1 size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <PostCard
                        post={r}
                        myPub={myPub}
                        compact
                        forceOffline={forceOffline}
                        onLike={onLike}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {compact && threadOpen && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => setThreadOpen(false)}
            aria-label="Fermer le fil"
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </article>
  );
}

/** Variante affichant un post en attente dans la file locale (courrier) */
export function PendingPostCard({
  content,
  geohash,
  precision,
  onDismiss,
}: {
  content: string;
  geohash?: string | null;
  precision?: number | null;
  onDismiss?: () => void;
}) {
  return (
    <article
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
      aria-label="Publication en attente dans la file locale"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
          <Clock className="size-5 text-amber-500" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">Toi</span>
            <Badge variant="outline" className="gap-1 border-amber-500/50 text-[10px] text-amber-500">
              <Clock className="size-3" aria-hidden="true" />
              en attente — courrier local
            </Badge>
            {geohash && (
              <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/5 font-mono text-[10px] text-primary">
                <MapPin className="size-3" aria-hidden="true" />
                {geohash}
              </Badge>
            )}
            {precision != null && (
              <span className="text-[10px] text-muted-foreground">
                {precisionLabel(precision).toLowerCase()}
              </span>
            )}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
            {content}
          </p>
        </div>
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={onDismiss}
            aria-label="Abandonner ce message en file"
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </article>
  );
}
