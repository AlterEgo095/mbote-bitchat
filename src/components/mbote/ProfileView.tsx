"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  Bell,
  Check,
  Copy,
  Flame,
  Languages,
  Loader2,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { apiFetchFeed, apiGetUser, apiUpsertIdentity, describeApiError } from "@/lib/mbote/api";
// D2 — réputation : libellés des tiers extraits dans le catalogue i18n
// (profile.reputation.*) — miroir exact des textes FR de sybil.ts (vague G).
import { shortKey, signPayload } from "@/lib/mbote/crypto";
import { identityProofMessage } from "@/lib/mbote/proof";
import {
  isPushSupported,
  notificationPermission,
  subscribePush,
  unsubscribePush,
} from "@/lib/mbote/push-client";
import type { StoredIdentity } from "@/lib/mbote/identity";
import { isLocale, useI18n } from "@/lib/mbote/i18n";
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
  // G (i18n) : hook UNIQUE du composant — la carte Préférences (prefs.*) est
  // déjà câblée ; l'extraction des autres textes réutilise ce même `t`.
  const { locale, setLocale, t, tp, fmt } = useI18n();
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

  // ADM Étape 6 — avertissements de modération adressés à CETTE identité
  // (visible dans le profil — directive : « pas de DM pour rester E2EE »).
  // Lecture par preuve de possession courte durée (même mécanique F-07 que
  // la lecture DM) : impossible de lire les avertissements d'autrui.
  const warnings = useQuery({
    queryKey: ["warnings", myPub],
    queryFn: async () => {
      const ts = Date.now();
      const signature = await signPayload(
        identity.signPriv,
        `${myPub}|warnings-read|${ts}`
      );
      const res = await fetch(
        `/api/moderation/warnings?me=${encodeURIComponent(myPub)}&ts=${ts}&signature=${encodeURIComponent(signature)}`
      );
      if (!res.ok) throw new Error("avertissements indisponibles");
      return (await res.json()) as {
        warnings: Array<{ id: string; category: string; note: string; createdAt: string }>;
      };
    },
    refetchInterval: forceOffline ? false : 30000,
    retry: 1,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [nickname, setNickname] = useState(identity.nickname);
  const [bio, setBio] = useState(identity.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // ── C1 : notifications push (knock sans contenu) ──
  const pushSupported = isPushSupported();
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">(
    notificationPermission()
  );
  // l'ÉTAT OPÉRATOIRE est la SUBSCRIPTION (pas la permission seule : un
  // navigateur peut avoir GRANTÉ la permission sans abonnement actif —
  // re-install PWA, purge serveur — le bouton doit alors proposer Activer)
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNotice, setPushNotice] = useState<string | null>(null);
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [vapidState, setVapidState] = useState<"loading" | "ok" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    setPushPermission(notificationPermission());
    (async () => {
      try {
        const reg = await navigator.serviceWorker?.getRegistration("/");
        const sub = await reg?.pushManager.getSubscription();
        if (!cancelled) setPushSubscribed(!!sub);
      } catch {
        if (!cancelled) setPushSubscribed(false);
      }
    })();
    fetch("/api/push/config")
      .then(async (r) => {
        if (r.status === 503) {
          if (!cancelled) setVapidState("unavailable");
          return null;
        }
        if (!r.ok) {
          if (!cancelled) setVapidState("unavailable");
          return null;
        }
        const body = (await r.json()) as { publicKey?: string };
        if (!cancelled) {
          setVapidKey(body.publicKey ?? null);
          setVapidState(body.publicKey ? "ok" : "unavailable");
        }
        return null;
      })
      .catch(() => {
        if (!cancelled) setVapidState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** ACTIVER — invariant §1.8 : le bouton attend le 2xx du serveur (et le
   *  subscribe navigateur) avant d'afficher « activées ». Rien d'optimiste. */
  const activerPush = async () => {
    if (!vapidKey || pushBusy) return;
    setPushBusy(true);
    setPushNotice(null);
    try {
      const res = await subscribePush({
        me: myPub,
        sign: (payload) => signPayload(identity.signPriv, payload),
        vapidPublicKey: vapidKey,
        userAgent: navigator.userAgent,
      });
      if (res.ok) {
        setPushPermission(notificationPermission());
        setPushSubscribed(true);
        setPushNotice(t("profile.push.enabledNotice"));
      } else {
        // l'état suit le RÉEL : ni permission ni registration — refetch serveur
        setPushPermission(notificationPermission());
        setPushNotice(res.reason);
      }
    } catch (e) {
      setPushNotice(e instanceof Error ? e.message : t("profile.push.enableFailed"));
    } finally {
      setPushBusy(false);
    }
  };

  /** DÉSACTIVER — même invariant. */
  const desactiverPush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushNotice(null);
    try {
      await unsubscribePush({ me: myPub, sign: (payload) => signPayload(identity.signPriv, payload) });
      setPushPermission(notificationPermission());
      setPushSubscribed(false);
      setPushNotice(t("profile.push.disabledNotice"));
    } finally {
      setPushBusy(false);
    }
  };

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
        identity.signPriv,
        identityProofMessage({ ...payload, ts })
      );
      await apiUpsertIdentity({ ...payload, ts, signature });
      await qc.invalidateQueries({ queryKey: ["me", myPub] });
      await qc.invalidateQueries({ queryKey: ["feed"] });
      toast.success(t("profile.toasts.updated"));
      setEditOpen(false);
    } catch (e) {
      toast.error(t("profile.toasts.updateFailed"), {
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
      toast.success(t("profile.fingerprintCopied"));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("profile.copyFailed"));
    }
  };

  return (
    <div className="space-y-5">
      {/* F #35 — échec de chargement du profil distant : honnête (les données
          locales restent affichées, l'état réseau est dit) */}
      {me.isError && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          {t("profile.remoteUnavailable", { error: describeApiError(me.error) })}
        </div>
      )}
      {/* F #35 — échec de chargement des avertissements : rendu (avant : jeté
          en silence — « avertissements indisponibles » jamais affiché) */}
      {warnings.isError && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {t("profile.warningsUnavailable", { error: describeApiError(warnings.error) })}
        </div>
      )}
      {/* ADM Étape 6 — avertissements de modération (visibles du titulaire seul) */}
      {warnings.data && warnings.data.warnings.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" aria-hidden="true" />
              <h2 className="text-sm font-semibold">
                {tp("profile.warnings.title", warnings.data.warnings.length)}
              </h2>
            </div>
            <ul className="mt-3 space-y-2">
              {warnings.data.warnings.map((w) => (
                <li
                  key={w.id}
                  className="rounded-lg border border-amber-200 bg-amber-50 p-3"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                    {w.category}
                  </p>
                  <p className="mt-1 text-sm text-amber-950">{w.note}</p>
                  <p className="mt-1 text-[11px] text-amber-800/70">
                    {fmt.fmtDateTime.format(new Date(w.createdAt))}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("profile.warnings.privateNote")}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Carte d'identité */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <MboteAvatar pubkey={myPub} nickname={user?.nickname ?? identity.nickname} size={72} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold">
                  {user?.nickname ?? identity.nickname}
                </h1>
                <span
                  title={t("profile.identityTitle")}
                  className="inline-flex items-center gap-1 text-[11px] text-primary"
                >
                  <BadgeCheck className="size-4" aria-hidden="true" />
                  {t("profile.keysVerified")}
                </span>
                {user?.quota && (
                  <Badge
                    data-testid="reputation-badge"
                    variant={
                      user.quota.tier === "exemplary"
                        ? "default"
                        : user.quota.tier === "negative"
                          ? "destructive"
                          : "secondary"
                    }
                    className={user.quota.tier === "established" ? "bg-emerald-600 text-white" : undefined}
                    title={t("profile.reputationScoreTitle", {
                      score: fmt.fmtNumber(user.quota.reputationScore),
                    })}
                  >
                    {t(`profile.reputation.${user.quota.tier}`)}
                  </Badge>
                )}
              </div>

              <p className="mt-1 text-sm text-muted-foreground">
                {user?.bio || identity.bio || t("profile.noBio")}
              </p>

              <button
                onClick={copyPubkey}
                className="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t("profile.copyFingerprint", { key: shortKey(myPub, 14) })}
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
                    {fmt.fmtNumber(user?._count?.posts ?? 0)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{t("profile.counters.posts")}</p>
                </div>
                <div className="rounded-lg border bg-background/50 p-2">
                  <p className="font-mono text-lg font-bold text-primary">
                    {fmt.fmtNumber(user?._count?.followers ?? 0)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{t("profile.counters.followers")}</p>
                </div>
                <div className="rounded-lg border bg-background/50 p-2">
                  <p className="font-mono text-lg font-bold text-primary">
                    {fmt.fmtNumber(user?._count?.following ?? 0)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{t("profile.counters.following")}</p>
                </div>
              </div>

              {user?.quota && (
                <div
                  data-testid="quota-counters"
                  className="mt-2 rounded-lg border border-dashed bg-muted/30 p-2 text-[11px] text-muted-foreground"
                >
                  <span data-testid="quota-posts" className="font-medium text-foreground">
                    {user.quota.posts.remaining === null
                      ? t("profile.quota.postsUnlimited")
                      : t("profile.quota.postsRemaining", {
                          remaining: fmt.fmtNumber(user.quota.posts.remaining),
                          limit: fmt.fmtNumber(user.quota.posts.limit),
                        })}
                  </span>
                  <span className="mx-2" aria-hidden="true">
                    ·
                  </span>
                  <span data-testid="quota-dms" className="font-medium text-foreground">
                    {user.quota.dms.remaining == null
                      ? t("profile.quota.dmsUnlimited")
                      : t("profile.quota.dmsRemaining", {
                          remaining: fmt.fmtNumber(user.quota.dms.remaining),
                          limit: fmt.fmtNumber(user.quota.dms.limit ?? 0),
                        })}
                  </span>
                  {user.flaggedCount ? (
                    <span className="mt-1 block text-amber-600">
                      {tp("profile.quota.flagged", user.flaggedCount)}
                    </span>
                  ) : null}
                </div>
              )}

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
                  {t("profile.editButton")}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Mes publications */}
      <div>
        <h2 className="mb-2.5 text-sm font-bold uppercase tracking-wide text-muted-foreground">
          {t("profile.postsTitle")}
        </h2>
        {myPosts.isError ? (
          // F #35 — échec de chargement de l'historique : plus de faux « rien
          // publié » ; bannière d'erreur + Réessayer (pattern FeedView #15)
          <Card className="border-red-300 bg-red-50">
            <CardContent className="flex flex-col items-start gap-3 p-5" role="alert">
              <p className="text-sm font-semibold text-red-900">
                {t("profile.postsError")}
              </p>
              <p className="text-sm text-red-800">{describeApiError(myPosts.error)}</p>
              <Button size="sm" className="h-11 bg-red-700 text-white hover:bg-red-800" onClick={() => void myPosts.refetch()}>
                {t("common.retry")}
              </Button>
            </CardContent>
          </Card>
        ) : myPosts.isLoading ? (
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
              {t("profile.postsEmpty")}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {(myPosts.data?.posts ?? []).map((p) => (
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

      {/* ── C1 : Notifications push (knock sans contenu) ── */}
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Bell className="size-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("profile.push.title")}</p>
            <p className="text-xs text-muted-foreground">
              {t("profile.push.description")}
            </p>
            {pushNotice && (
              <p
                className="mt-1 text-xs font-medium text-foreground"
                role="status"
                data-testid="push-notice"
              >
                {pushNotice}
              </p>
            )}
            {!pushSupported && (
              <p className="mt-1 text-xs" data-testid="push-unsupported">
                {t("profile.push.unsupported")}
              </p>
            )}
            {pushSupported && vapidState === "unavailable" && (
              <p className="mt-1 text-xs" data-testid="push-unavailable">
                {t("profile.push.unavailable")}
              </p>
            )}
            {pushSupported && pushPermission === "denied" && (
              <p className="mt-1 text-xs text-destructive" data-testid="push-denied">
                {t("profile.push.denied")}
              </p>
            )}
          </div>
          {pushSupported && vapidState === "ok" && pushSubscribed !== null && (
            pushSubscribed ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                onClick={() => void desactiverPush()}
                disabled={pushBusy}
                data-testid="btn-push-disable"
              >
                {pushBusy ? t("profile.push.busy") : t("profile.push.disable")}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-9 shrink-0"
                onClick={() => void activerPush()}
                disabled={pushBusy}
                data-testid="btn-push-enable"
              >
                {pushBusy ? t("profile.push.busyServer") : t("profile.push.enable")}
              </Button>
            )
          )}
        </CardContent>
      </Card>

      {/* ── G : Préférences — sélecteur de langue (i18n maison) ── */}
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Languages className="size-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("prefs.title")}</p>
            <p className="text-xs text-muted-foreground">{t("prefs.hint")}</p>
          </div>
          <Select
            value={locale}
            onValueChange={(v) => {
              if (isLocale(v)) setLocale(v);
            }}
          >
            <SelectTrigger
              className="h-9 w-[140px] shrink-0"
              aria-label={t("prefs.language")}
              data-testid="lang-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fr">{t("prefs.langFr")}</SelectItem>
              <SelectItem value="en">{t("prefs.langEn")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Zone de danger */}
      <Card className="border-destructive/40">
        <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Flame className="size-5 text-destructive" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("profile.wipe.title")}</p>
            <p className="text-xs text-muted-foreground">
              {t("profile.wipe.description")}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="h-9 shrink-0">
                <Flame className="size-4" aria-hidden="true" />
                {t("profile.wipe.trigger")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                  {t("profile.wipe.confirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("profile.wipe.confirmDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onPanicWipe}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  <Flame className="size-4" aria-hidden="true" />
                  {t("profile.wipe.confirmAction")}
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
            <DialogTitle>{t("profile.edit.title")}</DialogTitle>
            <DialogDescription>{t("profile.edit.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-nick">{t("profile.edit.nickname")}</Label>
              <Input
                id="edit-nick"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={32}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-bio">{t("profile.edit.bio")}</Label>
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
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
