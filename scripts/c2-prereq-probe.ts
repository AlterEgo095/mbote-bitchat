/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C2 — SONDES DE PRÉREQUIS BLOQUANTS (exécuter AVANT tout code d'appels)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/c2-prereq-probe.ts
 *
 *  P1. TURN réel joignable : un serveur TURN (node-turn en process local —
 *      coturn/docker indisponibles en sandbox : pas de root, constat §preuve)
 *      démarré sur 127.0.0.1:3478, puis UNE RTCPeerConnection configurée
 *      iceTransportPolicy:'relay' (SEUL le relay TURN est autorisé) échange
 *      l'audio avec une seconde PC locale. Succès = le chemin TURN/relay
 *      fonctionne avec un client WebRTC réel (plus fort que turnutils_uclient :
 *      c'est le VRAI chemin de production DTLS-SRTP).
 *  P2. DTLS-SRTP disponible dans le Chromium Playwright : deux PC en
 *      host-candidates échantillonnent un flux fake (fake device), se
 *      connectent, et getStats() montre des octets media reçus — le handshake
 *      DTLS-SRTP complet fonctionne (sans lui, tout test d'appel E2E est
 *      impossible en sandbox).
 *  P3. micro fake disponible : getUserMedia({audio}) avec --use-fake-device
 *      rend une piste audio réelle (le harnais C2 en dépend).
 *
 *  VERDICT écrit en JSON sur stdout ; exit 1 si un prérequis manque (C2
 *  s'arrête alors — plan B « notes vocales » documenté dans la directive).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface Verdict {
  turn_relay: boolean;
  turn_detail?: string;
  dtls_srtp: boolean;
  dtls_detail?: string;
  fake_mic: boolean;
  fake_mic_detail?: string;
  ok: boolean;
}

const verdict: Verdict = { turn_relay: false, dtls_srtp: false, fake_mic: false, ok: false };

// ── 0. serveur TURN local (node-turn) ────────────────────────────────────────
// node-turn est CJS : module.exports = TURNServer (constructeur direct) —
// l'interrop ESM de bun le place sur .default
const turnModule = (await import("node-turn")) as unknown as {
  default?: unknown;
};
const TURNServerCtor = (turnModule.default ?? turnModule) as new (opts: {
  authMech: string;
  credentials: Record<string, string>;
  debug?: (level: string, msg: string) => void;
}) => { start: () => void; stop: () => void };
const turn = new TURNServerCtor({
  authMech: "long-term",
  credentials: { c2probe: "c2probe-secret" },
  debug: (level: string, msg: string) => {
    if (process.env.C2_TURN_DEBUG) console.log(`[node-turn ${level}] ${msg}`);
  },
});
await new Promise<void>((resolve, reject) => {
  try {
    turn.start();
    resolve();
  } catch (e) {
    reject(e);
  }
});
await new Promise((r) => setTimeout(r, 500)); // laisse les sockets UDP/TCP s'ouvrir

// ── 1. Chromium (fake devices) ───────────────────────────────────────────────
const { chromium } = await import("playwright-core");
const chromePath = `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
if (!existsSync(chromePath)) {
  console.error("FAIL — Chromium introuvable");
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--headless=new",
    "--use-fake-device-for-media-stream", // tonalité oscillante (fake mic)
    "--use-fake-ui-for-media-stream", // auto-accept des prompts
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.error("[probe pageerror]", e.message.slice(0, 200)));

// navigator.mediaDevices n'existe QUE dans un contexte sécurisé — sert une
// page dummy sur http://127.0.0.1 (localhost = contexte sécurisé natif)
const PROBE_ORIGIN = "http://127.0.0.1:8123";
await page.route(`${PROBE_ORIGIN}/**`, (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><head><title>c2 probe</title></head><body>probe</body></html>",
  })
);
await page.goto(`${PROBE_ORIGIN}/`, { waitUntil: "domcontentloaded" });

const RESULT = await page.evaluate(
  async ({ turnUrl, turnUser, turnPass }) => {
    const out: Record<string, unknown> = {};

    // P3 — fake mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      out.fake_mic = !!track && track.readyState === "live";
      out.fake_mic_detail = `track ${track.label} settings=${JSON.stringify(track.getSettings()).slice(0, 120)}`;
      track.stop();
    } catch (e) {
      out.fake_mic = false;
      out.fake_mic_detail = String(e).slice(0, 200);
    }

    /** Fabrique une PC et son transceiver audio émetteur. */
    async function makeCaller(policy: "all" | "relay"): Promise<RTCPeerConnection> {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: turnUrl, username: turnUser, credential: turnPass }],
        iceTransportPolicy: policy,
      });
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(s.getAudioTracks()[0], s);
      return pc;
    }

    async function connectPair(
      a: RTCPeerConnection,
      b: RTCPeerConnection
    ): Promise<void> {
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
    }

    async function waitConnected(pc: RTCPeerConnection, ms: number): Promise<boolean> {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (pc.connectionState === "connected") return true;
        if (pc.connectionState === "failed" || pc.connectionState === "closed") return false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }

    async function audioBytes(pc: RTCPeerConnection): Promise<{ bytes: number; relay: string | null }> {
      const stats = await pc.getStats();
      let bytes = 0;
      let relay: string | null = null;
      stats.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        if (rec.type === "inbound-rtp" && rec.kind === "audio") bytes += Number(rec.bytesReceived ?? 0);
        if (rec.type === "candidate-pair" && rec.state === "succeeded" && rec.nominated) {
          const local = stats.get(rec.localCandidateId as string) as Record<string, unknown> | undefined;
          relay = (local?.candidateType as string) ?? null;
        }
      });
      return { bytes, relay };
    }

    // P1 — chemin TURN FORCÉ (iceTransportPolicy:'relay' : aucune candidate
    // host/srflx ne sort ; seule la allocation TURN peut porter le média)
    try {
      const a = await makeCaller("relay");
      const b = await makeCaller("relay");
      await connectPair(a, b);
      const okA = await waitConnected(a, 15000);
      await new Promise((r) => setTimeout(r, 1500)); // laisse couler l'audio
      const s = await audioBytes(b);
      out.turn_relay = okA && s.bytes > 0;
      out.turn_detail = `connectionState=${a.connectionState} relayCandidate=${s.relay} audioBytesReceived=${s.bytes}`;
      a.close();
      b.close();
    } catch (e) {
      out.turn_relay = false;
      out.turn_detail = String(e).slice(0, 200);
    }

    // P2 — DTLS-SRTP host-to-host (chemin baseline sans TURN)
    try {
      const a = await makeCaller("all");
      const b = await makeCaller("all");
      await connectPair(a, b);
      const okA = await waitConnected(a, 15000);
      await new Promise((r) => setTimeout(r, 1500));
      const s = await audioBytes(b);
      out.dtls_srtp = okA && s.bytes > 0;
      out.dtls_detail = `connectionState=${a.connectionState} localCandidate=${s.relay} audioBytesReceived=${s.bytes}`;
      a.close();
      b.close();
    } catch (e) {
      out.dtls_srtp = false;
      out.dtls_detail = String(e).slice(0, 200);
    }

    return out;
  },
  {
    turnUrl: "turn:127.0.0.1:3478",
    turnUser: "c2probe",
    turnPass: "c2probe-secret",
  }
);

verdict.fake_mic = RESULT.fake_mic === true;
verdict.fake_mic_detail = String(RESULT.fake_mic_detail ?? "");
verdict.turn_relay = RESULT.turn_relay === true;
verdict.turn_detail = String(RESULT.turn_detail ?? "");
verdict.dtls_srtp = RESULT.dtls_srtp === true;
verdict.dtls_detail = String(RESULT.dtls_detail ?? "");
verdict.ok = verdict.fake_mic && verdict.turn_relay && verdict.dtls_srtp;

try {
  turn.stop();
} catch {
  /* déjà arrêté */
}
await browser.close();

const ASSETS = join(process.cwd(), "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });
writeFileSync(join(ASSETS, "c2-prereq-probe.json"), JSON.stringify(verdict, null, 2));
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 1);
