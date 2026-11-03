/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Outbox durable — cœur isomorphe (P2 de la pile hybride Mbote)
 * ─────────────────────────────────────────────────────────────────────────────
 *  File d'attente persistante des paquets BitChat en attente d'un canal
 *  (spray-and-wait §3.1). La garantie P2 : un paquet mis en outbox SURVIT à
 *  la mort de l'app — seul le stockage change entre plateformes
 *  (storage adapter injecté) :
 *    • web    : IndexedDB + repli localStorage  (web-outbox-storage.ts)
 *    • mobile : expo-sqlite + repli AsyncStorage (outbox-storage.ts)
 *
 *  Politique (docs/HYBRID-TRANSPORT-STACK.md §P2) :
 *    • purge par ack — statuts `accepted` / `duplicate` du pont (canal
 *      confirmé) ; `invalid` est purgé aussi (paquet poison, comme côté natif)
 *    • backoff exponentiel 30 s → 15 min sur les échecs de flush
 *    • jamais plus de 3 flush concurrents (garde semaphore)
 *    • déclencheurs câblés par l'intégrateur : regain réseau (NetInfo /
 *      event `online`), foreground (AppState / visibilitychange), timer
 *      périodique 5 min, paquet reçu (« un voisin = un canal »)
 *
 *  Zéro import : TS pur, isomorphe web/mobile (Next.js ↔ React Native).
 *  Copie synchronisée avec l'autre cible :
 *    • web    : src/lib/mbote/transports/outbox-core.ts  (ce fichier)
 *    • mobile : mobile/src/transport/outbox-core.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Un paquet en attente dans l'outbox durable. */
export interface OutboxItem {
  id: string;
  /** Paquet binaire BitChat encodé base64 (opaque, jamais interprété ici). */
  base64: string;
  bytes: number;
  /** Trace libre (type de paquet, clientRef…). */
  trace?: string;
  /** Métadonnées d'affichage libres (preview, fragLabel, hops…). */
  meta?: Record<string, string>;
  enqueuedAt: number;
  /** Nombre de tentatives de flush échouées (0 = jamais tenté). */
  attempts: number;
  /** Le paquet n'est reflushé qu'après cette date (backoff). */
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
}

/**
 * Adaptateur de stockage durable. Toutes les méthodes sont asynchrones ;
 * l'implémentation est responsable de la persistance réelle sur disque.
 */
