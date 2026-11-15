"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  i18n — internationalisation MAISON (vague G, Clarification 2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  CHOIX DOCUMENTÉ (C2) : next-intl@4.15.1 a été AUDITÉ — licence MIT
 *  (fichier package/LICENSE du tarball, copyright Jan Amann) → compatible.
 *  L'approche MAISON (React.Context + JSON, zéro dépendance) a néanmoins été
 *  retenue, pour quatre raisons argumentées :
 *    1. posture supply-chain D3 : zéro nouvelle dépendance runtime à auditer
 *       (leçon web-push MPL-2.0 appliquée au-delà de la licence : chaque
 *       paquet est un risque) ;
 *    2. SPA mono-route : le routage/middleware de next-intl est du poids mort
 *       ici (pas d'URL localisée) ;
 *    3. le livrable G exige EXPLICITEMENT Intl.DateTimeFormat /
 *       Intl.NumberFormat / Intl.PluralRules — cette implémentation les câble
 *       directement (pluriels CLDR réels, pas un mini-format maison) ;
 *    4. runtime ~120 lignes 100 % auditable pour une messagerie sécurisée.
 *
 *  PRIORITÉ DE LOCALE (documentée) :
 *    localStorage `mbote_locale` > préférence serveur (compte, /api/preferences)
 *    > détection navigateur (navigator.languages, première supportée) > « fr ».
 *  - setLocale écrit le LS IMMÉDIATEMENT puis pousse au serveur (signé ECDSA,
 *    best effort — l'i18n n'est pas critique : un échec réseau ne casse rien).
 *  - au démarrage SANS LS et AVEC identité : la préférence du compte est
 *    adoptée (roaming multi-appareils), sauf choix explicite de la session.
 *
 *  Catalogues : `locales/fr.json` + `locales/en.json` (racine repo, clés
 *  plates « domaine.clef »). Pluriels : clé « k.one » / « k.other » (CLDR via
 *  Intl.PluralRules — fr traite 0 et 1 comme « one », cf. select(0)).
 *  PANIC WIPE : `mbote_locale` fait partie de l'état local promis effacé.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import frCatalog from "../../../locales/fr.json";
import enCatalog from "../../../locales/en.json";
import { LS_LOCALE } from "./constants";
import { loadIdentity } from "./identity";
import { signPayload } from "./crypto";
import { preferencesProofMessage } from "./proof";

export type Locale = "fr" | "en";
export const SUPPORTED_LOCALES: Locale[] = ["fr", "en"];
export const DEFAULT_LOCALE: Locale = "fr";

/** Tags BCP-47 utilisés pour tous les Intl.* (dates, nombres, pluriels, RTF). */
export const LOCALE_TAGS: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

type Catalog = Record<string, string>;
const CATALOGS: Record<Locale, Catalog> = {
  fr: frCatalog as unknown as Catalog,
  en: enCatalog as unknown as Catalog,
};

export function isLocale(v: unknown): v is Locale {
  return v === "fr" || v === "en";
}

// ───────────────────────── traduction + interpolation ─────────────────────────

/** Interpolation « {nom} » — une variable absente reste littérale (diagnostique). */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, k: string) =>
    k in vars ? String(vars[k]) : match
  );
}

/** Traduction plate. Clé absente → clé retournée + warn (jamais silencieux). */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key];
  if (raw === undefined) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[i18n] clé absente « ${key} » (locale ${locale})`);
    }
    return key;
  }
  return interpolate(raw, vars);
}

/**
 * Pluriel CLDR réel : catégorie via Intl.PluralRules du TAG (fr-FR/en-US),
 * lookup `key.<catégorie>` puis repli `key.other`. Le compteur est injecté
 * comme variable {count} sauf vars explicites.
 */
export function translatePlural(
  locale: Locale,
  key: string,
  count: number,
  vars?: Record<string, string | number>
): string {
  const cat = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
  const category = new Intl.PluralRules(LOCALE_TAGS[locale]).select(count);
  const merged: Record<string, string | number> = { count, ...vars };
  const raw = cat[`${key}.${category}`] ?? cat[`${key}.other`];
  if (raw === undefined) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[i18n] clé plurielle absente « ${key}.${category} » (locale ${locale})`);
    }
    return interpolate(key, merged);
  }
  return interpolate(raw, merged);
}

// ───────────────────────── formats Intl (dates / nombres / relatif) ─────────────────────────

export interface I18nFormatters {
  /** tag BCP-47 courant (fr-FR / en-US) */
  tag: string;
  /** « 14 novembre 2026 » / « November 14, 2026 » */
  fmtDate: Intl.DateTimeFormat;
  /** « 14 nov. 2026, 09:30 » / « Nov 14, 2026, 09:30 » */
  fmtDateTime: Intl.DateTimeFormat;
  /** « 09:30 » */
  fmtTime: Intl.DateTimeFormat;
  /** séparateurs de milliers / décimales localisés — « 1 234 » / « 1,5 » */
  fmtNumber: (n: number) => string;
  /** « il y a 2 minutes » / « 2 minutes ago » (Intl.RelativeTimeFormat) */
  fmtRelative: (d: Date | string | number) => string;
}

