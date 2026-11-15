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
import { useI18n } from "@/lib/mbote/i18n";
import type { UserPublic } from "@/lib/mbote/types";
import { MboteAvatar } from "./Avatar";
import { BitChatBridge } from "./BitChatBridge";
import dynamic from "next/dynamic";

// F-34 : la simulation (1 400+ lignes) ne voyage plus dans le bundle initial —
// chargée uniquement quand l'utilisateur ouvre la vue Réseau.
function MeshSimulationLoading() {
  const { t } = useI18n();
  return (
    <div
      className="h-64 rounded-xl border bg-card/50"
      aria-busy="true"
      aria-label={t("network.simulationLoading")}
    />
  );
}

const MeshSimulation = dynamic(() => import("./MeshSimulation"), {
  ssr: false,
  loading: MeshSimulationLoading,
});

// F-24 : les textes décrivent le VRAI transport internet de cette démo —
// le pont mesh + le relay socket.io de Mbote (jamais déployé : relays Nostr).
const TRANSPORT_INTERNET_LABEL = "relais internet Mbote" as const;
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
  const res = await fetch(`/api/users?${q.toString()}`, {
    // F-32 : garde-fou anti-fetch suspendu
    signal: AbortSignal.timeout(15_000),
  });
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
  const { t, tp, fmt } = useI18n();
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
          ? t("network.followFail", { name: vars.target.nickname })
          : t("network.unfollowFail", { name: vars.target.nickname }),
        { description: error instanceof Error ? error.message : t("network.errorUnknown") }
      );
    },
    onSuccess: (_data, vars) => {
      toast.success(
        vars.action === "follow"
          ? t("network.followOk", { name: vars.target.nickname })
          : t("network.unfollowOk", { name: vars.target.nickname }),
        { description: t("network.proofOk") }
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
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <UsersRound className="size-4 text-primary" aria-hidden="true" />
          {t("network.followTitle")}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("network.followSubtitle")}</p>

        <div className="mt-3">
          {!identityReady || users.isLoading ? (
            <div className="space-y-2" aria-label={t("network.followLoading")}>
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
              <p className="text-sm font-semibold">{t("network.followNeedIdentity")}</p>
              <p className="text-xs text-muted-foreground">
                {t("network.followNeedIdentityHint")}
              </p>
            </div>
          ) : users.isError ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-5 text-center">
              <p className="text-xs text-muted-foreground">
                {t("network.followLoadError")}
                {users.error instanceof Error && users.error.message
                  ? ` — ${users.error.message}`
                  : ""}
                .
              </p>
              <Button size="sm" variant="outline" onClick={() => void users.refetch()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : (users.data?.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
              {t("network.followEmpty")}
            </p>
          ) : (
            <ul
              className="scrollbar-thin max-h-96 space-y-2 overflow-y-auto pr-1"
              aria-label={t("network.followTitle")}
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
                          {t("network.demoBadge")}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {u.bio?.trim() ? `${u.bio.trim()} · ` : ""}
                      {tp("network.postCount", postCount(u), {
                        count: fmt.fmtNumber(postCount(u)),
                      })}
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
                      u.isFollowing
                        ? t("network.unfollowAria", { name: u.nickname })
                        : t("network.followAria", { name: u.nickname })
                    }
                  >
                    {pendingPub === u.pubkey ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : u.isFollowing ? (
                      <UserCheck className="size-3.5" aria-hidden="true" />
                    ) : (
                      <UserPlus className="size-3.5" aria-hidden="true" />
                    )}
                    {u.isFollowing ? t("network.following") : t("network.follow")}
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
  { icon: Hourglass, value: "7", labelKey: "network.statTtlLabel", subKey: "network.statTtlSub" },
  { icon: Mail, value: "4 → 8", labelKey: "network.statCopiesLabel", subKey: "network.statCopiesSub" },
  { icon: Archive, value: "3", labelKey: "network.statCouriersLabel", subKey: "network.statCouriersSub" },
  { icon: Waves, value: "6 h", labelKey: "network.statGossipLabel", subKey: "network.statGossipSub" },
];

export function NetworkView() {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold tracking-tight">{t("network.title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("network.subtitle")}</p>
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
        {PROTOCOL_STATS.map(({ icon: Icon, value, labelKey, subKey }) => (
          <Card key={labelKey}>
            <CardContent className="p-4">
              <Icon className="size-4 text-primary" aria-hidden="true" />
              <p className="mt-2 font-mono text-xl font-bold text-primary">{value}</p>
              <p className="text-xs font-medium">{t(labelKey)}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t(subKey)}</p>
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
                  {t("network.archiTitle")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                {t("network.archiBodyA")} <strong>mesh Bluetooth LE</strong>{" "}
                {t("network.archiBodyB")} <strong>{TRANSPORT_INTERNET_LABEL}</strong>{" "}
                {t("network.archiBodyC")}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="crypto">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                  {t("network.cryptoTitle")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                {t("network.cryptoBodyA")} <strong>Noise XX</strong>
                {t("network.cryptoBodyB")} <strong>Noise X</strong> {t("network.cryptoBodyC")}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="store">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Archive className="size-4 text-primary" aria-hidden="true" />
                  {t("network.storeTitle")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                {t("network.storeBodyA")} <strong>{t("network.storeCouriers")}</strong>{" "}
                {t("network.storeBodyB")} {TRANSPORT_INTERNET_LABEL} {t("network.storeBodyC")}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="geohash">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <MapPinned className="size-4 text-primary" aria-hidden="true" />
                  {t("network.geohashTitle")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                {t("network.geohashBody")}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="meta">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Eye className="size-4 text-amber-500" aria-hidden="true" />
                  {t("network.metaTitle")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                {t("network.metaBody")}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
