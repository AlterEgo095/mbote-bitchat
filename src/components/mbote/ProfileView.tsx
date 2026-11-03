"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Copy,
  Flame,
  Loader2,
  PenLine,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetchFeed, apiGetUser, apiUpsertIdentity } from "@/lib/mbote/api";
import { shortKey, signPayload } from "@/lib/mbote/crypto";
import { identityProofMessage } from "@/lib/mbote/proof";
import type { StoredIdentity } from "@/lib/mbote/identity";
import { MboteAvatar } from "./Avatar";
import { PostCard } from "./PostCard";

interface ProfileViewProps {
  identity: StoredIdentity;
  forceOffline: boolean;
  onLike: (postId: string, liked: boolean) => void;
  onReply: (parentId: string, content: string) => Promise<void>;
  onPanicWipe: () => void;
}

export function ProfileView({
  identity,
  forceOffline,
  onLike,
  onReply,
  onPanicWipe,
}: ProfileViewProps) {
  const qc = useQueryClient();
  const myPub = identity.pubkey;

  const me = useQuery({
    queryKey: ["me", myPub],
    queryFn: () => apiGetUser(myPub),
    refetchInterval: 15000,
  });

  const myPosts = useQuery({
    queryKey: ["feed", "user", myPub, myPub],
    queryFn: () => apiFetchFeed({ scope: "user", authorPub: myPub, myPub }),
    refetchInterval: forceOffline ? false : 6000,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [nickname, setNickname] = useState(identity.nickname);
  const [bio, setBio] = useState(identity.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const user = me.data?.user;

  const saveProfile = async () => {
    setSaving(true);
    try {
      // F-01 : preuve de possession — la mise à jour du profil est signée par
      // la clé privée locale, vérifiée par le serveur (anti-usurpation).
      const ts = Date.now();
      const payload = {
        pubkey: myPub,
        nickname: nickname.trim(),
        bio: bio.trim(),
        ecdhPub: identity.ecdhPub,
      };
      const signature = await signPayload(
        identity.signPrivJwk,
        identityProofMessage({ ...payload, ts })
      );
      await apiUpsertIdentity({ ...payload, ts, signature });
      await qc.invalidateQueries({ queryKey: ["me", myPub] });
      await qc.invalidateQueries({ queryKey: ["feed"] });
      toast.success("Profil mis à jour");
      setEditOpen(false);
    } catch (e) {
      toast.error("Échec de mise à jour", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const copyPubkey = async () => {
    try {
      await navigator.clipboard.writeText(myPub);
      setCopied(true);
      toast.success("Empreinte copiée");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copie impossible");
    }
  };

  return (
    <div className="space-y-5">
      {/* Carte d'identité */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <MboteAvatar pubkey={myPub} nickname={user?.nickname ?? identity.nickname} size={72} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold">
                  {user?.nickname ?? identity.nickname}
                </h2>
                <span
                  title="Identité = paire de clés locale (ECDSA P-256)"
                  className="inline-flex items-center gap-1 text-[11px] text-primary"
                >
                  <BadgeCheck className="size-4" aria-hidden="true" />
                  clés locales vérifiées
                </span>
              </div>

              <p className="mt-1 text-sm text-muted-foreground">
                {user?.bio || identity.bio || "Aucune bio pour l'instant."}
              </p>

              <button
                onClick={copyPubkey}
                className="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Copier l'empreinte de la clé publique"
              >
                {copied ? (
                  <Check className="size-3 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <Copy className="size-3 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">{shortKey(myPub, 14)}</span>
              </button>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg border bg-background/50 p-2">
                  <p className="font-mono text-lg font-bold text-primary">
                    {user?._count?.posts ?? 0}
                  </p>
                  <p className="text-[10px] text-muted-foreground">publications</p>
                </div>
                <div className="rounded-lg border bg-background/50 p-2">
                  <p className="font-mono text-lg font-bold text-primary">
                    {user?._count?.followers ?? 0}
                  </p>
                  <p className="text-[10px] text-muted-foreground">abonnés</p>
                </div>
                <div className="rounded-lg border bg-background/50 p-2">
                  <p className="font-mono text-lg font-bold text-primary">
                    {user?._count?.following ?? 0}
                  </p>
                  <p className="text-[10px] text-muted-foreground">abonnements</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setNickname(user?.nickname ?? identity.nickname);
                    setBio(user?.bio ?? identity.bio ?? "");
                    setEditOpen(true);
                  }}
                  className="h-9"
                >
                  <PenLine className="size-3.5" aria-hidden="true" />
                  Modifier le profil
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Mes publications */}
      <div>
        <h3 className="mb-2.5 text-sm font-bold uppercase tracking-wide text-muted-foreground">
          Mes publications
        </h3>
        {myPosts.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="mt-2 h-4 w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (myPosts.data?.posts.length ?? 0) === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Rien publié pour l&apos;instant — ton historique vit ici, signé par ta clé.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {myPosts.data!.posts.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                myPub={myPub}
                forceOffline={forceOffline}
                onLike={onLike}
                onReply={onReply}
              />
            ))}
          </div>
        )}
      </div>

      {/* Zone de danger */}
      <Card className="border-destructive/40">
        <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Flame className="size-5 text-destructive" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Panic wipe</p>
            <p className="text-xs text-muted-foreground">
              Efface instantanément les clés privées, la file locale et l&apos;état de
              l&apos;application — comme le triple-tap de BitChat. Irréversible : ta clé
              publique ne pourra plus être prouvée.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="h-9 shrink-0">
                <Flame className="size-4" aria-hidden="true" />
                Tout effacer
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                  Confirmer le panic wipe ?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Clés privées, identité, file « courrier » et préférences locales seront
                  détruites sur cet appareil. Tes publications déjà diffusées sur le serveur
                  resteront (publiques par nature) — mais plus personne ne pourra prouver qu&apos;il
                  détient encore ta clé.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Annuler</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onPanicWipe}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  <Flame className="size-4" aria-hidden="true" />
                  Effacer définitivement
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {/* Dialogue édition */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Modifier le profil</DialogTitle>
            <DialogDescription>
              Publiquement associé à ton empreinte de clé — rien de plus.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-nick">Pseudo</Label>
              <Input
                id="edit-nick"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={32}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-bio">Bio</Label>
              <Textarea
                id="edit-bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                maxLength={240}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={saveProfile} disabled={saving || nickname.trim().length < 2}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
