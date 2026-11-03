"use client";

import { useEffect } from "react";

/**
 * Enregistre le service worker (PWA offline-first) — PRODUCTION uniquement.
 * En développement (sandbox), il reste inactif pour ne pas gêner le HMR :
 * le manifest reste actif partout, l'app reste installable.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((e) => console.warn("[pwa] service worker non enregistré", e));
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
