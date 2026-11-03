"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Eye,
  Hourglass,
  KeyRound,
  Loader2,
  Mail,
  MapPinned,
  ShieldCheck,
  UserCheck,
  UserPlus,
  UsersRound,
  Waves,
} from "lucide-react";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiSetFollow } from "@/lib/mbote/api";
import { signPayload } from "@/lib/mbote/crypto";
import { loadIdentity, type StoredIdentity } from "@/lib/mbote/identity";
import { followProofMessage } from "@/lib/mbote/proof";
import type { UserPublic } from "@/lib/mbote/types";
import { MboteAvatar } from "./Avatar";
import { BitChatBridge } from "./BitChatBridge";
import MeshSimulation from "./MeshSimulation";
import { RouteurPanel } from "./RouteurPanel";

/**
 * F-12 : UserPublic + annotation `isFollowing` renvoyée par GET /api/users?me=…
 * Type étendu déclaré LOCALEMENT (types.ts inchangé) — champ additionnel
 * rétrocompatible côté serveur.
 */
interface UserWithFollow extends UserPublic {
  isFollowing: boolean;
}

/** Liste des identités avec annotation de suivi (on passe `me` ET on s'exclut soi-même). */
async function fetchUsersWithFollow(mePub: string): Promise<UserWithFollow[]> {
  const q = new URLSearchParams({ me: mePub, exclude: mePub });
  const res = await fetch(`/api/users?${q.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { users: UserWithFollow[] };
  return data.users;
}

/**
 * F-12 : « Identités à suivre » — l'UI du graphe de confiance.
 * La pubkey locale vient de loadIdentity() (même source que MboteApp), chargée
 * dans un useEffect pour rester hydration-safe (aucun accès localStorage au
 * premier render). apiSetFollow / apiGetFollow de api.ts sont enfin consommées.
 */
function FollowSuggestions() {
  const [me, setMe] = useState<StoredIdentity | null>(null);
  const [identityReady, setIdentityReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadIdentity().then((id) => {
      if (cancelled) return;
      setMe(id);
      setIdentityReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const qc = useQueryClient();
  const usersKey = ["users", "follow", me?.pubkey ?? null] as const;

  const users = useQuery({
    queryKey: usersKey,
    queryFn: () => {
      if (!me) throw new Error("Aucune identité locale");
      return fetchUsersWithFollow(me.pubkey);
    },
    enabled: identityReady && !!me,
    staleTime: 15_000,
  });

  // Suivre / ne plus suivre : même chaîne de preuve que les likes (F-01) —
  // signature ECDSA locale sur `${followerPub}|follow|${action}|${targetPub}|${ts}`
  // (followProofMessage de proof.ts), vérifiée côté serveur par POST /api/follows.
  // Mise à jour optimiste du cache react-query, rollback si la preuve ou
  // l'écriture est refusée.
  const followMutation = useMutation({
    mutationFn: async (vars: { target: UserWithFollow; action: "follow" | "unfollow" }) => {
      if (!me) throw new Error("Aucune identité locale");
      const ts = Date.now();
      let signature: string;
      try {
        signature = await signPayload(
          me.signPriv,
          followProofMessage(me.pubkey, vars.target.pubkey, vars.action, ts)
        );
      } catch {
        throw new Error("Signature impossible — action annulée");
      }
      return apiSetFollow({
        followerPub: me.pubkey,
        targetPub: vars.target.pubkey,
        action: vars.action,
        ts,
        signature,
      });
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: usersKey });
      const previous = qc.getQueryData<UserWithFollow[]>(usersKey);
      qc.setQueryData<UserWithFollow[]>(usersKey, (old) =>
        (old ?? []).map((u) =>
          u.pubkey === vars.target.pubkey
            ? { ...u, isFollowing: vars.action === "follow" }
            : u
        )
      );
      return { previous };
    },
    onError: (error, vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(usersKey, ctx.previous);
      else void qc.invalidateQueries({ queryKey: usersKey });
      toast.error(
        vars.action === "follow"
          ? `Impossible de suivre ${vars.target.nickname}`
          : `Impossible de ne plus suivre ${vars.target.nickname}`,
        { description: error instanceof Error ? error.message : "Erreur inconnue" }
      );
    },
    onSuccess: (_data, vars) => {
      toast.success(
        vars.action === "follow"
          ? `Tu suis désormais ${vars.target.nickname}`
          : `Tu ne suis plus ${vars.target.nickname}`,
        { description: "Preuve signée sur ton appareil ✓" }
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: usersKey });
      // les abonnements alimentent le scope « following » du fil (FeedView)
      void qc.invalidateQueries({ queryKey: ["feed"] });
    },
  });

  const pendingPub = followMutation.isPending
    ? (followMutation.variables?.target.pubkey ?? null)
    : null;

  const postCount = (u: UserWithFollow) => u._count?.posts ?? 0;

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <UsersRound className="size-4 text-primary" aria-hidden="true" />
          Identités à suivre
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Le graphe de confiance local — tes abonnements alimentent l&apos;onglet
          « Abonnements » du fil global.
        </p>

        <div className="mt-3">
          {!identityReady || users.isLoading ? (
            <div className="space-y-2" aria-label="Chargement des identités">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg border p-2.5">
                  <Skeleton className="size-9 shrink-0 rounded-full" />
                  <div className="w-full space-y-1.5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-2.5 w-48" />
                  </div>
                  <Skeleton className="h-8 w-20 shrink-0" />
                </div>
              ))}
            </div>
          ) : !me ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
              <KeyRound className="size-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-semibold">Crée ton identité pour suivre des identités</p>
              <p className="text-xs text-muted-foreground">
                Chaque abonnement est signé par ta clé locale — sans identité, pas de graphe de
                confiance.
              </p>
            </div>
          ) : users.isError ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-5 text-center">
              <p className="text-xs text-muted-foreground">
                Impossible de charger les identités
                {users.error instanceof Error && users.error.message
                  ? ` — ${users.error.message}`
                  : ""}
                .
              </p>
              <Button size="sm" variant="outline" onClick={() => void users.refetch()}>
                Réessayer
              </Button>
            </div>
          ) : (users.data?.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
              Aucune autre identité enregistrée pour l&apos;instant — elles apparaîtront ici dès
              leur première publication.
            </p>
          ) : (
            <ul
              className="scrollbar-thin max-h-96 space-y-2 overflow-y-auto pr-1"
              aria-label="Identités à suivre"
            >
              {users.data?.map((u) => (
                <li key={u.id} className="flex items-center gap-3 rounded-lg border p-2.5">
                  <MboteAvatar pubkey={u.pubkey} nickname={u.nickname} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{u.nickname}</p>
                      {u.isBot && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[9px] text-muted-foreground"
                        >
                          démo
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {u.bio?.trim() ? `${u.bio.trim()} · ` : ""}
                      {postCount(u)} publication{postCount(u) > 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={u.isFollowing ? "outline" : "default"}
                    disabled={pendingPub === u.pubkey}
                    onClick={() =>
                      followMutation.mutate({
                        target: u,
                        action: u.isFollowing ? "unfollow" : "follow",
                      })
                    }
                    aria-label={
                      u.isFollowing ? `Ne plus suivre ${u.nickname}` : `Suivre ${u.nickname}`
                    }
                  >
                    {pendingPub === u.pubkey ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : u.isFollowing ? (
                      <UserCheck className="size-3.5" aria-hidden="true" />
                    ) : (
                      <UserPlus className="size-3.5" aria-hidden="true" />
                    )}
                    {u.isFollowing ? "Abonné(e)" : "Suivre"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const PROTOCOL_STATS = [
  { icon: Hourglass, value: "7", label: "sauts TTL max", sub: "clampé à 5 en zone dense" },
  { icon: Mail, value: "4 → 8", label: "budget de copies", sub: "courriers spray-and-wait" },
  { icon: Archive, value: "3", label: "courriers / message", sub: "+ outbox local 24 h" },
  { icon: Waves, value: "6 h", label: "fenêtre gossip", sub: "historique sync entre pairs" },
];

export function NetworkView() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold tracking-tight">Le réseau, en direct</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Simulation fidèle des paramètres du protocole BitChat (whitepaper v2.0, domaine
          public) : inondation contrôlée avec TTL et gigue, courriers « spray-and-wait » pour
          joindre un pair hors de portée.
        </p>
      </div>

      {/* F-12 : le graphe de confiance devient une UI — suivre / ne plus suivre */}
      <FollowSuggestions />

      {/* Routeur de transports (DORS) : santé + journal des décisions */}
      <RouteurPanel />

      {/* Tunnel réel : encapsulation BitChat → passerelle → VPS */}
      <BitChatBridge />

      <Card className="p-2">
        <CardContent className="p-2">
          <MeshSimulation />
        </CardContent>
      </Card>

      {/* Chiffres clés du protocole */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {PROTOCOL_STATS.map(({ icon: Icon, value, label, sub }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <Icon className="size-4 text-primary" aria-hidden="true" />
              <p className="mt-2 font-mono text-xl font-bold text-primary">{value}</p>
              <p className="text-xs font-medium">{label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Architecture */}
      <Card>
        <CardContent className="p-4">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="archi">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Waves className="size-4 text-primary" aria-hidden="true" />
                  Architecture à double transport
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Chaque message tente d&apos;abord le <strong>mesh Bluetooth LE</strong> (portée
                locale, multi-sauts, zéro infrastructure) puis bascule sur{" "}
                <strong>Nostr</strong> (relays internet mondiaux, canaux géohash) si personne
                n&apos;est à portée. Le routeur choisit le meilleur transport automatiquement —
                ici, la file locale « courrier » joue le rôle du store-and-forward.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="crypto">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                  Chiffrement : Noise XX en session, Noise X hors-ligne
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Les pairs en direct établissent une session <strong>Noise XX</strong>
                (Curve25519, ChaCha20-Poly1305) : authentification mutuelle et confidentialité
                persistante. Le courrier hors-ligne est scellé en <strong>Noise X</strong> vers
                la clé statique du destinataire — les relais ne portent que du ciphertext opaque.
                Cette démo implémente l&apos;équivalent WebCrypto : ECDH P-256 + AES-GCM 256.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="store">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Archive className="size-4 text-primary" aria-hidden="true" />
                  Store-and-forward : outbox, courriers, gossip
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Quatre mécanismes couvrent « le destinataire n&apos;est pas là » : l&apos;outbox
                persistante de l&apos;expéditeur, les <strong>courriers</strong> (3 pairs
                transporteurs, budget de copies 4→8, tags rotatifs quotidiens), la
                réconciliation d&apos;historique public par filtres de Golomb (GCS) toutes les
                15 s, et les boîtes aux lettres Nostr avec rappel de 24 h.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="geohash">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <MapPinned className="size-4 text-primary" aria-hidden="true" />
                  Canaux géohash : la carte devient un espace social
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Un géohash encode lat/lng en cellules emboîtables : 7 caractères = un bloc
                (~150 m), 5 = une ville (~5 km), 2 = un pays. Chaque cellule est un salon
                public transporté par les relays ; les identités y sont éphémères par zone.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="meta">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Eye className="size-4 text-amber-500" aria-hidden="true" />
                  Limites honnêtes (métadonnées)
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Le whitepaper le dit lui-même : l&apos;ID pair est stable et les annonces
                publient les clés en clair — un observateur radio peut suivre un appareil dans
                l&apos;espace-temps. Les identités rotatives sont listées en « travaux futurs ».
                Et côté démo : l&apos;ECDH statique-statique des DM n&apos;offre pas de
                confidentialité persistante (pas de prekeys). Transparence totale.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
