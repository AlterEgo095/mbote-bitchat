"use client";

import { useState } from "react";
import { Loader2, Mail, MapPin, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_POST_LENGTH } from "@/lib/mbote/constants";
import { precisionLabel } from "@/lib/mbote/geohash";

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
  const [text, setText] = useState(initialText ?? "");
  const remaining = MAX_POST_LENGTH - text.length;
  const valid = text.trim().length > 0 && remaining >= 0;

  const submit = async () => {
    if (!valid || submitting) return;
    const content = text.trim();
    setText("");
    try {
      await onSubmit(content);
    } catch {
      // remet le texte si échec pour éviter la perte
      setText(content);
    }
  };

  return (
    <div
      className={`rounded-xl border bg-card p-4 ${
        forceOffline && canPost ? "border-amber-500/40" : "border-border"
      }`}
      aria-label="Composer une publication"
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
              ? `Écris dans le canal ${channelGeohash}…`
              : "Quoi de neuf ? Ton message sera signé sur ton appareil…"
          }
          rows={3}
          maxLength={MAX_POST_LENGTH}
          disabled={!canPost}
          className="min-h-[64px] resize-none text-sm"
          aria-label="Message à publier"
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {forceOffline && canPost ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
              <Mail className="size-3.5" aria-hidden="true" />
              mode mesh : mise en file locale (courrier)
            </span>
          ) : (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              Ctrl+Entrée pour publier · signature ECDSA locale
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
            {remaining}
          </span>
          <Button onClick={submit} disabled={!canPost || !valid || submitting} className="h-9">
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : forceOffline && canPost ? (
              <Mail className="size-4" aria-hidden="true" />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
            {forceOffline && canPost ? "Mettre en file" : "Publier"}
          </Button>
        </div>
      </div>
    </div>
  );
}
