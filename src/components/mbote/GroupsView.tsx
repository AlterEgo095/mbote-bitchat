"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C4 — GroupsView : groupes privés MLS (création, conversation, membres)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Monté comme vue « Groupes » de MboteApp. Rôles :
 *   • publication des key packages MLS à l'ouverture (3 frais — single-use) ;
 *   • création : nom + sélection multi-contacts (un commit multi-adds MLS) ;
 *   • conversation : messages déchiffrés LOCALEMENT (ciphertext opaque côté
 *     serveur), badge MLS + epoch courant affiché ;
 *   • gestion des membres : liste, invitation (key package frais consommé),
 *     retrait avec confirmation (forward secrecy — l'ex-membre ne lit plus
 *     les messages d'après, preuve PoC T1) ;
 *   • messages système : membre ajouté/retiré (visible, hors E2EE — l'annuaire
 *     est public par définition) ;
 *   • temps réel : événements group-envelope via le hub (relais), polling de
 *     secours (le relay éteint ne casse rien).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Users, UserPlus, UserMinus, ShieldCheck, Loader2, RefreshCw, LogOut, Crown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { signPayload, shortKey } from "@/lib/mbote/crypto";
import { describeApiError, describeApiStatus } from "@/lib/mbote/api";
import { getSocket } from "@/lib/mbote/socket";
import {
  setMlsIdentity,
  publishKeyPackages,
  createGroupMls,
  syncGroupHandshakes,
  syncGroupMessages,
  sendGroupMessage,
  inviteMember,
  removeMember,
  type DecryptedGroupMessage,
} from "@/lib/mbote/mls/client";
import type { StoredIdentity } from "@/lib/mbote/identity";

interface GroupInfo {
  id: string;
  name: string;
  creatorKey: string;
  createdAt: string;
  joinedAt: string;
  members: Array<{ userKey: string; joinedAt: string }>;
}

interface Contact {
  pubkey: string;
  nickname: string;
}

const POLL_MS = 4_000;

/** preuve de lecture GET (query) — même chaîne que client.ts */
async function authQuery(signPriv: CryptoKey, pubkey: string, message: string): Promise<string> {
  const ts = Date.now();
  const signature = await signPayload(signPriv, `${message}|${ts}`);
  return `me=${encodeURIComponent(pubkey)}&ts=${ts}&signature=${encodeURIComponent(signature)}`;
}

export function GroupsView({ identity }: { identity: StoredIdentity }) {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [kpPublished, setKpPublished] = useState(false);
  // F #42 — échec de listing des groupes : plus de catch{} silencieux —
  // « réseau HS » n'est plus indistinguable d'« aucun groupe ».
  const [listingError, setListingError] = useState<string | null>(null);

  // brancher l'identité MLS + publier les key packages (une fois par session)
  useEffect(() => {
    setMlsIdentity({
      pubkey: identity.pubkey,
      signPriv: identity.signPriv,
      ecdhPriv: identity.ecdhPriv,
      ecdhPub: identity.ecdhPub,
    });
    let cancelled = false;
    void publishKeyPackages(3)
      .then(() => {
        if (!cancelled) setKpPublished(true);
      })
      .catch((e: unknown) => {
        console.warn("[groups] publication key packages échouée", e);
        if (!cancelled) setKpPublished(false);
      });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  // liste des groupes (poll) + contacts
  const refreshGroups = useCallback(async () => {
    try {
      const q = await authQuery(identity.signPriv, identity.pubkey, `${identity.pubkey}|groups-list`);
      const res = await fetch(`/api/groups?${q}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        // F #42 — échec HTTP rendu (statut FR via le mapping central)
        setListingError(describeApiStatus(res.status));
        return;
      }
      const json = (await res.json()) as { groups: GroupInfo[] };
      setGroups(json.groups);
      setListingError(null);
    } catch (e) {
      /* hors ligne — le poll suivant retentera ; l'état est dit (F #42) */
      setListingError(
        e instanceof DOMException && e.name === "AbortError"
          ? "Délai dépassé — vérifie ta connexion puis réessaie."
          : "Réseau injoignable — la liste se rechargera au retour du réseau."
      );
    }
  }, [identity]);

  useEffect(() => {
    // tick asynchrone initial (règle set-state-in-effect) + poll périodique
    const t0 = setTimeout(() => void refreshGroups(), 0);
    const t = setInterval(() => void refreshGroups(), POLL_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [refreshGroups]);

  useEffect(() => {
    // ticks asynchrones (règle set-state-in-effect — mêmes patterns useElapsed)
    const t = setTimeout(() => {
      fetch(`/api/users?me=${encodeURIComponent(identity.pubkey)}&exclude=${encodeURIComponent(identity.pubkey)}`, {
        signal: AbortSignal.timeout(15_000),
      })
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d: { users?: Contact[] }) => setContacts(d.users ?? []))
        .catch(() => setContacts([]));
    }, 0);
    return () => clearTimeout(t);
  }, [identity.pubkey]);

  // socket : sync des handshakes PUIS rafraîchissement — un welcome est
  // traité même si le groupe n'est pas sélectionné (jointure hors vue)
  const groupsRef = useRef<GroupInfo[]>([]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    const syncPending = async (groupId?: string) => {
      const targets = groupId ? [groupId] : groupsRef.current.map((g) => g.id);
      for (const id of targets) {
        try {
          await syncGroupHandshakes(id);
        } catch {
          /* re-sync au prochain tick */
        }
      }
      void refreshGroups();
    };
    const s = getSocket();
    const onEnvelope = (d: { groupId?: string }) => {
      // tick asynchrone (règle set-state-in-effect — syncPending → setGroups)
      setTimeout(() => void syncPending(d?.groupId), 0);
    };
    s.on("group-envelope", onEnvelope);
    return () => {
      s.off("group-envelope", onEnvelope);
    };
  }, [refreshGroups]);


  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-3 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Groupes privés</h1>
        <div className="flex items-center gap-2">
          {!kpPublished && (
            <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              préparation MLS…
            </Badge>
          )}
          <CreateGroupDialog
            contacts={contacts}
            kpPublished={kpPublished}
            onCreated={(id) => {
              setSelectedId(id);
              void refreshGroups();
            }}
          />
        </div>
      </div>

      {listingError ? (
        // F #42 — échec de listing rendu avec action (réseau HS ≠ aucun groupe)
        <Card className="border-red-300 bg-red-50" data-testid="groups-listing-error">
          <CardContent className="flex flex-col items-start gap-3 p-6" role="alert">
            <p className="text-sm font-semibold text-red-900">Impossible de charger tes groupes</p>
            <p className="text-sm text-red-800">{listingError}</p>
            <Button size="sm" className="h-11 bg-red-700 text-white hover:bg-red-800" onClick={() => void refreshGroups()}>
              Réessayer
            </Button>
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Users className="size-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="font-medium text-foreground">Aucun groupe</p>
            <p className="text-xs">
              Les groupes sont chiffrés de bout en bout (MLS, RFC 9420) — le serveur
              ne voit que le nom et la liste des membres, jamais les messages.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <Card
              key={g.id}
              data-testid={`group-card-${g.id}`}
              // F #39 — sélection de groupe accessible au clavier et au lecteur
              // d'écran (2.1.1 / 4.1.2) : la Card cliquable était un div sans
              // rôle, sans tabIndex, sans keydown — impossible au clavier.
              role="button"
              tabIndex={0}
              aria-pressed={g.id === selectedId}
              className={`cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                g.id === selectedId ? "border-primary/60" : ""
              }`}
              onClick={() => setSelectedId(g.id === selectedId ? null : g.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedId(g.id === selectedId ? null : g.id);
                }
              }}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{g.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {g.members.length} membre{g.members.length > 1 ? "s" : ""} ·{" "}
                    {g.creatorKey === identity.pubkey ? "vous administrez" : `créé par ${shortKey(g.creatorKey)}`}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 gap-1 text-[10px] text-primary">
                  <ShieldCheck className="size-3" aria-hidden="true" />
                  MLS
                </Badge>
              </CardContent>
              {g.id === selectedId && (
                <GroupConversation
                  group={g}
                  identity={identity}
                  contacts={contacts}
                  onGroupChanged={() => void refreshGroups()}
                />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── création ─────────────────────────────────────────────────────────────────

function CreateGroupDialog({
  contacts,
  kpPublished,
  onCreated,
}: {
  contacts: Contact[];
  kpPublished: boolean;
  onCreated: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const toggle = (pk: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  };

  const onCreate = useCallback(async () => {
    if (!name.trim() || picked.size === 0 || creating) return;
    setCreating(true);
    try {
      const created = await createGroupMls(name.trim(), Array.from(picked));
      toast.success(`Groupe créé — ${picked.size + 1} membre(s), MLS actif`);
      onCreated(created.serverGroupId);
      setOpen(false);
      setName("");
      setPicked(new Set());
    } catch (e) {
      toast.error(`Création impossible — ${describeApiError(e)}`);
    } finally {
      setCreating(false);
    }
  }, [name, picked, creating, onCreated]);

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!kpPublished}
        aria-label="Créer un groupe"
        data-testid="create-group"
      >
        <UserPlus className="size-4" aria-hidden="true" />
        Nouveau groupe
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nouveau groupe privé</DialogTitle>
            <DialogDescription>
              Chiffré de bout en bout via MLS. Les contacts doivent avoir publié
              une key package (ils doivent s&apos;être connectés une fois).
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nom du groupe"
            maxLength={60}
            aria-label="Nom du groupe"
          />
          <div className="max-h-56 space-y-1 overflow-y-auto" data-testid="contact-picker">
            {contacts.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">Aucun contact enregistré</p>
            )}
            {contacts.map((c) => (
              <label
                key={c.pubkey}
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-sm transition-colors hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={picked.has(c.pubkey)}
                  onChange={() => toggle(c.pubkey)}
                  className="size-4"
                  aria-label={`Inviter ${c.nickname}`}
                  // testid déterministe par nickname (les scripts de preuve
                  // ciblent le testid, pas l'accessible name)
                  data-testid={`invite-check-${c.nickname}`}
                />
                <span className="truncate">{c.nickname}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {shortKey(c.pubkey)}
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button
              onClick={() => void onCreate()}
              disabled={creating || !name.trim() || picked.size === 0}
              aria-label="Créer le groupe"
              data-testid="confirm-create-group"
            >
              {creating && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Créer ({picked.size + 1} membres)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── conversation + membres ───────────────────────────────────────────────────

interface SystemLine {
  id: string;
  text: string;
}

function GroupConversation({
  group,
  identity,
  contacts,
  onGroupChanged,
}: {
  group: GroupInfo;
  identity: StoredIdentity;
  contacts: Contact[];
  onGroupChanged: () => void;
}) {
  const [messages, setMessages] = useState<DecryptedGroupMessage[]>([]);
  const [systemLines, setSystemLines] = useState<SystemLine[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [inviting, setInviting] = useState(false);
  const prevMembers = useRef<Set<string>>(new Set(group.members.map((m) => m.userKey)));
  const listRef = useRef<HTMLDivElement | null>(null);
  const onGroupChangedRef = useRef<(() => void) | null>(null);
  onGroupChangedRef.current = onGroupChanged;

  const nicknameOf = useCallback(
    (pk: string) =>
      pk === identity.pubkey ? "vous" : (contacts.find((c) => c.pubkey === pk)?.nickname ?? shortKey(pk)),
    [contacts, identity.pubkey]
  );

  // détection membres ajoutés/retirés (annuaire public — messages système)
  useEffect(() => {
    const current = new Set(group.members.map((m) => m.userKey));
    const lines: SystemLine[] = [];
    for (const pk of current) {
      if (!prevMembers.current.has(pk)) lines.push({ id: `join-${pk}-${Date.now()}`, text: `${nicknameOf(pk)} a rejoint le groupe` });
    }
    for (const pk of prevMembers.current) {
      if (!current.has(pk)) lines.push({ id: `leave-${pk}-${Date.now()}`, text: `${nicknameOf(pk)} a été retiré du groupe` });
    }
    if (lines.length > 0) setSystemLines((prev) => [...prev, ...lines]);
    prevMembers.current = current;
  }, [group.members, nicknameOf]);

  // sync : handshakes puis messages (poll + à l'ouverture)
  const syncAll = useCallback(async () => {
    try {
      const applied = await syncGroupHandshakes(group.id);
      const msgs = await syncGroupMessages(group.id);
      if (msgs.length > 0) {
        setMessages((prev) => [...prev, ...msgs.filter((m) => m.text !== "" || m.senderKey === identity.pubkey)]);
      }
      if (applied > 0 || msgs.length > 0) onGroupChangedRef.current?.();
    } catch (e) {
      console.warn("[groups] sync échouée", e);
    }
  }, [group.id, identity.pubkey]);

  useEffect(() => {
    void syncAll();
    const t = setInterval(() => void syncAll(), POLL_MS);
    return () => clearInterval(t);
  }, [syncAll]);

  // socket : sync immédiate à chaque événement
  useEffect(() => {
    const s = getSocket();
    const onEnv = (d: { groupId?: string }) => {
      if (d?.groupId === group.id) void syncAll();
    };
    s.on("group-envelope", onEnv);
    return () => {
      s.off("group-envelope", onEnv);
    };
  }, [group.id, syncAll]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendGroupMessage(group.id, text);
      setDraft("");
      setMessages((prev) => [
        ...prev,
        { id: `self-${Date.now()}`, senderKey: identity.pubkey, text, createdAt: new Date().toISOString(), epoch: 0 },
      ]);
    } catch (e) {
      toast.error(`Envoi impossible — ${describeApiError(e)}`);
    } finally {
      setSending(false);
    }
  }, [draft, sending, group.id, identity.pubkey]);

  const onInvite = useCallback(
    async (userKey: string) => {
      setInviting(true);
      try {
        await inviteMember(group.id, userKey);
        toast.success("Membre invité — commit diffusé, welcome envoyé");
        onGroupChanged();
      } catch (e) {
        toast.error(`Invitation impossible — ${describeApiError(e)}`);
      } finally {
        setInviting(false);
      }
    },
    [group.id, onGroupChanged]
  );

  const onRemove = useCallback(
    async (userKey: string, nickname: string) => {
      if (!window.confirm(`Retirer ${nickname} du groupe ? Il ne pourra plus lire les messages d'après.`)) return;
      try {
        await removeMember(group.id, userKey);
        toast.success("Membre retiré — nouvelle epoch, forward secrecy appliquée");
        onGroupChanged();
      } catch (e) {
        toast.error(`Retrait impossible — ${describeApiError(e)}`);
      }
    },
    [group.id, onGroupChanged]
  );

  const inviteCandidates = contacts.filter(
    (c) => !group.members.some((m) => m.userKey === c.pubkey)
  );
  const isCreator = group.creatorKey === identity.pubkey;
  const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const allLines = [
    ...systemLines,
    ...group.members.map(
      (m) => ({ id: `joined-${m.userKey}-${m.joinedAt}`, text: `${nicknameOf(m.userKey)} a rejoint le groupe` }) as SystemLine
    ),
  ];

  return (
    <div
      className="border-t px-4 pb-4 pt-3"
      data-testid="group-conversation"
      // BUG PREUVE N4 : sans stopPropagation, chaque clic interne (envoi,
      // badge membre) bouillonne jusqu'à la Card et désélectionne le groupe
      onClick={(e) => e.stopPropagation()}
    >
      {/* panneau membres */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="group-members">
        {group.members.map((m) => (
          <Badge
            key={m.userKey}
            variant="outline"
            className="gap-1 py-1 text-[11px]"
          >
            {m.userKey === group.creatorKey && <Crown className="size-3 text-amber-500" aria-hidden="true" />}
            {nicknameOf(m.userKey)}
            {isCreator && m.userKey !== identity.pubkey && (
              <button
                type="button"
                // F #44 — cible 44×44 (l'action est IRRÉVERSIBLE : forward secrecy)
                className="ml-1 inline-flex size-11 items-center justify-center rounded-full hover:bg-muted"
                onClick={() => void onRemove(m.userKey, nicknameOf(m.userKey))}
                aria-label={`Retirer ${nicknameOf(m.userKey)} du groupe`}
                data-testid={`remove-${shortKey(m.userKey)}`}
              >
                <UserMinus className="size-4" aria-hidden="true" />
              </button>
            )}
          </Badge>
        ))}
        <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <ShieldCheck className="size-3" aria-hidden="true" />
MLS actif
        </span>
      </div>

      {/* inviter (créateur) */}
      {isCreator && inviteCandidates.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" data-testid="invite-candidates">
          {inviteCandidates.slice(0, 6).map((c) => (
            <Button
              key={c.pubkey}
              size="sm"
              variant="outline"
              // F #45 — cible tactile 44×44
              className="min-h-11 gap-1 px-3 text-xs"
              disabled={inviting}
              onClick={() => void onInvite(c.pubkey)}
              aria-label={`Inviter ${c.nickname} dans le groupe`}
            >
              <UserPlus className="size-4" aria-hidden="true" />
              Inviter {c.nickname}
            </Button>
          ))}
        </div>
      )}

      {/* fil des messages */}
      <div
        ref={listRef}
        className="max-h-96 space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-3"
        data-testid="group-messages"
        aria-label={`Messages du groupe ${group.name}`}
      >
        {allLines.map((l) => (
          <p key={l.id} className="text-center text-[10px] italic text-muted-foreground">
            {l.text}
          </p>
        ))}
        {sorted.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            Aucun message encore déchiffré.
          </p>
        )}
        {sorted.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.senderKey === identity.pubkey ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                m.senderKey === identity.pubkey
                  ? "bg-primary text-primary-foreground"
                  : "border bg-background"
              }`}
            >
              {m.senderKey !== identity.pubkey && (
                <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                  {nicknameOf(m.senderKey)}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
            </div>
            <span className="mt-0.5 text-[9px] text-muted-foreground">
              {new Date(m.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>

      {/* composer */}
      <div className="mt-3 flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="Message chiffré (MLS)…"
          aria-label="Message de groupe"
          data-testid="group-composer"
        />
        <Button
          size="icon"
          className="size-11"
          onClick={() => void onSend()}
          disabled={sending || !draft.trim()}
          aria-label="Envoyer le message de groupe"
          data-testid="group-send"
        >
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4 rotate-180" aria-hidden="true" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-11"
          onClick={() => void syncAll()}
          aria-label="Rafraîchir les messages du groupe"
          data-testid="group-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
