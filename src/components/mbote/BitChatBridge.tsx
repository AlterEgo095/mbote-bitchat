"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Binary,
  Bluetooth,
  ClipboardCopy,
  CloudUpload,
  PackageOpen,
  RefreshCw,
  Router,
  Send,
  Smartphone,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { apiBridgeDownlink, type BridgeDownlink } from "@/lib/mbote/api";
import {
  PACKET_TYPE_NAMES,
  PAYLOAD_MAX_BYTES,
  PKT_PUBLIC,
  PROTOCOL_VERSION,
  TTL_DENSE,
  TTL_MAX,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  describePacket,
  encodeMeshEvent,
  encodePacket,
  fragmentPayload,
  fnv64,
  hexDump,
  retransmitJitter,
  senderIdFromPubkey,
  shortSenderId,
  ttlForDensity,
  type MeshEvent,
} from "@/lib/mbote/bitchat-protocol";
import { CITY_PRESETS } from "@/lib/mbote/constants";
import { generateKeyBundle, signPayload } from "@/lib/mbote/crypto";
import { encodeGeohash } from "@/lib/mbote/geohash";
import { useI18n } from "@/lib/mbote/i18n";
import { loadIdentity, loadIdentityMeta } from "@/lib/mbote/identity";
import { getWebOutbox, type OutboxItem } from "@/lib/mbote/transports";
import { getWebRouter } from "@/lib/mbote/transports";

/** Un paquet en attente dans l'outbox durable de la passerelle (vue UI) */
interface QueuedPacket {
  id: string;
  base64: string;
  bytes: number;
  hash: string;
  typeName: string;
  hops: number;
  senderId: string;
  meshLatencyMs: number;
  preview: string;
  fragLabel?: string; // « frag 1/2 » si le post a été fragmenté
  createdAt: number;
  attempts: number; // P2 : tentatives de flush déjà échouées
  nextAttemptAt: number; // P2 : backoff courant
}

/** Projette un item durable de l'outbox vers la vue UI du tunnel. */
function itemToQueued(it: OutboxItem): QueuedPacket {
  const desc = describePacket(base64ToBytes(it.base64));
  return {
    id: it.id,
    base64: it.base64,
    bytes: desc.totalBytes,
    hash: desc.hash,
    typeName: desc.typeName,
    hops: Number(it.meta?.hops ?? 0),
    senderId: bytesToHex(desc.header.senderId).toUpperCase(),
    meshLatencyMs: Number(it.meta?.meshLatencyMs ?? 0),
    // i18n : repli « contenu opaque » résolu au rendu via t("bridge.previewOpaque")
    preview: it.meta?.preview ?? "",
    fragLabel: it.meta?.fragLabel,
    createdAt: it.enqueuedAt,
    attempts: it.attempts,
    nextAttemptAt: it.nextAttemptAt,
  };
}

const CANAL_NONE = "__global__";

