"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  Bot,
  Clock,
  ImageOff,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Lock,
  MessageSquarePlus,
  Mic,
  Film,
  Paperclip,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
// D1 : index local de recherche DM — 100 % IndexedDB, ZÉRO requête réseau
import {
  pruneDmConversations,
  replaceDmConversation,
} from "@/lib/mbote/dm-search-index";

/** D1 : placeholder d'échec de déchiffrement — JAMAIS indexé (bruit de recherche). */
const UNDECRYPTABLE = "🔒 Enveloppe indéchiffrable";
// C2 : appel audio — bouton téléphone + résolveur annuaire pour les entrants
import { callManager } from "@/lib/mbote/webrtc";
import { CallButton } from "./CallView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  apiBotReply,
  apiGetConversation,
  apiGetConversations,
  apiListUsers,
  apiSendDm,
  apiVerifyTrust,
} from "@/lib/mbote/api";
import { openMessage, sealMessage, shortKey, signPayload } from "@/lib/mbote/crypto";
import { dm2ProofMessage, dmReadProofMessage, trustVerifyProofMessage } from "@/lib/mbote/proof";
import { newDmMsgId, nextDmSeq } from "@/lib/mbote/dm-sequence";
import { VoiceNote } from "@/components/VoiceNote";
import { VideoBubble, type VideoThumbRef } from "@/components/VideoBubble";
import {
  attachUploadQueueFlusher,
  downloadImage,
  downloadVoiceNote,
  enqueueOfflineUpload,
  MediaClientError,
  sessionCekFor,
  uploadImage,
  uploadVideoNote,
  uploadVoiceNote,
  type UploadStage,
  type UploadedMedia,
  type UploadedVideo,
  type UploadedVoice,
} from "@/lib/mbote/media-client";
import {
  VOICE_MAX_DURATION_S,
  VOICE_UNSUPPORTED_MESSAGE,
  isOpusRecordingSupported,
  VoiceRecorder,
  type VoiceRecording,
} from "@/lib/mbote/media/opus";
import {
  VIDEO_MAX_DURATION_S,
  VIDEO_UNSUPPORTED_MESSAGE,
  isVideoRecordingSupported,
  VideoRecorder,
  type VideoRecording,
} from "@/lib/mbote/media/video";
import {
  confirmLocalTrust,
  evaluateLocalTrust,
  type TrustLevel,
} from "@/lib/mbote/trust-client";
import type { DirectMessageDto, UserPublic } from "@/lib/mbote/types";
import { enqueueOutbox, type StoredIdentity } from "@/lib/mbote/identity";
import { MboteAvatar } from "./Avatar";

/** F-15 : DM mis en file hors-ligne (bulle « En attente » de la conversation) */
interface QueuedDm {
  clientRef: string;
  recipientKey: string;
  iv: string;
  text: string;
  queuedAt: number;
}

// ── B2 — payload média d'un dm2 (spec MEDIA-ENVELOPE-SPEC §7.3) ──────────────
// Le plaintext dm2 pour un média est un JSON : le CEK voyage DANS le dm2 E2EE —
// le serveur reste aveugle. Tout plaintext non-JSON (historique) = texte brut.
interface MediaDmPayload {
  kind: "media";
  text: string;
  mediaId: string;
  cek: string;
  mediaType: string;
  bytes: number;
  objectKey: string;
  /** B3 — voix : durée (ms) + waveform (100 peaks) voyagent dans le dm2 E2EE */
  durationMs?: number;
  peaks?: number[];
  /** B4 — vidéo : vignette image B2 (voyage dans le dm2 E2EE, serveur aveugle) */
  thumb?: VideoThumbRef;
  width?: number;
  height?: number;
}

