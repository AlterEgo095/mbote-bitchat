/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  push/sender — Web Push VAPID, KNOCK SANS CONTENU (C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  TRANCHEMENT BIBLIOTHÈQUE (directive C1 : « à évaluer avant d'ajouter ») :
 *  `web-push@4.0.0` (web-push-libs/web-push) — licence RÉELLE **MPL-2.0**
 *  (la directive annonçait « MIT » : divergence documentée — MPL-2.0 est un
 *  faible copyleft fichier-à-fichier, acceptable pour une dépendance utilisée
 *  SANS modification ; les obligations restent dans la lib). Standard de
 *  facto Web Push depuis 2014 (RFC 8291 aes128gcm + RFC 8292 VAPID),
 *  maintenance active, surface cryptographique locale (le chiffrement du
 *  payload se fait ici, l'envoi est HTTPS vers le push service).
 *  L'alternative « implémentation maison node:crypto » (ECDH P-256 + HKDF +
 *  AES-128-GCM + JWT ES256 maison) est ÉCARTÉE : risque d'erreur cryptographique
 *  sans recul communautaire — exactement la classe de bug que le projet fuit.
 *
 *  PAYLOAD KNOCK-ONLY (directive) : { type: "new_message", fromLabel } —
 *  AUCUN contenu, AUCUN ciphertext, AUCUNE clé (E2EE oblige : le serveur
 *  notifie qu'il ne peut pas lire). Pas de senderKey dans le knock V1
 *  (tranché : le destinataire voit « Nouveau message de X » et ouvre sa vue
 *  messages — la notification précise par conversation est C4).
 *
 *  ERREURS PUSH SERVICE :
 *   - 410 Gone → abonnement mort : disabledAt posé (purge douce, la ligne
 *     reste auditable) ;
 *   - 429 → retry backoff LOGGÉ (le rate limit outbound évite d'y arriver).
 *
 *  PRÉSENCE (à trancher par la directive : « le relay expose-t-il la
 *  présence ? ») : le hub socket.io n'est requêtable PAS par clé depuis l'API
 *  (health = compteurs globaux seulement) → TRANCHÉ : TOUJOURS envoyer. Le
 *  knock ne contient rien ; le coût est un push ignoré si l'utilisateur est
 *  en ligne — acceptable en V1, filtrage présence = dette mineure tracée
 *  dans docs/proofs/C1-push.md §NON TESTÉ.
 *
 *  TOUTE RÉPONSE : fire-and-forget côté /api/dms (jamais bloquant — même
 *  règle que relayNotify : « le temps réel ne doit JAMAIS bloquer l'API »).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ⚠️ web-push est CommonJS SANS export default — Turbopack (Next 16) refuse
// `import webpush from "web-push"` (ModuleBuildError attrapé par le harnais
// C1 au premier run) : import NAMESPACE interop obligatoire.
import * as webpush from "web-push";
import { getRateStore } from "@/lib/mbote/state-store";

/** Rate limit OUTBOUND (directive : « 1 push / 30s / destinataire »). */
const OUTBOUND_PER_WINDOW = 1;
const OUTBOUND_WINDOW_MS = 30_000;

/** Clefs VAPID — fail-closed : sans clés, AUCUN envoi (log warn une fois). */
let vapidConfigured: boolean | null = null;

function configureVapid(): boolean {
  if (vapidConfigured !== null) return vapidConfigured;
  const pub = process.env.VAPID_PUBLIC_KEY ?? "";
  const priv = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@mbotemesh.aenews.online";
  if (!pub || !priv) {
    console.warn(
      "[push:sender] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY absentes — push DÉSACTIVÉ (fail-closed). " +
        "Générer : bunx web-push generate-vapid-keys"
    );
    vapidConfigured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidConfigured = true;
  } catch (e) {
    console.warn("[push:sender] clés VAPID invalides — push DÉSACTIVÉ :", e instanceof Error ? e.message : e);
    vapidConfigured = false;
  }
  return vapidConfigured;
}

/** Clé publique VAPID pour l'UI (applicationServerKey du subscribe). */
export function vapidPublicKey(): string | null {
  return configureVapid() ? (process.env.VAPID_PUBLIC_KEY ?? null) : null;
}

export interface PushKnock {
  /** type fermé V1 — le seul scénario est un DM reçu (C4 étendra aux groupes) */
  type: "new_message";
  /** libellé PUBLIC de l'expéditeur (nickname annuaire — jamais de contenu) */
  fromLabel: string;
}

/**
 * Envoie le knock à TOUTES les subscriptions actives d'un destinataire.
 * Fire-and-forget assumé : les erreurs sont loguées, jamais propagées.
 */
export async function sendPushToUser(recipientKey: string, knock: PushKnock): Promise<void> {
  if (!configureVapid()) return; // fail-closed : rien à faire

  // rate limit OUTBOUND : 1 push / 30 s / destinataire (anti-spam conversation rapide)
  const rates = getRateStore();
  const gate = rates.hit(`push-out:${recipientKey}`, OUTBOUND_PER_WINDOW, OUTBOUND_WINDOW_MS);
  if (!gate.allowed) {
    console.warn(
      `[push:sender] rate limit outbound pour ${recipientKey.slice(0, 12)}… — knock ignoré (retry ${Math.ceil(gate.retryAfterMs / 1000)} s)`
    );
    return;
  }

  const { db } = await import("@/lib/db");
  const subs = await db.pushSubscription.findMany({
    where: { userId: recipientKey, disabledAt: null },
    select: { id: true, endpoint: true, keysP256dh: true, keysAuth: true },
  });
  if (subs.length === 0) return;

  // KNOCK-ONLY : la SEULE chose qui traverse est ce payload
  const payload = JSON.stringify({ type: knock.type, fromLabel: knock.fromLabel });
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        // PREUVE (directive C1 : « Payload Wireshark-like → aucun contenu
        // visible ») : le log sert de capture côté serveur — le payload est
        // knock-only PAR CONSTRUCTION (ce log ne peut donc rien fuiter).
        console.warn(`[push:sender] payload knock → ${payload}`);
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth },
          },
          payload,
          { TTL: 3600 }
        );
      } catch (e) {
        if (e instanceof webpush.WebPushError) {
          if (e.statusCode === 410) {
            // abonnement mort : purge DOUCE (disabledAt, la ligne reste)
            await db.pushSubscription
              .updateMany({
                where: { id: sub.id, disabledAt: null },
                data: { disabledAt: new Date() },
              })
              .catch(() => undefined);
            console.warn(`[push:sender] 410 Gone → subscription ${sub.id.slice(0, 8)}… désactivée`);
            return;
          }
          if (e.statusCode === 429) {
            // backoff : le rate limit outbound devrait éviter ce cas — log et
            // LAISSER tomber (pas de retry actif en V1 : le prochain DM rejouera)
            console.warn(`[push:sender] 429 du push service (backoff passif) — endpoint ${sub.id.slice(0, 8)}…`);
            return;
          }
          console.warn(`[push:sender] erreur push ${e.statusCode} — endpoint ${sub.id.slice(0, 8)}… : ${e.body?.slice(0, 120) ?? ""}`);
          return;
        }
        console.warn("[push:sender] erreur inconnue :", e instanceof Error ? e.message : e);
      }
    })
  );
}