export function BitChatBridge() {
  const qc = useQueryClient();
  const { t, tp, fmt } = useI18n();
  // P2 : outbox durable (IndexedDB, repli localStorage) — les paquets en
  // attente survivent au rechargement de la page et reflushent tout seuls.
  const outbox = useMemo(() => getWebOutbox(), []);

  const [draft, setDraft] = useState("");
  const [neighbors, setNeighbors] = useState(3);
  const [hops, setHops] = useState(3);
  const [channel, setChannel] = useState<string>(CANAL_NONE);
  const [queue, setQueue] = useState<QueuedPacket[]>([]);
  const [outboxKind, setOutboxKind] = useState<string>("");
  const [downlink, setDownlink] = useState<BridgeDownlink | null>(null);
  const [sending, setSending] = useState(false);
  const [showHex, setShowHex] = useState<string | null>(null);
  const [hasIdentity, setHasIdentity] = useState(false);

  useEffect(() => {
    // F-06 : lecture publique synchronisée (les clés privées sont en IndexedDB)
    setHasIdentity(!!loadIdentityMeta());
  }, []);

  // P2 : la file affichée EST l'outbox durable (source unique)
  useEffect(() => {
    let mounted = true;
    void outbox.ready().then(() => {
      if (!mounted) return;
      setQueue(outbox.snapshot().map(itemToQueued));
      setOutboxKind(outbox.storageKind);
    });
    const unsub = outbox.onChange(() => {
      setQueue(outbox.snapshot().map(itemToQueued));
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, [outbox]);

  // TTL effectif selon la densité (whitepaper §3.1 : ≥6 voisins → clamp 5)
  const ttlEff = ttlForDensity(neighbors);
  const maxHops = ttlEff - 1;

  useEffect(() => {
    if (hops > maxHops) setHops(maxHops);
  }, [maxHops, hops]);

  const cityChannels = useMemo(
    () =>
      CITY_PRESETS.slice(0, 8).map((c) => ({
        value: encodeGeohash(c.lat, c.lng, 5),
        label: `${c.name} (${c.country})`,
      })),
    []
  );

  /** identité de l'émetteur : réelle si l'utilisateur en a une, sinon pair
   *  éphémère (rotative, fidèle BitChat) — mais TOUJOURS munie d'une vraie
   *  paire P-256 et d'une signature valide : le pont refuse désormais tout
   *  post non signé (F-01). L'horodatage signé est en MILLISECONDES (ms),
   *  comme partout ailleurs (alignement F-16 côté émission). */
  const resolveSender = async () => {
    const ts = Date.now();
    const id = await loadIdentity();
    if (id) {
      const signature = await signPayload(id.signPriv, `${id.pubkey}|${draft.trim()}|${ts}`);
      return { pubkey: id.pubkey, nickname: id.nickname, ecdhPub: id.ecdhPub, signature, ts };
    }
    const bundle = await generateKeyBundle();
    const signature = await signPayload(
      bundle.signPriv,
      `${bundle.pubkey}|${draft.trim()}|${ts}`
    );
    return {
      pubkey: bundle.pubkey,
      nickname: `pair-${shortSenderId(senderIdFromPubkey(bundle.pubkey))}`,
      ecdhPub: bundle.ecdhPub,
      signature,
      ts,
    };
  };

  const gatewayId = useMemo(() => {
    const id = loadIdentityMeta();
    return bytesToHex(senderIdFromPubkey(id?.pubkey ?? "mbote-browser-gateway")).toUpperCase();
  }, []);

  /** Étape 1 : encapsuler le message en paquet(s) binaire(s) BitChat —
   *  un post long est fragmenté comme sur un vrai appareil (§2 whitepaper) */
  const encapsulate = async () => {
    const content = draft.trim();
    if (!content) return;
    const sender = await resolveSender();
    // en-tête de paquet : secondes unix (protocole) — l'événement signé, lui,
    // porte l'horodatage ms de la signature (sender.ts)
    const tsSec = Math.floor(Date.now() / 1000);
    const jitterChain = Array.from({ length: hops }, () => retransmitJitter());
    const ev: MeshEvent = {
      kind: "post",
      clientRef: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pubkey: sender.pubkey,
      nickname: sender.nickname,
      ecdhPub: sender.ecdhPub,
      content,
      geohash: channel === CANAL_NONE ? null : channel,
      precision: channel === CANAL_NONE ? null : 5,
      parentId: null,
      signature: sender.signature,
      ts: sender.ts,
    };
    const ttl = Math.max(1, ttlEff - hops);
    const senderId = senderIdFromPubkey(sender.pubkey);
    const payload = encodeMeshEvent(ev);
    const chunks =
      payload.length <= PAYLOAD_MAX_BYTES
        ? [payload]
        : fragmentPayload(payload, parseInt(fnv64(payload).slice(0, 4), 16));

    const newPkts: QueuedPacket[] = chunks.map((chunk, i) => {
      const bytes = encodePacket({
        version: PROTOCOL_VERSION,
        type: PKT_PUBLIC,
        ttl,
        senderId,
        timestamp: tsSec,
        payloadLen: chunk.length,
        payload: chunk,
      });
      const desc = describePacket(bytes);
      return {
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        base64: bytesToBase64(bytes),
        bytes: desc.totalBytes,
        hash: desc.hash,
        typeName: desc.typeName,
        hops,
        senderId: bytesToHex(desc.header.senderId).toUpperCase(),
        meshLatencyMs: jitterChain.reduce((a, b) => a + b, 0),
        preview: content,
        fragLabel: chunks.length > 1 ? `frag ${i + 1}/${chunks.length}` : undefined,
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
      };
    });
    // P2 : écriture durable immédiate — même un F5 ou un kill d'onglet ne
    // perd plus les paquets ; le flush automatique (online/visibility/5 min)
    // les remontera au pont dès qu'un canal existe.
    await outbox.enqueueMany(
      newPkts.map((p) => ({
        id: p.id,
        base64: p.base64,
        trace: `${p.typeName}${p.fragLabel ? ` ${p.fragLabel}` : ""}`,
        meta: {
          preview: p.preview,
          hops: String(p.hops),
          meshLatencyMs: String(p.meshLatencyMs),
          ...(p.fragLabel ? { fragLabel: p.fragLabel } : {}),
        },
      }))
    );
    setDraft("");
    const totalBytes = newPkts.reduce((a, p) => a + p.bytes, 0);
    toast.success(
      chunks.length > 1
        ? tp("bridge.toastFragmented", newPkts.length, {
            bytes: fmt.fmtNumber(totalBytes),
            ttl,
          })
        : t("bridge.toastEncapsulated", { bytes: fmt.fmtNumber(totalBytes), ttl }),
      {
        description:
          hops > 0
            ? tp("bridge.toastJitter", hops, { ms: fmt.fmtNumber(newPkts[0].meshLatencyMs) })
            : t("bridge.toastDirect", { storage: outbox.storageKind }),
      }
    );
  };

  /** Étape 2 : le routeur DORS trouve un canal → chaque paquet est routé
   *  individuellement (BLE indisponible côté web → Internet ou outbox) et la
   *  décision est journalisée dans le panneau Routeur. P2 : les paquets sans
   *  canal DORMENT dans l'outbox durable (spray-and-wait) — reflush auto sur
   *  regain réseau / foreground / timer, purge par ack du pont. */
  const transmit = async () => {
    if (queue.length === 0 || sending) return;
    setSending(true);
    try {
      const { router } = getWebRouter();
      const results: { hash: string; status: string; detail?: string }[] = [];

      for (const p of queue) {
        const d = await router.submit(base64ToBytes(p.base64), {
          trace: `${p.typeName}${p.fragLabel ? ` ${p.fragLabel}` : ""}`,
        });
        if (d.action === "queued") {
          // aucun canal : le paquet DORT dans l'outbox durable (backoff P2)
          results.push({ hash: p.hash, status: "outbox", detail: d.detail });
          await outbox.recordAttempt(p.id, false, d.detail);
        } else if (d.delivered) {
          results.push({
            hash: p.hash,
            status: d.detail.includes("déjà connu") ? "duplicate" : "accepted",
            detail: d.detail,
          });
          await outbox.recordAttempt(p.id, true); // ack = purge durable
        } else {
          // paquet refusé par le pont (invalid) : purgé, comme côté natif
          results.push({ hash: p.hash, status: "invalid", detail: d.detail });
          await outbox.recordAttempt(p.id, true);
        }
      }

      const accepted = results.filter((r) => r.status === "accepted").length;
      const duplicates = results.filter((r) => r.status === "duplicate").length;
      const queuedN = results.filter((r) => r.status === "outbox").length;
      toast.success(
        tp("bridge.toastRouted", accepted + duplicates, { queued: fmt.fmtNumber(queuedN) }),
        {
          description:
            queuedN > 0
              ? t("bridge.toastPendingDesc")
              : t("bridge.toastInjectedDesc"),
        }
      );
      if (accepted > 0) await qc.invalidateQueries({ queryKey: ["feed"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.txFailed"));
    } finally {
      setSending(false);
    }
  };

  /** Étape 3 (sens inverse) : le downlink à redistribuer en BLE localement */
  const pullDownlink = async () => {
    try {
      const dl = await apiBridgeDownlink(gatewayId);
      setDownlink(dl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.downlinkFailed"));
    }
  };

  return (
    <Card className="border-primary/25">
      <CardContent className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-bold tracking-tight">
              <Bluetooth className="size-4 text-primary" aria-hidden="true" />
              {t("bridge.title")}
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {t("bridge.desc1")}
              <strong> {t("bridge.descPacket")}</strong> {t("bridge.desc2")}
              <strong> {t("bridge.descGateway")}</strong> {t("bridge.desc3")}{" "}
              <code className="font-mono">/api/mesh/bridge</code> {t("bridge.desc4")}
            </p>
          </div>
        </div>

        {/* schéma du chemin */}
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-background/60 p-3 text-[11px]">
          <Badge variant="outline" className="gap-1.5 py-1">
            <Smartphone className="size-3.5" aria-hidden="true" /> {t("bridge.badgeDevice")}
          </Badge>
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <Badge variant="outline" className="gap-1.5 border-primary/40 py-1 text-primary">
            <Bluetooth className="size-3.5" aria-hidden="true" />{" "}
            {tp("bridge.badgeMesh", hops, { ttl: Math.max(1, ttlEff - hops) })}
          </Badge>
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <Badge variant="outline" className="gap-1.5 py-1">
            <Router className="size-3.5" aria-hidden="true" /> {t("bridge.badgeGateway")}
          </Badge>
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <Badge variant="outline" className="gap-1.5 border-primary/40 py-1 text-primary">
            <CloudUpload className="size-3.5" aria-hidden="true" /> VPS /api/mesh/bridge
          </Badge>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {/* ① appareil */}
          <section className="rounded-xl border p-4" aria-label={t("bridge.a11yCompose")}>
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <Smartphone className="size-4 text-primary" aria-hidden="true" />
                {t("bridge.sectionDevice")}
              </h4>
              {!hasIdentity && (
                <Badge variant="outline" className="text-[10px]">
                  {t("bridge.ephemeralIdentity")}
                </Badge>
              )}
            </div>

            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder={t("bridge.placeholderDraft")}
              className="mt-3 min-h-[72px] text-sm"
              aria-label={t("bridge.a11yDraft")}
            />

            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-muted-foreground">
                  {t("bridge.neighborsLabel")} <span className="font-mono font-semibold text-foreground">{neighbors}</span>
                </Label>
                <Slider
                  value={[neighbors]}
                  onValueChange={([v]) => setNeighbors(v)}
                  min={0}
                  max={9}
                  step={1}
                  className="mt-2"
                  aria-label={t("bridge.a11yNeighbors")}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {neighbors >= 6 ? (
                    <span className="text-amber-500">
                      {t("bridge.ttlDense", { ttl: TTL_DENSE })}
                    </span>
                  ) : (
                    <>{t("bridge.ttlEffective", { ttl: TTL_MAX })}</>
                  )}
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  {t("bridge.hopsLabel")} <span className="font-mono font-semibold text-foreground">{hops}</span>
                </Label>
                <Slider
                  value={[hops]}
                  onValueChange={([v]) => setHops(v)}
                  min={0}
                  max={maxHops}
                  step={1}
                  className="mt-2"
                  aria-label={t("bridge.a11yHops")}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">{t("bridge.maxHops", { count: maxHops })}</p>
              </div>
            </div>

            <div className="mt-3">
              <Label className="text-xs text-muted-foreground">{t("bridge.channelLabel")}</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger size="sm" className="mt-1.5" aria-label={t("bridge.a11yChannel")}>
                  <SelectValue placeholder={t("bridge.channelPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CANAL_NONE}>{t("bridge.noChannel")}</SelectItem>
                  {cityChannels.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.value} · {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button onClick={encapsulate} disabled={!draft.trim()} className="mt-4 w-full">
              <Send className="size-4" aria-hidden="true" />
              {t("bridge.encapsulate")}
            </Button>
          </section>

          {/* ② passerelle */}
          <section className="rounded-xl border p-4" aria-label={t("bridge.a11yOutbox")}>
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <Router className="size-4 text-primary" aria-hidden="true" />
                {t("bridge.sectionOutbox")}
              </h4>
              <Badge variant="outline" className="gap-1.5 font-mono text-[10px]">
                GW {gatewayId.slice(0, 8)}
                {outboxKind && (
                  <span className="border-l pl-1.5 text-primary">{outboxKind}</span>
                )}
              </Badge>
            </div>

            {queue.length === 0 ? (
              <div className="mt-3 flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
                <PackageOpen className="size-6 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  {t("bridge.outboxEmptyTitle")}<br />
                  {t("bridge.outboxEmptyBody", { storage: outboxKind || "IndexedDB" })}
                </p>
              </div>
            ) : (
              <ul className="mt-3 max-h-52 space-y-2 overflow-y-auto scrollbar-thin pr-1" aria-label={t("bridge.a11yQueue")}>
                {queue.map((p, i) => {
                  // F-48 : l'en-tête n'est décodé que si le dump hex est ouvert
                  const expanded = showHex === p.id;
                  const pHeader = expanded
                    ? describePacket(base64ToBytes(p.base64)).header
                    : null;
                  return (
                    <li key={p.id} className="rounded-lg border bg-background/60 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="font-mono text-[10px]">
                            #{i + 1} {p.typeName}
                            {p.fragLabel ? ` · ${p.fragLabel}` : ""}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {tp("bridge.pktMeta", p.hops, {
                              bytes: fmt.fmtNumber(p.bytes),
                              hash: p.hash.slice(0, 8),
                            })}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            onClick={() => setShowHex(expanded ? null : p.id)}
                            aria-label={t("bridge.a11yHexToggle", { n: i + 1 })}
                            aria-expanded={expanded}
                          >
                            <Binary className="size-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            onClick={() => void outbox.purge([p.id])}
                            aria-label={t("bridge.a11yRemove", { n: i + 1 })}
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {t("bridge.previewLine", { preview: p.preview || t("bridge.previewOpaque") })}
                      </p>
                      {p.attempts > 0 && (
                        <p className="mt-1 font-mono text-[10px] text-amber-500">
                          {tp("bridge.backoff", p.attempts, {
                            when:
                              p.nextAttemptAt > Date.now()
                                ? t("bridge.reflushIn", { s: Math.ceil((p.nextAttemptAt - Date.now()) / 1000) })
                                : t("bridge.reflushSoon"),
                          })}
                        </p>
                      )}
                      {expanded && (
                        <div className="mt-2">
                          <pre className="max-h-32 overflow-auto scrollbar-thin rounded bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-emerald-300">
{hexDump(base64ToBytes(p.base64))}
                          </pre>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                            {t("bridge.headerDecoded", {
                              version: pHeader?.version ?? "?",
                              sender: p.senderId,
                              ttl: pHeader?.ttl ?? "?",
                              type: PACKET_TYPE_NAMES[PKT_PUBLIC],
                            })}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-3 flex gap-2">
              <Button onClick={transmit} disabled={queue.length === 0 || sending} className="flex-1">
                {sending ? (
                  <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CloudUpload className="size-4" aria-hidden="true" />
                )}
                {queue.length > 0 ? tp("bridge.transmit", queue.length) : t("bridge.transmitAll")}
              </Button>
              {queue.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => void outbox.clear()}
                  aria-label={t("bridge.clearOutbox")}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  <span className="sr-only">{t("bridge.clearOutbox")}</span>
                </Button>
              )}
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              {t("bridge.sfNote", { storage: outboxKind || "IndexedDB" })}
            </p>
          </section>
        </div>

        {/* downlink + stats */}
        <section className="mt-4 rounded-xl border p-4" aria-label={t("bridge.a11yDownlink")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold">
              <ClipboardCopy className="size-4 text-primary" aria-hidden="true" />
              {t("bridge.sectionDownlink")}
            </h4>
            <Button variant="outline" size="sm" onClick={pullDownlink}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t("bridge.pullDownlink")}
            </Button>
          </div>

          {downlink && (
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <Stat label={t("bridge.statPackets")} value={fmt.fmtNumber(downlink.packets.length)} />
              <Stat label={t("bridge.statIngested")} value={fmt.fmtNumber(downlink.stats.ingested24h)} />
              <Stat label={t("bridge.statAvgHops")} value={fmt.fmtNumber(downlink.stats.avgHops)} />
              <Stat label={t("bridge.statGateways")} value={fmt.fmtNumber(downlink.stats.gateways.length)} />
              {downlink.packets[0] && (
                <p className="col-span-full truncate font-mono text-[10px] text-muted-foreground">
                  {t("bridge.firstPacket", {
                    bytes: fmt.fmtNumber(downlink.packets[0].bytes),
                    payload: downlink.packets[0].base64.slice(0, 72),
                  })}
                </p>
              )}
            </div>
          )}
          {!downlink && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("bridge.downlinkDesc1")} <code className="font-mono">GET /api/mesh/bridge</code>{" "}
              {t("bridge.downlinkDesc2")}
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background/60 p-3">
      <p className="font-mono text-lg font-bold text-primary">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
