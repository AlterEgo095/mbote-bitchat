/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  pow-harness — helpers PoW + isolation IP pour les tests D2 et suivants
 * ─────────────────────────────────────────────────────────────────────────────
 *  Depuis D2 (Sybil phase 0), la CRÉATION d'identité exige un PoW SHA-256 à
 *  20 bits et un plafond de 3 créations/heure/IP. Les tests qui créent des
 *  identités via POST /api/identity doivent donc :
 *   1. joindre un nonce PoW valide (solvePow — sha256 natif bun, ≈ 0,5 s) ;
 *   2. s'isoler par IP (cfSpoofHeaders) quand un test en crée PLUS de 3 ou
 *      cohabite avec d'autres créations sur le même serveur de preuve.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import {
  hashMeetsDifficultyHex,
  POW_DIFFICULTY_BITS,
  powChallengeMessage,
} from "../src/lib/mbote/sybil";

/** Résout le PoW exigé par POST /api/identity à la création (bun : SHA-256
 *  natif ≈ 1 M hash/s → 20 bits ≈ 0,5 s). Même règle que le serveur
 *  (sybil.ts hashMeetsDifficultyHex) et que le worker navigateur. */
export function solvePow(
  pubkey: string,
  ts: number,
  bits: number = POW_DIFFICULTY_BITS
): { nonce: string } {
  const challenge = powChallengeMessage(pubkey, ts);
  for (let n = 0; ; n++) {
    const hex = createHash("sha256").update(`${challenge}:${n}`).digest("hex");
    if (hashMeetsDifficultyHex(hex, bits)) return { nonce: String(n) };
  }
}

let spoofCounter = 0;
/**
 * En-têtes CF forgés pour l'isolation par IP en tests (mode production
 * standalone : clientIp exige cf-connecting-ip + dernier maillon XFF ∈ plages
 * CF + cf-ray — bouche documentée dans client-ip.ts tant que le verrou nginx
 * n'est pas appliqué). IP unique par appel SAUF si `fixedIp` est fourni (les
 * tests de rate-limit partagent volontairement un même bucket).
 */
export function cfSpoofHeaders(label = "d2test", fixedIp?: string): Record<string, string> {
  spoofCounter += 1;
  const ip = fixedIp ?? `203.0.113.${(spoofCounter % 250) + 1}`;
  return {
    "x-forwarded-for": `${ip}, 103.21.244.5`,
    "cf-connecting-ip": ip,
    "cf-ray": `${label}-${spoofCounter}-hac`,
  };
}
