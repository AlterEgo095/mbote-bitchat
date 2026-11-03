"use client";

import { keyHue } from "@/lib/mbote/crypto";
import { cn } from "@/lib/utils";

/** Avatar déterministe : dégradé dérivé de la clé publique (pas d'image à charger) */
export function MboteAvatar({
  pubkey,
  nickname,
  size = 40,
  className,
}: {
  pubkey: string;
  nickname: string;
  size?: number;
  className?: string;
}) {
  const hue = keyHue(pubkey);
  const initials = (nickname || "??").slice(0, 2).toUpperCase();
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white/95 shadow-inner",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, size * 0.38),
        background: `linear-gradient(135deg, hsl(${hue} 62% 44%), hsl(${(hue + 48) % 360} 70% 30%))`,
      }}
    >
      {initials}
    </div>
  );
}
