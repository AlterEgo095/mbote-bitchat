/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  justification — forme §6 d'ADMIN-RBAC.md (appliquée SERVEUR, ADM Étape 6)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 6 : « Chaque action mutante : formulaire de justification
 *  (catégorie dropdown + texte ≥ 20 chars), conformément à ADMIN-RBAC.md. »
 *
 *  Spec §6 : catégorie (enum fermé) + texte libre ≥ 20 caractères — validation
 *  SERVEUR, refus 422 sinon ; format stocké : « CATÉGORIE: texte » dans
 *  AdminAudit.justification et ModerationAction.reason.
 *
 *  applicable à TOUTE mutation : hide, unhide, purge, dismiss, warn, suspend,
 *  unsuspend — et à tout nouveau type de mutation (invariant §1.7).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const JUSTIFICATION_CATEGORIES = [
  "SPAM",
  "HARASSMENT",
  "SCAM",
  "CSAM",
  "OTHER",
] as const;

export type JustificationCategory = (typeof JUSTIFICATION_CATEGORIES)[number];

export const JUSTIFICATION_MIN_LEN = 20;
export const JUSTIFICATION_MAX_LEN = 500; // borne haute = cap historique `reason`

export interface Justification {
  category: JustificationCategory;
  text: string;
  /** forme stockée : « CATÉGORIE: texte » */
  formatted: string;
}

export type JustificationResult =
  | { ok: true; value: Justification }
  | { ok: false; error: string };

/**
 * Valide {category, justification} venant du body HTTP. Retourne une erreur
 * LISIBLE (le client peut l'afficher) — l'endpoint la renvoie en 422.
 */
export function parseJustification(
  body: Record<string, unknown>
): JustificationResult {
  const rawCategory = body.category;
  const rawText = body.justification;

  if (typeof rawCategory !== "string" || rawCategory.length === 0) {
    return { ok: false, error: "catégorie de justification requise" };
  }
  const category = rawCategory as JustificationCategory;
  if (!(JUSTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      error: `catégorie invalide (valeurs : ${JUSTIFICATION_CATEGORIES.join(", ")})`,
    };
  }
  if (typeof rawText !== "string") {
    return { ok: false, error: "justification (texte) requise" };
  }
  const text = rawText.trim();
  if (text.length < JUSTIFICATION_MIN_LEN) {
    return {
      ok: false,
      error: `justification trop courte (${text.length}/${JUSTIFICATION_MIN_LEN} caractères minimum)`,
    };
  }
  if (text.length > JUSTIFICATION_MAX_LEN) {
    return {
      ok: false,
      error: `justification trop longue (${text.length}/${JUSTIFICATION_MAX_LEN} caractères maximum)`,
    };
  }
  return { ok: true, value: { category, text, formatted: `${category}: ${text}` } };
}
