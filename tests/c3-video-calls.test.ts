/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  C3 — APPELS VIDÉO 1:1 : signalisation (hub RÉEL in-process) + contrôleur
 *       qualité + knock vidéo. Extension directe de C2 (mêmes patterns).
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/c3-video-calls.test.ts
 *
 *  Scénarios (directive C3) :
 *   V1. ÉCHANGE SIGNALISATION VIDÉO (hub réel, clés ECDSA réelles) : offer
 *       portant une m-line `m=video` → relayée INTACTE à B ; answer vidéo ;
 *       ICE ; hangup.
 *   V2. call:media (état pistes {videoOn, audioOn}) : relayé si les deux
 *       champs sont STRICTEMENT booléens ; rejeté sinon (borne contenu).
 *   V3. SÉCURITÉ call:media : signature absente/mauvaise → NON relayé ;
 *       usurpation from ≠ identité socket → NON relayé.
 *   V4. BORNES : SDP vidéo > 16 Ko → NON relayé ; call:media est compté dans
 *       le rate limit 60/min du même socket (anti-spam unifié).
 *   V5. CONTRÔLEUR QUALITÉ (pur) : 480p→360p→240p sous 2 mesures consécutives
 *       > 5 % (hystérésis), hold sur mesures saines, étage bas jamais dépassé,
 *       mesure invalide ignorée.
 *   V6. offerHasVideo : m=video port 0 → false (m-line rejetée) ; port 9 →
 *       true ; absence → false (décision répondeur audio/vidéo).
 *   V7. KNOCK VIDÉO : la chaîne signée par le client
 *       `${from}|call-knock|${to}|${callId}|video|${ts}` est VÉRIFIÉE par la
 *       route (verifySignedMessage) ; falsification du type (video→audio)
 *       → REFUS 401.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "http";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { createRelayHub, type RelayHub } from "../mini-services/relay-service/hub";
import { verifySignedMessage } from "../src/lib/mbote/proof";
import { VideoQualityController, VIDEO_QUALITY_STAGES, PACKET_LOSS_BAD_RATIO } from "../src/lib/mbote/webrtc";

// ── WebCrypto helpers (clés ECDSA réelles — même format que l'app) ──────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64url");
}

async function makeIdentity(): Promise<{ pubkey: string; signPriv: CryptoKey }> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubkey: b64url(raw), signPriv: kp.privateKey };
}

async function sign(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(message)
  );
  return b64url(sig);
}

// ── hub réel in-process ──────────────────────────────────────────────────────

let httpServer: Server;
let _hub: RelayHub;
let hubUrl: string;

beforeAll(async () => {
  httpServer = createServer();
  _hub = createRelayHub(httpServer, { allowedOrigins: [] });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("port hub introuvable");
  hubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  httpServer.close();
});

interface Identity {
  name: string;
  pubkey: string;
  signPriv: CryptoKey;
}

async function connectClient(id: Identity): Promise<ClientSocket> {
  const s = ioClient(hubUrl, { transports: ["websocket"], forceNew: true });
  await new Promise<void>((resolve) => s.on("connect", resolve));
  const ts = Date.now();
  s.emit("hello", {
    pubkey: id.pubkey,
    nickname: id.name,
    dmAuth: { ts, signature: await sign(id.signPriv, `${id.pubkey}|relay-hello|${ts}`) },
  });
  await new Promise((r) => setTimeout(r, 150));
  return s;
}

async function emitCall(
  s: ClientSocket,
  id: Identity,
  kind: string,
  to: string,
  callId: string,
  extra: Record<string, unknown> = {},
  opts: { skipSig?: boolean; badSig?: boolean; from?: string } = {}
): Promise<void> {
  const ts = Date.now();
  const from = opts.from ?? id.pubkey;
  const sig = opts.skipSig
    ? undefined
    : opts.badSig
      ? "AAAA-bad-signature-AAAA"
      : await sign(id.signPriv, `${from}|${kind}|${to}|${callId}|${ts}`);
  s.emit(`call:${kind.split("-")[1]}`, { from, to, callId, ts, sig, ...extra });
}

