// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formatage partagés des NOUVELLES vues admin 2026-11 (médias,
// sécurité, infrastructure, réseau social).
//
// Fichier NOUVEAU, sans dépendance node (importable depuis un composant
// 'use client' — garde DEV-SETUP §6). Les helpers équivalents des vues
// existantes (fmt de PostsView, etc.) ne sont pas exportés et il est interdit
// de modifier ces fichiers pour les exporter : d'où ce module commun, qui
// évite de dupliquer quatre fois les mêmes fonctions.
// ─────────────────────────────────────────────────────────────────────────────

const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const numFmt = new Intl.NumberFormat("fr-FR");

/** Date + heure locale fr (— si absent). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

/** Nombre formaté fr (séparateur de milliers) — — si non fini/négatif anormal. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return numFmt.format(n);
}

/**
 * Taille lisible Ko/Mo/Go (base 1024, unités fr : o, Ko, Mo, Go, To).
 * Les octets bruts restent visibles via title= là où c'est utile.
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/**
 * Date RELATIVE courte (« à l'instant », « il y a 3 min », « il y a 2 h »,
 * « il y a 5 j ») — au-delà de 30 j, bascule en date locale fr. Skew d'horloge
 * (futur) ramené à « à l'instant ». Jamais de throw, « — » si absent.
 */
export function fmtRel(iso: string | null | undefined, nowMs?: number): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const diffMs = Math.max(0, now - d.getTime());
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return fmtDate(iso);
}

/**
 * Clé/pubkey/hash longue → extrait court mono pour les tableaux
 * (`abcdefgh…wxyz`), clé complète conservée dans title= côté appelant.
 */
export function shortKey(key: string | null | undefined, head = 8, tail = 4): string {
  if (!key) return "—";
  if (key.length <= head + tail + 1) return key;
  return `${key.slice(0, head)}…${key.slice(-tail)}`;
}

/** Chaîne tronquée propre (endpoint, user-agent…) — — si absent. */
export function truncate(text: string | null | undefined, max = 40): string {
  if (!text) return "—";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
