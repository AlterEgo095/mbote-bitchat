"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  dm-sequence — séquence monotone client par conversation (A1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le serveur rejette toute séquence non croissante par (expéditeur,
 *  destinataire, époque de 6 h). Le compteur client vit dans localStorage :
 *   • persistant → survit au rechargement (pas de régression après restart) ;
 *   • par conversation → un pair ne peut pas bloquer une autre conversation ;
 *   • époque : si l'époque serveur a avancé de 6 h pendant l'offline, un seq
 *     client plus ancien reste valide (nouvelle époque = compteur neuf).
 *  Le msgId (uuid) donne l'idempotence outbox : le flush rejoue l'identique,
 *  le serveur répond 409 `duplicate` = succès.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const KEY_PREFIX = "mbote.dmseq.v1.";

/** Prochain numéro de séquence pour (expéditeur → destinataire). Persistant. */
export function nextDmSeq(myPub: string, recipientKey: string): number {
  const key = `${KEY_PREFIX}${myPub}.${recipientKey}`;
  const current = Number(localStorage.getItem(key) ?? "0");
  const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1;
  try {
    localStorage.setItem(key, String(next));
  } catch {
    /* quota plein : le message part quand même — le serveur acceptera un seq
       réutilisé seulement si l'époque a tourné, sinon il renverra 409 et
       l'outbox retiendra l'enveloppe pour un reflush post-épuration */
  }
  return next;
}

/** Identifiant de message client (uuid quand disponible, repli aléatoire). */
export function newDmMsgId(): string {
  const g = globalThis.crypto;
  if (g?.randomUUID) return g.randomUUID();
  const bytes = new Uint8Array(16);
  g?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