export interface OutboxStorage {
  /** Étiquette lisible (journal UI : « sqlite », « indexeddb »…). */
  readonly kind: string;
  init(): Promise<void>;
  /** Insère (ou remplace) les items — un seul appel transactionnel. */
  enqueue(items: OutboxItem[]): Promise<void>;
  list(): Promise<OutboxItem[]>;
  remove(ids: string[]): Promise<void>;
  /** Met à jour attempts / nextAttemptAt / lastError des items. */
  update(items: OutboxItem[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Enveloppe « primaire → secondaire » : si l'init du stockage primaire échoue
 * (IndexedDB bloqué en navigation privée, sqlite natif absent…), tout bascule
 * de façon transparente sur le secondaire (localStorage, AsyncStorage…).
 */
export class AsyncFallbackOutboxStorage implements OutboxStorage {
  private primaryFailed = false;

  constructor(
    private readonly primary: OutboxStorage,
    private readonly secondary: OutboxStorage
  ) {}

  /** Reflète le stockage réellement actif (F-52 : plus de kind figé au constructeur) */
  get kind(): string {
    return this.primaryFailed ? this.secondary.kind : this.primary.kind;
  }

  async init(): Promise<void> {
    try {
      await this.primary.init();
      return;
    } catch {
      this.primaryFailed = true;
    }
    await this.secondary.init();
  }

  private get active(): OutboxStorage {
    return this.primaryFailed ? this.secondary : this.primary;
  }

  enqueue(items: OutboxItem[]): Promise<void> {
    return this.active.enqueue(items);
  }
  list(): Promise<OutboxItem[]> {
    return this.active.list();
  }
  remove(ids: string[]): Promise<void> {
    return this.active.remove(ids);
  }
  update(items: OutboxItem[]): Promise<void> {
    return this.active.update(items);
  }
  clear(): Promise<void> {
    return this.active.clear();
  }
}

/** Stockage mémoire — repli ultime (SSR, tests) : la file ne survit pas. */
export class MemoryOutboxStorage implements OutboxStorage {
  readonly kind = "mémoire";
  private items = new Map<string, OutboxItem>();

  async init(): Promise<void> {
    /* rien */
  }
  async enqueue(items: OutboxItem[]): Promise<void> {
    for (const it of items) this.items.set(it.id, { ...it });
  }
  async list(): Promise<OutboxItem[]> {
    return [...this.items.values()];
  }
  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.items.delete(id);
  }
  async update(items: OutboxItem[]): Promise<void> {
    for (const it of items) this.items.set(it.id, { ...it });
  }
  async clear(): Promise<void> {
    this.items.clear();
  }
}

// ───────────────────────── backoff exponentiel ─────────────────────────

/** Première attente après un échec : 30 s (spec P2). */
export const OUTBOX_BACKOFF_BASE_MS = 30_000;
/** Plafond d'attente : 15 min (spec P2). */
export const OUTBOX_BACKOFF_MAX_MS = 900_000;

/**
 * Backoff exponentiel : 30 s · 1 min · 2 min · 4 min · 8 min · 15 min (plafond).
 * `attempts` = nombre d'échecs déjà subis (1 après le premier échec).
 */
export function outboxBackoffMs(attempts: number): number {
  const ms = OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(ms, OUTBOX_BACKOFF_MAX_MS);
}

// ───────────────────────── orchestration du flush ─────────────────────────

/** Statut par paquet renvoyé par /api/mesh/bridge (aligné sur le lot envoyé). */
export interface OutboxSendResult {
  status: string;
  detail?: string;
}

/**
 * Fonction d'envoi injectée par la plateforme : porte un lot base64 au pont
 * VPS et renvoie les statuts ALIGNÉS sur le lot (accepted/duplicate/invalid).
 * Une exception = échec de transport (réseau) → backoff sur tout le lot.
 */
export type OutboxSender = (base64Batch: string[]) => Promise<OutboxSendResult[]>;

export interface FlushOutcome {
  /** Paquets soumis au pont pendant ce flush. */
  attempted: number;
  accepted: number;
  duplicate: number;
  /** Purgés comme poison (statut invalid). */
  invalid: number;
  /** Restés en file avec backoff reprogrammé. */
  failed: number;
  /** Profondeur de la file après flush. */
  remaining: number;
  error?: string;
}

export interface DurableOutboxOptions {
  /** Taille d'un lot de flush. Défaut : 64 (BRIDGE_BATCH du protocole). */
  batchSize?: number;
  /** Garde anti-tempête : flush concurrents max. Défaut : 3 (spec P2). */
  maxConcurrent?: number;
  /** Plafond de la file : au-delà, les plus vieux paquets sont abandonnés. */
  maxItems?: number;
  /** Envoi de lot (requis pour flush()). */
  send?: OutboxSender;
  onLog?: (msg: string) => void;
  /** Horloge injectable (tests). */
  clock?: () => number;
}

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_ITEMS = 1000;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let outboxSeq = 0;
function newOutboxId(now: number): string {
  outboxSeq = (outboxSeq + 1) % 0xffff;
  return `${now.toString(36)}-${outboxSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * L'outbox durable — cœur P2. Enfile, attend, reflushe, purge par ack.
 * Toutes les méthodes sont sûres : une erreur de stockage ne casse jamais
 * l'appelant (les paquets restent en cache mémoire tant que le disque refuse).
 */
export class DurableOutbox {
  private readonly storage: OutboxStorage;
  private readonly opts: Required<Pick<DurableOutboxOptions, "batchSize" | "maxConcurrent" | "maxItems">> &
    DurableOutboxOptions;
  private cache: OutboxItem[] = []; // FIFO (enqueuedAt croissant)
  private cacheById = new Map<string, OutboxItem>();
  private readyPromise: Promise<void> | null = null;
  private inFlight = 0;
  private changeCbs = new Set<(depth: number) => void>();

  constructor(storage: OutboxStorage, opts?: DurableOutboxOptions) {
    this.storage = storage;
    this.opts = {
      batchSize: opts?.batchSize ?? DEFAULT_BATCH_SIZE,
      maxConcurrent: opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxItems: opts?.maxItems ?? DEFAULT_MAX_ITEMS,
      send: opts?.send,
      onLog: opts?.onLog,
      clock: opts?.clock,
    };
  }

  private get now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  /** Initialisation idempotente : charge la file depuis le stockage durable. */
  async ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      try {
        await this.storage.init();
        const items = await this.storage.list();
        items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        this.cache = items;
        this.cacheById = new Map(items.map((i) => [i.id, i]));
        this.log(
          `outbox ${this.storage.kind} chargée : ${items.length} paquet(s) durable(s)`
        );
      } catch (e) {
        this.log(
          `outbox : stockage ${this.storage.kind} indisponible (${e instanceof Error ? e.message : "?"}) — file mémoire`
        );
      }
    })();
    return this.readyPromise;
  }

  get storageKind(): string {
    return this.storage.kind;
  }

  count(): number {
    return this.cache.length;
  }

  /** Nombre de paquets dont le backoff est écoulé (prêts à reflusher). */
  dueCount(): number {
    const now = this.now;
    return this.cache.filter((i) => i.nextAttemptAt <= now).length;
  }

  /** Date d'enfilement du plus vieux paquet (null si vide). */
  oldestEnqueuedAt(): number | null {
    return this.cache.length > 0 ? this.cache[0].enqueuedAt : null;
  }

  /** Photo FIFO du cache — l'UI lit ici, jamais le disque. */
  snapshot(): OutboxItem[] {
    return [...this.cache];
  }

  /** Abonnement aux changements de profondeur (→ UI + santé transport). */
  onChange(cb: (depth: number) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  /** Enfile un paquet — persistance immédiate, notification au retour. */
  async enqueue(
    base64: string,
    info?: { trace?: string; meta?: Record<string, string>; id?: string }
  ): Promise<OutboxItem> {
    const [item] = await this.enqueueMany([
      { base64, trace: info?.trace, meta: info?.meta, id: info?.id },
    ]);
    return item;
  }

  /** Enfile plusieurs paquets en une seule écriture durable. */
  async enqueueMany(
    items: { base64: string; trace?: string; meta?: Record<string, string>; id?: string }[]
  ): Promise<OutboxItem[]> {
    const now = this.now;
    const fresh: OutboxItem[] = items.map((it) => ({
      id: it.id ?? newOutboxId(this.now),
      base64: it.base64,
      bytes: Math.floor((it.base64.length * 3) / 4),
      trace: it.trace,
      meta: it.meta,
      enqueuedAt: now,
      attempts: 0,
      nextAttemptAt: now, // dû immédiatement : le premier flush n'attend pas
    }));

    // plafond : abandon (journalisé) des plus vieux paquets au-delà de maxItems
    const overflow = this.cache.length + fresh.length - this.opts.maxItems;
    if (overflow > 0) {
      const dropped = this.cache.slice(0, overflow);
      await this.removeInternal(dropped.map((d) => d.id));
      this.log(`outbox saturée : ${dropped.length} paquet(s) le(s) plus vieux abandonné(s)`);
    }

    this.cache.push(...fresh);
    for (const it of fresh) this.cacheById.set(it.id, it);
    try {
      await this.storage.enqueue(fresh);
    } catch (e) {
      this.log(`outbox : écriture durable échouée (${e instanceof Error ? e.message : "?"})`);
    }
    this.notify();
    return fresh;
  }

  /**
   * Flush par lot (chemin rapide des déclencheurs réseau/foreground/timer) :
   * envoie les paquets dus au pont, purge les acquittés, programme le backoff
   * des échecs. Ne lève jamais — le FlushOutcome fait foi.
   */
  async flush(force = false): Promise<FlushOutcome> {
    const outcome: FlushOutcome = {
      attempted: 0,
      accepted: 0,
      duplicate: 0,
      invalid: 0,
      failed: 0,
      remaining: this.cache.length,
    };
    if (!this.opts.send) {
      outcome.error = "aucune fonction d'envoi configurée";
      return outcome;
    }
    if (this.inFlight >= this.opts.maxConcurrent) {
      outcome.error = `flush ignoré : ${this.inFlight} flush déjà en cours (garde ${this.opts.maxConcurrent})`;
      this.log(`outbox : ${outcome.error}`);
      return outcome;
    }
    await this.ready();

    const now = this.now;
    const due = force ? [...this.cache] : this.cache.filter((i) => i.nextAttemptAt <= now);
    if (due.length === 0) return outcome;

    this.inFlight++;
    try {
      for (const batch of chunks(due, this.opts.batchSize)) {
        try {
          const statuses = await this.opts.send(batch.map((b) => b.base64));
          const acked: OutboxItem[] = [];
          const retry: OutboxItem[] = [];
          for (let i = 0; i < batch.length; i++) {
            outcome.attempted++;
            const status = statuses?.[i]?.status ?? "invalid";
            if (status === "accepted") {
              outcome.accepted++;
              acked.push(batch[i]);
            } else if (status === "duplicate") {
              outcome.duplicate++;
              acked.push(batch[i]);
            } else if (status === "invalid") {
              // paquet poison : purgé, exactement comme côté natif
              outcome.invalid++;
              acked.push(batch[i]);
            } else {
              outcome.failed++;
              retry.push(this.withBackoff(batch[i], status));
            }
          }
          if (acked.length > 0) await this.removeInternal(acked.map((a) => a.id));
          if (retry.length > 0) await this.updateInternal(retry);
        } catch (e) {
          // échec de transport : tout le lot reprogrammé, on arrête le flush
          const msg = e instanceof Error ? e.message : "réseau injoignable";
          outcome.error = msg;
          const retry = batch.map((b) => this.withBackoff(b, msg));
          outcome.failed += batch.length;
          outcome.attempted += batch.length;
          await this.updateInternal(retry);
          this.log(`outbox : flush interrompu (${msg}) — backoff programmé`);
          break;
        }
      }
    } finally {
      this.inFlight--;
      outcome.remaining = this.cache.length;
      this.notify();
    }
    return outcome;
  }

  /**
   * Chemin par paquet (le tunnel web soumet chaque paquet au routeur) :
   * enregistre le résultat d'une tentative individuelle — purgé si confirmé,
   * backoff sinon. Met à jour la profondeur notifiée à l'UI.
   */
  async recordAttempt(id: string, delivered: boolean, detail?: string): Promise<void> {
    const item = this.cacheById.get(id);
    if (!item) return;
    if (delivered) {
      await this.removeInternal([id]);
    } else {
      await this.updateInternal([this.withBackoff(item, detail ?? "aucun canal")]);
    }
    this.notify();
  }

  /** Purge explicite (UI : suppression d'un paquet, clear all). */
  async purge(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.removeInternal(ids);
    this.notify();
  }

  async clear(): Promise<void> {
    this.cache = [];
    this.cacheById.clear();
    try {
      await this.storage.clear();
    } catch (e) {
      this.log(`outbox : purge durable échouée (${e instanceof Error ? e.message : "?"})`);
    }
    this.notify();
  }

  // ───────────────────────── interne ─────────────────────────

  private withBackoff(item: OutboxItem, error: string): OutboxItem {
    const attempts = item.attempts + 1;
    const now = this.now;
    return {
      ...item,
      attempts,
      lastAttemptAt: now,
      lastError: error,
      nextAttemptAt: now + outboxBackoffMs(attempts),
    };
  }

  private async removeInternal(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.cache = this.cache.filter((i) => !set.has(i.id));
    for (const id of ids) this.cacheById.delete(id);
    try {
      await this.storage.remove(ids);
    } catch (e) {
      this.log(`outbox : suppression durable échouée (${e instanceof Error ? e.message : "?"})`);
    }
  }

  private async updateInternal(items: OutboxItem[]): Promise<void> {
    for (const it of items) this.cacheById.set(it.id, it);
    try {
      await this.storage.update(items);
    } catch (e) {
      this.log(`outbox : mise à jour durable échouée (${e instanceof Error ? e.message : "?"})`);
    }
  }

  private notify(): void {
    for (const cb of this.changeCbs) {
      try {
        cb(this.cache.length);
      } catch {
        // un observateur fautif ne casse jamais l'outbox
      }
    }
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }
}
