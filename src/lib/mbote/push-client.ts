"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  push-client — subscribe/unsubscribe Web Push côté navigateur (C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  PUR JS (WebCrypto + btoa) — RÈGLE DEV-SETUP §6 : AUCUN import node dans
 *  un fichier 'use client' (la garde ESLint mbote-client-guard/no-node-in-
 *  client échouerait le lint). L'applicationServerKey VAPID (base64url) est
 *  décodée sans le global node (btoa pur).
 *
 *  SIGNATURE (même mécanique que /api/dms — preuve de possession) :
 *    subscribe   : `${me}|push-sub|${endpoint}|${p256dh}|${auth}|${ts}`
 *    unsubscribe : `${me}|push-unsub|${endpoint}|${ts}`
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** base64url → Uint8Array (pur JS — la garde §6 interdit Buffer côté client). */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Le push Web exige HTTPS (ou localhost) + service worker + permission. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  // le SW est enregistré par PwaRegister (prod) — on lit l'état courant
  // SANS re-enregistrer (PwaRegister est le seul propriétaire du register).
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

/**
 * Subscribe complet : permission → pushManager.subscribe → POST signé.
 * La permission est demandée ICI (l'UI affiche d'abord l'intention).
 */
export async function subscribePush(opts: {
  me: string;
  sign: (payload: string) => Promise<string>;
  vapidPublicKey: string;
  userAgent: string;
}): Promise<{ ok: true; endpoint: string } | { ok: false; reason: string }> {
  if (!isPushSupported()) return { ok: false, reason: "Push non supporté par ce navigateur" };
  const reg = await currentRegistration();
  if (!reg) return { ok: false, reason: "Service worker non enregistré — attendez la fin du chargement (mode en ligne)" };

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, reason: "Demande de permission refusée par le navigateur" };
  }
  if (permission !== "granted") {
    return {
      ok: false,
      reason:
        permission === "denied"
          ? "Notifications bloquées — réautorisez-les dans les réglages du navigateur pour ce site"
          : "Permission de notification refusée",
    };
  }

  const applicationServerKey = urlBase64ToUint8Array(opts.vapidPublicKey);
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, // exigence navigateur : toute push doit s'afficher
      applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
    });
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? `Subscription refusée par le navigateur : ${e.message}` : "Subscription refusée",
    };
  }
  const json = sub.toJSON() as PushSubscriptionJson;
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, reason: "Subscription incomplète (navigateur)" };
  }

  const ts = Date.now();
  const signature = await opts.sign(`${opts.me}|push-sub|${json.endpoint}|${json.keys.p256dh}|${json.keys.auth}|${ts}`);
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      me: opts.me,
      endpoint: json.endpoint,
      keys: json.keys,
      ts,
      signature,
      userAgent: opts.userAgent,
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    // annuler localement la subscription orpheline (le serveur refuse → pas de
    // notification sans enregistrement)
    await sub.unsubscribe().catch(() => undefined);
    const detail = res ? `HTTP ${res.status}` : "réseau injoignable";
    return { ok: false, reason: `Enregistrement côté serveur refusé (${detail})` };
  }
  return { ok: true, endpoint: json.endpoint };
}

/** Désabonnement : unsubscribe navigateur + POST /api/push/unsubscribe signé. */
export async function unsubscribePush(opts: {
  me: string;
  sign: (payload: string) => Promise<string>;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushSupported()) return { ok: false, reason: "Push non supporté" };
  const reg = await currentRegistration();
  if (!reg) return { ok: false, reason: "Service worker absent" };
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) return { ok: true }; // rien à faire — idempotent

  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);

  const ts = Date.now();
  const signature = await opts.sign(`${opts.me}|push-unsub|${endpoint}|${ts}`);
  const res = await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: opts.me, endpoint, ts, signature }),
  }).catch(() => null);
  // le désabonnement NAVIGATEUR est fait — l'échec serveur est non bloquant
  // (la subscription 410 purgera la ligne au prochain knock)
  if (!res || !res.ok) return { ok: true, reason: `serveur : ${res ? `HTTP ${res.status}` : "réseau"}` };
  return { ok: true };
}
