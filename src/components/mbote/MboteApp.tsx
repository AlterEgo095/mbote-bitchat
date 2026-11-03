"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  Flame,
  MapPinned,
  MessageSquare,
  Moon,
  Newspaper,
  Radio,
  Sun,
  UserRound,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import Image from "next/image";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  apiCreatePost,
  apiFetchChannels,
  apiFetchStats,
  apiGetConversations,
  apiSeed,
  apiSendDm,
  apiToggleLike,
  apiUpsertIdentity,
} from "@/lib/mbote/api";
import { generateKeyBundle, signPayload } from "@/lib/mbote/crypto";
import {
  enqueueOutbox,
  loadForceOffline,
  loadIdentity,
  loadOutbox,
  panicWipe,
  removeOutbox,
  saveForceOffline,
  saveIdentity,
  type OutboxItem,
  type StoredIdentity,
} from "@/lib/mbote/identity";
import { LS_OUTBOX } from "@/lib/mbote/constants";
import {
  getSocket,
  type RealtimeDmPayload,
  type RealtimeLikePayload,
  type RealtimePostPayload,
  type RealtimePresencePayload,
} from "@/lib/mbote/socket";
import type { ActiveChannel, PendingPost, ViewKey } from "@/lib/mbote/types";

import { MboteAvatar } from "./Avatar";
import { ChannelsView } from "./ChannelsView";
import { FeedView } from "./FeedView";
import { MessagesView } from "./MessagesView";
import { NetworkView } from "./NetworkView";
import { OnboardingDialog } from "./OnboardingDialog";
import { ProfileView } from "./ProfileView";

const NAV_ITEMS: { key: ViewKey; label: string; icon: typeof Newspaper }[] = [
  { key: "feed", label: "Fil", icon: Newspaper },
  { key: "channels", label: "Canaux", icon: MapPinned },
  { key: "messages", label: "Messages", icon: MessageSquare },
  { key: "network", label: "Réseau", icon: Radio },
  { key: "profile", label: "Profil", icon: UserRound },
];

