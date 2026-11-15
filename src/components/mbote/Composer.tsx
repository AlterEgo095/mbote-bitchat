"use client";

import { useState } from "react";
import { Loader2, Mail, MapPin, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_POST_LENGTH } from "@/lib/mbote/constants";
import { describeApiError } from "@/lib/mbote/api";
import { precisionLabel } from "@/lib/mbote/geohash";
import { useI18n } from "@/lib/mbote/i18n";

interface ComposerProps {
  canPost: boolean;
  channelGeohash?: string | null;
  channelPrecision?: number | null;
  channelLabel?: string | null;
  forceOffline: boolean;
  submitting: boolean;
  /** texte initial (partage PWA share_target, brouillon) — monté une seule fois */
  initialText?: string;
  onSubmit: (content: string) => Promise<void>;
}

export function Composer({
  canPost,
  channelGeohash,
  channelPrecision,
  channelLabel,
  forceOffline,
  submitting,
  initialText,
  onSubmit,
}: ComposerProps) {
  const { t, fmt } = useI18n();
  const [text, setText] = useState(initialText ?? "");
  const remaining = MAX_POST_LENGTH - text.length;
  const valid = text.trim().length > 0 && remaining >= 0;

  const submit = async () => {
    if (!valid || submitting) return;
    const content = text.trim();
    setText("");
    try {
      await onSubmit(content);
    } catch (e) {
      // remet le texte si échec pour éviter la perte
      setText(content);
      // D2 : le message SERVEUR est affiché tel quel — plafond de réputation
      // atteint (« … Le score de réputation augmente avec la participation de
      // qualité. »), suspension, etc. Un toast explicite vaut mieux qu'un
      // échec muet (directive D2 : message clair si plafond atteint).
      // D2 : la CAUSE SERVEUR est conservée si actionnable (FR), sinon le
      // mapping central du statut (F #23 — plus de « HTTP 429 » brut).
      toast.error(describeApiError(e), {
        duration: 6000,
      });
    }
  };

  return (
    <div
      className={`rounded-xl border bg-card p-4 ${
        forceOffline && canPost ? "border-amber-500/40" : "border-border"
      }`}
      aria-label={t("composer.aria")}
    >
      {channelGeohash && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="gap-1 border-primary/40 bg-primary/5 font-mono text-[11px] text-primary"
          >
            <MapPin className="size-3" aria-hidden="true" />
            {channelGeohash}
          </Badge>
          {channelLabel && (
            <span className="text-xs text-muted-foreground">
              {channelLabel}
              {channelPrecision != null && ` · ${precisionLabel(channelPrecision).toLowerCase()}`}
            </span>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
          placeholder={
            channelGeohash
              ? t("composer.placeholderChannel", { geohash: channelGeohash })
              : t("composer.placeholder")
          }
          rows={3}
          maxLength={MAX_POST_LENGTH}
          disabled={!canPost}
          className="min-h-[64px] resize-none text-sm"
          aria-label={t("composer.textareaAria")}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {forceOffline && canPost ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
              <Mail className="size-3.5" aria-hidden="true" />
              {t("composer.meshHint")}
            </span>
          ) : (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              {t("composer.ctrlHint")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-[11px] ${
              remaining < 50 ? "text-amber-500" : "text-muted-foreground"
            }`}
            aria-live="polite"
          >
            {fmt.fmtNumber(remaining)}
          </span>
          <Button onClick={submit} disabled={!canPost || !valid || submitting} className="h-9">
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : forceOffline && canPost ? (
              <Mail className="size-4" aria-hidden="true" />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
            {forceOffline && canPost ? t("composer.queue") : t("composer.publish")}
          </Button>
        </div>
      </div>
    </div>
  );
}
