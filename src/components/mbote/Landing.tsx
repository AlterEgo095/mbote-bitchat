"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Landing — vitrine publique de Mbote Mesh (route « / »)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Toutes les chaînes visibles passent par useI18n() (catalogues fr/en,
 *    clés « landing.* » présentes dans locales/fr.json ET locales/en.json).
 *  - Zéro nouvelle dépendance : Tailwind pur + lucide-react + Button shadcn.
 *  - Accent unique : --primary (émeraude). Pas d'indigo, pas de bleu.
 *  - Footer collant : racine min-h-screen flex flex-col + footer mt-auto.
 *  - Accessibilité : header/main/section/footer sémantiques, cibles ≥ 44px,
 *    aria-live pour la détection d'OS, focus-visible via Button shadcn.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  useEffect,
  useState,
  type MouseEvent,
} from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Apple,
  ArrowRight,
  Clock,
  Code2,
  KeyRound,
  MessageCircle,
  Mic,
  Network,
  PhoneCall,
  Scale,
  ShieldCheck,
  Smartphone,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/mbote/i18n";

const DOWNLOAD_APK = "/downloads/mbote-latest.apk";
const CONTACT_EMAIL = "admin@mbotemesh.aenews.online";
const GITHUB_URL = "https://github.com/AlterEgo095/mbote-bitchat";
type DetectedPlatform = "android" | "ios" | null;

interface IconKeyItem {
  Icon: LucideIcon;
  key: string;
}

interface FeatureItem {
  Icon: LucideIcon;
  titleKey: string;
  descKey: string;
}

const TRUST_ITEMS: readonly IconKeyItem[] = [
  { Icon: ShieldCheck, key: "landing.trust.e2ee" },
  { Icon: Code2, key: "landing.trust.openSource" },
  { Icon: XCircle, key: "landing.trust.noAds" },
  { Icon: KeyRound, key: "landing.trust.noNumber" },
];

const FEATURES: readonly FeatureItem[] = [
  {
    Icon: PhoneCall,
    titleKey: "landing.features.callsTitle",
    descKey: "landing.features.callsDesc",
  },
  {
    Icon: Network,
    titleKey: "landing.features.groupsTitle",
    descKey: "landing.features.groupsDesc",
  },
  {
    Icon: Mic,
    titleKey: "landing.features.mediaTitle",
    descKey: "landing.features.mediaDesc",
  },
  {
    Icon: Scale,
    titleKey: "landing.features.govTitle",
    descKey: "landing.features.govDesc",
  },
];

const STEP_KEYS = ["landing.steps.one", "landing.steps.two", "landing.steps.three"] as const;