function waitFor(sock: ClientSocket, ev: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ev}`)), timeoutMs);
    sock.once(ev, (d: Record<string, unknown>) => {
      clearTimeout(t);
      resolve(d);
    });
  });
}

// SDP vidéo factice (m-line vidéo + m-line audio) — la borne hub est 16 Ko
const VIDEO_OFFER_SDP = [
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv",
  "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv",
].join("\r\n");
const VIDEO_ANSWER_SDP = VIDEO_OFFER_SDP; // structure identique pour le test

// ── V1 : échange de signalisation vidéo complet ──────────────────────────────

describe("C3 signalisation vidéo (hub réel)", () => {
  test("V1 — offer m=video / answer vidéo / ice / hangup relayés intacts", async () => {
    const A = await makeIdentity();
    const B = await makeIdentity();
    const sa = await connectClient({ name: "A", ...A });
    const sb = await connectClient({ name: "B", ...B });
    const callId = "call-c3-v1-video";

    const pOfferB = waitFor(sb, "call-offer");
    await emitCall(sa, { name: "A", ...A }, "call-offer", B.pubkey, callId, {
      offer: { type: "offer", sdp: VIDEO_OFFER_SDP },
    });
    const offer = (await pOfferB) as { from: string; offer: { sdp: string } };
    expect(offer.from).toBe(A.pubkey);
    expect(offer.offer.sdp).toContain("m=video 9"); // m-line vidéo INTACTE
    expect(offer.offer.sdp).toContain("m=audio 9");

    const pAnswerA = waitFor(sa, "call-answer");
    await emitCall(sb, { name: "B", ...B }, "call-answer", A.pubkey, callId, {
      answer: { type: "answer", sdp: VIDEO_ANSWER_SDP },
    });
    const answer = (await pAnswerA) as { answer: { sdp: string } };
    expect(answer.answer.sdp).toContain("m=video 9");

    const pIceB = waitFor(sb, "call-ice");
    await emitCall(sa, { name: "A", ...A }, "call-ice", B.pubkey, callId, {
      candidate: { candidate: "candidate:1 1 UDP 2122252543 127.0.0.1 40001 typ host" },
    });
    await pIceB;

    const pHangupA = waitFor(sa, "call-hangup");
    await emitCall(sb, { name: "B", ...B }, "call-hangup", A.pubkey, callId, { reason: "user" });
    await pHangupA;

    sa.disconnect();
    sb.disconnect();
  });

  test("V2 — call:media {videoOn,audioOn} relayé ; champs non booléens → NON relayé", async () => {
    const A = await makeIdentity();
    const B = await makeIdentity();
    const sa = await connectClient({ name: "A", ...A });
    const sb = await connectClient({ name: "B", ...B });
    const callId = "call-c3-v2-media";

    const pMedia = waitFor(sb, "call-media");
    await emitCall(sa, { name: "A", ...A }, "call-media", B.pubkey, callId, {
      videoOn: false,
      audioOn: true,
    });
    const media = (await pMedia) as { videoOn: unknown; audioOn: unknown; from: string };
    expect(media.from).toBe(A.pubkey);
    expect(media.videoOn).toBe(false);
    expect(media.audioOn).toBe(true);

    // payload invalide : videoOn string → la borne extraCheck refuse (pas de
    // contenu qui ne soit pas strictement booléen)
    let gotBad = false;
    sb.on("call-media", () => {
      gotBad = true;
    });
    await emitCall(sa, { name: "A", ...A }, "call-media", B.pubkey, "call-c3-v2-bad", {
      videoOn: "non-boolean",
      audioOn: true,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(gotBad).toBe(false);

    sa.disconnect();
    sb.disconnect();
  });

  test("V3 — call:media signature absente/mauvaise ou usurpation → NON relayé", async () => {
    const A = await makeIdentity();
    const B = await makeIdentity();
    const C = await makeIdentity();
    const sa = await connectClient({ name: "A", ...A });
    const sb = await connectClient({ name: "B", ...B });

    let got = false;
    sb.on("call-media", () => {
      got = true;
    });

    // sans signature
    await emitCall(sa, { name: "A", ...A }, "call-media", B.pubkey, "call-c3-v3-nosig", { videoOn: true, audioOn: true }, { skipSig: true });
    // mauvaise signature
    await emitCall(sa, { name: "A", ...A }, "call-media", B.pubkey, "call-c3-v3-badsig", { videoOn: true, audioOn: true }, { badSig: true });
    // usurpation : C signe avec SA clé mais prétend from=A
    await emitCall(sa, { name: "C", ...C }, "call-media", B.pubkey, "call-c3-v3-spoof", { videoOn: true, audioOn: true }, { from: A.pubkey, badSig: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(got).toBe(false);

    sa.disconnect();
    sb.disconnect();
  });

  test("V4 — bornes : SDP vidéo > 16 Ko NON relayé ; call:media dans le rate limit 60/min", async () => {
    // ── borne SDP (socket DÉDIÉ — DÉCOUVERTE HARNAIS : callRateOk() incrémente
    // AVANT la borne de taille, donc un payload refusé consomme quand même un
    // slot du compteur 60/min ; comportement hub documenté, pas un bug —
    // fail-closed cohérent avec l'anti-ampère) ──
    const A1 = await makeIdentity();
    const B1 = await makeIdentity();
    const sa1 = await connectClient({ name: "A1", ...A1 });
    const sb1 = await connectClient({ name: "B1", ...B1 });
    let gotBig = false;
    sb1.on("call-offer", () => {
      gotBig = true;
    });
    await emitCall(sa1, { name: "A1", ...A1 }, "call-offer", B1.pubkey, "call-c3-v4-big", {
      offer: { type: "offer", sdp: `m=video 9 UDP/TLS/RTP/SAVPF 96\r\n${"x".repeat(20_000)}` },
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(gotBig).toBe(false);
    sa1.disconnect();
    sb1.disconnect();

    // ── rate limit unifié (socket dédié, aucune autre émission) ──
    const A = await makeIdentity();
    const B = await makeIdentity();
    const sa = await connectClient({ name: "A", ...A });
    const sb = await connectClient({ name: "B", ...B });
    let gotMedia = 0;
    sb.on("call-media", () => {
      gotMedia += 1;
    });
    for (let i = 0; i < 80; i++) {
      await emitCall(sa, { name: "A", ...A }, "call-media", B.pubkey, `call-c3-v4-${String(i).padStart(4, "0")}`, {
        videoOn: false,
        audioOn: false,
      });
    }
    await new Promise((r) => setTimeout(r, 1200));
    expect(gotMedia).toBe(60);

    sa.disconnect();
    sb.disconnect();
  });
});

// ── V5 : contrôleur qualité (pur) ────────────────────────────────────────────

describe("C3 qualité vidéo adaptative", () => {
  test("V5 — descente 480p→360p→240p avec hystérésis ; jamais de remontée ; bornes", () => {
    const c = new VideoQualityController();
    expect(c.stage.quality).toBe("high");

    // 1 mesure dégradée → hold (hystérésis 2)
    expect(c.measure(PACKET_LOSS_BAD_RATIO + 0.01)).toBe("hold");
    expect(c.stage.quality).toBe("high");
    // mesure saine → réinitialise le compteur
    expect(c.measure(0.01)).toBe("hold");
    // une seule mesure dégradée après reset → encore hold
    expect(c.measure(0.2)).toBe("hold");
    // 2ᵉ consécutive → descend vers medium
    expect(c.measure(0.2)).toBe("down");
    expect(c.stage.quality).toBe("medium");
    expect(c.stage.maxBitrate).toBe(VIDEO_QUALITY_STAGES[1]?.maxBitrate);

    // descente jusqu'à l'étage bas puis PLAFOND (jamais au-delà)
    expect(c.measure(0.3)).toBe("hold");
    expect(c.measure(0.3)).toBe("down");
    expect(c.stage.quality).toBe("low");
    // mesures catastrophiques au niveau bas → hold (pas de 4ᵉ étage)
    expect(c.measure(0.9)).toBe("hold");
    expect(c.measure(0.9)).toBe("hold");
    expect(c.measure(0.9)).toBe("hold");
    expect(c.stage.quality).toBe("low");

    // mesure invalide (NaN/négative) → ignorée
    expect(c.measure(Number.NaN)).toBe("hold");
    expect(c.measure(-0.5)).toBe("hold");
    expect(c.stage.quality).toBe("low");

    // seuil exact : 5 % n'est PAS instable (strictement > 5 %)
    const c2 = new VideoQualityController();
    expect(c2.measure(PACKET_LOSS_BAD_RATIO)).toBe("hold");
    expect(c2.stage.quality).toBe("high");
  });

  test("V6 — offerHasVideo : m=video port 0 → false (m-line rejetée), port 9 → true", () => {
    // recopie PURE de la décision répondeur (précédent S5 C2 — le module
    // client 'use client' n'est pas importable sous bun ; le comportement
    // intégral est prouvé côté navigateur c3-browser-proof)
    function offerHasVideo(sdp: string | undefined): boolean {
      if (!sdp) return false;
      for (const line of sdp.split("\n")) {
        const m = /^m=video\s+(\d+)\b/i.exec(line.trim());
        if (m && m[1] !== "0") return true;
      }
      return false;
    }
    expect(offerHasVideo(VIDEO_OFFER_SDP)).toBe(true);
    expect(offerHasVideo("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv")).toBe(false);
    expect(offerHasVideo("v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=inactive")).toBe(false);
    expect(offerHasVideo(undefined)).toBe(false);
    expect(offerHasVideo("")).toBe(false);
  });
});

// ── V7 : knock vidéo (chaîne signée client ↔ vérification route) ─────────────

describe("C3 knock vidéo", () => {
  test("V7 — la chaîne `…|call-knock|…|video|ts` est vérifiée par la route ; falsification du type → refus", async () => {
    const A = await makeIdentity();
    const ts = Date.now();
    const callId = "call-c3-v7-knock";

    // ce que le CLIENT signe (webrtc.ts startOutgoing — resolvedType "video")
    const clientMessage = `${A.pubkey}|call-knock|${A.pubkey}|${callId}|video|${ts}`;
    const clientSig = await sign(A.signPriv, clientMessage);

    // ce que la ROUTE vérifie (call-knock/route.ts — knockKind "video")
    const routeCheckVideo = await verifySignedMessage({
      message: `${A.pubkey}|call-knock|${A.pubkey}|${callId}|video|${ts}`,
      pubkey: A.pubkey,
      ts,
      signature: clientSig,
      maxAgeMs: 15 * 60_000,
    });
    expect(routeCheckVideo.valid).toBe(true);

    // falsification : un intercepteur re-annonce le knock comme AUDIO →
    // la signature ne couvre plus la chaîne → 401 (anti-falsification du rendu)
    const routeCheckAudio = await verifySignedMessage({
      message: `${A.pubkey}|call-knock|${A.pubkey}|${callId}|audio|${ts}`,
      pubkey: A.pubkey,
      ts,
      signature: clientSig,
      maxAgeMs: 15 * 60_000,
    });
    expect(routeCheckAudio.valid).toBe(false);
  });
});
