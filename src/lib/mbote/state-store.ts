/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  state-store — état applicatif PLUGGABLE (décision scalabilité D2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Règle D2 : l'API doit rester 100 % sans état pour scaler en N instances.
 *  Tout ce qui vit en RAM passe par une interface dont l'implémentation est
 *  remplaçable : MemoryStore aujourd'hui, Redis demain — sans toucher aux routes.
 *
 *  Contient :
 *   • RateStore     — jetons par fenêtre glissante (rate limiting D4)
 *   • PerfTracker   — métriques de latence/débit (fenêtre 5 min, p95)
 *   • FragmentAssembler singleton — réassembly des paquets mesh partagé
 *   • startBackgroundTasks()      — purges périodiques (MeshIngest 6 h, …)
 *
 *  Les singletons vivent sur globalThis : ils survivent au HMR de Next.js et
 *  il n'existe qu'une instance par process (jamais 2 timers concurrents).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { FragmentAssembler } from "@/lib/mbote/bitchat-protocol";
import { db } from "@/lib/db";

// ───────────────────────── Rate limiting (D4) ─────────────────────────

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateStore {
  /** Consomme 1 jeton pour une clé. Fenêtre fixe, atomique dans le process. */
  hit(key: string, limit: number, windowMs: number): RateVerdict;
  /** Taille suivie (diagnostic /api/stats) */
  size(): number;
}

/** Implémentation mémoire — suffisante pour un process (Palier 0).
 *  Au Palier 1, on branche RedisRateStore (INCR + EXPIRE) sur la même interface. */
export class MemoryRateStore implements RateStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  hit(key: string, limit: number, windowMs: number): RateVerdict {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
    }
    if (b.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, b.resetAt - now) };
    }
    b.count++;
    return { allowed: true, remaining: limit - b.count, retryAfterMs: 0 };
  }

  size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
    this.lastSweep = now;
  }
}

// ───────────────────────── Métriques de performance ─────────────────────────

const PERF_WINDOW_MS = 5 * 60_000;
const PERF_MAX_SAMPLES = 5_000;

export interface RoutePerf {
  route: string;
  count: number;
  p95Ms: number;
}

export interface PerfSnapshot {
  reqPerSec: number;
  p95Ms: number;
  byRoute: RoutePerf[];
  since: string;
}

export class PerfTracker {
  private samples: { route: string; ms: number; at: number }[] = [];

  /** À appeler une fois par requête API suivie (done() en fin de handler). */
  record(route: string, ms: number): void {
    const now = Date.now();
    this.samples.push({ route, ms, at: now });
    if (this.samples.length > PERF_MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - PERF_MAX_SAMPLES);
    }
  }

  snapshot(): PerfSnapshot {
    const now = Date.now();
    this.samples = this.samples.filter((s) => now - s.at <= PERF_WINDOW_MS);
    const windowSec = PERF_WINDOW_MS / 1000;
    const sorted = [...this.samples].map((s) => s.ms).sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      : 0;

    const byRouteMap = new Map<string, number[]>();
    for (const s of this.samples) {
      const arr = byRouteMap.get(s.route) ?? [];
      arr.push(s.ms);
      byRouteMap.set(s.route, arr);
    }
    const byRoute: RoutePerf[] = [...byRouteMap.entries()]
      .map(([route, arr]) => ({
        route,
        count: arr.length,
        p95Ms: quantile(arr.sort((a, b) => a - b), 0.95),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return {
      reqPerSec: +(this.samples.length / windowSec).toFixed(2),
      p95Ms: Math.round(p95),
      byRoute,
      since: new Date(now - PERF_WINDOW_MS).toISOString(),
    };
  }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** Chronomètre une requête : `const done = trackApiRequest("posts.get")` puis `done()`. */
export function trackApiRequest(route: string): () => void {
  const start = Date.now();
  return () => getPerf().record(route, Date.now() - start);
}

/** Extrait l'IP client — condition de sécurité n° 5 : seules les requêtes
 *  prouvées Cloudflare (dernier maillon XFF ∈ plages officielles CF + cf-ray)
 *  révèlent leur IP réelle ; tout le reste partage le bucket « local ».
 *  Implémentation : @/lib/mbote/client-ip.ts (pure, sans dépendance). */
export { clientIp, isCloudflareIp } from "@/lib/mbote/client-ip";

// ───────────────────────── Singletons (survitent au HMR) ─────────────────────────

interface MboteStateGlobal {
  __mboteRateStore?: RateStore;
  __mbotePerf?: PerfTracker;
  __mboteAssembler?: FragmentAssembler;
  __mboteBackgroundStarted?: boolean;
}

const g = globalThis as unknown as MboteStateGlobal;

export function getRateStore(): RateStore {
  if (!g.__mboteRateStore) g.__mboteRateStore = new MemoryRateStore();
  return g.__mboteRateStore;
}

export function getPerf(): PerfTracker {
  if (!g.__mbotePerf) g.__mbotePerf = new PerfTracker();
  return g.__mbotePerf;
}

export function getFragmentAssembler(): FragmentAssembler {
  if (!g.__mboteAssembler) g.__mboteAssembler = new FragmentAssembler();
  return g.__mboteAssembler;
}

// ───────────────────────── Tâches de fond ─────────────────────────

const MESH_INGEST_TTL_MS = 6 * 60 * 60 * 1000; // fenêtre de dédup persistante (§ pont)
const PURGE_INTERVAL_MS = 10 * 60_000;

/** Purge la dédup mesh expirée (batch unique, périodique — plus jamais par requête). */
async function purgeMeshIngest(): Promise<number> {
  try {
    const res = await db.meshIngest.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - MESH_INGEST_TTL_MS) } },
    });
    return res.count;
  } catch {
    return 0; // la DB peut être momentanément indisponible — on retentera au prochain tour
  }
}

/** A1 : purge de la garde anti-rejeu (gardes expirées + compteurs d'époques révolues). */
async function purgeReplayGuards(): Promise<void> {
  try {
    const { prismaReplayStore } = await import("./anti-replay-prisma");
    await prismaReplayStore().prune(new Date());
  } catch {
    /* indisponibilité momentanée — retentée au prochain tour */
  }
}

/** Démarre les tâches périodiques UNE FOIS par process (appelé par instrumentation.ts). */
export function startBackgroundTasks(): void {
  if (g.__mboteBackgroundStarted) return;
  g.__mboteBackgroundStarted = true;

  const tick = () => {
    void purgeMeshIngest();
    void purgeReplayGuards();
  };
  // premier passage immédiat, puis intervalle
  setTimeout(tick, 5_000);
  setInterval(tick, PURGE_INTERVAL_MS);
  // défrissage du rate store
  setInterval(() => {
    const store = getRateStore();
    if (store instanceof MemoryRateStore) store.size(); // sweep effectué au hit
  }, 5 * 60_000);
}