export function Landing() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<DetectedPlatform>(null);

  // Détection OS — une fois après montage, dans une microtask (même pattern
  // que i18n.tsx : react-hooks/set-state-in-effect n'aime pas le setState
  // synchrone dans le corps d'effet).
  useEffect(() => {
    queueMicrotask(() => {
      const ua = navigator.userAgent.toLowerCase();
      const android = ua.includes("android");
      const ios =
        /iphone|ipad|ipod/.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      setPlatform(android ? "android" : ios ? "ios" : null);
    });
  }, []);

  /** Ancre accessible : défilement doux sauf prefers-reduced-motion. */
  const smoothScrollToDownload = (e: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById("telecharger");
    if (!target) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  const detectedText =
    platform === "android"
      ? t("landing.download.detectedAndroid")
      : platform === "ios"
        ? t("landing.download.detectedIos")
        : "";

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* ─────────────── header sticky ─────────────── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
        <nav
          aria-label={t("nav.mainAria")}
          className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6"
        >
          <Link
            href="/"
            aria-label={t("landing.header.logoAlt")}
            className="flex min-h-[44px] items-center gap-2.5"
          >
            <Image
              src="/mbote/logo.webp"
              alt={t("landing.header.logoAlt")}
              width={32}
              height={32}
              className="h-8 w-8 rounded"
            />
            <span className="text-base font-semibold tracking-tight">
              {t("landing.brand")}
            </span>
          </Link>
          <Button asChild className="h-11 px-4" aria-label={t("landing.header.openApp")}>
            <Link href="/chat">{t("landing.header.openApp")}</Link>
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        {/* ─────────────── hero ─────────────── */}
        <section aria-labelledby="landing-hero-title">
          <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-10 sm:px-6 sm:pb-14 sm:pt-16 lg:pt-20">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                {t("landing.hero.badgeE2ee")}
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                {t("landing.hero.badgeMesh")}
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                {t("landing.hero.badgeNoAccount")}
              </span>
            </div>

            <h1
              id="landing-hero-title"
              className="mt-5 max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl"
            >
              {t("landing.hero.title")}
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg sm:leading-relaxed">
              {t("landing.hero.subtitle")}
            </p>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="h-12 min-w-[44px] px-6 text-base">
                <Link href="/chat">
                  <MessageCircle className="size-5" aria-hidden="true" />
                  {t("landing.hero.ctaPrimary")}
                  <ArrowRight className="size-5" aria-hidden="true" />
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-12 min-w-[44px] px-6 text-base"
              >
                <a href="#telecharger" onClick={smoothScrollToDownload}>
                  {t("landing.hero.ctaSecondary")}
                </a>
              </Button>
            </div>

            <div className="mt-10 sm:mt-14">
              <Image
                src="/mbote/hero.webp"
                alt={t("landing.hero.imageAlt")}
                width={1344}
                height={768}
                priority
                sizes="(max-width: 768px) 100vw, 1024px"
                className="aspect-video w-full rounded-2xl border border-border/60 object-cover shadow"
              />
            </div>
          </div>
        </section>

        {/* ─────────────── bandeau de confiance ─────────────── */}
        <section
          aria-label={t("landing.trust.aria")}
          className="border-y border-border/60 bg-card/40"
        >
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-6 gap-y-4 px-4 py-8 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {TRUST_ITEMS.map(({ Icon, key }) => (
              <div key={key} className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="text-sm font-medium">{t(key)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ─────────────── fonctionnalités ─────────────── */}
        <section id="features" aria-labelledby="landing-features-title">
          <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
            <h2
              id="landing-features-title"
              className="max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("landing.features.title")}
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
              {FEATURES.map(({ Icon, titleKey, descKey }) => (
                <article
                  key={titleKey}
                  className="rounded-xl border border-border/60 bg-card p-6 transition-colors"
                >
                  <span className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold">{t(titleKey)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {t(descKey)}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─────────────── téléchargement ─────────────── */}
        <section id="telecharger" aria-labelledby="landing-download-title" className="scroll-mt-20">
          <div className="mx-auto w-full max-w-6xl px-4 pb-14 sm:px-6 sm:pb-20">
            <h2
              id="landing-download-title"
              className="max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("landing.download.title")}
            </h2>
            <p className="mt-3 max-w-2xl text-base text-muted-foreground">
              {t("landing.download.subtitle")}
            </p>

            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
              {/* Android */}
              <article
                className={cn(
                  "rounded-xl border border-border/60 bg-card p-6 transition-opacity",
                  platform === "android" && "ring-2 ring-primary",
                  platform === "ios" && "opacity-70"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Smartphone className="size-5" aria-hidden="true" />
                  </span>
                  {platform === "android" && (
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-primary/30">
                      {t("landing.download.recommended")}
                    </span>
                  )}
                </div>
                <h3 className="mt-4 text-lg font-semibold">
                  {t("landing.download.androidTitle")}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {t("landing.download.androidDesc")}
                </p>
                <Button asChild className="mt-5 h-12 w-full sm:w-auto sm:min-w-[220px]">
                  <a href={DOWNLOAD_APK} download>
                    <Smartphone className="size-4" aria-hidden="true" />
                    {t("landing.download.androidCta")}
                  </a>
                </Button>
                <p className="mt-3 font-mono text-xs text-muted-foreground">
                  {t("landing.download.androidCaption")}
                </p>
              </article>

              {/* iOS */}
              <article
                className={cn(
                  "rounded-xl border border-border/60 bg-card p-6 transition-opacity",
                  platform === "ios" && "ring-2 ring-primary",
                  platform === "android" && "opacity-70"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Apple className="size-5" aria-hidden="true" />
                  </span>
                  {platform === "ios" && (
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-primary/30">
                      {t("landing.download.recommended")}
                    </span>
                  )}
                </div>
                <h3 className="mt-4 text-lg font-semibold">
                  {t("landing.download.iosTitle")}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {t("landing.download.iosDesc")}{" "}
                  <a
                    href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
                      t("landing.download.iosSubject")
                    )}`}
                    className="inline-flex min-h-[44px] items-center font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("landing.download.iosWaitlist")}
                  </a>
                </p>
                <Button
                  variant="outline"
                  disabled
                  className="mt-5 h-12 w-full sm:w-auto sm:min-w-[220px]"
                >
                  <Clock className="size-4" aria-hidden="true" />
                  {t("landing.download.iosCta")}
                </Button>
              </article>
            </div>

            {/* Annonce SR de la plateforme détectée */}
            <p aria-live="polite" className="sr-only">
              {detectedText}
            </p>
          </div>
        </section>

        {/* ─────────────── 3 étapes ─────────────── */}
        <section aria-labelledby="landing-steps-title">
          <div className="mx-auto w-full max-w-6xl px-4 pb-14 sm:px-6 sm:pb-20">
            <h2 id="landing-steps-title" className="sr-only">
              {t("landing.steps.title")}
            </h2>
            <ol className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
              {STEP_KEYS.map((key, i) => (
                <li
                  key={key}
                  className="flex items-start gap-3 rounded-xl border border-border/60 bg-card p-6"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {i + 1}
                  </span>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t(key)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      {/* ─────────────── footer (mt-auto → colle en bas) ─────────────── */}
      <footer className="mt-auto border-t border-border/60 bg-card/40">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5">
            <Image
              src="/mbote/logo.webp"
              alt={t("landing.header.logoAlt")}
              width={24}
              height={24}
              className="h-6 w-6 rounded"
            />
            <span className="text-sm font-medium">{t("landing.brand")}</span>
            <span className="text-xs text-muted-foreground">
              {t("landing.footer.rights")}
            </span>
          </div>
          <nav aria-label={t("landing.footer.navAria")} className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link
              href="/chat"
              className="inline-flex min-h-[44px] items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("landing.footer.openApp")}
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("landing.footer.source")}
            </a>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex min-h-[44px] items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("landing.footer.contact")}
            </a>
          </nav>
          <p className="text-xs text-muted-foreground">{t("landing.footer.tagline")}</p>
        </div>
      </footer>
    </div>
  );
}
