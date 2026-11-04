"use client";

/**
 * Panneau « Routeur » (DORS maison) — NetworkView.
 * Montre en direct :
 *   • la santé de chaque transport (sonde RTT, voisins BLE…)
 *   • le journal des décisions de routage (action, raison, latence)
 * Transparence totale : l'utilisateur VOIT pourquoi son message voyage.
 */

import { useEffect, useState } from "react";
import { Bluetooth, CheckCircle2, Clock, Router, Wifi, WifiOff, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  getWebRouter,
  type RouteAction,
  type RouteDecision,
  type TransportHealth,
} from "@/lib/mbote/transports";

const ACTION_LABEL: Record<RouteAction, string> = {
  ble: "BLE",
  internet: "INTERNET",
  queued: "OUTBOX",
};

const ACTION_CLASS: Record<RouteAction, string> = {
  ble: "border-emerald-500/40 text-emerald-500",
  internet: "border-primary/40 text-primary",
  queued: "border-amber-500/40 text-amber-500",
};

const JOURNAL_MAX = 30;

export function RouteurPanel() {
  const [health, setHealth] = useState<TransportHealth[]>([]);
  const [decisions, setDecisions] = useState<RouteDecision[]>([]);

  useEffect(() => {
    const { router, bridge } = getWebRouter();

    // synchronisation initiale avec le store externe (differée : jamais de
    // setState synchrone dans le corps de l'effet)
    const initial = setTimeout(() => {
      setHealth(router.healthSnapshot());
      setDecisions(router.decisions(JOURNAL_MAX));
    }, 0);

    const off = router.onDecision((d) => {
      setDecisions((prev) => [d, ...prev].slice(0, JOURNAL_MAX));
      setHealth(router.healthSnapshot());
    });

    // rafraîchissement de la santé + resynchronisation on/offline navigateur
    const tick = setInterval(() => setHealth(router.healthSnapshot()), 5000);
    const onOnline = () => {
      bridge.invalidateProbe();
      setHealth(router.healthSnapshot());
    };
    const onOffline = () => setHealth(router.healthSnapshot());
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      clearTimeout(initial);
      off();
      clearInterval(tick);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const internet = health.find((h) => h.id === "internet");

  return (
    <Card className="border-primary/25">
      <CardContent className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-bold tracking-tight">
              <Router className="size-4 text-primary" aria-hidden="true" />
              Routeur de transports (DORS) — décisions en direct
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Chaque paquet sortant est évalué par la politique §3.1 :{" "}
              <strong>BLE si ≥ 1 voisin</strong> (avec copie outbox), sinon{" "}
              <strong>Internet</strong> si la sonde RTT est OK, sinon le paquet{" "}
              <strong>dort dans l&apos;outbox</strong> (spray-and-wait). Le journal
              ci-dessous trace chaque décision — rien n&apos;est opaque.
            </p>
          </div>
          <Badge variant="outline" className="gap-1.5 py-1">
            <Clock className="size-3.5" aria-hidden="true" />
            journal · {decisions.length}
          </Badge>
        </div>

        {/* santé des transports */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border bg-background/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                {internet?.available === false ? (
                  <WifiOff className="size-4 text-amber-500" aria-hidden="true" />
                ) : (
                  <Wifi className="size-4 text-primary" aria-hidden="true" />
                )}
                Internet → pont VPS
              </p>
              <Badge
                variant="outline"
                className={
                  internet?.available
                    ? "border-emerald-500/40 text-emerald-500"
                    : "border-amber-500/40 text-amber-500"
                }
              >
                {internet?.available ? "prêt" : "attente sonde"}
              </Badge>
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              {internet?.detail ?? "sonde en cours…"}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              priorité 10 · canal confirmé (accusé accepted/duplicate)
            </p>
          </div>

          {/* a11y : plus d'opacity-70 — le muted-foreground à 70 % tombait
              sous le seuil de contraste WCAG AA (audit axe Vague 6). */}
          <div className="rounded-xl border bg-background/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Bluetooth className="size-4 text-muted-foreground" aria-hidden="true" />
                Mesh BLE
              </p>
              <Badge variant="outline" className="text-muted-foreground">
                natif mobile
              </Badge>
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              transport priorité 0 de l&apos;app native (module mbote-ble) — hors scope
              navigateur
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              livraison « au mieux » + copie outbox jusqu&apos;à confirmation
            </p>
          </div>
        </div>

        {/* journal des décisions */}
        <div className="mt-4">
          <h4 className="text-sm font-semibold">Journal de routage</h4>
          {decisions.length === 0 ? (
            <div className="mt-2 flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
              <Router className="size-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-xs text-muted-foreground">
                Aucune décision encore — encapsulez puis transmettez un paquet dans le
                tunnel ci-dessous : chaque paquet sera routé individuellement.
              </p>
            </div>
          ) : (
            <ul
              className="mt-2 max-h-56 space-y-1.5 overflow-y-auto scrollbar-thin pr-1 font-mono text-[11px]"
              aria-label="Journal des décisions de routage"
            >
              {decisions.map((d) => (
                <li
                  key={d.id}
                  className="flex items-start gap-2 rounded-lg border bg-background/60 px-2.5 py-2"
                >
                  {d.delivered ? (
                    <CheckCircle2
                      className="mt-0.5 size-3.5 shrink-0 text-emerald-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <XCircle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                  )}
                  <span className="text-muted-foreground">
                    {new Date(d.at).toLocaleTimeString()}
                  </span>
                  <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${ACTION_CLASS[d.action]}`}>
                    {ACTION_LABEL[d.action]}
                  </Badge>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">
                    {d.bytes} o{d.trace ? ` · ${d.trace}` : ""} · {d.detail}
                    {d.latencyMs !== undefined ? ` · ${d.latencyMs} ms` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-muted-foreground">
            OUTBOX = le paquet attend un canal (store-and-forward, purge par ack du pont —
            la file durable expo-sqlite / IndexedDB arrive en P2).
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
