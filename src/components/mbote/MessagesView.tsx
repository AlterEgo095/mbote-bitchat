"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  Bot,
  Clock,
  KeyRound,
  Lock,
  Loader2,
  MessageSquarePlus,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { toast } from "sonner";
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

interface MessagesViewProps {
  identity: StoredIdentity;
  isOnline: boolean;
  forceOffline: boolean;
  /** F-15 : délègue la mise en file à MboteApp (propriétaire de l'outbox). */
  onQueueDm?: (payload: Record<string, unknown>, clientRef: string) => void;
}

export function MessagesView({ identity, isOnline, forceOffline, onQueueDm }: MessagesViewProps) {
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

  const [selectedPub, setSelectedPub] = useState<string | null>(null);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const peer: UserPublic | undefined = useMemo(() => {
    const fromConv = conversations.data?.conversations.find((c) => c.peer.pubkey === selectedPub)
      ?.peer;
    if (fromConv) return fromConv;
    return users.data?.users.find((u) => u.pubkey === selectedPub);
  }, [conversations.data, users.data, selectedPub]);

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
            next[m.id] = "🔒 Enveloppe indéchiffrable";
          }
        }
      }
      if (!cancelled) setPlain(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [messages.data, identity, peer?.ecdhPub]);

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
                  <Badge variant="outline" className="shrink-0 gap-1 border-primary/40 text-[10px] text-primary">
                    <ShieldCheck className="size-3" aria-hidden="true" />
                    E2E actif
                  </Badge>
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
                      return (
                        <div
                          key={m.id}
                          className={`flex ${mine ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed md:max-w-[75%] ${
                              mine
                                ? "rounded-br-md bg-primary text-primary-foreground"
                                : "rounded-bl-md bg-muted text-foreground"
                            }`}
                          >
                            <p className="whitespace-pre-wrap break-words">{body}</p>
                            <p
                              className={`mt-1 flex items-center gap-1 text-[10px] ${
                                mine ? "text-primary-foreground/70" : "text-muted-foreground"
                              }`}
                            >
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
                <div className="flex items-center gap-2">
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

      {/* Dialogue nouvelle conversation */}
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
    </div>
  );
}