export function MboteApp() {
  const qc = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();

  const [mounted, setMounted] = useState(false);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<ViewKey>("feed");
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
  const [forceOffline, setForceOffline] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingPosts, setPendingPosts] = useState<PendingPost[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [realtimeOk, setRealtimeOk] = useState(false);
  const [presence, setPresence] = useState(0);
  const flushingRef = useRef(false);
  const seededRef = useRef(false);

  // ---------- initialisation ----------
  useEffect(() => {
    const id = loadIdentity();
    setIdentity(id);
    setForceOffline(loadForceOffline());
    setIsOnline(navigator.onLine);
    setOutbox(loadOutbox());
    setMounted(true);
    if (!id) setOnboardingOpen(true);
    if (!seededRef.current) {
      seededRef.current = true;
      apiSeed().catch(() => undefined);
    }
  }, []);

  // ---------- connexion en ligne / hors-ligne ----------
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // ---------- flush de la file locale (courrier) ----------
  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const items = [...loadOutbox()].sort((a, b) =>
        a.type === "identity" ? -1 : b.type === "identity" ? 1 : a.queuedAt - b.queuedAt
      );
      let synced = 0;
      for (const item of items) {
        try {
          if (item.type === "identity") {
            await apiUpsertIdentity(
              item.payload as unknown as Parameters<typeof apiUpsertIdentity>[0]
            );
          } else if (item.type === "post") {
            await apiCreatePost(
              item.payload as unknown as Parameters<typeof apiCreatePost>[0]
            );
          } else if (item.type === "like") {
            await apiToggleLike(
              item.payload as unknown as Parameters<typeof apiToggleLike>[0]
            );
          } else if (item.type === "dm") {
            await apiSendDm(
              item.payload as unknown as Parameters<typeof apiSendDm>[0]
            );
          }
          removeOutbox(item.id);
          setOutbox(loadOutbox());
          synced++;
          const ref = (item.payload as { clientRef?: string }).clientRef;
          if (ref) setPendingPosts((ps) => ps.filter((p) => p.clientRef !== ref));
        } catch (e) {
          const msg = e instanceof Error ? e.message : "";
          // erreur définitive (4xx) → on jette l'enveloppe pour ne pas bloquer la file
          if (/HTTP 4\d\d/.test(msg)) {
            removeOutbox(item.id);
            setOutbox(loadOutbox());
          }
        }
      }
      if (synced > 0) {
        qc.invalidateQueries();
        toast.success(`${synced} élément(s) synchronisé(s) depuis la file locale`, {
          description: "Le courrier a rejoint le réseau.",
        });
      }
    } finally {
      flushingRef.current = false;
    }
  }, [qc]);

  useEffect(() => {
    if (mounted && isOnline && !forceOffline && outbox.length > 0) {
      void flushOutbox();
    }
  }, [mounted, isOnline, forceOffline, outbox.length, flushOutbox]);

  // ---------- données globales ----------
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: apiFetchStats,
    refetchInterval: 60000,
    enabled: mounted,
  });

  const unread = useQuery({
    queryKey: ["conversations", identity?.pubkey],
    queryFn: () => apiGetConversations(identity!.pubkey),
    enabled: mounted && !!identity,
    refetchInterval: 30000,
  });
  const unreadTotal =
    unread.data?.conversations.reduce((acc, c) => acc + c.unread, 0) ?? 0;

  const topChannels = useQuery({
    queryKey: ["channels", "sidebar"],
    queryFn: () => apiFetchChannels(),
    enabled: mounted,
    refetchInterval: 45000,
  });

  const canSend = isOnline && !forceOffline;

  // ---------- temps réel (hub socket.io) ----------
  useEffect(() => {
    if (!mounted) return;
    const s = getSocket();
    const hello = () =>
      s.emit("hello", {
        pubkey: identity?.pubkey ?? null,
        nickname: identity?.nickname ?? null,
      });
    const onConnect = () => {
      setRealtimeOk(true);
      hello();
    };
    const onDisconnect = () => setRealtimeOk(false);
    const onPresence = (p: RealtimePresencePayload) =>
      setPresence(typeof p?.online === "number" ? p.online : 0);
    const onPost = (data: RealtimePostPayload) => {
      if (!data?.post) return;
      qc.invalidateQueries({ queryKey: ["feed"] });
      qc.invalidateQueries({ queryKey: ["channels"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    };
    const onLike = (data: RealtimeLikePayload) => {
      if (!data?.postId) return;
      qc.invalidateQueries({ queryKey: ["feed"] });
    };
    const onDm = (data: RealtimeDmPayload) => {
      if (!data?.message) return;
      qc.invalidateQueries({ queryKey: ["dms"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      if (identity && data.message.recipientKey === identity.pubkey) {
        toast("🔓 Nouvelle enveloppe chiffrée", {
          description: "Un message privé t'attend dans Messages.",
        });
      }
    };
    const onIdentity = () => {
      qc.invalidateQueries({ queryKey: ["users"] });
    };

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("presence:update", onPresence);
    s.on("post:new", onPost);
    s.on("post:like", onLike);
    s.on("dm:new", onDm);
    s.on("identity:new", onIdentity);
    // identité créée pendant que le socket est déjà connecté → re-hello
    if (s.connected) {
      setRealtimeOk(true);
      hello();
    }

    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("presence:update", onPresence);
      s.off("post:new", onPost);
      s.off("post:like", onLike);
      s.off("dm:new", onDm);
      s.off("identity:new", onIdentity);
    };
  }, [mounted, identity?.pubkey, identity?.nickname, qc]);

  // ---------- actions ----------
  const createIdentity = useCallback(
    async (nickname: string, bio: string) => {
      setCreating(true);
      try {
        const bundle = await generateKeyBundle();
        const stored: StoredIdentity = {
          ...bundle,
          nickname,
          bio: bio || undefined,
        };
        saveIdentity(stored);
        setIdentity(stored);
        setOnboardingOpen(false);
        try {
          await apiUpsertIdentity({
            pubkey: bundle.pubkey,
            nickname,
            bio: bio || undefined,
            ecdhPub: bundle.ecdhPub,
          });
          toast.success("Identité créée et publiée", {
            description: "Tes clés privées ne quitteront jamais cet appareil.",
          });
        } catch {
          enqueueOutbox({
            type: "identity",
            payload: {
              pubkey: bundle.pubkey,
              nickname,
              bio: bio || undefined,
              ecdhPub: bundle.ecdhPub,
            },
          });
          setOutbox(loadOutbox());
          toast.info("Clés créées localement", {
            description: "Ton profil sera publié au retour du réseau.",
          });
        }
        qc.invalidateQueries();
      } finally {
        setCreating(false);
      }
    },
    [qc]
  );

  const publish = useCallback(
    async (input: {
      content: string;
      geohash: string | null;
      precision: number | null;
      parentId?: string | null;
    }) => {
      if (!identity) throw new Error("Aucune identité locale");
      const ts = Date.now();
      // chaîne canonique du protocole (§ bitchat-protocol) : `${pubkey}|${content}|${ts}`
      // — le serveur VÉRIFIE cette signature (D4) : ne pas modifier la forme.
      const signature = await signPayload(
        identity.signPrivJwk,
        `${identity.pubkey}|${input.content}|${ts}`
      );
      const payload = { pubkey: identity.pubkey, ...input, signature, ts };

      if (canSend) {
        await apiCreatePost(payload as Parameters<typeof apiCreatePost>[0]);
        qc.invalidateQueries({ queryKey: ["feed"] });
        qc.invalidateQueries({ queryKey: ["channels"] });
        qc.invalidateQueries({ queryKey: ["stats"] });
        toast.success(input.parentId ? "Réponse publiée" : "Publication diffusée", {
          description: "Signée ECDSA sur ton appareil ✓",
        });
        return;
      }

      const clientRef = `pending-${ts}-${Math.random().toString(36).slice(2, 7)}`;
      enqueueOutbox({ type: "post", payload: { ...payload, clientRef } });
      setOutbox(loadOutbox());
      setPendingPosts((ps) => [
        ...ps,
        {
          clientRef,
          content: input.content,
          geohash: input.geohash,
          precision: input.precision,
          queuedAt: ts,
        },
      ]);
      toast.info(input.parentId ? "Réponse mise en file (courrier)" : "Mis en file locale (courrier)", {
        description: "Le message partira dès le retour du réseau.",
      });
    },
    [identity, canSend, qc]
  );

  const like = useCallback(
    (postId: string, _liked: boolean) => {
      if (!identity) return;
      const payload = { pubkey: identity.pubkey, postId };
      if (canSend) {
        apiToggleLike(payload)
          .then(() => {
            qc.invalidateQueries({ queryKey: ["feed"] });
          })
          .catch(() => {
            enqueueOutbox({ type: "like", payload });
            setOutbox(loadOutbox());
            toast.info("J'aime mis en file locale (courrier)");
          });
      } else {
        enqueueOutbox({ type: "like", payload });
        setOutbox(loadOutbox());
        toast.info("J'aime en file locale — synchronisé plus tard");
      }
    },
    [identity, canSend, qc]
  );

  const publishManaged = useCallback(
    async (input: {
      content: string;
      geohash: string | null;
      precision: number | null;
      parentId?: string | null;
    }) => {
      setSubmitting(true);
      try {
        await publish(input);
      } finally {
        setSubmitting(false);
      }
    },
    [publish]
  );

  const dismissPending = useCallback((clientRef: string) => {
    setPendingPosts((ps) => ps.filter((p) => p.clientRef !== clientRef));
    // retire aussi l'item correspondant de la file persistante
    const items = loadOutbox().filter(
      (i) => (i.payload as { clientRef?: string }).clientRef !== clientRef
    );
    localStorage.setItem(LS_OUTBOX, JSON.stringify(items));
    setOutbox(items);
  }, []);

  const doPanicWipe = useCallback(() => {
    panicWipe();
    setIdentity(null);
    setPendingPosts([]);
    setOutbox([]);
    setForceOffline(false);
    setActiveChannel(null);
    setView("feed");
    qc.clear();
    setOnboardingOpen(true);
    toast.success("Panic wipe exécuté", {
      description: "Clés, file locale et état local détruits sur cet appareil.",
    });
  }, [qc]);

  const openChannel = useCallback((channel: ActiveChannel) => {
    setActiveChannel(channel);
    setView("feed");
  }, []);

  // ---------- rendu ----------
  if (!mounted) {
    return (
      <div className="flex min-h-screen flex-col">
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const viewContent = () => {
    switch (view) {
      case "feed":
        return (
          <FeedView
            myPub={identity?.pubkey ?? null}
            hasIdentity={!!identity}
            activeChannel={activeChannel}
            onClearChannel={() => setActiveChannel(null)}
            onOpenOnboarding={() => setOnboardingOpen(true)}
            onPublish={publishManaged}
            onLike={like}
            onReply={(parentId, content) =>
              publishManaged({ content, geohash: activeChannel?.geohash ?? null, precision: activeChannel?.precision ?? null, parentId })
            }
            forceOffline={forceOffline}
            submitting={submitting}
            pendingPosts={pendingPosts}
            onDismissPending={dismissPending}
          />
        );
      case "channels":
        return <ChannelsView onOpenChannel={openChannel} />;
      case "messages":
        return identity ? (
          <MessagesView identity={identity} isOnline={isOnline} forceOffline={forceOffline} />
        ) : (
          <IdentityCta onOpen={() => setOnboardingOpen(true)} />
        );
      case "network":
        return <NetworkView />;
      case "profile":
        return identity ? (
          <ProfileView
            identity={identity}
            forceOffline={forceOffline}
            onLike={like}
            onReply={(parentId, content) =>
              publishManaged({ content, geohash: null, precision: null, parentId })
            }
            onPanicWipe={doPanicWipe}
          />
        ) : (
          <IdentityCta onOpen={() => setOnboardingOpen(true)} />
        );
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
          <button
            className="flex min-w-0 items-center gap-2"
            onClick={() => {
              setView("feed");
              setActiveChannel(null);
            }}
            aria-label="Accueil Mbote Mesh"
          >
            <Image
              src="/mbote/logo.png"
              alt="Logo Mbote Mesh"
              width={34}
              height={34}
              className="rounded-lg"
              priority
            />
            <span className="truncate text-sm font-bold tracking-tight">
              Mbote <span className="text-primary">Mesh</span>
            </span>
          </button>

          {/* statut réseau */}
          <div
            className={cn(
              "ml-1 hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:flex",
              canSend
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-amber-500/40 bg-amber-500/10 text-amber-500"
            )}
            role="status"
          >
            {canSend ? (
              <Wifi className="size-3.5" aria-hidden="true" />
            ) : (
              <WifiOff className="size-3.5" aria-hidden="true" />
            )}
            {canSend ? "En ligne" : "Mesh · file locale"}
            {outbox.length > 0 && (
              <span className="flex size-4.5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-amber-950">
                {outbox.length}
              </span>
            )}
          </div>

          {/* statut temps réel (hub socket.io) */}
          <div
            className={cn(
              "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium md:flex",
              realtimeOk
                ? "border-primary/40 bg-primary/5 text-primary"
                : "border-muted bg-muted/40 text-muted-foreground"
            )}
            role="status"
            aria-label="Statut du hub temps réel"
          >
            <Radio
              className={cn("size-3.5", realtimeOk && "animate-pulse")}
              aria-hidden="true"
            />
            {realtimeOk ? `${Math.max(presence, 1)} en direct` : "relay…"}
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            {/* bascule mode mesh */}
            <div className="flex items-center gap-1.5">
              <Switch
                id="mesh-mode"
                checked={forceOffline}
                onCheckedChange={(v) => {
                  setForceOffline(v);
                  saveForceOffline(v);
                  if (!v) toast.success("Réseau rétabli", { description: "La file locale va se synchroniser." });
                  else toast.info("Mode mesh activé", { description: "Les publications attendent en file locale, comme des courriers." });
                }}
                aria-label="Simuler une coupure réseau (mode mesh)"
              />
              <Label
                htmlFor="mesh-mode"
                className="hidden cursor-pointer text-[11px] text-muted-foreground md:inline"
              >
                Mode mesh
              </Label>
            </div>

            {/* thème */}
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Basculer le thème clair/sombre"
            >
              {resolvedTheme === "dark" ? (
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
            </Button>

            {/* identité */}
            {identity ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Menu de mon identité">
                    <MboteAvatar pubkey={identity.pubkey} nickname={identity.nickname} size={34} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="truncate">
                    {identity.nickname}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setView("profile")}>
                    <UserRound className="size-4" aria-hidden="true" />
                    Mon profil
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setForceOffline(true);
                      saveForceOffline(true);
                    }}
                  >
                    <WifiOff className="size-4" aria-hidden="true" />
                    Activer le mode mesh
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={doPanicWipe}
                    className="text-destructive focus:text-destructive"
                  >
                    <Flame className="size-4" aria-hidden="true" />
                    Panic wipe
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" className="h-9" onClick={() => setOnboardingOpen(true)}>
                Créer mon identité
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* ---------- corps ---------- */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-6 pb-24 lg:pb-6">
        {/* navigation latérale */}
        <aside className="sticky top-20 hidden h-fit w-56 shrink-0 space-y-4 lg:block">
          <nav aria-label="Navigation principale" className="space-y-1">
            {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setView(key)}
                aria-current={view === key}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  view === key
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="size-4.5" aria-hidden="true" />
                {label}
                {key === "messages" && unreadTotal > 0 && (
                  <span className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                    {unreadTotal}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <Card>
            <CardContent className="p-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Canaux actifs
              </p>
              <div className="space-y-1">
                {(topChannels.data?.channels ?? []).slice(0, 4).map((ch) => (
                  <button
                    key={`${ch.geohash}-${ch.precision}`}
                    onClick={() =>
                      openChannel({
                        geohash: ch.geohash,
                        precision: ch.precision,
                        label: `#${ch.geohash}`,
                      })
                    }
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <MapPinned className="size-3 shrink-0 text-primary" aria-hidden="true" />
                    <span className="truncate">#{ch.geohash}</span>
                    <span className="ml-auto shrink-0 text-[10px]">{ch.postCount}</span>
                  </button>
                ))}
                {(topChannels.data?.channels.length ?? 0) === 0 && (
                  <p className="px-1.5 py-1 text-[11px] text-muted-foreground">
                    Aucun canal encore.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                <Users className="size-3" aria-hidden="true" />
                Réseau
              </p>
              <div className="space-y-0.5 text-[11px] text-muted-foreground">
                <p>
                  <span className="font-mono font-semibold text-primary">{realtimeOk ? Math.max(presence, 1) : "—"}</span>{" "}
                  identités en direct
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.users ?? "—"}</span>{" "}
                  identités enregistrées
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.posts ?? "—"}</span>{" "}
                  publications
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.channels ?? "—"}</span>{" "}
                  canaux
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.dms ?? "—"}</span>{" "}
                  enveloppes DM
                </p>
              </div>
            </CardContent>
          </Card>
        </aside>

        {/* vue active */}
        <main className="min-w-0 flex-1" aria-live="polite">
          {viewContent()}
        </main>
      </div>

      {/* ---------- footer (sticky bas de viewport) ---------- */}
      <footer className="mt-auto border-t bg-background/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-1.5 px-4 py-4 text-center text-[11px] text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Mbote Mesh</span> — preuve de
            concept fullstack inspirée du protocole{" "}
            <a
              href="https://github.com/permissionlesstech/bitchat"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-primary/50 underline-offset-2 hover:text-foreground"
            >
              BitChat
            </a>{" "}
            (domaine public) · déployable sur VPS en un conteneur.
          </p>
          <p className="flex flex-wrap items-center justify-center gap-x-2">
            <span>
              {stats.data?.users ?? "—"} identités · {stats.data?.posts ?? "—"} publications ·{" "}
              {stats.data?.channels ?? "—"} canaux · {stats.data?.dms ?? "—"} enveloppes
              chiffrées
            </span>
            <Badge variant="outline" className="border-primary/40 px-1.5 py-0 text-[9px] text-primary">
              zéro compte · zéro numéro
            </Badge>
          </p>
        </div>
      </footer>

      {/* ---------- navigation mobile ---------- */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:hidden"
        aria-label="Navigation mobile"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-5">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              aria-current={view === key}
              className={cn(
                "relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors",
                view === key ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
              {key === "messages" && unreadTotal > 0 && (
                <span className="absolute right-3 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                  {unreadTotal}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* ---------- onboarding ---------- */}
      <OnboardingDialog
        open={onboardingOpen}
        creating={creating}
        onCreate={createIdentity}
        onOpenChange={setOnboardingOpen}
      />
    </div>
  );
}

function IdentityCta({ onOpen }: { onOpen: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-primary/10">
          <UserRound className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold">Une identité locale est requise</p>
          <p className="mt-0.5 max-w-sm text-xs text-muted-foreground">
            Les messages privés sont chiffrés avec TA clé privée, qui ne quitte jamais cet
            appareil. Générons-la en une seconde.
          </p>
        </div>
        <Button size="sm" onClick={onOpen}>
          Créer mon identité
        </Button>
      </CardContent>
    </Card>
  );
}
