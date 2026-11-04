"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
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
  apiSendDm,
  apiToggleLike,
  apiUpsertIdentity,
  isDefinitiveApiError,
  ApiError,
} from "@/lib/mbote/api";
import { generateKeyBundle, signPayload } from "@/lib/mbote/crypto";
import {
  dmReadProofMessage,
  identityProofMessage,
  likeProofMessage,
  relayHelloProofMessage,
} from "@/lib/mbote/proof";
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
import { closeWebOutbox } from "@/lib/mbote/transports/web-outbox";

import { MboteAvatar } from "./Avatar";
// F-34 (audit Vague 5) : code-splitting des vues secondaires — FeedView
// reste eager (vue par défaut + candidat LCP), les 4 autres vues + le
// tunnel BitChat sont chargés à la demande (bundle initial allégé).
const ChannelsView = dynamic(
  () => import("./ChannelsView").then((m) => m.ChannelsView),
  { ssr: false, loading: ViewSkeleton }
);
const MessagesView = dynamic(
  () => import("./MessagesView").then((m) => m.MessagesView),
  { ssr: false, loading: ViewSkeleton }
);
const NetworkView = dynamic(
  () => import("./NetworkView").then((m) => m.NetworkView),
  { ssr: false, loading: ViewSkeleton }
);
const ProfileView = dynamic(
  () => import("./ProfileView").then((m) => m.ProfileView),
  { ssr: false, loading: ViewSkeleton }
);
import { FeedView } from "./FeedView";
import { OnboardingDialog } from "./OnboardingDialog";

/** Squelette de chargement des vues découpées (F-34). */
function ViewSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Chargement de la vue">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

const NAV_ITEMS: { key: ViewKey; label: string; icon: typeof Newspaper }[] = [
  { key: "feed", label: "Fil", icon: Newspaper },
  { key: "channels", label: "Canaux", icon: MapPinned },
  { key: "messages", label: "Messages", icon: MessageSquare },
  { key: "network", label: "Réseau", icon: Radio },
  { key: "profile", label: "Profil", icon: UserRound },
];

/** F-14 : allowlist des valeurs acceptées pour le raccourci PWA `?view=…` */
const VIEW_KEYS: readonly ViewKey[] = ["feed", "channels", "messages", "network", "profile"];

