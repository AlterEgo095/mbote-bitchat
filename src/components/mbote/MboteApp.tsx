"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  AlertTriangle,
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
  UsersRound,
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
import { useI18n } from "@/lib/mbote/i18n";

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
  describeApiError,
} from "@/lib/mbote/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
// reste eager (vue par défaut + candidat LCP). ARBITRAGE B2 (2026-11-06) :
// MessagesView repasse en import EAGER — le dynamic(ssr:false) le montait
// dans un sous-arbre DÉTACHÉ du root hydraté (fiber sans HostRoot en amont,
// constat navigateur) → tout setState de la vue était un NO-OP silencieux
// (dialog d'attachement d'image mort, handlers inertes). La vue porte les
// états les plus lourds (DM, queue média, dialogs) : fiabilité > taille de
// bundle initial. ChannelsView/NetworkView/ProfileView restent dynamic
// (hors périmètre B2 — note NON TESTÉ).
import { MessagesView } from "./MessagesView";
import { GlobalSearch } from "./GlobalSearch";
// C2 : overlay d'appel audio (survit aux changements de vue)
import { CallView } from "./CallView";
import { GroupsView } from "./GroupsView";
import { callManager } from "@/lib/mbote/webrtc";
const ChannelsView = dynamic(
  () => import("./ChannelsView").then((m) => m.ChannelsView),
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
// D2 — preuve de travail de création (Sybil phase 0) : Web Worker non bloquant
import { computePow, exposePowBenchmark } from "@/lib/mbote/pow-client";

/** Squelette de chargement des vues découpées (F-34). */
function ViewSkeleton() {
  const { t } = useI18n();
  return (
    <div className="space-y-3" aria-busy="true" aria-label={t("view.skeletonAria")}>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// i18n vague G : `label` est une CLÉ de catalogue (« nav.* »), résolue via
// t(label) AU RENDU dans MboteApp (les libellés ne peuvent pas vivre au
// niveau module — le catalogue dépend de la locale courante).
const NAV_ITEMS: { key: ViewKey; label: string; icon: typeof Newspaper }[] = [
  { key: "feed", label: "nav.feed", icon: Newspaper },
  { key: "channels", label: "nav.channels", icon: MapPinned },
  { key: "messages", label: "nav.messages", icon: MessageSquare },
  { key: "groups", label: "nav.groups", icon: UsersRound },
  { key: "network", label: "nav.network", icon: Radio },
  { key: "profile", label: "nav.profile", icon: UserRound },
];

/** F-14 : allowlist des valeurs acceptées pour le raccourci PWA `?view=…` */
const VIEW_KEYS: readonly ViewKey[] = ["feed", "channels", "messages", "groups", "network", "profile"];

export function MboteApp() {
  const qc = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();
  const { t, tp, fmt } = useI18n();

  const [mounted, setMounted] = useState(false);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // F #1 — le panic wipe du header exige une confirmation (même garde que
  // ProfileView) : deux chemins de destruction, deux fois protégés.
  const [panicConfirmOpen, setPanicConfirmOpen] = useState(false);
  // F #2 — échec de publication de l'identité : état PERSISTANT (le toast
  // fugace laissait l'utilisateur croire qu'il était publié — constaté en
  // rendu réel, UI-AUDIT #2/§6.2 : 429 D2 → contacts ne le voient jamais).
  const [identityPublishError, setIdentityPublishError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // D2 — progression du PoW de création (0..1), null = pas de calcul en cours
  const [powProgress, setPowProgress] = useState<number | null>(null);
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
            toast.error(t("banner.rejected"), {
              description: e instanceof Error ? e.message : t("banner.definitiveError"),
            });
          }
          // sinon : erreur de transport → l'enveloppe reste, reflush plus tard
        }
      }
      if (synced > 0) {
        qc.invalidateQueries();
        toast.success(tp("banner.outboxSynced", synced), {
          description: t("banner.outboxSyncedDesc"),
        });
      }
    } finally {
      flushingRef.current = false;
    }
  }, [qc, t, tp]);

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
    // C2 : le gestionnaire d'appels signe avec l'identité courante (les
    // événements call:* exigent une identité PROUVÉE côté hub). Panic wipe →
    // destruction locale immédiate sans signalisation.
    callManager.setIdentity(identity ? { pubkey: identity.pubkey, signPriv: identity.signPriv } : null);
  }, [mounted, identity]);

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
        toast(t("banner.dmNew"), {
          description: t("banner.dmNewDesc"),
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
  }, [mounted, identity, qc, t]);

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
        // D2 : le dialogue RESTE ouvert pendant le PoW (progression visible)
        // — la création locale est déjà effective (T0 : publier/signer hors
        // ligne marche sans serveur ni PoW) ; seule la publication serveur
        // attend la preuve de travail.
        // F-01 : preuve de possession signée AVANT tout — envoyée maintenant,
        // ou conservée telle quelle dans la file locale (courrier) pour être
        // re-jouée au retour du réseau (tolérance offline 7 j côté serveur).
        const ts = Date.now();
        const identityPayload: Parameters<typeof apiUpsertIdentity>[0] = {
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
        // D2 — PoW 20 bits en Web Worker : ~2-5 s mobile bas de gamme, avec
        // progression visible. Un worker indisponible n'empêche RIEN : le
        // payload part sans PoW (le serveur refusera la création → file
        // courrier), la création locale reste effective.
        try {
          setPowProgress(0);
          const pow = await computePow(bundle.pubkey, ts, (p) => setPowProgress(p.ratio));
          exposePowBenchmark(pow);
          identityPayload.pow = { nonce: pow.nonce };
          setPowProgress(1);
        } catch (powError) {
          // F #3 — l'échec du PoW n'est plus avalé : l'utilisateur comprend la
          // cause et la conséquence (le serveur refusera la création sans PoW
          // → l'identité restera dans la file courrier).
          setPowProgress(null);
          toast.warning(t("banner.powFailed"), {
            description: t("banner.powFailedDesc", {
              reason: powError instanceof Error ? powError.message : t("banner.powUnavailable"),
            }),
          });
        }
        try {
          await apiUpsertIdentity(identityPayload);
          setIdentityPublishError(null);
          toast.success(t("banner.identityCreated"), {
            description: t("banner.identityCreatedDesc"),
          });
        } catch (e) {
          enqueueOutbox({ type: "identity", payload: identityPayload });
          setOutbox(loadOutbox());
          // F #2 — l'échec n'est plus silencieux : état persistant + cause FR
          // actionnable (mapping central). La clé locale reste utilisable ; le
          // profil sera publié au retry ou au retour du réseau (outbox).
          const cause = describeApiError(e);
          setIdentityPublishError(cause);
          toast.warning(t("banner.identityUnpublished"), {
            description: cause,
          });
        }
        setOnboardingOpen(false);
        setPowProgress(null);
        qc.invalidateQueries();
      } finally {
        setCreating(false);
      }
    },
    [qc, t]
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
        toast.success(input.parentId ? t("banner.replyPublished") : t("banner.postPublished"), {
          description: t("banner.publishedDesc"),
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
      toast.info(input.parentId ? t("banner.replyQueued") : t("banner.postQueued"), {
        description: t("banner.queuedDesc"),
      });
    },
    [identity, canSend, qc, t]
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
        toast.error(t("banner.likeSignFailed"));
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
            toast.error(t("banner.likeRejected"), {
              description: e instanceof Error ? e.message : t("banner.serverRejection"),
            });
            return false;
          }
          // erreur de transport → comportement offline-first : file locale
          enqueueOutbox({ type: "like", payload });
          setOutbox(loadOutbox());
          toast.info(t("banner.likeQueued"));
          return true;
        }
      } else {
        enqueueOutbox({ type: "like", payload });
        setOutbox(loadOutbox());
        toast.info(t("banner.likeQueuedOffline"));
        return true;
      }
    },
    [identity, canSend, qc, t]
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
    toast.info(t("banner.dmQueued"), {
      description: t("banner.dmQueuedDesc"),
    });
  }, [t]);

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
    await callManager.wipe(); // C2 : détruit toute session d'appel locale (pc/tracks/ringtone)
    await panicWipe();
    setIdentity(null);
    setPendingPosts([]);
    setOutbox([]);
    setForceOffline(false);
    setActiveChannel(null);
    changeView("feed");
    qc.clear();
    setOnboardingOpen(true);
    toast.success(t("wipe.done"), {
      description: t("wipe.doneDesc"),
    });
  }, [qc, changeView, t]);

  const openChannel = useCallback((channel: ActiveChannel) => {
    setActiveChannel(channel);
    changeView("feed");
  }, [changeView]);

  // D1 : navigation depuis la recherche (post du fil public / message privé)
  // ⚠️ Rules of Hooks : TOUS les hooks AVANT le early return « !mounted ».
  const [searchFocusPost, setSearchFocusPost] = useState<string | null>(null);
  const [searchFocusMessage, setSearchFocusMessage] = useState<{
    peer: string;
    messageId: string;
  } | null>(null);

  const openPostFromSearch = useCallback(
    (postId: string) => {
      setSearchFocusPost(postId);
      changeView("feed");
    },
    [changeView]
  );
  const openMessageFromSearch = useCallback(
    (peer: string, messageId: string) => {
      setSearchFocusMessage({ peer, messageId });
      changeView("messages");
    },
    [changeView]
  );

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
            focusPostId={searchFocusPost}
            onFocusPostConsumed={() => setSearchFocusPost(null)}
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
            focusMessage={searchFocusMessage}
            onFocusConsumed={() => setSearchFocusMessage(null)}
          />
        ) : (
          <IdentityCta onOpen={() => setOnboardingOpen(true)} />
        );
      case "groups":
        return identity ? (
          <GroupsView identity={identity} />
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
            aria-label={t("header.homeAria")}
          >
            <Image
              src="/mbote/logo.png"
              alt={t("header.logoAlt")}
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
            {canSend ? t("common.online") : t("header.meshQueue")}
            {outbox.length > 0 && (
              <span className="flex size-4.5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-amber-950">
                {fmt.fmtNumber(outbox.length)}
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
            aria-label={t("header.realtimeAria")}
          >
            <Radio
              className={cn("size-3.5", realtimeOk && "animate-pulse")}
              aria-hidden="true"
            />
            {realtimeOk ? t("header.presenceLive", { count: fmt.fmtNumber(presence) }) : t("header.relay")}
          </div>

          {/* D1 : recherche globale (fil public serveur + DM local) */}
          <div className="ml-2 hidden sm:block">
            <GlobalSearch
              onOpenPost={openPostFromSearch}
              onOpenMessage={openMessageFromSearch}
              hasIdentity={!!identity}
            />
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
                  if (!v) toast.success(t("banner.networkRestored"), { description: t("banner.networkRestoredDesc") });
                  else toast.info(t("banner.meshOn"), { description: t("banner.meshOnDesc") });
                }}
                aria-label={t("header.meshAria")}
              />
              <Label
                htmlFor="mesh-mode"
                className="hidden cursor-pointer text-[11px] text-muted-foreground md:inline"
              >
                {t("header.meshMode")}
              </Label>
            </div>

            {/* thème */}
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label={t("header.themeAria")}
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
                  <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("header.identityMenuAria", { initials: identity.nickname.slice(0, 2).toUpperCase() })}>
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
                    {t("header.menuProfile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setForceOffline(true);
                      saveForceOffline(true);
                    }}
                  >
                    <WifiOff className="size-4" aria-hidden="true" />
                    {t("header.menuMeshOn")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setPanicConfirmOpen(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Flame className="size-4" aria-hidden="true" />
                    {t("header.menuPanicWipe")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" className="h-9" onClick={() => setOnboardingOpen(true)}>
                {t("cta.createIdentity")}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* F #2 — échec de publication de l'identité : bannière PERSISTANTE avec
          cause FR actionnable + bouton Réessayer (flush de la file courrier) */}
      {identityPublishError && (
        <div
          data-testid="identity-publish-error"
          role="alert"
          className="mx-auto mt-4 flex w-full max-w-6xl items-start justify-between gap-4 rounded-lg border border-amber-400 bg-amber-100 px-4 py-3 text-sm text-amber-950"
        >
          <div className="min-w-0">
            <p className="font-semibold">{t("banner.identityUnpublished")}</p>
            <p className="mt-0.5 break-words">{identityPublishError}</p>
            <p className="mt-0.5 text-xs text-amber-900">
              {t("banner.identityUnpublishedHint")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              className="h-11"
              onClick={() => {
                void flushOutbox().then(() => {
                  if (loadOutbox().length === 0) setIdentityPublishError(null);
                });
              }}
            >
              {t("cta.retryPublish")}
            </Button>
            <Button size="sm" variant="ghost" className="h-11" onClick={() => setIdentityPublishError(null)}>
              {t("cta.hide")}
            </Button>
          </div>
        </div>
      )}

      {/* ---------- corps ---------- */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-6 pb-24 lg:pb-6">
        {/* navigation latérale */}
        <aside className="sticky top-20 hidden h-fit w-56 shrink-0 space-y-4 lg:block">
          <nav aria-label={t("nav.mainAria")} className="space-y-1">
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
                {t(label)}
                {key === "messages" && unreadTotal > 0 && (
                  <span className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                    {fmt.fmtNumber(unreadTotal)}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <Card>
            <CardContent className="p-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                {t("nav.activeChannels")}
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
                    <span className="ml-auto shrink-0 text-[10px]">{fmt.fmtNumber(ch.postCount)}</span>
                  </button>
                ))}
                {(topChannels.data?.channels.length ?? 0) === 0 && (
                  <p className="px-1.5 py-1 text-[11px] text-muted-foreground">
                    {t("nav.noChannels")}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                <Users className="size-3" aria-hidden="true" />
                {t("nav.network")}
              </p>
              <div className="space-y-0.5 text-[11px] text-muted-foreground">
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.users != null ? fmt.fmtNumber(stats.data.users) : "—"}</span>{" "}
                  {t("view.registeredIdentities")}
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.posts != null ? fmt.fmtNumber(stats.data.posts) : "—"}</span>{" "}
                  {t("view.posts")}
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.channels != null ? fmt.fmtNumber(stats.data.channels) : "—"}</span>{" "}
                  {t("view.channels")}
                </p>
                <p>
                  <span className="font-mono font-semibold text-foreground">{stats.data?.dms != null ? fmt.fmtNumber(stats.data.dms) : "—"}</span>{" "}
                  {t("view.dmEnvelopes")}
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
            <span className="font-semibold text-foreground">Mbote Mesh</span>{" "}
            {t("view.conceptPrefix")}{" "}
            <a
              href="https://github.com/permissionlesstech/bitchat"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-primary/50 underline-offset-2 hover:text-foreground"
            >
              BitChat
            </a>{" "}
            {t("view.conceptSuffix")}
          </p>
          <p className="flex flex-wrap items-center justify-center gap-x-2">
            {/* doublon de la carte Réseau (desktop) → mobile uniquement */}
            <span className="md:hidden">
              {t("view.footerStats", {
                users: stats.data?.users != null ? fmt.fmtNumber(stats.data.users) : "—",
                posts: stats.data?.posts != null ? fmt.fmtNumber(stats.data.posts) : "—",
                channels: stats.data?.channels != null ? fmt.fmtNumber(stats.data.channels) : "—",
                dms: stats.data?.dms != null ? fmt.fmtNumber(stats.data.dms) : "—",
              })}
            </span>
            <Badge variant="outline" className="border-primary/40 px-1.5 py-0 text-[9px] text-primary">
              {t("view.noAccounts")}
            </Badge>
          </p>
        </div>
      </footer>

      {/* ---------- navigation mobile ---------- */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:hidden"
        aria-label={t("nav.mobileAria")}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-6">
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
              {t(label)}
              {key === "messages" && unreadTotal > 0 && (
                <span className="absolute right-3 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                  {fmt.fmtNumber(unreadTotal)}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* ---------- onboarding ---------- */}
      {/* F #1 — confirmation du panic wipe du header (même garde que ProfileView) */}
      <AlertDialog open={panicConfirmOpen} onOpenChange={setPanicConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
              {t("wipe.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("wipe.confirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void doPanicWipe()}
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive"
            >
              <Flame className="size-4" aria-hidden="true" />
              {t("wipe.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* C2 : overlay d'appel audio — au-dessus de toutes les vues */}
      <CallView />
      <OnboardingDialog
        open={onboardingOpen}
        creating={creating}
        powProgress={powProgress}
        onCreate={createIdentity}
        onOpenChange={setOnboardingOpen}
      />
    </div>
  );
}

function IdentityCta({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-primary/10">
          <UserRound className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold">{t("cta.identityRequired")}</p>
          <p className="mt-0.5 max-w-sm text-xs text-muted-foreground">
            {t("cta.identityRequiredDesc")}
          </p>
        </div>
        <Button size="sm" onClick={onOpen}>
          {t("cta.createIdentity")}
        </Button>
      </CardContent>
    </Card>
  );
}
