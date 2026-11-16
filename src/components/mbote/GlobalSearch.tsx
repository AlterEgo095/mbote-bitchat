"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D1 — Recherche globale : barre + panneau de résultats en deux sections
 * ─────────────────────────────────────────────────────────────────────────────
 *  • « Fil public » : /api/search (FTS5 serveur) — lecture anonyme possible,
 *    30 req/min/IP (rate limit serveur) ;
 *  • « Messages privés » : searchLocalDm (IndexedDB local) — ZÉRO requête
 *    réseau, frontière E2EE (le serveur ne voit jamais le contenu des DM).
 *  Un seul chemin de code (Dialog) pour desktop et mobile. Debounce 250 ms.
 *  Navigation : onOpenPost(postId) → FeedView (scroll/flash, fetch isolé si
 *  absent du fil) · onOpenMessage(peer, messageId) → MessagesView.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Lock, MessageCircle, Newspaper, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { apiSearchPosts, type SearchResultPost } from "@/lib/mbote/api";
import { searchLocalDm, type DmSearchHit } from "@/lib/mbote/dm-search-index";
import { useI18n } from "@/lib/mbote/i18n";

interface GlobalSearchProps {
  onOpenPost: (postId: string) => void;
  onOpenMessage: (peer: string, messageId: string) => void;
  /** recherche DM locale désactivée sans identité (rien à déchiffrer) */
  hasIdentity: boolean;
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const esc = terms
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!esc.length) return <>{text}</>;
  const re = new RegExp(`(${esc.join("|")})`, "giu");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        re.test(p) && i % 2 === 1 ? (
          <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

export function GlobalSearch({ onOpenPost, onOpenMessage, hasIdentity }: GlobalSearchProps) {
  const { t, tp, fmt } = useI18n();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  // résultat local TAGGÉ par la requête qui l'a produit : l'affichage dérive
  // (hits = null si la requête a changé) — pas de setState synchrone d'effet
  const [localResult, setLocalResult] = useState<{
    q: string;
    hits: DmSearchHit[];
    terms: string[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // debounce 250 ms — limite les hits serveur (30/min) ET le travail local
  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  const terms = useMemo(
    () => (debounced.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8),
    [debounced]
  );

  // recherche serveur (fil public) — posts uniquement
  const postsQuery = useQuery({
    queryKey: ["search-posts", debounced],
    queryFn: () => apiSearchPosts(debounced, 0, 20),
    enabled: open && debounced.length >= 2,
    staleTime: 15_000,
    retry: false,
  });

  // recherche locale DM — 100 % IndexedDB, aucune requête réseau
  useEffect(() => {
    if (!open || debounced.length < 2 || !hasIdentity) return;
    let cancelled = false;
    void searchLocalDm(debounced, 20)
      .then((hits) => {
        if (!cancelled) {
          setLocalResult({
            q: debounced,
            hits,
            terms: terms.map((t) =>
              t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
            ),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setLocalResult({ q: debounced, hits: [], terms: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, open, hasIdentity, terms]);

  // dérivé : les hits locaux ne sont valides QUE pour la requête courante
  const localHits = localResult && localResult.q === debounced ? localResult.hits : null;
  const dmTerms = localResult && localResult.q === debounced ? localResult.terms : [];

  // focus auto à l'ouverture
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const openPost = useCallback(
    (postId: string) => {
      setOpen(false);
      onOpenPost(postId);
    },
    [onOpenPost]
  );

  const openMessage = useCallback(
    (peer: string, messageId: string) => {
      setOpen(false);
      onOpenMessage(peer, messageId);
    },
    [onOpenMessage]
  );

  const results = postsQuery.data?.results ?? [];
  const empty = debounced.length >= 2 && !postsQuery.isLoading && localHits !== null
    && results.length === 0 && localHits.length === 0;

  return (
    <>
      {/* déclencheur — bouton style « champ » (un seul chemin de code mobile/desktop) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("search.triggerAria")}
        className="flex h-9 w-9 items-center justify-center rounded-lg border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:h-9 md:w-56 md:justify-start md:gap-2 md:px-3"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="hidden text-xs text-muted-foreground md:inline">
          {t("search.triggerPlaceholder")}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="sr-only">
            <DialogTitle>{t("search.title")}</DialogTitle>
            <DialogDescription>{t("search.description")}</DialogDescription>
          </DialogHeader>
          <div className="border-b p-3">
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={inputRef}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder={t("search.inputPlaceholder")}
                aria-label={t("search.inputAria")}
                className="pl-8"
              />
            </div>
            <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
              {t("search.footerNote")}
            </p>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-3">
              {debounced.length < 2 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {t("search.minChars")}
                </p>
              )}

              {debounced.length >= 2 && postsQuery.isLoading && (
                <div className="space-y-2" aria-hidden="true">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              )}

              {debounced.length >= 2 && postsQuery.isError && (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                  {t("search.publicError", {
                    message: (postsQuery.error as Error)?.message ?? t("search.publicErrorNetwork"),
                  })}
                </p>
              )}

              {/* ── section fil public ── */}
              {results.length > 0 && (
                <section aria-label={t("search.sectionPublic")}>
                  <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Newspaper className="size-3.5" aria-hidden="true" />
                    {t("search.publicHeader")}
                    <Badge
                      variant="outline"
                      className="ml-1 px-1.5 py-0 text-[9px]"
                      aria-label={tp("search.results", results.length)}
                      title={tp("search.results", results.length)}
                    >
                      {results.length}
                    </Badge>
                  </h3>
                  <ul className="space-y-1.5">
                    {results.map((r: SearchResultPost) => (
                      <li key={r.postId}>
                        <button
                          type="button"
                          onClick={() => openPost(r.postId)}
                          className="w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-accent"
                        >
                          <p className="line-clamp-2 text-sm">
                            <Highlight text={r.snippet} terms={terms} />
                          </p>
                          <p className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="truncate font-medium">{r.authorNickname}</span>
                            <span aria-hidden="true">·</span>
                            {fmt.fmtRelative(r.createdAt)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {postsQuery.data?.hasMore && (
                    <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                      {t("search.moreResults")}
                    </p>
                  )}
                </section>
              )}

              {/* ── section messages privés (local) ── */}
              {hasIdentity && localHits && localHits.length > 0 && (
                <section aria-label={t("search.sectionDm")}>
                  <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <MessageCircle className="size-3.5" aria-hidden="true" />
                    {t("search.dmHeader")}
                    <Badge
                      variant="outline"
                      className="ml-1 px-1.5 py-0 text-[9px]"
                      aria-label={tp("search.dmResults", localHits.length)}
                      title={tp("search.dmResults", localHits.length)}
                    >
                      {localHits.length}
                    </Badge>
                    <span className="ml-auto flex items-center gap-1 text-[9px] normal-case">
                      <Lock className="size-2.5" aria-hidden="true" /> {t("search.localChip")}
                    </span>
                  </h3>
                  <ul className="space-y-1.5">
                    {localHits.map((h) => (
                      <li key={`${h.conversationId}:${h.messageId}`}>
                        <button
                          type="button"
                          onClick={() => openMessage(h.conversationId, h.messageId)}
                          className="w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-accent"
                        >
                          <p className="line-clamp-2 text-sm">
                            <Highlight text={h.snippet} terms={dmTerms} />
                          </p>
                          <p className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <Lock className="size-2.5" aria-hidden="true" />
                            {t("search.dmConversation")} · {fmt.fmtRelative(h.createdAt)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {empty && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {t("search.noResults", { q: debounced })}
                </p>
              )}

              {/* recherche DM locale en cours (pas de skeleton serveur pour elle — instantanée) */}
              {hasIdentity && debounced.length >= 2 && localHits === null && (
                <p className="flex items-center justify-center gap-2 py-2 text-[10px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" /> {t("search.localIndexing")}
                </p>
              )}
            </div>
          </ScrollArea>

          <div className="flex items-center justify-between border-t p-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
