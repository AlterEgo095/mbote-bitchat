"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Enregistre le service worker (PWA offline-first) — PRODUCTION uniquement.
 * En développement (sandbox), il reste inactif pour ne pas gêner le HMR :
 * le manifest reste actif partout, l'app reste installable.
 *
 * F-26 (audit Vague 5) : flux de mise à jour ANNONCÉ — quand un nouveau SW
 * est en attente d'activation, un toast propose « Mettre à jour » ; le
 * rechargement n'a lieu qu'après consentement (plus jamais de skipWaiting
 * en pleine rédaction).
 *
 * C1 (push) : le clic sur une notification peut poster { type: "NAVIGATE",
 * url } au client (fenêtre déjà ouverte) — navigation SPA-safe via
 * location.assign (l'app relit ?view=… au boot, F-14) ; l'outbox persistée
 * n'est jamais perdue (IndexedDB).
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // C1 : clic sur notification → naviguer vers la cible (vue messages)
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === "NAVIGATE" && typeof data.url === "string") {
        // same-origin garanti par le SW (postMessage same-origin only)
        window.location.assign(data.url);
      }
    };
    navigator.serviceWorker.addEventListener("message", onSwMessage);

    let updateToastShown = false;

    const announceUpdate = (waiting: ServiceWorker) => {
      if (updateToastShown) return;
      updateToastShown = true;
      toast("Nouvelle version disponible", {
        description: "Relancer l'app pour charger la dernière version.",
        duration: Infinity,
        action: {
          label: "Mettre à jour",
          onClick: () => {
            // autorise le nouveau worker, puis recharge quand il prend le contrôle
            waiting.postMessage("SKIP_WAITING");
            navigator.serviceWorker.addEventListener("controllerchange", () => {
              window.location.reload();
            }, { once: true });
          },
        },
      });
    };

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration) => {
          // un worker en attente dès l'arrivée sur la page
          if (registration.waiting && navigator.serviceWorker.controller) {
            announceUpdate(registration.waiting);
          }
          // un worker installé pendant la session
          registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (
                installing.state === "installed" &&
                navigator.serviceWorker.controller
              ) {
                announceUpdate(installing);
              }
            });
          });
        })
        .catch((e) => console.warn("[pwa] service worker non enregistré", e));
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, []);

  return null;
}
