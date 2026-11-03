/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  @mbote/mbote-ble — facade TypeScript du module natif BLE (Android + iOS)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le module natif transporte des OCTETS OPAQUES (paquets BitChat encodés par
 *  le cœur TS). Toute la logique de routage (TTL, dédup, gigue, densité)
 *  reste en TypeScript — la couche native ne connaît que le transport radio :
 *
 *    ┌──────────────────────────────┐
 *    │  TS  : MeshTransport         │  TTL / dédup / jitter / événements
 *    │  TS  : bitchat-protocol      │  encodage binaire BitChat
 *    ├──────────────────────────────┤
 *    │ NATIF : MboteBle (ce module) │  GATT serveur + client, scan, advertise
 *    │        fragmentation BLE     │  frames ≤ MTU-3, réassembly
 *    └──────────────────────────────┘
 *
 *  Contrat natif (identique Android Kotlin / iOS Swift) :
 *    Fonctions : start() stop() send(base64) peers() requestPermissions()
 *                isSupported()
 *    Événements: onPacket{base64,rssi,peerId} onPeerConnected{peerId}
 *                onPeerDisconnected{peerId} onStateChanged{state} onLog{msg}
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  requireNativeModule,
  type EventSubscription,
} from "expo-modules-core";
// Barrel expo-modules-core : EventEmitter n'y est exporté que comme valeur.
// On importe le TYPE générique depuis sa déclaration source.
import type { EventEmitter } from "expo-modules-core/build/ts-declarations/EventEmitter";
import { bytesToBase64, base64ToBytes } from "./ble-base64";

export const MBOTE_SERVICE_UUID = "F7C41D5A-9C6B-4E4F-8D2A-3B1E0C5A6D7F";
export const MBOTE_CHAR_WRITE_UUID = "F7C41D5B-9C6B-4E4F-8D2A-3B1E0C5A6D7F";
export const MBOTE_CHAR_NOTIFY_UUID = "F7C41D5C-9C6B-4E4F-8D2A-3B1E0C5A6D7F";

/** GATT : 3 octets de surcoût ATT (opcode + handle) sur chaque write/notify */
export const ATT_OVERHEAD = 3;
/** MTU par défaut si non négocié (plancher iOS/Android quasi universel) */
export const DEFAULT_MTU = 185;
/** Plafond de connexions GATT simultanées par rôle (stabilité radio) */
export const MAX_PEERS_PER_ROLE = 6;

export interface PeerInfo {
  /** identifiant transport stable de session (sans PII) */
  peerId: string;
  /** dBm — 127 = inconnu */
  rssi: number;
  /** rôle par lequel le pair est joignable */
  roles: ("central" | "peripheral")[];
  since: number;
  lastSeen: number;
}

export interface NativePacket {
  /** paquet BitChat COMPLET (réassemblé côté natif), base64 */
  base64: string;
  rssi: number;
  peerId: string;
}

export interface PermissionResult {
  granted: boolean;
  missing: string[];
}

/** Carte des événements émis par le moteur natif (valeurs = signatures de listeners) */
type MboteBleEvents = {
  onPacket: (pkt: NativePacket) => void;
  onPeerConnected: (e: { peerId: string }) => void;
  onPeerDisconnected: (e: { peerId: string }) => void;
  onStateChanged: (e: MeshStateEvent) => void;
  onLog: (e: { msg: string }) => void;
};

interface MboteBleNativeModule {
  isSupported(): boolean;
  start(): Promise<{ running: boolean }>;
  stop(): Promise<{ running: boolean }>;
  send(base64: string): Promise<{ delivered: number }>;
  peers(): PeerInfo[];
  requestPermissions(): Promise<PermissionResult>;
}

const MboteBle = requireNativeModule<MboteBleNativeModule>("MboteBle");

/** Depuis Expo SDK 52, le module natif EST déjà un EventEmitter — on le retape. */
const emitter = MboteBle as unknown as EventEmitter<MboteBleEvents>;

export interface MeshStateEvent {
  state:
    | "unsupported"
    | "permission_needed"
    | "bluetooth_off"
    | "starting"
    | "running"
    | "stopped";
  detail?: string;
}

export const BleMesh = {
  isSupported: (): boolean => {
    try {
      return MboteBle.isSupported();
    } catch {
      return false;
    }
  },
  start: (): Promise<{ running: boolean }> => MboteBle.start(),
  stop: (): Promise<{ running: boolean }> => MboteBle.stop(),
  /** Envoie un paquet BitChat complet à tous les pairs (fragmentation native) */
  send: (packet: Uint8Array): Promise<{ delivered: number }> =>
    MboteBle.send(bytesToBase64(packet)),
  peers: (): PeerInfo[] => (MboteBle.peers() ?? []) as PeerInfo[],
  requestPermissions: (): Promise<PermissionResult> => MboteBle.requestPermissions(),

  onPacket: (cb: (pkt: NativePacket) => void): EventSubscription =>
    emitter.addListener("onPacket", cb),
  onPeerConnected: (cb: (e: { peerId: string }) => void): EventSubscription =>
    emitter.addListener("onPeerConnected", cb),
  onPeerDisconnected: (cb: (e: { peerId: string }) => void): EventSubscription =>
    emitter.addListener("onPeerDisconnected", cb),
  onStateChanged: (cb: (e: MeshStateEvent) => void): EventSubscription =>
    emitter.addListener("onStateChanged", cb),
  onLog: (cb: (e: { msg: string }) => void): EventSubscription =>
    emitter.addListener("onLog", cb),
};

export { base64ToBytes };

export default MboteBle;
