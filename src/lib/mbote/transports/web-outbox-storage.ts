/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Stockage durable de l'outbox — navigateur (P2 pile hybride Mbote)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • IndexedDB (base `mbote-outbox`, store `packets`, clé `id`) : le chemin
 *    nominal — transactionnel, asynchrone, tolérant aux gros lots.
 *  • repli localStorage si IndexedDB est indisponible (navigation privée
 *    stricte, quota) — branché via AsyncFallbackOutboxStorage (outbox-core).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { OutboxItem, OutboxStorage } from "./outbox-core";

const DB_NAME = "mbote-outbox";
const DB_VERSION = 1;
const STORE = "packets";
const LS_KEY = "mbote.outbox.packets.v1";

// ───────────────────────── IndexedDB (nominal) ─────────────────────────

export class IndexedDbOutboxStorage implements OutboxStorage {
  readonly kind = "IndexedDB";
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (typeof indexedDB === "undefined") {
      throw new Error("indexedDB indisponible");
    }
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("ouverture IndexedDB échouée"));
      req.onblocked = () => reject(new Error("IndexedDB bloquée par un autre onglet"));
    });
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error("IndexedDB non initialisée");
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  /** Ferme la connexion (panic wipe F-11 : débloque deleteDatabase). */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  private wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("opération IndexedDB échouée"));
    });
  }

  async enqueue(items: OutboxItem[]): Promise<void> {
    if (items.length === 0) return;
    const st = this.store("readwrite");
    for (const it of items) st.put(it);
  }

  async list(): Promise<OutboxItem[]> {
    return this.wrap(this.store("readonly").getAll() as IDBRequest<OutboxItem[]>);
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const st = this.store("readwrite");
    for (const id of ids) st.delete(id);
  }

  async update(items: OutboxItem[]): Promise<void> {
    if (items.length === 0) return;
    const st = this.store("readwrite");
    for (const it of items) st.put(it);
  }

  async clear(): Promise<void> {
    this.store("readwrite").clear();
  }
}

// ───────────────────────── localStorage (repli) ─────────────────────────

export class LocalStorageOutboxStorage implements OutboxStorage {
  readonly kind = "localStorage";

  private read(): OutboxItem[] {
    if (typeof localStorage === "undefined") return [];
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }

  private write(items: OutboxItem[]): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(items));
    } catch {
      // quota dépassé : la file mémoire reste la source côté runtime
    }
  }

  async init(): Promise<void> {
    if (typeof localStorage === "undefined") throw new Error("localStorage indisponible");
  }

  async enqueue(items: OutboxItem[]): Promise<void> {
    const all = this.read();
    for (const it of items) {
      const idx = all.findIndex((x) => x.id === it.id);
      if (idx >= 0) all[idx] = { ...it };
      else all.push({ ...it });
    }
    this.write(all);
  }

  async list(): Promise<OutboxItem[]> {
    return this.read();
  }

  async remove(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.write(this.read().filter((i) => !set.has(i.id)));
  }

  async update(items: OutboxItem[]): Promise<void> {
    await this.enqueue(items); // même sémantique put
  }

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* rien */
    }
  }
}
