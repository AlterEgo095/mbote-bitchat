"use client";

import { LS_IDENTITY, LS_OUTBOX, LS_FORCE_OFFLINE } from "./constants";
import type { KeyBundle } from "./crypto";

export interface StoredIdentity extends KeyBundle {
  nickname: string;
  bio?: string;
}

export function loadIdentity(): StoredIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LS_IDENTITY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: StoredIdentity): void {
  localStorage.setItem(LS_IDENTITY, JSON.stringify(identity));
}

/** Panic wipe : efface identité, outbox et tout état local */
export function panicWipe(): void {
  localStorage.removeItem(LS_IDENTITY);
  localStorage.removeItem(LS_OUTBOX);
  localStorage.removeItem(LS_FORCE_OFFLINE);
}

// ---------- outbox (file d'attente "courrier" hors-ligne) ----------

export type OutboxItem =
  | { id: string; type: "identity"; payload: Record<string, unknown>; queuedAt: number }
  | { id: string; type: "post"; payload: Record<string, unknown>; queuedAt: number }
  | { id: string; type: "like"; payload: Record<string, unknown>; queuedAt: number }
  | { id: string; type: "dm"; payload: Record<string, unknown>; queuedAt: number };

export function loadOutbox(): OutboxItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_OUTBOX);
    return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(items: OutboxItem[]): void {
  localStorage.setItem(LS_OUTBOX, JSON.stringify(items));
}

export function enqueueOutbox(item: Omit<OutboxItem, "id" | "queuedAt">): OutboxItem[] {
  const items = loadOutbox();
  const full: OutboxItem = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: Date.now(),
  } as OutboxItem;
  items.push(full);
  saveOutbox(items);
  return items;
}

export function removeOutbox(id: string): OutboxItem[] {
  const items = loadOutbox().filter((i) => i.id !== id);
  saveOutbox(items);
  return items;
}

export function loadForceOffline(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LS_FORCE_OFFLINE) === "1";
}

export function saveForceOffline(v: boolean): void {
  if (v) localStorage.setItem(LS_FORCE_OFFLINE, "1");
  else localStorage.removeItem(LS_FORCE_OFFLINE);
}