export function MboteApp() {
  const qc = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();

  const [mounted, setMounted] = useState(false);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<ViewKey>("feed");
  /** F-49 : texte reçu via share_target (?text=&url=) → brouillon composer */
  const [shareDraft, setShareDraft] = useState<string | null>(null);
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
  const [forceOffline, setForceOffline] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingPosts, setPendingPosts] = useState<PendingPost[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [realtimeOk, setRealtimeOk] = useState(false);
  const [presence, setPresence] = useState(0);
  const flushingRef = useRef(false);
  /** F-33 : salle de canal actuellement jointe côté relay (channel:<geohash>). */
  const channelRoomRef = useRef<string | null>(null);

  // ---------- initialisation ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // F-06 : les clés privées (non-extractibles) viennent du coffre IndexedDB,
      // avec migration automatique de l'ancien stockage JWK en clair.
      const id = await loadIdentity();
      if (cancelled) return;
      setIdentity(id);
      setForceOffline(loadForceOffline());
      setIsOnline(navigator.onLine);
      setOutbox(loadOutbox());
      // F-14 : raccourcis PWA (`/?view=…`) — lecture hydration-safe (dans un
      // useEffect, jamais au premier rendu) et APRÈS la décision d'onboarding :
      // sans identité, OnboardingDialog reste prioritaire et le paramètre est
      // ignoré. Valeur inconnue → ignorée silencieusement (reste sur « feed »).
      if (id) {
        const sp = new URLSearchParams(window.location.search);
        const requested = sp.get("view");
        if (requested && (VIEW_KEYS as readonly string[]).includes(requested)) {
          setView(requested as ViewKey);
        }
        // F-49 : partage PWA (share_target GET) → brouillon du composer, puis
        // nettoyage de l'URL (le brouillon vit dans l'état, pas dans l'adresse)
        const sharedText = [sp.get("text"), sp.get("url")].filter(Boolean).join(" ").trim();
        if (sharedText) {
          setShareDraft(sharedText);
          const keepView =
            requested && (VIEW_KEYS as readonly string[]).includes(requested) && requested !== "feed"
              ? requested
              : null;
          window.history.replaceState(null, "", keepView ? `/?view=${keepView}` : "/");
        }
      }
      setMounted(true);
      if (!id) setOnboardingOpen(true);
    })();
    // F-02 : plus d'auto-seed déclenché par chaque visiteur — le seed est un
    // geste opérateur (POST /api/seed, garde env/secret côté serveur).
    return () => {
      cancelled = true;
    };
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

  // ---------- navigation (F-14 : l'URL reflète toujours la vue affichée) ----------
  const changeView = useCallback((v: ViewKey) => {
    setView(v);
    try {
      window.history.replaceState(null, "", v === "feed" ? "/" : `/?view=${v}`);
    } catch {
      /* environnement sans historique — la vue change quand même */
    }
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
          // A1 : un 409 `outcome=duplicate` sur un DM = le message est DÉJÀ
          // livré (flush outbox rejoué après échec réseau post-write) →
          // SUCCÈS idempotent : purge de la file, PAS d'erreur.
          if (
            item.type === "dm" &&
            e instanceof ApiError &&
            e.status === 409
          ) {
            removeOutbox(item.id);
            setOutbox(loadOutbox());
            synced++;
            continue;
          }
          // F-31 : erreur DÉFINITIVE (4xx, hors 429) → enveloppe jetée (le
          // retest est futile : preuve expirée, malformation…). L'ancienne
          // détection par regex /HTTP 4\d\d/ ne matchait presque jamais
          // (le message est le texte d'erreur serveur, pas le statut).
          if (isDefinitiveApiError(e)) {
            removeOutbox(item.id);
            setOutbox(loadOutbox());
            toast.error("Élément rejeté — retiré de la file locale", {
              description: e instanceof Error ? e.message : "erreur définitive",
            });
          }
          // sinon : erreur de transport → l'enveloppe reste, reflush plus tard
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
    // F-07 : chaque lecture de boîte DM est signée (preuve courte durée)
    queryFn: async () => {
      if (!identity) throw new Error("identité absente");
      const ts = Date.now();
      const signature = await signPayload(identity.signPriv, dmReadProofMessage(identity.pubkey, "*", ts));
      return apiGetConversations(identity.pubkey, { ts, signature });
    },
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
    // F-08 : le hello ouvre la boîte DM `dm:<pubkey>` UNIQUEMENT avec une
    // preuve de possession signée courte durée — sans identité (ou en cas
    // d'échec de signature), la connexion reste dans le fil public.
    const hello = async () => {
      if (!identity) {
        s.emit("hello", { pubkey: null, nickname: null });
        return;
      }
      try {
        const ts = Date.now();
        const signature = await signPayload(
          identity.signPriv,
          relayHelloProofMessage(identity.pubkey, ts)
        );
        s.emit("hello", {
          pubkey: identity.pubkey,
          nickname: identity.nickname,
          dmAuth: { ts, signature },
        });
      } catch {
        s.emit("hello", { pubkey: null, nickname: identity.nickname });
      }
    };
    const onConnect = () => {
      setRealtimeOk(true);
      void hello();
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
      void hello();
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
  }, [mounted, identity, qc]);

  // ---------- F-33 : abonnement réel aux salles de canal ----------
  // Le relay diffuse post:new vers ["feed", "channel:<geohash>"] mais la
  // salle canal n'était JAMAIS jointe (subscribe jamais émis) → push canal
  // mort. On joint la salle du canal actif, on quitte l'ancienne, et on
  // rejoint après chaque reconnexion (la mémoire de rooms est perdue côté
  // relay à la déconnexion).
  useEffect(() => {
    if (!mounted) return;
    const s = getSocket();
    const room = activeChannel ? `channel:${activeChannel.geohash}` : null;
    const prev = channelRoomRef.current;
    if (prev && prev !== room) {
      s.emit("unsubscribe", { rooms: [prev] });
    }
    if (room && room !== prev) {
      s.emit("subscribe", { rooms: [room] });
    }
    channelRoomRef.current = room;
    const resubscribe = () => {
      if (channelRoomRef.current) {
        s.emit("subscribe", { rooms: [channelRoomRef.current] });
      }
    };
    s.on("connect", resubscribe);
    return () => {
      s.off("connect", resubscribe);
    };
  }, [mounted, activeChannel]);

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
        await saveIdentity(stored);
        setIdentity(stored);
        setOnboardingOpen(false);
        // F-01 : preuve de possession signée AVANT tout — envoyée maintenant,
        // ou conservée telle quelle dans la file locale (courrier) pour être
        // re-jouée au retour du réseau (tolérance offline 7 j côté serveur).
        const ts = Date.now();
        const identityPayload = {
          pubkey: bundle.pubkey,
          nickname,
          bio: bio || undefined,
          ecdhPub: bundle.ecdhPub,
          ts,
          signature: await signPayload(
            bundle.signPriv,
            identityProofMessage({
              pubkey: bundle.pubkey,
              nickname,
              bio: bio || undefined,
              ecdhPub: bundle.ecdhPub,
              ts,
            })
          ),
        };
        try {
          await apiUpsertIdentity(identityPayload);
          toast.success("Identité créée et publiée", {
            description: "Tes clés privées ne quitteront jamais cet appareil.",
          });
        } catch {
          enqueueOutbox({ type: "identity", payload: identityPayload });
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
        identity.signPriv,
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
    async (postId: string, _liked: boolean): Promise<boolean> => {
      if (!identity) return false;
      // F-01 : le like est signé AVANT l'envoi (ou la mise en file) — preuve
      // de possession vérifiée côté serveur à l'arrivée comme au flush.
      const ts = Date.now();
      let signature: string;
      try {
        signature = await signPayload(
          identity.signPriv,
          likeProofMessage(identity.pubkey, postId, ts)
        );
      } catch {
        toast.error("Signature impossible — like non envoyé");
        return false;
      }
      const payload = { pubkey: identity.pubkey, postId, ts, signature };
      if (canSend) {
        try {
          await apiToggleLike(payload);
          qc.invalidateQueries({ queryKey: ["feed"] });
          return true;
        } catch (e) {
          // F-28 : rejet DÉFINITIF (4xx, hors 429) → l'appelant ROLLBACK
          // l'état optimiste (l'ancien comportement mettait en outbox une
          // enveloppe condamnée, qui saturait la file de rejets 401).
          if (isDefinitiveApiError(e)) {
            toast.error("Like refusé", {
              description: e instanceof Error ? e.message : "rejet du serveur",
            });
            return false;
          }
          // erreur de transport → comportement offline-first : file locale
          enqueueOutbox({ type: "like", payload });
          setOutbox(loadOutbox());
          toast.info("J'aime mis en file locale (courrier)");
          return true;
        }
      } else {
        enqueueOutbox({ type: "like", payload });
        setOutbox(loadOutbox());
        toast.info("J'aime en file locale — synchronisé plus tard");
        return true;
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

  // F-15 : MboteApp reste propriétaire de l'état outbox — MessagesView délègue
  // la mise en file d'un DM hors-ligne (payload déjà scellé + signé ; le
  // clientRef transite DANS le payload, comme pour les posts, et est relu par
  // flushOutbox — le serveur ignore ce champ supplémentaire).
  const queueDm = useCallback((payload: Record<string, unknown>) => {
    enqueueOutbox({ type: "dm", payload });
    setOutbox(loadOutbox());
    toast.info("Message mis en file — partira au retour du réseau", {
      description: "Le courrier chiffré attend dans la file locale, comme chez BitChat.",
    });
  }, []);

  const dismissPending = useCallback((clientRef: string) => {
    setPendingPosts((ps) => ps.filter((p) => p.clientRef !== clientRef));
    // retire aussi l'item correspondant de la file persistante
    const items = loadOutbox().filter(
      (i) => (i.payload as { clientRef?: string }).clientRef !== clientRef
    );
    localStorage.setItem(LS_OUTBOX, JSON.stringify(items));
    setOutbox(items);
  }, []);

  const doPanicWipe = useCallback(async () => {
    // F-11 : efface TOUT l'état local promis (clés IndexedDB, outbox binaire,
    // repli LS, thème) — voir identity.ts panicWipe.
    closeWebOutbox(); // libère la connexion IndexedDB avant deleteDatabase
    await panicWipe();
    setIdentity(null);
    setPendingPosts([]);
    setOutbox([]);
    setForceOffline(false);
    setActiveChannel(null);
    changeView("feed");
    qc.clear();
    setOnboardingOpen(true);
    toast.success("Panic wipe exécuté", {
      description: "Clés, file locale et état local détruits sur cet appareil.",
    });
  }, [qc, changeView]);

  const openChannel = useCallback((channel: ActiveChannel) => {
    setActiveChannel(channel);
    changeView("feed");
  }, [changeView]);

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
            draft={shareDraft}
          />
        );
      case "channels":
        return <ChannelsView onOpenChannel={openChannel} />;
      case "messages":
        return identity ? (
          <MessagesView
            identity={identity}
            isOnline={isOnline}
            forceOffline={forceOffline}
            onQueueDm={queueDm}
          />
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
      <header className="sticky top-0 z-40 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
          <button
            className="flex min-w-0 items-center gap-2"
            onClick={() => {
              changeView("feed");
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
            {realtimeOk ? `${presence} en direct` : "relay…"}
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
                  {/* a11y (2.5.3) : les initiales affichées par l'avatar sont le
                      texte visible — incluses telles quelles dans le nom (une
                      parenthèse casse la correspondance de mot d'axe). */}
                  <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Menu de mon identité - ${identity.nickname.slice(0, 2).toUpperCase()}`}>
                    <MboteAvatar pubkey={identity.pubkey} nickname={identity.nickname} size={34} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="truncate">
                    {identity.nickname}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => changeView("profile")}>
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
                    onClick={() => void doPanicWipe()}
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
                onClick={() => changeView(key)}
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
                  <span className="font-mono font-semibold text-primary">{realtimeOk ? presence : "—"}</span>{" "}
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
              onClick={() => changeView(key)}
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