function parseDmBody(body: string): MediaDmPayload | null {
  if (!body.startsWith("{")) return null;
  try {
    const p = JSON.parse(body) as Partial<MediaDmPayload>;
    if (
      p?.kind === "media" &&
      typeof p.mediaId === "string" &&
      typeof p.cek === "string" &&
      typeof p.mediaType === "string"
    ) {
      return {
        kind: "media",
        text: p.text ?? "",
        mediaId: p.mediaId,
        cek: p.cek,
        mediaType: p.mediaType,
        bytes: p.bytes ?? 0,
        objectKey: p.objectKey ?? "",
        durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
        peaks: Array.isArray(p.peaks) ? (p.peaks as number[]) : undefined,
        thumb:
          p.thumb && typeof p.thumb.mediaId === "string" && typeof p.thumb.cek === "string"
            ? {
                mediaId: p.thumb.mediaId,
                cek: p.thumb.cek,
                mediaType: typeof p.thumb.mediaType === "string" ? p.thumb.mediaType : "image/jpeg",
                bytes: typeof p.thumb.bytes === "number" ? p.thumb.bytes : 0,
                objectKey: typeof p.thumb.objectKey === "string" ? p.thumb.objectKey : "",
              }
            : undefined,
        width: typeof p.width === "number" ? p.width : undefined,
        height: typeof p.height === "number" ? p.height : undefined,
      };
    }
  } catch {
    /* plaintext historique — texte brut */
  }
  return null;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1048576).toFixed(1)} Mo`;
}

interface MessagesViewProps {
  identity: StoredIdentity;
  isOnline: boolean;
  forceOffline: boolean;
  /** F-15 : délègue la mise en file à MboteApp (propriétaire de l'outbox). */
  onQueueDm?: (payload: Record<string, unknown>, clientRef: string) => void;
  /** D1 : navigation depuis la recherche locale DM (conversation + message). */
  focusMessage?: { peer: string; messageId: string } | null;
  /** D1 : consommé quand le message ciblé a été scrollé/flashé. */
  onFocusConsumed?: () => void;
}

// ── B2 — bulle média : vignette lazy (download → decrypt → magic bytes) ──────

interface MediaBubbleProps {
  payload: MediaDmPayload;
  mine: boolean;
  me: string;
  signPriv: CryptoKey;
}

function MediaBubble({ payload, mine, me, signPriv }: MediaBubbleProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [errCode, setErrCode] = useState<string | null>(null);
  const [fullOpen, setFullOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // À MOI : le CEK de session est le fallback si le dm2 n'a pas encore
      // été refetché — même clé que celle utilisée à l'upload.
      const session = sessionCekFor(payload.mediaId);
      try {
        const img = await downloadImage({
          mediaId: payload.mediaId,
          cekB64: payload.cek || session?.cekB64 || "",
          declaredType: payload.mediaType,
          me,
          sign: (p) => signPayload(signPriv, p),
        });
        if (!cancelled) {
          setUrl(URL.createObjectURL(img.blob));
          setStatus("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setErrCode(e instanceof MediaClientError ? e.code : "unknown");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload.mediaId, payload.cek, payload.mediaType, me, signPriv]);

  if (status === "error") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 p-2.5 text-xs" role="alert">
        <ImageOff className="size-4 shrink-0 opacity-70" aria-hidden="true" />
        <span>
          {errCode === "magic-bytes-mismatch"
            ? "Média refusé — le contenu ne correspond pas au type annoncé (protection MIME spoofing)."
            : errCode === "decrypt-failed"
              ? "Média indéchiffrable (CEK absent ou objet altéré)."
              : "Média indisponible."}
        </span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => status === "ok" && setFullOpen(true)}
        className="block overflow-hidden rounded-lg"
        aria-label={`Image reçue — ${humanBytes(payload.bytes)} (${payload.mediaType})`}
      >
        {status === "ok" && url ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob local déchiffré client, pas d'optimisation possible
          <img
            src={url}
            alt={`Image partagée (${humanBytes(payload.bytes)})`}
            className="max-h-44 w-auto max-w-[280px] rounded-lg object-cover"
            loading="lazy"
          />
        ) : (
          <span
            className={`flex h-32 w-44 items-center justify-center gap-2 rounded-lg text-xs ${mine ? "bg-primary-foreground/15" : "bg-background/60"}`}
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            décryptage…
          </span>
        )}
      </button>
      <Dialog open={fullOpen} onOpenChange={setFullOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <ImageIcon className="size-4 text-primary" aria-hidden="true" />
              Image chiffrée · {humanBytes(payload.bytes)} · {payload.mediaType}
            </DialogTitle>
            <DialogDescription>
              Déchiffrée localement (AES-256-GCM) — magic bytes vérifiés avant rendu.
            </DialogDescription>
          </DialogHeader>
          {url && (
            // eslint-disable-next-line @next/next/no-img-element -- blob local déchiffré client
            <img src={url} alt="Image partagée en plein écran" className="max-h-[70vh] w-auto rounded-lg object-contain" />
          )}
          {payload.text && <p className="text-sm text-muted-foreground">{payload.text}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── B3 — bulle voix : download → decrypt → sniff opus → VoiceNote ────────────

function VoiceBubble({ payload, mine, me, signPriv }: MediaBubbleProps) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [measuredPeaks, setMeasuredPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = sessionCekFor(payload.mediaId);
      try {
        const voice = await downloadVoiceNote({
          mediaId: payload.mediaId,
          cekB64: payload.cek || session?.cekB64 || "",
          declaredType: payload.mediaType,
          me,
          sign: (p) => signPayload(signPriv, p),
          wantMeasure: !payload.peaks, // fallback : le dm2 n'a pas porté les peaks
        });
        if (!cancelled) {
          setBlob(voice.blob);
          setMeasuredPeaks(voice.peaks);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(
            e instanceof MediaClientError && e.code === "magic-bytes-mismatch"
              ? "Note refusée — le contenu n'est pas de l'opus annoncé."
              : "Note vocale indisponible (CEK absent ou objet altéré)."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload.mediaId, payload.cek, payload.mediaType, payload.peaks, me, signPriv]);

  return (
    <VoiceNote
      blob={blob}
      error={err}
      durationMs={payload.durationMs ?? 0}
      peaks={payload.peaks ?? measuredPeaks}
      mine={mine}
      bytes={payload.bytes}
    />
  );
}

export function MessagesView({
  identity,
  isOnline,
  forceOffline,
  onQueueDm,
  focusMessage,
  onFocusConsumed,
}: MessagesViewProps) {
  const qc = useQueryClient();
  const myPub = identity.pubkey;
  const canUseNetwork = isOnline && !forceOffline;

  const conversations = useQuery({
    queryKey: ["conversations", myPub],
    // F-07 : la liste des conversations exige une preuve de possession courte durée
    queryFn: async () => {
      const ts = Date.now();
      const signature = await signPayload(
        identity.signPriv,
        dmReadProofMessage(myPub, "*", ts)
      );
      return apiGetConversations(myPub, { ts, signature });
    },
    refetchInterval: canUseNetwork ? 25000 : false, // fallback : dm:new pousse en direct
  });

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => apiListUsers(),
  });

  // C2 : nommer l'APPELANT sur l'overlay entrant (annuaire → CallView)
  useEffect(() => {
    callManager.setLabelResolver(async (pk) => {
      return users.data?.users.find((u) => u.pubkey === pk)?.nickname ?? null;
    });
  }, [users.data]);

  const [selectedPub, setSelectedPub] = useState<string | null>(null);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── B2 : upload média (picker → preview → orchestré → dm2) ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<{
    name: string;
    bytes: Uint8Array;
    mediaType: string;
    previewUrl: string;
  } | null>(null);
  const [uploadState, setUploadState] = useState<{
    stage: UploadStage;
    fraction?: number;
    message?: string;
  } | null>(null);
  // file hors-ligne : ref de queue → destinataire (dm2 auto au retour réseau)
  const queuePeerRef = useRef<Map<string, string>>(new Map());

  // ── B3 : note vocale (hold-to-record — arbitrage spec §8.5) ──
  // TRANCHEMENT : hold-to-record (WhatsApp, référence RDC) — pointerdown =
  // début, pointerup = stop → preview. Un relâchement < 400 ms bascule en
  // mode tap-to-toggle (accessibilité clavier : Enter/Space sur le bouton).
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const voiceTapModeRef = useRef(false);
  const voiceTapArmedAtRef = useRef(0); // anti-rebond : le click du MÊME tap est avalé
  const voiceSupported = useMemo(() => isOpusRecordingSupported(), []);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0);
  const [pendingVoice, setPendingVoice] = useState<VoiceRecording | null>(null);
  const [voiceUploading, setVoiceUploading] = useState(false);

  const cancelPendingVoice = () => setPendingVoice(null);

  const peer: UserPublic | undefined = useMemo(() => {
    const fromConv = conversations.data?.conversations.find((c) => c.peer.pubkey === selectedPub)
      ?.peer;
    if (fromConv) return fromConv;
    return users.data?.users.find((u) => u.pubkey === selectedPub);
  }, [conversations.data, users.data, selectedPub]);

  // ── B3 : cycle d'enregistrement (hold-to-record + fallback tap-toggle) ──
  const startVoiceRecording = async () => {
    if (!peer?.ecdhPub || peer.isBot) return;
    const rec = new VoiceRecorder({
      bitrateKey: "default",
      onTick: (ms) => setVoiceElapsedMs(ms),
      onAutoStop: () =>
        toast.info(`Durée maximale atteinte (${VOICE_MAX_DURATION_S} s) — relâchez pour prévisualiser`),
    });
    voiceRecorderRef.current = rec;
    setVoiceElapsedMs(0);
    try {
      await rec.start();
      setVoiceRecording(true);
    } catch (e) {
      voiceRecorderRef.current = null;
      toast.error("Micro indisponible", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const stopVoiceRecording = async (discard: boolean) => {
    const rec = voiceRecorderRef.current;
    voiceRecorderRef.current = null;
    setVoiceRecording(false);
    if (!rec) return;
    try {
      if (discard) {
        await rec.cancel();
        return;
      }
      const result = await rec.stop();
      if (result.durationMs < 400) {
        toast.info("Trop court — maintenez le bouton (ou tapez pour démarrer/arrêter).");
        return;
      }
      setPendingVoice(result);
    } catch (e) {
      toast.error("Enregistrement perdu", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  /** Hold-to-record : presser = démarrer, relâcher = stop → preview.
   *  Relâchement < 400 ms → mode tap-toggle : le click du MÊME tap est AVALÉ
   *  (anti-rebond 250 ms — sinon la course d'état stoppe l'enregistrement
   *  à peine démarré, bug attrapé par la preuve navigateur) ; le tap SUIVANT
   *  arrête. */
  function onMicPointerDown() {
    if (voiceRecording) return;
    voiceTapModeRef.current = false;
    void startVoiceRecording();
  }
  function onMicPointerUp() {
    if (!voiceRecording) return;
    if (voiceElapsedMs < 400) {
      // tap-to-toggle : l'enregistrement CONTINUE, le prochain tap arrête
      voiceTapModeRef.current = true;
      voiceTapArmedAtRef.current = Date.now() + 250;
      return;
    }
    void stopVoiceRecording(false);
  }
  function onMicClick() {
    if (
      voiceTapModeRef.current &&
      voiceRecording &&
      Date.now() >= voiceTapArmedAtRef.current
    ) {
      voiceTapModeRef.current = false;
      void stopVoiceRecording(false);
    }
  }

  const messages = useQuery({
    queryKey: ["dms", myPub, selectedPub],
    // F-07 : lecture authentifiée — preuve signée à chaque poll/refetch
    queryFn: async () => {
      if (!selectedPub) throw new Error("destinataire manquant");
      const ts = Date.now();
      const signature = await signPayload(
        identity.signPriv,
        dmReadProofMessage(myPub, selectedPub, ts)
      );
      return apiGetConversation(myPub, selectedPub, { ts, signature });
    },
    enabled: !!selectedPub,
    refetchInterval: canUseNetwork && selectedPub ? 20000 : false, // fallback : dm:new pousse en direct
  });

  // F-15 : courriers DM en attente (mode mesh) — bulles locales, par conversation
  const [queued, setQueued] = useState<QueuedDm[]>([]);
  const queuedForPeer = useMemo(
    () => queued.filter((item) => item.recipientKey === selectedPub),
    [queued, selectedPub]
  );

  // F-15 : purge des bulles en attente — quand la conversation est refetchée et
  // que le serveur renvoie une enveloppe avec le MÊME IV, le courrier est bien
  // parti (flushOutbox a re-joué l'outbox) : la bulle cède sa place au vrai message.
  useEffect(() => {
    const list = messages.data?.messages;
    if (!list?.length) return;
    const sentIvs = new Set(list.map((m) => m.iv));
    setQueued((q) => {
      const next = q.filter((item) => !sentIvs.has(item.iv));
      return next.length === q.length ? q : next;
    });
  }, [messages.data]);

  // sélection par défaut : le bot
  useEffect(() => {
    if (!selectedPub && users.data) {
      const bot = users.data.users.find((u) => u.isBot);
      if (bot) setSelectedPub(bot.pubkey);
    }
  }, [users.data, selectedPub]);

  // D1 : boot/rebuild — les conversations disparues sortent de l'index local
  useEffect(() => {
    const convs = conversations.data?.conversations;
    if (!convs) return;
    void pruneDmConversations(convs.map((c) => c.peer.pubkey)).catch(() => {
      /* index indisponible : la recherche locale restera vide, non bloquant */
    });
  }, [conversations.data]);

  // déchiffrement local des enveloppes
  const [plain, setPlain] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const list: DirectMessageDto[] = messages.data?.messages ?? [];
    (async () => {
      const next: Record<string, string> = {};
      if (identity && peer?.ecdhPub) {
        for (const m of list) {
          try {
            next[m.id] = await openMessage(identity.ecdhPriv, peer.ecdhPub, {
              iv: m.iv,
              ciphertext: m.ciphertext,
            });
          } catch {
            next[m.id] = UNDECRYPTABLE;
          }
        }
      }
      if (!cancelled) setPlain(next);
      // D1 : REBUILD de l'index local de cette conversation — le fetch serveur
      // renvoie la fenêtre complète (200 messages), on la miroite telle quelle
      // dans IndexedDB (textes déjà déchiffrés pour l'affichage — aucune donnée
      // nouvelle, aucun appel réseau de plus). Les enveloppes indéchiffrables
      // ne sont PAS indexées (placeholder UNDECRYPTABLE exclu).
      if (!cancelled && selectedPub) {
        try {
          await replaceDmConversation(
            selectedPub,
            list.map((m) => ({
              messageId: m.id,
              text: next[m.id] === UNDECRYPTABLE ? "" : next[m.id] ?? "",
              createdAt: m.createdAt,
            }))
          );
        } catch {
          /* index local indisponible (quota, navigation privée) : la recherche
             DM rendra moins de résultats — jamais d'erreur bloquante ici. */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages.data, identity, peer?.ecdhPub, selectedPub]);

  // D1 : navigation depuis la recherche — sélection de la conversation cible
  useEffect(() => {
    if (focusMessage?.peer) setSelectedPub(focusMessage.peer);
  }, [focusMessage]);

  // D1 : scroll + flash du message ciblé une fois chargé et déchiffré
  useEffect(() => {
    if (!focusMessage || focusMessage.peer !== selectedPub) return;
    if (messages.isLoading) return;
    const target = plain[focusMessage.messageId];
    if (target === undefined) return; // pas encore déchiffré → prochain cycle
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(focusMessage.messageId)}"]`
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-primary", "ring-offset-2");
    const t = setTimeout(
      () => el.classList.remove("ring-2", "ring-primary", "ring-offset-2"),
      2500
    );
    onFocusConsumed?.();
    return () => clearTimeout(t);
  }, [focusMessage, selectedPub, messages.isLoading, plain, onFocusConsumed]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.data?.messages.length, plain, queuedForPeer.length]);

  // ── A2 : confiance locale — épinglage indépendant du serveur ──
  const [trust, setTrust] = useState<{
    level: TrustLevel;
    safetyNumber: string;
    firstContact: boolean;
    keyChanged: boolean;
  } | null>(null);
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrust(null);
    if (!peer?.ecdhPub) return;
    (async () => {
      try {
        const verdict = await evaluateLocalTrust(
          { pubkey: identity.pubkey, ecdhPub: identity.ecdhPub },
          peer.pubkey,
          peer.ecdhPub as string
        );
        if (!cancelled) setTrust(verdict);
      } catch {
        /* WebCrypto indisponible : pas d'alerte, pas de blocage */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peer?.pubkey, peer?.ecdhPub, identity.pubkey, identity.ecdhPub]);

  const confirmTrust = async () => {
    if (!peer?.ecdhPub || !trust) return;
    setVerifying(true);
    try {
      await confirmLocalTrust(
        { pubkey: identity.pubkey, ecdhPub: identity.ecdhPub },
        peer.pubkey,
        peer.ecdhPub,
        trust.safetyNumber
      );
      // audit serveur (best effort — l'épinglage LOCAL fait foi) : le numéro
      // signé lie quel numéro a été vérifié, quand, par qui
      try {
        const ts = Date.now();
        const signature = await signPayload(
          identity.signPriv,
          trustVerifyProofMessage(identity.pubkey, peer.pubkey, trust.safetyNumber, ts)
        );
        await apiVerifyTrust({
          me: identity.pubkey,
          peer: peer.pubkey,
          safetyNumber: trust.safetyNumber,
          ts,
          signature,
        });
      } catch {
        /* hors-ligne : la confirmation locale reste valide */
      }
      setTrust({ ...trust, level: "green", firstContact: false, keyChanged: false });
      setTrustDialogOpen(false);
      toast.success("Numéro de sécurité vérifié", {
        description: "La clé de chiffrement de ce contact est épinglée sur cet appareil.",
      });
    } finally {
      setVerifying(false);
    }
  };

  const trustBlocked = trust?.level === "red";

  const send = async () => {
    const text = draft.trim();
    if (!text || !peer) return;
    if (!peer.ecdhPub) {
      toast.error("Ce contact n'a pas de clé de chiffrement enregistrée");
      return;
    }
    setSending(true);
    try {
      const sealed = await sealMessage(identity.ecdhPriv, peer.ecdhPub, text);
      if (peer.isBot) {
        // F-15 : le bot répond en ligne par design — pas de courrier pour lui
        if (!canUseNetwork) {
          toast.info("Mbote (bot) est joignable seulement une fois reconnecté au réseau", {
            description: "Ses réponses partent du serveur : le mode mesh ne peut pas les porter.",
          });
          return;
        }
        await apiBotReply({ meKey: myPub, iv: sealed.iv, ciphertext: sealed.ciphertext });
        setDraft("");
        await qc.invalidateQueries({ queryKey: ["dms", myPub, peer.pubkey] });
        await qc.invalidateQueries({ queryKey: ["conversations", myPub] });
      } else {
        // A1 : enveloppe v2 — msgId (uuid, idempotence outbox) + seq (monotone
        // par conversation) couverts par la signature dm2. Le même payload est
        // utilisé en ligne ET dans l'outbox : le flush rejoue l'identique et le
        // serveur répond 409 duplicate = succès idempotent.
        const msgId = newDmMsgId();
        const seq = nextDmSeq(myPub, peer.pubkey);
        const ts = Date.now();
        const signature = await signPayload(
          identity.signPriv,
          dm2ProofMessage(myPub, peer.pubkey, msgId, seq, sealed.iv, sealed.ciphertext, ts)
        );
        const payload = {
          senderKey: myPub,
          recipientKey: peer.pubkey,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
          msgId,
          seq,
          ts,
          signature,
        };
        if (!canUseNetwork) {
          // F-15 : DM hors-ligne → courrier. Scellé ET signé maintenant (la
          // preuve dm2 part dans l'outbox, tolérée 7 j côté serveur comme les
          // posts) ; flushOutbox re-jouera cet item tel quel via apiSendDm.
          const clientRef = `pending-dm-${ts}-${Math.random().toString(36).slice(2, 7)}`;
          const queuedPayload = { ...payload, clientRef };
          if (onQueueDm) {
            onQueueDm(queuedPayload, clientRef);
          } else {
            // défensif : propriétaire outbox absent — on ne perd JAMAIS le courrier
            enqueueOutbox({ type: "dm", payload: queuedPayload });
            toast.error("File locale indisponible — courrier conservé sur l'appareil", {
              description: "Il partira dès que la synchronisation redeviendra possible.",
            });
          }
          setQueued((q) => [
            ...q,
            { clientRef, recipientKey: peer.pubkey, iv: sealed.iv, text, queuedAt: ts },
          ]);
          setDraft("");
        } else {
          await apiSendDm(payload);
          setDraft("");
          await qc.invalidateQueries({ queryKey: ["dms", myPub, peer.pubkey] });
          await qc.invalidateQueries({ queryKey: ["conversations", myPub] });
        }
      }
    } catch (e) {
      toast.error("Échec d'envoi", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSending(false);
    }
  };

  // ── B2 : envoi du dm2 MÉDIA (payload JSON — CEK dans le canal E2EE, §7.3) ──
  const sendMediaDm = async (media: UploadedMedia, peerPub: string, text: string) => {
    const target = peerPub === selectedPub ? peer : users.data?.users.find((u) => u.pubkey === peerPub);
    if (!target?.ecdhPub) {
      toast.error("Ce contact n'a pas de clé de chiffrement enregistrée");
      return;
    }
    const payloadMedia: MediaDmPayload = {
      kind: "media",
      text,
      mediaId: media.mediaId,
      cek: media.cekB64,
      mediaType: media.mediaType,
      bytes: media.plainBytes,
      objectKey: media.objectKey,
    };
    const sealed = await sealMessage(identity.ecdhPriv, target.ecdhPub, JSON.stringify(payloadMedia));
    const msgId = newDmMsgId();
    const seq = nextDmSeq(myPub, peerPub);
    const ts = Date.now();
    const signature = await signPayload(
      identity.signPriv,
      dm2ProofMessage(myPub, peerPub, msgId, seq, sealed.iv, sealed.ciphertext, ts)
    );
    await apiSendDm({
      senderKey: myPub,
      recipientKey: peerPub,
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
      msgId,
      seq,
      ts,
      signature,
    });
    await qc.invalidateQueries({ queryKey: ["dms", myPub, peerPub] });
    await qc.invalidateQueries({ queryKey: ["conversations", myPub] });
  };

  // ── B3 : envoi du dm2 VOIX (même canal E2EE — durée + peaks dans le payload) ─
  const sendVoiceDm = async (voice: UploadedVoice, peerPub: string) => {
    const target = peerPub === selectedPub ? peer : users.data?.users.find((u) => u.pubkey === peerPub);
    if (!target?.ecdhPub) {
      toast.error("Ce contact n'a pas de clé de chiffrement enregistrée");
      return;
    }
    const payloadVoice: MediaDmPayload = {
      kind: "media",
      text: "",
      mediaId: voice.mediaId,
      cek: voice.cekB64,
      mediaType: voice.mediaType,
      bytes: voice.plainBytes,
      objectKey: voice.objectKey,
      durationMs: voice.durationMs,
      peaks: voice.peaks,
    };
    const sealed = await sealMessage(identity.ecdhPriv, target.ecdhPub, JSON.stringify(payloadVoice));
    const msgId = newDmMsgId();
    const seq = nextDmSeq(myPub, peerPub);
    const ts = Date.now();
    const signature = await signPayload(
      identity.signPriv,
      dm2ProofMessage(myPub, peerPub, msgId, seq, sealed.iv, sealed.ciphertext, ts)
    );
    await apiSendDm({
      senderKey: myPub,
      recipientKey: peerPub,
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
      msgId,
      seq,
      ts,
      signature,
    });
    await qc.invalidateQueries({ queryKey: ["dms", myPub, peerPub] });
    await qc.invalidateQueries({ queryKey: ["conversations", myPub] });
  };

  /** B3 : preview → envoi (uploadVoiceNote → dm2). Invariant B2 : l'upload
   *  EST l'orchestration observable — aucun état « envoyé » avant le 2xx.
   *  Clarification 4 B4 (invariant §1.8 ADMIN-RBAC) : la preview n'est PAS
   *  jetée avant confirmation — en cas d'échec elle est RESTAURÉE (l'état UI
   *  reflète le résultat réel : rien envoyé, enregistrement toujours
   *  envoyable). Avant ce fix, `setPendingVoice(null)` précoce perdait
   *  l'enregistrement en cas d'erreur réseau sans aucun retour serveur. */
  const sendPendingVoice = async () => {
    const voice = pendingVoice;
    if (!voice || !peer?.pubkey) return;
    const peerPub = peer.pubkey;
    setPendingVoice(null);
    setVoiceUploading(true);
    try {
      const uploaded = await uploadVoiceNote({
        bytes: voice.bytes,
        durationMs: voice.durationMs,
        peaks: voice.peaks,
        me: myPub,
        sign: (p) => signPayload(identity.signPriv, p),
        onProgress: (stage, info) => setUploadState({ stage, fraction: info?.fraction, message: info?.message }),
      });
      await sendVoiceDm(uploaded, peerPub);
      toast.success("Note vocale envoyée", {
        description: `Opus ${(uploaded.durationMs / 1000).toFixed(1)} s · ${humanBytes(uploaded.plainBytes)} · chiffrée (AES-256-GCM)`,
      });
    } catch (e) {
      setPendingVoice(voice); // échec → preview restaurée (invariant §1.8)
      toast.error("Échec d'envoi vocal", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setVoiceUploading(false);
      setUploadState(null);
    }
  };

  // ── B4 : cycle vidéo (TAP-TO-START/STOP — tranché §9.6 : la vidéo exige de
  // garder l'application ouverte en visée, le hold-to-record de la voix n'a
  // pas de sens les yeux sur l'écran) ────────────────────────────────────────
  const videoRecorderRef = useRef<VideoRecorder | null>(null);
  const videoSupported = useMemo(() => isVideoRecordingSupported(), []);
  const [videoRecording, setVideoRecording] = useState(false);
  const [videoElapsedMs, setVideoElapsedMs] = useState(0);
  const [pendingVideo, setPendingVideo] = useState<VideoRecording | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);

  const cancelPendingVideo = () => {
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    setVideoPreviewUrl(null);
    setPendingVideo(null);
  };

  const startVideoRecording = async () => {
    if (!peer?.ecdhPub || peer.isBot) return;
    const rec = new VideoRecorder({
      onTick: (ms) => setVideoElapsedMs(ms),
      onAutoStop: () =>
        toast.info(`Durée maximale atteinte (${VIDEO_MAX_DURATION_S} s) — prévisualisation`),
    });
    videoRecorderRef.current = rec;
    setVideoElapsedMs(0);
    try {
      await rec.start();
      setVideoRecording(true);
    } catch (e) {
      videoRecorderRef.current = null;
      toast.error("Caméra indisponible", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const stopVideoRecording = async (discard: boolean) => {
    const rec = videoRecorderRef.current;
    videoRecorderRef.current = null;
    setVideoRecording(false);
    if (!rec) return;
    try {
      if (discard) {
        await rec.cancel();
        return;
      }
      const result = await rec.stop();
      setPendingVideo(result);
      setVideoPreviewUrl(URL.createObjectURL(new Blob([result.bytes as unknown as BlobPart], { type: result.container })));
    } catch (e) {
      toast.error("Enregistrement perdu", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  /** B4 : preview → envoi (uploadVideoNote → dm2). Invariant §1.8 : la
   *  preview est RESTAURÉE en cas d'échec (leçon Clarification 4 — la
   *  vidéo ne disparaît pas avant le 2xx). */
  const sendPendingVideo = async () => {
    const video = pendingVideo;
    if (!video || !peer?.pubkey) return;
    const peerPub = peer.pubkey;
    const target = peer;
    if (!target.ecdhPub) {
      toast.error("Ce contact n'a pas de clé de chiffrement enregistrée");
      return;
    }
    setPendingVideo(null);
    setVideoUploading(true);
    try {
      const uploaded: UploadedVideo = await uploadVideoNote({
        bytes: video.bytes,
        durationMs: video.durationMs,
        width: video.width,
        height: video.height,
        thumb: video.thumb ? { bytes: video.thumb.bytes, width: video.thumb.width, height: video.thumb.height } : null,
        me: myPub,
        sign: (p) => signPayload(identity.signPriv, p),
        onProgress: (stage, info) => setUploadState({ stage, fraction: info?.fraction, message: info?.message }),
      });
      // dm2 vidéo : thumb (image B2) + durée dans le payload — serveur aveugle
      const payloadVideo: MediaDmPayload = {
        kind: "media",
        text: "",
        mediaId: uploaded.mediaId,
        cek: uploaded.cekB64,
        mediaType: uploaded.mediaType,
        bytes: uploaded.plainBytes,
        objectKey: uploaded.objectKey,
        durationMs: uploaded.durationMs,
        width: uploaded.width,
        height: uploaded.height,
        thumb: uploaded.thumb
          ? {
              mediaId: uploaded.thumb.mediaId,
              cek: uploaded.thumb.cekB64,
              mediaType: uploaded.thumb.mediaType,
              bytes: uploaded.thumb.bytes,
              objectKey: uploaded.thumb.objectKey,
            }
          : undefined,
      };
      const sealed = await sealMessage(identity.ecdhPriv, target.ecdhPub, JSON.stringify(payloadVideo));
      const msgId = newDmMsgId();
      const seq = nextDmSeq(myPub, peerPub);
      const ts = Date.now();
      const signature = await signPayload(
        identity.signPriv,
        dm2ProofMessage(myPub, peerPub, msgId, seq, sealed.iv, sealed.ciphertext, ts)
      );
      await apiSendDm({
        senderKey: myPub,
        recipientKey: peerPub,
        iv: sealed.iv,
        ciphertext: sealed.ciphertext,
        msgId,
        seq,
        ts,
        signature,
      });
      await qc.invalidateQueries({ queryKey: ["dms", myPub, peerPub] });
      await qc.invalidateQueries({ queryKey: ["conversations", myPub] });
      toast.success("Vidéo envoyée", {
        description: `${uploaded.mediaType === "video/mp4" ? "MP4" : "WebM"} ${(uploaded.durationMs / 1000).toFixed(1)} s · ${humanBytes(uploaded.plainBytes)} · chiffrée (AES-256-GCM)`,
      });
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
      setVideoPreviewUrl(null);
    } catch (e) {
      setPendingVideo(video); // échec → preview restaurée (invariant §1.8)
      toast.error("Échec d'envoi vidéo", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setVideoUploading(false);
      setUploadState(null);
    }
  };

  // B2 : au retour du réseau, la file des uploads re-orchestre — puis le dm2
  // part automatiquement vers le destinataire d'origine.
  useEffect(() => {
    const detach = attachUploadQueueFlusher(identity.pubkey, (p) => signPayload(identity.signPriv, p),
      (item, media) => {
        const peerPub = queuePeerRef.current.get(item.ref);
        queuePeerRef.current.delete(item.ref);
        if (peerPub && peerPub !== "") {
          void sendMediaDm(media, peerPub, "").then(() =>
            toast.success("Image envoyée après reprise réseau")
          ).catch((e) =>
            toast.error("Image uploadée mais envoi échoué", {
              description: e instanceof Error ? e.message : undefined,
            })
          );
        }
      });
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-branche sur changement d'identité
  }, [identity.pubkey, identity.signPriv]);

  // B2 : picker → preview (nom + taille) — validation d'entrée AVANT tout
  const pickFile = async (file: File) => {
    if (peer?.isBot) {
      toast.info("Le bot ne reçoit pas d'images — choisissez un contact humain.");
      return;
    }
    if (!peer?.ecdhPub) {
      toast.error("Ce contact n'a pas de clé de chiffrement enregistrée");
      return;
    }
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      toast.error(`Type ${file.type || "inconnu"} refusé — images jpeg, png ou webp uniquement`);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(`Fichier de ${(file.size / 1048576).toFixed(1)} Mo — la limite est 5 Mo`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    setPendingFile({
      name: file.name,
      bytes,
      mediaType: file.type,
      previewUrl: URL.createObjectURL(file),
    });
  };

  // B2 : upload orchestré (strip → chiffrement → PUT → finalize) → dm2
  const attachAndSend = async () => {
    const file = pendingFile;
    if (!file || !peer?.pubkey) return;
    const peerPub = peer.pubkey;
    setPendingFile(null);
    setUploadState({ stage: "strip" });
    try {
      const media = await uploadImage({
        bytes: file.bytes,
        mediaType: file.mediaType,
        me: myPub,
        sign: (p) => signPayload(identity.signPriv, p),
        onProgress: (stage, info) => setUploadState({ stage, fraction: info?.fraction, message: info?.message }),
      });
      await sendMediaDm(media, peerPub, "");
      toast.success("Image envoyée", {
        description: `Chiffrée (AES-256-GCM) · ${humanBytes(media.plainBytes)} · EXIF nettoyé`,
      });
    } catch (e) {
      if (e instanceof MediaClientError && (e.code === "put-failed" || e.code === "presign-failed")) {
        // réseau tombé en cours d'upload → FILE (reprise au retour du réseau)
        const item = enqueueOfflineUpload(file.name, file.bytes, file.mediaType);
        queuePeerRef.current.set(item.ref, peerPub);
        toast.info("Upload interrompu — conservé sur l'appareil", {
          description: "L'image partira automatiquement au retour du réseau.",
        });
      } else {
        // Clarification 4 É9+C1 (invariant §1.8, symétrie voix/vidéo) : échec
        // sans retour serveur 2xx → preview RESTAURÉE, rien perdu. (Avant ce
        // fix, l'image était jetée en cas d'échec non-réseau — même classe que
        // le bug setPendingVoice(null) précoce B3.)
        setPendingFile(file);
        toast.error("Échec d'upload", {
          description: e instanceof Error ? e.message : undefined,
        });
      }
    } finally {
      setUploadState(null);
    }
  };

  // B2-fix (bug préexistant découvert par la preuve navigateur) : le Dialogue
  // « nouvelle conversation » est partagé par les DEUX returns — avant ce fix,
  // le clic « Nouvelle conversation » depuis l'état VIDE montait le state sans
  // jamais rendre le Dialog (early return sans JSX) : impossible de démarrer
  // une conversation depuis l'état vide.
  const newConvDialog = (
    <Dialog open={newConvOpen} onOpenChange={setNewConvOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden="true" />
            Choisir un contact
          </DialogTitle>
          <DialogDescription>
            Seules les identités publiées sur le réseau apparaissent — toujours.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto scrollbar-thin">
          {(users.data?.users ?? [])
            .filter((u) => u.pubkey !== myPub)
            .map((u) => (
              <button
                key={u.pubkey}
                onClick={() => {
                  setSelectedPub(u.pubkey);
                  setNewConvOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left hover:bg-accent"
              >
                <MboteAvatar pubkey={u.pubkey} nickname={u.nickname} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {u.nickname}
                    {u.isBot && <span className="ml-1 text-[10px] text-primary">bot</span>}
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {shortKey(u.pubkey, 8)}
                  </p>
                </div>
                {u.ecdhPub && (
                  <Lock className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                )}
              </button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );

  if (!peer && !conversations.isLoading) {
    return (
      <div className="space-y-4">
        {/* a11y : l'état vide remplace TOUTE la vue → il porte le h1 aussi */}
        <h1 className="text-lg font-bold tracking-tight">Messages privés</h1>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <MessageSquarePlus className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-semibold">Aucune conversation</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Démarre un dialogue chiffré de bout en bout — essaie d&apos;abord le{" "}
              <strong>Mbote Bot</strong>, il répond toujours (en ciphertext authentique).
            </p>
            <Button size="sm" onClick={() => setNewConvOpen(true)}>
              <MessageSquarePlus className="size-4" aria-hidden="true" />
              Nouvelle conversation
            </Button>
          </CardContent>
        </Card>
        {newConvDialog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Messages privés</h1>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3 text-primary" aria-hidden="true" />
            E2E : ECDH P-256 + AES-GCM sur ton appareil — le serveur ne voit que du ciphertext.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setNewConvOpen(true)} className="h-9">
          <MessageSquarePlus className="size-4" aria-hidden="true" />
          Nouvelle
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-[240px_1fr]">
        {/* Liste des conversations */}
        <div className="rounded-xl border bg-card md:max-h-[560px]">
          <p className="border-b px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Conversations
          </p>
          <ScrollArea className="h-52 md:h-[520px]">
            <div className="scrollbar-thin space-y-0.5 p-1.5">
              {conversations.isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="m-1.5 h-12" />
                ))
              ) : (conversations.data?.conversations.length ?? 0) === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  Rien encore. Le bot est le premier contact idéal.
                </p>
              ) : (
                (conversations.data?.conversations ?? []).map(({ peer: u, unread }) => (
                  <button
                    key={u.pubkey}
                    onClick={() => setSelectedPub(u.pubkey)}
                    className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors ${
                      selectedPub === u.pubkey ? "bg-primary/10" : "hover:bg-accent"
                    }`}
                    aria-current={selectedPub === u.pubkey}
                  >
                    <MboteAvatar pubkey={u.pubkey} nickname={u.nickname} size={36} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {u.nickname}
                        {u.isBot && <span className="ml-1 text-[10px] text-primary">bot</span>}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {u.ecdhPub ? "🔒 enveloppe chiffrée" : "clés indisponibles"}
                      </p>
                    </div>
                    {unread > 0 && (
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                        aria-label={`${unread} non lus`}
                      >
                        {unread}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Panneau de chat */}
        <div className="flex min-h-[420px] flex-col rounded-xl border bg-card md:h-[560px]">
          {peer ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <MboteAvatar pubkey={peer.pubkey} nickname={peer.nickname} size={38} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{peer.nickname}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {shortKey(peer.pubkey)}
                    </p>
                  </div>
                </div>
                {peer.ecdhPub ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {/* C2 : appel audio 1:1 — disponible dès que le pair a une clé E2EE */}
                    <CallButton peer={peer.pubkey} peerLabel={peer.nickname} />
                    {/* C3 : appel vidéo 1:1 — mêmes patterns, m-line vidéo */}
                    <CallButton peer={peer.pubkey} peerLabel={peer.nickname} mode="video" />
                    <Badge variant="outline" className="gap-1 border-primary/40 text-[10px] text-primary">
                      <ShieldCheck className="size-3" aria-hidden="true" />
                      E2E actif
                    </Badge>
                  </div>
                ) : (
                  <Badge variant="outline" className="shrink-0 gap-1 border-amber-500/40 text-[10px] text-amber-500">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    clés absentes
                  </Badge>
                )}
              </div>

              {peer.isBot && (
                <div className="flex items-start gap-2 border-b bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
                  <Bot className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  Bot de démonstration : ses réponses sont réellement chiffrées vers ta clé
                  publique — écris « aide » pour explorer.
                </div>
              )}

              {/* A2 : ALERTE ROUGE BLOQUANTE — substitution de clé détectée */}
              {trust?.level === "red" && (
                <div
                  role="alert"
                  className="flex items-start gap-2 border-b border-red-900/40 bg-red-950/40 px-3 py-2.5 text-xs text-red-200"
                >
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-400" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-red-300">
                      Clé de chiffrement changée — envoi bloqué
                    </p>
                    <p className="mt-0.5 text-red-200/90">
                      La clé de {peer.nickname} diffère de celle épinglée sur cet appareil.
                      Re-vérifiez le numéro de sécurité en présentiel avant de continuer —
                      c&apos;est peut-être un nouvel appareil, ou une tentative d&apos;interception.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-8 border-red-700/60 text-red-200 hover:bg-red-900/40"
                      onClick={() => setTrustDialogOpen(true)}
                    >
                      <KeyRound className="size-3.5" aria-hidden="true" />
                      Re-vérifier le numéro de sécurité
                    </Button>
                  </div>
                </div>
              )}

              {/* A2 : premier contact — invitation à la vérification (non bloquant) */}
              {trust?.level === "yellow" && (
                <button
                  type="button"
                  onClick={() => setTrustDialogOpen(true)}
                  className="flex w-full items-start gap-2 border-b bg-amber-950/30 px-3 py-2 text-left text-[11px] text-amber-200/90 transition-colors hover:bg-amber-950/50"
                >
                  <ShieldQuestion className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    {trust.firstContact
                      ? "Premier contact — numéro de sécurité non vérifié. Comparez-le en présentiel pour sceller cette conversation."
                      : "Numéro de sécurité non vérifié — comparez-le en présentiel pour sceller cette conversation."}
                  </span>
                  <span className="shrink-0 font-semibold text-amber-300">Vérifier</span>
                </button>
              )}

              <ScrollArea className="flex-1">
                <div className="scrollbar-thin space-y-2 p-3">
                  {messages.isLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className={`h-10 ${i % 2 ? "ml-auto w-2/3" : "w-2/3"}`} />
                    ))
                  ) : (messages.data?.messages.length ?? 0) === 0 && queuedForPeer.length === 0 ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      Aucun message. Écris le premier — il sera chiffré avant de quitter cet
                      onglet.
                    </p>
                  ) : (
                    (messages.data?.messages ?? []).map((m) => {
                      const mine = m.senderKey === myPub;
                      const body = peer.ecdhPub
                        ? (plain[m.id] ?? "…déchiffrement")
                        : "🔒 ciphertext (clés de démo indisponibles)";
                      const media = parseDmBody(body);
                      return (
                        <div
                          key={m.id}
                          data-message-id={m.id}
                          className={`flex ${mine ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed md:max-w-[75%] ${
                              mine
                                ? "rounded-br-md bg-primary text-primary-foreground"
                                : "rounded-bl-md bg-muted text-foreground"
                            }`}
                          >
                            {media ? (
                              media.mediaType === "audio/opus" ? (
                                <VoiceBubble payload={media} mine={mine} me={myPub} signPriv={identity.signPriv} />
                              ) : media.mediaType.startsWith("video/") ? (
                                <VideoBubble
                                  media={{
                                    mediaId: media.mediaId,
                                    cek: media.cek,
                                    mediaType: media.mediaType,
                                    bytes: media.bytes,
                                  }}
                                  thumb={media.thumb ?? null}
                                  durationMs={media.durationMs}
                                  mine={mine}
                                  me={myPub}
                                  signPriv={identity.signPriv}
                                />
                              ) : (
                                <MediaBubble payload={media} mine={mine} me={myPub} signPriv={identity.signPriv} />
                              )
                            ) : (
                              <p className="whitespace-pre-wrap break-words">{body}</p>
                            )}
                            <p
                              className={`mt-1 flex items-center gap-1 text-[10px] ${
                                mine ? "text-primary-foreground/70" : "text-muted-foreground"
                              }`}
                            >
                              {media && (
                                media.mediaType === "audio/opus" ? (
                                  <Mic className="size-2.5" aria-hidden="true" />
                                ) : media.mediaType.startsWith("video/") ? (
                                  <Film className="size-2.5" aria-hidden="true" />
                                ) : (
                                  <ImageIcon className="size-2.5" aria-hidden="true" />
                                )
                              )}
                              <Lock className="size-2.5" aria-hidden="true" />
                              {formatDistanceToNow(new Date(m.createdAt), {
                                addSuffix: true,
                                locale: fr,
                              })}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                  {/* F-15 : courriers en attente — bulles « En attente » (opacité réduite) */}
                  {queuedForPeer.map((item) => (
                    <div key={item.clientRef} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-dashed border-primary/40 bg-primary/5 px-3.5 py-2 text-sm leading-relaxed opacity-70 md:max-w-[75%]">
                        <p className="whitespace-pre-wrap break-words">{item.text}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/40 px-1.5 py-0 text-[9px] text-amber-500"
                          >
                            <Clock className="size-2.5" aria-hidden="true" />
                            En attente
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            Sera envoyé dès le retour du réseau
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              </ScrollArea>

              <div className="border-t p-3">
                {/* B2 : bandeau d'upload en cours (états observables) */}
                {uploadState && (
                  <div
                    className="mb-2 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden="true" />
                    <span className="flex-1">
                      {uploadState.stage === "strip"
                        ? "Nettoyage EXIF (GPS, dates, appareil)…"
                        : uploadState.stage === "encrypt"
                          ? "Chiffrement de bout en bout…"
                          : uploadState.stage === "presign"
                            ? "Demande d'URL d'upload…"
                            : uploadState.stage === "put"
                              ? `Envoi chiffré au bucket… ${Math.round((uploadState.fraction ?? 0) * 100)} %`
                              : uploadState.stage === "finalize"
                                ? "Finalisation (vérification serveur)…"
                                : "Terminé"}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {/* B2 : pièce jointe image — picker natif, preview avant envoi */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = ""; // permet re-sélection du même fichier
                      if (f) void pickFile(f);
                    }}
                    aria-label="Choisir une image à envoyer"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-11 shrink-0"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!peer.ecdhPub || sending || uploadState !== null || trustBlocked || peer.isBot}
                    aria-label="Joindre une image"
                    title="Joindre une image (jpeg, png, webp — 5 Mo max)"
                  >
                    <Paperclip className="size-4" aria-hidden="true" />
                  </Button>
                  {/* B3 : note vocale — HOLD-TO-RECORD (arbitrage spec §8.5 :
                      WhatsApp est la référence d'usage en RDC). Relâchement
                      < 400 ms → mode tap-to-toggle (a11y + clavier :
                      Enter/Space déclenchent click après pointerdown/up). */}
                  <Button
                    variant="outline"
                    size="icon"
                    className={`h-11 shrink-0 ${voiceRecording ? "border-red-400 bg-red-50 text-red-700" : ""}`}
                    onPointerDown={onMicPointerDown}
                    onPointerUp={onMicPointerUp}
                    onPointerLeave={() => {
                      if (voiceRecording && !voiceTapModeRef.current) void stopVoiceRecording(false);
                    }}
                    onClick={onMicClick}
                    disabled={
                      !peer.ecdhPub ||
                      sending ||
                      uploadState !== null ||
                      voiceUploading ||
                      pendingVoice !== null ||
                      trustBlocked ||
                      peer.isBot ||
                      !voiceSupported
                    }
                    aria-label={
                      !voiceSupported
                        ? "Notes vocales indisponibles (Opus requis)"
                        : voiceRecording
                          ? "Arrêter l'enregistrement"
                          : "Note vocale — maintenir pour enregistrer"
                    }
                    title={
                      !voiceSupported
                        ? VOICE_UNSUPPORTED_MESSAGE
                        : voiceRecording
                          ? "Enregistrement… relâchez pour prévisualiser"
                          : "Maintenir pour enregistrer (Opus 8 kbps, 60 s max)"
                    }
                    data-testid="mic-button"
                  >
                    {voiceRecording ? (
                      <Square className="size-4" aria-hidden="true" />
                    ) : (
                      <Mic className="size-4" aria-hidden="true" />
                    )}
                  </Button>
                  {voiceRecording && (
                    <span
                      className="shrink-0 text-xs font-medium tabular-nums text-red-600"
                      role="timer"
                      aria-live="off"
                      data-testid="voice-timer"
                    >
                      ● {(voiceElapsedMs / 1000).toFixed(1)} s
                    </span>
                  )}
                  {/* B4 : vidéo — TAP-TO-START/STOP (tranché spec §9.6 : la
                      visée exige de garder l'œil sur l'écran, pas sur le
                      bouton — l'inverse du hold-to-record voix). */}
                  <Button
                    variant="outline"
                    size="icon"
                    className={`h-11 shrink-0 ${videoRecording ? "border-red-400 bg-red-50 text-red-700" : ""}`}
                    onClick={() => {
                      if (videoRecording) {
                        void stopVideoRecording(false);
                      } else {
                        void startVideoRecording();
                      }
                    }}
                    disabled={
                      !peer.ecdhPub ||
                      sending ||
                      uploadState !== null ||
                      videoUploading ||
                      pendingVideo !== null ||
                      voiceRecording ||
                      trustBlocked ||
                      peer.isBot ||
                      !videoSupported
                    }
                    aria-label={
                      !videoSupported
                        ? "Vidéo indisponible sur ce navigateur"
                        : videoRecording
                          ? "Arrêter la vidéo"
                          : "Enregistrer une vidéo"
                    }
                    title={
                      !videoSupported
                        ? VIDEO_UNSUPPORTED_MESSAGE
                        : videoRecording
                          ? "Enregistrement… cliquez pour arrêter"
                          : "Vidéo (webm 480p/720p, 60 s max, 100 Mo max)"
                    }
                    data-testid="video-button"
                  >
                    {videoRecording ? (
                      <Square className="size-4" aria-hidden="true" />
                    ) : (
                      <Film className="size-4" aria-hidden="true" />
                    )}
                  </Button>
                  {videoRecording && (
                    <span
                      className="shrink-0 text-xs font-medium tabular-nums text-red-600"
                      role="timer"
                      aria-live="off"
                      data-testid="video-timer"
                    >
                      ● {(videoElapsedMs / 1000).toFixed(1)} s
                    </span>
                  )}
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={
                      trustBlocked
                        ? "Envoi bloqué — re-vérifiez le numéro de sécurité"
                        : peer.ecdhPub
                          ? canUseNetwork
                            ? "Message chiffré (ECDH + AES-GCM)…"
                            : peer.isBot
                              ? "Mbote (bot) attend le retour du réseau…"
                              : "Hors-ligne — ton courrier partira au retour du réseau"
                          : "Contact sans clés ECDH"
                    }
                    disabled={!peer.ecdhPub || sending || trustBlocked}
                    maxLength={2000}
                    className="h-11"
                    aria-label="Message privé"
                  />
                  <Button
                    onClick={send}
                    disabled={!peer.ecdhPub || !draft.trim() || sending || trustBlocked}
                    className="h-11 shrink-0"
                    aria-label="Envoyer le message chiffré"
                  >
                    {sending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="size-4" aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
              Sélectionne une conversation…
            </div>
          )}
        </div>
      </div>

      {/* B3 : dialogue de PREVIEW voix (lecture, durée, annulable) */}
      <Dialog open={pendingVoice !== null} onOpenChange={(open) => !open && cancelPendingVoice()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mic className="size-4 text-primary" aria-hidden="true" />
              Envoyer une note vocale
            </DialogTitle>
            <DialogDescription>
              Opus {pendingVoice ? (pendingVoice.durationMs / 1000).toFixed(1) : "0"} s —
              chiffrée sur ton appareil, le serveur n&apos;entend rien. Écoute-toi avant
              d&apos;envoyer.
            </DialogDescription>
          </DialogHeader>
          {pendingVoice && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/40 p-3">
                <VoiceNote
                  blob={new Blob([pendingVoice.bytes as unknown as BlobPart], {
                    type: pendingVoice.container,
                  })}
                  durationMs={pendingVoice.durationMs}
                  peaks={pendingVoice.peaks}
                  mine={false}
                  bytes={pendingVoice.bytes.length}
                  downloadable
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={cancelPendingVoice}>
                  <X className="size-4" aria-hidden="true" />
                  Annuler
                </Button>
                <Button className="flex-1" onClick={sendPendingVoice} disabled={voiceUploading}>
                  {voiceUploading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Mic className="size-4" aria-hidden="true" />
                  )}
                  Chiffrer et envoyer
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* B4 : dialogue de PREVIEW vidéo (thumbnail, durée, taille, annulable) */}
      <Dialog open={pendingVideo !== null} onOpenChange={(open) => !open && cancelPendingVideo()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Film className="size-4 text-primary" aria-hidden="true" />
              Envoyer une vidéo
            </DialogTitle>
            <DialogDescription>
              {pendingVideo ? (pendingVideo.durationMs / 1000).toFixed(1) : "0"} s ·{" "}
              {pendingVideo ? humanBytes(pendingVideo.bytes.length) : "—"} — chiffrée sur ton
              appareil (AES-256-GCM), le serveur n&apos;en voit que le chiffré. Vise avant
              d&apos;envoyer.
            </DialogDescription>
          </DialogHeader>
          {pendingVideo && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/40 p-3">
                {videoPreviewUrl ? (
                  <video
                    src={videoPreviewUrl}
                    controls
                    preload="metadata"
                    className="max-h-56 w-full rounded-lg bg-black"
                    aria-label="Aperçu de la vidéo enregistrée"
                  />
                ) : pendingVideo.thumb ? (
                  <span className="text-xs text-muted-foreground">vignette seule (metadata en attente)</span>
                ) : null}
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {pendingVideo.width}×{pendingVideo.height} · {pendingVideo.container}
                </span>
                <span>{humanBytes(pendingVideo.bytes.length)}</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={cancelPendingVideo}>
                  <X className="size-4" aria-hidden="true" />
                  Annuler
                </Button>
                <Button className="flex-1" onClick={sendPendingVideo} disabled={videoUploading} data-testid="video-send">
                  {videoUploading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Film className="size-4" aria-hidden="true" />
                  )}
                  Chiffrer et envoyer
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* B2 : dialogue de PREVIEW avant upload (nom, taille, annulable) */}
      <Dialog open={pendingFile !== null} onOpenChange={(open) => !open && setPendingFile(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ImageIcon className="size-4 text-primary" aria-hidden="true" />
              Envoyer une image
            </DialogTitle>
            <DialogDescription>
              EXIF/GPS supprimés, chiffrement sur ton appareil, puis envoi au bucket —
              le serveur ne verra que du chiffré.
            </DialogDescription>
          </DialogHeader>
          {pendingFile && (
            <div className="space-y-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- blob local de preview */}
              <img
                src={pendingFile.previewUrl}
                alt={`Aperçu de ${pendingFile.name}`}
                className="max-h-56 w-full rounded-lg object-contain"
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="truncate">{pendingFile.name}</span>
                <span>{humanBytes(pendingFile.bytes.length)}</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setPendingFile(null)}>
                  <X className="size-4" aria-hidden="true" />
                  Annuler
                </Button>
                <Button className="flex-1" onClick={attachAndSend}>
                  <ImageIcon className="size-4" aria-hidden="true" />
                  Chiffrer et envoyer
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* A2 : dialogue du numéro de sécurité (vérification hors-bande) */}
      <Dialog open={trustDialogOpen} onOpenChange={setTrustDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" aria-hidden="true" />
              Numéro de sécurité
            </DialogTitle>
            <DialogDescription>
              Comparez ces 60 chiffres avec {peer?.nickname} — en présentiel ou par un canal
              déjà sûr (voix mesh). Identiques des deux côtés = personne au milieu.
            </DialogDescription>
          </DialogHeader>
          {trust && (
            <div className="space-y-3">
              <div
                className="rounded-lg border bg-muted/60 p-3 text-center font-mono text-sm font-semibold tracking-widest"
                aria-label="Numéro de sécurité en 12 groupes de 5 chiffres"
              >
                <p>{trust.safetyNumber.split(" ").slice(0, 6).join(" ")}</p>
                <p className="mt-1.5">{trust.safetyNumber.split(" ").slice(6, 12).join(" ")}</p>
              </div>
              {trust.keyChanged && (
                <p className="flex items-start gap-1.5 text-xs text-red-400">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  Ce numéro diffère du précédent — ne confirmez que si {peer?.nickname}
                  vous confirme ce NOUVEAU numéro de vive voix.
                </p>
              )}
              <Button className="w-full" onClick={confirmTrust} disabled={verifying}>
                {verifying ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="size-4" aria-hidden="true" />
                )}
                J&apos;ai comparé en présentiel — Sceller
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialogue nouvelle conversation (variable partagée — B2-fix) */}
      {newConvDialog}
    </div>
  );
}