function makeFormatters(locale: Locale): I18nFormatters {
  const tag = LOCALE_TAGS[locale];
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  const numberFmt = new Intl.NumberFormat(tag);
  return {
    tag,
    fmtDate: new Intl.DateTimeFormat(tag, { day: "numeric", month: "long", year: "numeric" }),
    fmtDateTime: new Intl.DateTimeFormat(tag, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    fmtTime: new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
    fmtNumber: (n: number) => numberFmt.format(n),
    fmtRelative: (d) => {
      const date = d instanceof Date ? d : new Date(d);
      const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
      const abs = Math.abs(diffSec);
      let value: number;
      let unit: Intl.RelativeTimeFormatUnit;
      if (abs < 60) {
        value = diffSec;
        unit = "second";
      } else if (abs < 3600) {
        value = Math.round(diffSec / 60);
        unit = "minute";
      } else if (abs < 86_400) {
        value = Math.round(diffSec / 3600);
        unit = "hour";
      } else if (abs < 7 * 86_400) {
        value = Math.round(diffSec / 86_400);
        unit = "day";
      } else if (abs < 30 * 86_400) {
        value = Math.round(diffSec / (7 * 86_400));
        unit = "week";
      } else if (abs < 365 * 86_400) {
        value = Math.round(diffSec / (30 * 86_400));
        unit = "month";
      } else {
        value = Math.round(diffSec / (365 * 86_400));
        unit = "year";
      }
      return rtf.format(value, unit);
    },
  };
}

// ───────────────────────── détection + persistance ─────────────────────────

function readLsLocale(): Locale | null {
  try {
    const saved = localStorage.getItem(LS_LOCALE);
    return isLocale(saved) ? saved : null;
  } catch {
    return null;
  }
}

function detectFromNavigator(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const langs = (navigator.languages?.length ? navigator.languages : [navigator.language]) ?? [];
  for (const lang of langs) {
    const base = (lang ?? "").toLowerCase().slice(0, 2);
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Pousse la préférence au serveur (signée ECDSA, chaîne canonique proof.ts). */
async function pushLocaleToServer(pubkey: string, locale: Locale): Promise<void> {
  const ts = Date.now();
  const id = await loadIdentity();
  if (!id || id.pubkey !== pubkey) return; // identité changée entre-temps : abandon
  const signature = await signPayload(id.signPriv, preferencesProofMessage(pubkey, locale, ts));
  await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, locale, ts, signature }),
  });
}

// ───────────────────────── contexte React ─────────────────────────

export interface I18nContextValue {
  locale: Locale;
  /** Change la locale : LS immédiat + push serveur signé (best effort). */
  setLocale: (l: Locale) => void;
  /** true une fois la détection/LS appliquée (évite le flash FR côté tests) */
  ready: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** pluriel CLDR : tp("search.results", n) → « 2 résultats » / « 2 results » */
  tp: (key: string, count: number, vars?: Record<string, string | number>) => string;
  fmt: I18nFormatters;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // Premier rendu (client ET server) = DEFAULT_LOCALE → aucune divergence
  // d'hydratation ; la détection s'applique dans l'effet de montage.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);
  /** la session a fait un choix explicite → l'adoption serveur se retire */
  const userChosenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Détection dans une microtask : le setState ne doit pas être synchrone
    // dans le corps de l'effet (react-hooks/set-state-in-effect) — la
    // microtask s'applique avant la première peinture utile (pas de flash).
    queueMicrotask(() => {
      if (cancelled) return;
      const saved = readLsLocale();
      if (saved) {
        setLocaleState(saved);
        setReady(true);
        return;
      }
      setLocaleState(detectFromNavigator());
      setReady(true);
      // Roaming : préférence du compte adoptée UNIQUEMENT sans choix local
      // (l'utilisateur qui vient de cliquer « English » ne doit pas être
      // écrasé par une réponse serveur en vol).
      void (async () => {
        try {
          const id = await loadIdentity();
          if (!id || cancelled || userChosenRef.current || readLsLocale()) return;
          const res = await fetch(`/api/preferences?pubkey=${encodeURIComponent(id.pubkey)}`);
          if (!res.ok) return;
          const json = (await res.json()) as { locale?: string | null; explicit?: boolean };
          // ADOPTION ROAMING STRICTE : uniquement un choix EXPLICITE du compte
          // (localeExplicit posé par POST /api/preferences). Le défaut 'fr'
          // d'un compte jamais réglé ne doit JAMAIS écraser la détection
          // navigateur (bug détecté par le harnais G : onboarding en-US
          // basculé en fr par adoption du défaut).
          if (!isLocale(json.locale) || json.explicit !== true) return;
          if (cancelled || userChosenRef.current || readLsLocale()) return; // re-vérifié après l'await
          setLocaleState(json.locale);
          try {
            localStorage.setItem(LS_LOCALE, json.locale);
          } catch {
            /* LS indisponible : la locale tient en mémoire pour la session */
          }
        } catch {
          /* préférence serveur indisponible : détection locale suffit */
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // html lang reflète toujours la locale (accessibilité — axe, lecteurs d'écran)
  useEffect(() => {
    document.documentElement.lang = LOCALE_TAGS[locale].slice(0, 2);
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    userChosenRef.current = true;
    setLocaleState(l);
    try {
      localStorage.setItem(LS_LOCALE, l);
    } catch {
      /* LS indisponible : la locale tient en mémoire pour la session */
    }
    // Push serveur best effort — jamais bloquant, jamais d'erreur UI
    void (async () => {
      try {
        const id = await loadIdentity();
        if (id) await pushLocaleToServer(id.pubkey, l);
      } catch {
        /* hors-ligne / coffre indisponible : la préférence reste locale */
      }
    })();
  }, []);

  const fmt = useMemo(() => makeFormatters(locale), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      ready,
      t: (key, vars) => translate(locale, key, vars),
      tp: (key, count, vars) => translatePlural(locale, key, count, vars),
      fmt,
    }),
    [locale, setLocale, ready, fmt]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n hors de I18nProvider");
  return ctx;
}
