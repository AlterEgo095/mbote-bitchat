/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  AppStore — état global de l'app mobile Mbote (React Context)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • identité persistée (AsyncStorage) : clés ECDSA/ECDH + nickname
 *  • transport mesh (MeshTransport) câblé une seule fois au montage
 *  • messages mesh, pairs BLE, journaux, état de la radio
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadOrCreateKeyBundle, signPayload, wipeIdentity, type KeyBundle } from "../core/crypto-rn";
import { MeshTransport, type MeshMeta } from "../transport/MeshTransport";
import type { MeshEvent } from "../core/bitchat-protocol";
import type { RouteDecision } from "../transport/types";
import type { MeshStateEvent, PeerInfo } from "../../modules/mbote-ble/index";

export interface MeshMessage {
  id: string;
  nickname: string;
  pubkey: string;
  content: string;
  hops: number;
  rssi: number;
  at: number;
  mine: boolean;
}

const NICK_KEY = "mbote.nickname.v1";
const BRIDGE_URL_KEY = "mbote.bridgeUrl.v1";
// F-47 : le fil de messages survit au kill de l'app (AsyncStorage, plafond 200)
const MESSAGES_KEY = "mbote.messages.v1";
const MAX_MESSAGES = 200;
const MAX_LOGS = 60;
const MAX_DECISIONS = 30;

interface AppState {
  ready: boolean;
  identity: KeyBundle | null;
  nickname: string;
  bridgeUrl: string;
  messages: MeshMessage[];
  peers: PeerInfo[];
  meshState: MeshStateEvent["state"] | "stopped";
  logs: string[];
  transport: MeshTransport;
  bridgeQueueSize: number;
  /** journal des décisions de routage DORS (plus récentes d'abord) */
  routeDecisions: RouteDecision[];
  setNickname: (n: string) => Promise<void>;
  setBridgeUrl: (u: string) => Promise<void>;
  sendPost: (content: string) => Promise<void>;
  syncBridge: () => Promise<string>;
  resetIdentity: () => Promise<void>;
  refreshPeers: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp hors AppProvider");
  return ctx;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const transportRef = useRef<MeshTransport>(new MeshTransport());
  const transport = transportRef.current;

  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<KeyBundle | null>(null);
  const [nickname, setNicknameState] = useState("mbote");
  const [bridgeUrl, setBridgeUrlState] = useState("");
  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [meshState, setMeshState] = useState<MeshStateEvent["state"] | "stopped">("stopped");
  const [logs, setLogs] = useState<string[]>([]);
  const [bridgeQueueSize, setBridgeQueueSize] = useState(0);
  const [routeDecisions, setRouteDecisions] = useState<RouteDecision[]>([]);

  const pushLog = useCallback((msg: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    setLogs((prev) => [line, ...prev].slice(0, MAX_LOGS));
  }, []);

