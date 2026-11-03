/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Stockage durable de l'outbox — mobile (P2 pile hybride Mbote)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • expo-sqlite (base `mbote-outbox.db`) : le chemin nominal — transactionnel,
 *    requêtable, garanti sur disque. Le bug P1 « je tue l'app, je perds 200
 *    paquets » disparaît ici.
 *  • repli AsyncStorage si le module natif sqlite est absent (build exotique,
 *    versions désynchronisées) — branché via AsyncFallbackOutboxStorage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SQLite from "expo-sqlite";

import type { OutboxItem, OutboxStorage } from "./outbox-core";

const DB_NAME = "mbote-outbox.db";
const LS_KEY = "mbote.outbox.packets.v1";

// ───────────────────────── expo-sqlite (nominal) ─────────────────────────

const SQL_CREATE = `
CREATE TABLE IF NOT EXISTS packets (
  id            TEXT PRIMARY KEY NOT NULL,
  base64        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  trace         TEXT,
  meta          TEXT,
  enqueuedAt    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt INTEGER NOT NULL,
  lastAttemptAt INTEGER,
  lastError     TEXT
)`;

function rowToItem(r: Record<string, unknown>): OutboxItem {
  return {
    id: String(r.id),
    base64: String(r.base64),
    bytes: Number(r.bytes),
    trace: (r.trace as string) ?? undefined,
    meta: r.meta ? (JSON.parse(String(r.meta)) as Record<string, string>) : undefined,
    enqueuedAt: Number(r.enqueuedAt),
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.nextAttemptAt),
    lastAttemptAt: r.lastAttemptAt != null ? Number(r.lastAttemptAt) : undefined,
    lastError: (r.lastError as string) ?? undefined,
  };
}

function itemToParams(it: OutboxItem): (string | number | null)[] {
  return [
    it.id,
    it.base64,
    it.bytes,
    it.trace ?? null,
    it.meta ? JSON.stringify(it.meta) : null,
    it.enqueuedAt,
    it.attempts,
    it.nextAttemptAt,
    it.lastAttemptAt ?? null,
    it.lastError ?? null,
  ];
}

export class SqliteOutboxStorage implements OutboxStorage {
  readonly kind = "SQLite";
  private db: SQLite.SQLiteDatabase | null = null;

  async init(): Promise<void> {
    // openDatabaseSync est synchrone mais sûr ici (premier accès au démarrage)
    this.db = SQLite.openDatabaseSync(DB_NAME);
    await this.db.execAsync(SQL_CREATE);
  }

  async enqueue(items: OutboxItem[]): Promise<void> {
    if (!this.db || items.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      for (const it of items) {
        await this.db!.runAsync(
          `INSERT OR REPLACE INTO packets
           (id, base64, bytes, trace, meta, enqueuedAt, attempts, nextAttemptAt, lastAttemptAt, lastError)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          itemToParams(it)
        );
      }
    });
  }

  async list(): Promise<OutboxItem[]> {
    if (!this.db) return [];
    const rows = await this.db.getAllAsync<Record<string, unknown>>(
      "SELECT * FROM packets ORDER BY enqueuedAt ASC"
    );
    return rows.map(rowToItem);
  }

  async remove(ids: string[]): Promise<void> {
    if (!this.db || ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    await this.db.runAsync(`DELETE FROM packets WHERE id IN (${placeholders})`, ids);
  }

  async update(items: OutboxItem[]): Promise<void> {
    await this.enqueue(items); // INSERT OR REPLACE = put
  }

  async clear(): Promise<void> {
    await this.db?.execAsync("DELETE FROM packets");
  }
}

// ───────────────────────── AsyncStorage (repli) ─────────────────────────

export class AsyncStorageOutboxStorage implements OutboxStorage {
  readonly kind = "AsyncStorage";

  private async read(): Promise<OutboxItem[]> {
    try {
      const raw = await AsyncStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }

  private async write(items: OutboxItem[]): Promise<void> {
    try {
      await AsyncStorage.setItem(LS_KEY, JSON.stringify(items));
    } catch {
      // quota/erreur : la file mémoire reste la source côté runtime
    }
  }

  async init(): Promise<void> {
    /* AsyncStorage s'ouvre paresseusement */
  }

  async enqueue(items: OutboxItem[]): Promise<void> {
    const all = await this.read();
    for (const it of items) {
      const idx = all.findIndex((x) => x.id === it.id);
      if (idx >= 0) all[idx] = { ...it };
      else all.push({ ...it });
    }
    await this.write(all);
  }

  async list(): Promise<OutboxItem[]> {
    return this.read();
  }

  async remove(ids: string[]): Promise<void> {
    const set = new Set(ids);
    await this.write((await this.read()).filter((i) => !set.has(i.id)));
  }

  async update(items: OutboxItem[]): Promise<void> {
    await this.enqueue(items);
  }

  async clear(): Promise<void> {
    await AsyncStorage.removeItem(LS_KEY);
  }
}

/**
 * Choix du stockage mobile : SQLite d'abord (test d'ouverture réel — un module
 * natif absent lève à l'init, pas à l'import), repli AsyncStorage automatique
 * via AsyncFallbackOutboxStorage côté appelant.
 */
export function createMobileOutboxStorage(): OutboxStorage {
  return new SqliteOutboxStorage();
}

export { AsyncStorageOutboxStorage as MobileFallbackOutboxStorage };
