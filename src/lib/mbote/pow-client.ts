/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  pow-client — Preuve de travail côté client (D2 — Sybil phase 0)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Lance le calcul PoW dans un Web Worker (public/pow-worker.js) et relaie la
 *  progression (barre « Préparation du compte… X% » de l'onboarding).
 *
 *  GARANTIE T0 : l'échec du worker (indisponible, erreur) ne bloque JAMAIS la
 *  création locale — l'appelant reçoit une exception et peut continuer hors
 *  ligne (le payload partira dans la file courrier/outbox ; le serveur
 *  vérifiera le PoW au retour du réseau — si l'utilisateur a rechargé entre-
 *  temps, l'outbox rejoue le nonce calculé, toujours valide : pas de fenêtre
 *  de fraîcheur côté serveur).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  POW_DIFFICULTY_BITS,
  powChallengeMessage,
} from "./sybil";

export interface PowResult {
  nonce: string;
  iterations: number;
  ms: number;
  difficultyBits: number;
}

export interface PowProgress {
  /** Ratio estimé 0..1 — iterations / attendu (plafonné, l'estimation reste
   *  probabiliste) ; passe à 1 au done. */
  ratio: number;
  iterations: number;
  ms: number;
}

/** Calcul PoW — rejette si le worker est indisponible (message type:"error",
 *  erreur de construction, ou contexte non sécurisé). */
export function computePow(
  pubkey: string,
  ts: number,
  onProgress?: (p: PowProgress) => void
): Promise<PowResult> {
  const challenge = powChallengeMessage(pubkey, ts);
  return new Promise<PowResult>((resolve, reject) => {
    let worker: Worker | undefined;
    const cleanup = () => {
      worker?.terminate();
      worker = undefined;
    };
    try {
      worker = new Worker("/pow-worker.js");
    } catch (e) {
      reject(e instanceof Error ? e : new Error("worker indisponible"));
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("délai PoW dépassé (120 s)"));
    }, 120_000);
    worker.onerror = (e) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`worker PoW : ${e.message ?? "erreur"}`));
    };
    worker.onmessage = (ev: MessageEvent) => {
      const d = ev.data as {
        type: string;
        nonce?: string;
        iterations?: number;
        ms?: number;
        expected?: number;
        message?: string;
      };
      if (d.type === "progress") {
        const expected = d.expected ?? Math.pow(2, POW_DIFFICULTY_BITS);
        onProgress?.({
          ratio: Math.min(0.97, (d.iterations ?? 0) / expected),
          iterations: d.iterations ?? 0,
          ms: d.ms ?? 0,
        });
        return;
      }
      if (d.type === "done" && d.nonce) {
        clearTimeout(timeout);
        cleanup();
        onProgress?.({ ratio: 1, iterations: d.iterations ?? 0, ms: d.ms ?? 0 });
        resolve({
          nonce: d.nonce,
          iterations: d.iterations ?? 0,
          ms: d.ms ?? 0,
          difficultyBits: POW_DIFFICULTY_BITS,
        });
        return;
      }
      if (d.type === "error") {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(d.message ?? "erreur worker PoW"));
      }
    };
    worker.postMessage({ challenge, difficultyBits: POW_DIFFICULTY_BITS });
  });
}

/** Benchmarks exposés pour la preuve navigateur D2 (jamais de donnée privée). */
export function exposePowBenchmark(result: PowResult): void {
  if (typeof window !== "undefined") {
    (
      window as unknown as { __mbotePow?: { ms: number; iterations: number; bits: number } }
    ).__mbotePow = { ms: result.ms, iterations: result.iterations, bits: result.difficultyBits };
  }
}