  const appendMessage = useCallback((m: MeshMessage) => {
    setMessages((prev) => {
      const next = [m, ...prev].slice(0, MAX_MESSAGES);
      // F-47 : persistance du transcript (fire-and-forget — jamais bloquant)
      void AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  // ── câblage du transport (une fois) ──
  useEffect(() => {
    transport.onLog = pushLog;
    transport.onStateChange = (s) => setMeshState(s);
    transport.onPeersChange = (p) => setPeers(p);
    transport.onRouteDecision = (d) =>
      setRouteDecisions((prev) => [d, ...prev].slice(0, MAX_DECISIONS));
    // P2 : compteur réactif de l'outbox durable (sqlite)
    transport.onOutboxChange = (n) => setBridgeQueueSize(n);

    transport.onEvent = (ev: MeshEvent, meta: MeshMeta) => {
      if (ev.kind === "post") {
        appendMessage({
          id: ev.clientRef,
          nickname: ev.nickname || "anonyme",
          pubkey: ev.pubkey,
          content: ev.content,
          hops: meta.hops,
          rssi: meta.rssi,
          at: meta.at,
          mine: false,
        });
      }
      // kind "announce" : la présence est reflétée par le rafraîchissement des pairs
    };
  }, [transport, appendMessage, pushLog]);

  // ── démarrage : identité → mesh ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bundle = await loadOrCreateKeyBundle();
        const storedNick = await AsyncStorage.getItem(NICK_KEY);
        const storedUrl = await AsyncStorage.getItem(BRIDGE_URL_KEY);
        // F-47 : le transcript persisté est restauré au démarrage (plafond 200)
        const storedMessages = await AsyncStorage.getItem(MESSAGES_KEY);
        let restoredMessages: MeshMessage[] = [];
        if (storedMessages) {
          try {
            const parsed: unknown = JSON.parse(storedMessages);
            if (Array.isArray(parsed)) {
              restoredMessages = (parsed as MeshMessage[])
                .filter((m) => m && typeof m.id === "string" && typeof m.content === "string")
                .slice(0, MAX_MESSAGES);
            }
          } catch {
            /* transcript illisible → démarrage à vide */
          }
        }
        if (cancelled) return;
        setIdentity(bundle);
        setNicknameState(storedNick || `mbote-${bundle.pubkey.slice(0, 4)}`);
        setBridgeUrlState(storedUrl || "");
        if (restoredMessages.length > 0) {
          setMessages(restoredMessages);
          pushLog(`transcript restauré (${restoredMessages.length} message(s))`);
        }
        pushLog("identité chargée (clés locales)");
        // F-05 : l'URL du pont persistée est réappliquée AU TRANSPORT avant le
        // démarrage — l'outbox et le downlink survivent au redémarrage de l'app.
        transport.setBridgeUrl(storedUrl || "");
        await transport.start({
          pubkey: bundle.pubkey,
          nickname: storedNick || `mbote-${bundle.pubkey.slice(0, 4)}`,
          ecdhPub: bundle.ecdhPub,
        });
      } catch (t) {
        pushLog(`erreur de démarrage : ${t instanceof Error ? t.message : "?"}`);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      transport.stop();
    };
  }, [transport, pushLog]);

  const setNickname = useCallback(
    async (n: string) => {
      const clean = n.trim().slice(0, 24) || "anonyme";
      setNicknameState(clean);
      await AsyncStorage.setItem(NICK_KEY, clean);
      if (identity) {
        await transport.announce(); // re-publie la présence avec le nouveau nom
      }
      pushLog(`nickname → ${clean}`);
    },
    [identity, transport, pushLog]
  );

  const setBridgeUrl = useCallback(async (u: string) => {
    const clean = u.trim();
    setBridgeUrlState(clean);
    await AsyncStorage.setItem(BRIDGE_URL_KEY, clean);
    // F-05 : le transport est configuré immédiatement (outbox + downlink vivants
    // sans attendre une sync manuelle)
    transport.setBridgeUrl(clean);
  }, [transport]);

  const sendPost = useCallback(
    async (content: string) => {
      const text = content.trim().slice(0, 500);
      if (!text || !identity) return;
      const ts = Date.now();
      const clientRef = `${identity.pubkey.slice(0, 8)}-${ts}-${Math.floor(Math.random() * 1e6)}`;
      const signature = await signPayload(identity.signPrivHex, `${identity.pubkey}|${text}|${ts}`);
      await transport.publish({
        kind: "post",
        clientRef,
        pubkey: identity.pubkey,
        nickname,
        ecdhPub: identity.ecdhPub,
        content: text,
        geohash: null,
        precision: null,
        parentId: null,
        signature,
        ts,
      });
      appendMessage({
        id: clientRef,
        nickname,
        pubkey: identity.pubkey,
        content: text,
        hops: 0,
        rssi: 0,
        at: ts,
        mine: true,
      });
      setBridgeQueueSize(transport.bridgeQueueSize);
    },
    [identity, nickname, transport, appendMessage]
  );

  const syncBridge = useCallback(async () => {
    if (!bridgeUrl) return "URL du pont non configurée (onglet Profil)";
    const res = await transport.syncBridge(bridgeUrl);
    setBridgeQueueSize(transport.bridgeQueueSize);
    if (res.ok) {
      return `pont : ${res.accepted} accepté(s), ${res.duplicate} déjà connu(s)`;
    }
    return `pont : échec — ${res.error}`;
  }, [bridgeUrl, transport]);

  const resetIdentity = useCallback(async () => {
    transport.stop();
    // F-11 : la promesse UI « tout est détruit » est tenue —
    //  · coffre SecureStore + vestiges AsyncStorage (wipeIdentity)
    //  · outbox durable SQLite (et son repli AsyncStorage)
    //  · nickname, URL du pont, messages, décisions de routage
    await wipeIdentity();
    try {
      await transport.outbox.clear();
    } catch {
      /* outbox déjà vide / store absent */
    }
    try {
      await AsyncStorage.multiRemove([
        NICK_KEY,
        BRIDGE_URL_KEY,
        MESSAGES_KEY, // F-47 : le transcript persisté fait partie du wipe
        "mbote.outbox.packets.v1", // repli AsyncStorage de l'outbox durable
      ]);
    } catch {
      /* rien à effacer */
    }
    transport.setBridgeUrl("");
    setMessages([]);
    setPeers([]);
    setIdentity(null);
    setNicknameState("mbote");
    setBridgeUrlState("");
    setBridgeQueueSize(0);
    setRouteDecisions([]);
    pushLog("identité et état local effacés — redémarrez l'app");
  }, [transport, pushLog]);

  const refreshPeers = useCallback(() => {
    // le transport re-publie la liste à chaque événement de pair
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      identity,
      nickname,
      bridgeUrl,
      messages,
      peers,
      meshState,
      logs,
      transport,
      bridgeQueueSize,
      routeDecisions,
      setNickname,
      setBridgeUrl,
      sendPost,
      syncBridge,
      resetIdentity,
      refreshPeers,
    }),
    [
      ready,
      identity,
      nickname,
      bridgeUrl,
      messages,
      peers,
      meshState,
      logs,
      transport,
      bridgeQueueSize,
      routeDecisions,
      setNickname,
      setBridgeUrl,
      sendPost,
      syncBridge,
      resetIdentity,
      refreshPeers,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
