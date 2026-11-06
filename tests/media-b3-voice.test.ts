/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-b3-voice — voice notes Opus (lib + client + E2E pipeline B2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner scripts/b3-voice-notes-proof-run.sh garantit tout) :
 *    MEDIA_B3_E2E=1 BASE_URL=http://127.0.0.1:3103 \
 *    MEDIA_S3_*=(config weed) DATABASE_URL=(db preuve) \
 *    bun test tests/media-b3-voice.test.ts
 *  Sinon : les E2E SKIP proprement (pattern MEDIA_B2_E2E) — les UNITAIRES
 *  tournent TOUJOURS (prérequis Opus + lib pure + round-trip crypto).
 *
 *  SCÉNARIOS (directive B3) :
 *    G1  PRÉREQUIS (bloquant avant UI) : fixtures opus présentes (produites
 *        par scripts/b3-opus-prereq.ts — ffmpeg 6/8/12 kbps + navigateur).
 *        Si absentes → SKIP explicite « lancer le prereq » (jamais de faux
 *        vert).
 *    S1  sniff : ogg/opus + webm/opus reconnus · MP3 → null · assertPlayable
 *        REFUSE un MP3 déclaré audio/opus (MIME spoofing, barrière au rendu).
 *    S2  validateVoiceForSend : 61 s → REFUS (directive) · 60 s → OK ·
 *        octets vides → REFUS · MP3 → REFUS conteneur.
 *    S3  waveform : computePeaksFromSamples(sinus synthétique) → 100 peaks
 *        dans [0..1], zone forte > silence (l'algorithme PARTAGÉ client/test).
 *    S4  isOpusRecordingSupported() === false sous bun (harness — documenté :
 *        la preuve navigateur est faite par b3-opus-prereq, Chromium réel).
 *    V1  E2E chaîne COMPLÈTE voix : uploadVoiceNote (client réel, garde 60 s)
 *        → presign audio/opus → PUT présigné → finalize → downloadVoiceNote →
 *        SHA-256 IDENTIQUE · conteneur webm reconnu.
 *    V2  E2E rejet : contentType audio/mpeg → 400 (whitelist B3).
 *    V3  E2E rejet : 11 Mo → 400 (limite PAR TYPE audio 10 Mo).
 *    V4  E2E round-trip DEUX appareils : A enregistre (fixture) → upload →
 *        dm2 E2EE (durée + peaks DANS le payload chiffré) → B reçoit, ouvre
 *        le dm2, déchiffre l'objet → SHA-256 identique + peaks/durée conservés.
 *    V5  garde client 61 s : uploadVoiceNote lève AVANT tout fetch (aucun
 *        octet envoyé — testé par interception de fetch compteur).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  computePeaksFromSamples,
  sniffOpusContainer,
  assertPlayableVoice,
  validateVoiceForSend,
  isOpusRecordingSupported,
  VOICE_BITRATES,
  VOICE_MAX_DURATION_S,
} from "../src/lib/mbote/media/opus";
import {
  decryptBytes,
  encryptBytes,
  uploadVoiceNote,
  downloadVoiceNote,
  MediaClientError,
  setDefaultStrip,
} from "../src/lib/mbote/media-client";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const ENABLED = process.env.MEDIA_B3_E2E === "1";
const d = ENABLED ? describe : describe.skip;

const db = new PrismaClient({ log: [] });

// ── fixtures opus (produites par le prereq — G1) ─────────────────────────────
const FIX_OGG = join(import.meta.dir, "fixtures", "voice-30s-8k.ogg");
const FIX_WEBM = join(import.meta.dir, "fixtures", "voice-30s-8k.webm");
const FIX_MP3 = join(import.meta.dir, "fixtures", "voice-reject.mp3");
const FIX_OK = existsSync(FIX_OGG) && existsSync(FIX_WEBM) && existsSync(FIX_MP3);
if (!FIX_OK) {
  console.warn(
    "fixtures opus absentes — lancer d'abord : bun scripts/b3-opus-prereq.ts\n" +
      "(prérequis BLOQUANT B3 : sans elles, S1-S4 skip, jamais de faux vert)"
  );
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ECDH P-256 → AES-GCM 256 (identique crypto.ts — WebCrypto PUR, bun OK). */
async function deriveAesKey(priv: CryptoKey, peerPubRaw: Uint8Array): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: await crypto.subtle.importKey("raw", peerPubRaw as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []) },
    priv,
    256
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealTo(priv: CryptoKey, peerPubRaw: Uint8Array, plaintext: string): Promise<{ iv: string; ciphertext: string }> {
  const aesKey = await deriveAesKey(priv, peerPubRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(plaintext) as unknown as BufferSource);
  return { iv: b64url(new Uint8Array(iv)), ciphertext: b64url(new Uint8Array(ct)) };
}

async function openFrom(priv: CryptoKey, peerPubRaw: Uint8Array, sealed: { iv: string; ciphertext: string }): Promise<string> {
  const aesKey = await deriveAesKey(priv, peerPubRaw);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(sealed.iv) as unknown as BufferSource },
    aesKey,
    b64urlToBytes(sealed.ciphertext) as unknown as BufferSource
  );
  return new TextDecoder().decode(pt);
}

interface TestIdentity {
  pub: string;
  sign: (payload: string) => Promise<string>;
  ecdhPriv: CryptoKey;
}

async function makeIdentity(): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pub = b64url(new Uint8Array(pubRaw));
  const sign = async (payload: string): Promise<string> => {
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      pair.privateKey,
      new TextEncoder().encode(payload) as unknown as BufferSource
    );
    return b64url(new Uint8Array(sig));
  };
  return { pub, sign, ecdhPriv: ecdh.privateKey as CryptoKey };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publishIdentity(id: TestIdentity, nickname: string, ecdhPubB64: string): Promise<void> {
  const ts = Date.now();
  const msg = `${id.pub}|identity|${nickname}||${ecdhPubB64}|${ts}`;
  const signature = await id.sign(msg);
  const res = await fetch(`${BASE_URL}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.pub, nickname, bio: "", ecdhPub: ecdhPubB64, ts, signature }),
  });
  expect(res.ok).toBe(true);
}

async function postUploadUrl(id: TestIdentity, mediaType: string, sizeBytes: number, sha256?: string): Promise<Response> {
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-upload|${mediaType}|${sizeBytes}|${ts}`);
  return fetch(`${BASE_URL}/api/media/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaType, sizeBytes, sha256, ts, signature }),
  });
}

beforeAll(async () => {
  if (!ENABLED) return;
  // la voix n'a PAS de strip (arbitrage §8.2-3) — un strip par défaut neutre
  // pour uploadVoiceNote n'est jamais appelé (pas d'étape strip dans la voie
  // voix) ; on pose quand même un guard pour catcher un appel accidentel.
  setDefaultStrip(async (b) => b);
  const res = await fetch(`${BASE_URL}/api/stats`);
  if (!res.ok) throw new Error(`app non prête sur ${BASE_URL} (HTTP ${res.status})`);
});

// ── S1–S4 : lib pure (toujours) ──────────────────────────────────────────────
describe("B3 · lib opus pure (sniff, validation, waveform)", () => {
  test("S1 — sniff conteneurs : ogg/opus + webm/opus OK · MP3 → null · spoof REFUSÉ", () => {
    if (!FIX_OK) return;
    const ogg = new Uint8Array(readFileSync(FIX_OGG));
    const webm = new Uint8Array(readFileSync(FIX_WEBM));
    const mp3 = new Uint8Array(readFileSync(FIX_MP3));
    expect(sniffOpusContainer(ogg)).toBe("audio/ogg");
    expect(sniffOpusContainer(webm)).toBe("audio/webm");
    expect(sniffOpusContainer(mp3)).toBeNull();
    expect(sniffOpusContainer(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    // barrière de rendu : un MP3 déclaré audio/opus est REFUSÉ (jamais rendu)
    expect(() => assertPlayableVoice(mp3, "audio/opus")).toThrow();
    expect(assertPlayableVoice(ogg, "audio/opus")).toBe("audio/ogg");
    // type déclaré incohérent → refus même si le conteneur est bon
    expect(() => assertPlayableVoice(ogg, "audio/mpeg")).toThrow();
  });

  test("S2 — validateVoiceForSend : 61 s REFUS · 60 s OK · vide REFUS · MP3 REFUS", () => {
    if (!FIX_OK) return;
    const webm = new Uint8Array(readFileSync(FIX_WEBM));
    const mp3 = new Uint8Array(readFileSync(FIX_MP3));
    const limit = VOICE_MAX_DURATION_S * 1000 + 250;
    expect(validateVoiceForSend({ bytes: webm, durationMs: limit })).toEqual({ ok: true, container: "audio/webm" });
    const tooLong = validateVoiceForSend({ bytes: webm, durationMs: 61_000 });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toContain("61.0 s");
    expect(validateVoiceForSend({ bytes: new Uint8Array(0), durationMs: 5000 }).ok).toBe(false);
    expect(validateVoiceForSend({ bytes: mp3, durationMs: 5000 }).ok).toBe(false);
    // constantes directive : bitrates 6/8/12 kbps, max 60 s
    expect(VOICE_BITRATES).toEqual({ mesh: 6000, default: 8000, comfort: 12000 });
    expect(VOICE_MAX_DURATION_S).toBe(60);
  });

  test("S3 — waveform : 100 peaks, bornés, zone forte > silence (algorithme partagé)", () => {
    const sr = 8000;
    const silence = new Float32Array(sr); // 1 s de silence
    const sine = new Float32Array(sr * 2);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.8;
    const both = new Float32Array(silence.length + sine.length);
    both.set(silence, 0);
    both.set(sine, silence.length);

    const peaksSilence = computePeaksFromSamples(silence);
    expect(peaksSilence).toHaveLength(100);
    expect(Math.max(...peaksSilence)).toBe(0);

    const peaks = computePeaksFromSamples(both);
    expect(peaks).toHaveLength(100);
    for (const p of peaks) expect(p).toBeGreaterThanOrEqual(0);
    for (const p of peaks) expect(p).toBeLessThanOrEqual(1);
    // les 33 premiers peaks (1 s / 3 s) = silence, les suivants = sinus fort
    expect(Math.max(...peaks.slice(0, 33))).toBe(0);
    expect(Math.max(...peaks.slice(40))).toBeGreaterThan(0.7);
  });

  test("S4 — isOpusRecordingSupported() === false sous bun (harness)", () => {
    // documenté §8.2-1 : la preuve d'enregistrement navigateur est faite par
    // b3-opus-prereq (Chromium réel + fake device) — bun n'a pas MediaRecorder.
    expect(isOpusRecordingSupported()).toBe(false);
  });

  test("V5 — garde client 61 s : uploadVoiceNote lève AVANT TOUT fetch", async () => {
    if (!FIX_OK) return;
    const webm = new Uint8Array(readFileSync(FIX_WEBM));
    let fetches = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (...args) => {
      fetches += 1;
      return orig(...args);
    }) as typeof fetch;
    try {
      await expect(
        uploadVoiceNote({
          bytes: webm,
          durationMs: 61_000,
          me: "x",
          sign: async () => "x",
        })
      ).rejects.toThrow(MediaClientError);
      expect(fetches).toBe(0); // refus AVANT tout octet envoyé
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("S5 — round-trip crypto : encryptBytes(A) → decryptBytes(B) SHA-256 identique", async () => {
    if (!FIX_OK) return;
    const ogg = new Uint8Array(readFileSync(FIX_OGG));
    const enc = await encryptBytes(ogg);
    const plain = await decryptBytes(enc.envelope, enc.cekB64);
    expect(await sha256Hex(plain)).toBe(await sha256Hex(ogg));
    // le plaintext reste une note jouable (sniff après decrypt — barrière)
    expect(assertPlayableVoice(plain, "audio/opus")).toBe("audio/ogg");
  });
});

// ── V1–V4 : E2E gated (app :3103 + weed réel — runner) ──────────────────────
d("B3 · E2E voix (pipeline B2, audio/opus)", () => {
  test("V1 — chaîne complète : uploadVoiceNote → presign → PUT → finalize → downloadVoiceNote → SHA-256 identique", async () => {
    if (!FIX_OK) return;
    const id = await makeIdentity();
    const webm = new Uint8Array(readFileSync(FIX_WEBM));
    const durationMs = 30_040;
    const peaks = computePeaksFromSamples(new Float32Array(240_000).map((_, i) => (i % 480 < 240 ? 0.6 : 0.1)));

    // uploadVoiceNote = le CLIENT RÉEL (garde 60 s, chiffrement, presign,
    // PUT, finalize) — BASE_URL pointe sur l'app standalone.
    const uploaded = await uploadVoiceNote({
      bytes: webm,
      durationMs,
      peaks,
      me: id.pub,
      sign: id.sign,
    });
    expect(uploaded.mediaType).toBe("audio/opus");
    expect(uploaded.container).toBe("audio/webm");
    expect(uploaded.durationMs).toBe(durationMs);
    expect(uploaded.peaks).toHaveLength(100);

    // la ligne Media est finalized, taille = enveloppe
    const row = await db.media.findUnique({ where: { id: uploaded.mediaId } });
    expect(row?.status).toBe("finalized");
    expect(row?.mediaType).toBe("audio/opus");
    expect(row?.sizeBytes).toBe(uploaded.sizeBytes);

    // download + decrypt + sniff (client réel)
    const dl = await downloadVoiceNote({
      mediaId: uploaded.mediaId,
      cekB64: uploaded.cekB64,
      declaredType: "audio/opus",
      me: id.pub,
      sign: id.sign,
    });
    expect(dl.container).toBe("audio/webm");
    expect(dl.bytes).toBe(webm.length);
    expect(await sha256Hex(new Uint8Array(await dl.blob.arrayBuffer()))).toBe(await sha256Hex(webm));
  });

  test("V2 — contentType audio/mpeg → 400 (whitelist)", async () => {
    const id = await makeIdentity();
    const res = await postUploadUrl(id, "audio/mpeg", 10_000);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("audio/opus");
  });

  test("V3 — 11 Mo audio/opus → 400 (limite PAR TYPE, image reste 5 Mo)", async () => {
    const id = await makeIdentity();
    const elevenMo = 11 * 1024 * 1024;
    const resVoice = await postUploadUrl(id, "audio/opus", elevenMo);
    expect(resVoice.status).toBe(400);
    const resImage = await postUploadUrl(id, "image/jpeg", 6 * 1024 * 1024);
    expect(resImage.status).toBe(400); // l'image garde SA limite B2 (5 Mo)
    const resAudio10 = await postUploadUrl(id, "audio/opus", 10 * 1024 * 1024);
    expect(resAudio10.status).toBe(201); // 10 Mo pile = accepté (pas de PUT derrière)
  });

  test("V4 — DEUX appareils : A enregistre → dm2 E2EE (durée+peaks chiffrés) → B reçoit → SHA-256 identique", async () => {
    if (!FIX_OK) return;
    const A = await makeIdentity();
    const B = await makeIdentity();

    const aEcdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const bEcdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const aPubRaw = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", aEcdh.publicKey)));
    const bPubRaw = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", bEcdh.publicKey)));
    await publishIdentity(A, `A-voice-${Date.now() % 100000}`, aPubRaw);
    await publishIdentity(B, `B-voice-${Date.now() % 100000}`, bPubRaw);

    // A enregistre (fixture webm = sortie MediaRecorder) et envoie
    const fixture = new Uint8Array(readFileSync(FIX_WEBM));
    const durationMs = 30_040;
    const peaks = computePeaksFromSamples(new Float32Array(120_000).map((_, i) => (Math.sin(i / 40) + 1) / 2));
    const uploaded = await uploadVoiceNote({
      bytes: fixture,
      durationMs,
      peaks,
      me: A.pub,
      sign: A.sign,
    });

    // A scelle le payload VOIX (durée + peaks DANS le dm2 chiffré)
    const payload = JSON.stringify({
      kind: "media",
      text: "",
      mediaId: uploaded.mediaId,
      cek: uploaded.cekB64,
      mediaType: uploaded.mediaType,
      bytes: uploaded.plainBytes,
      objectKey: uploaded.objectKey,
      durationMs: uploaded.durationMs,
      peaks: uploaded.peaks,
    });
    // scellement avec la PAIRE PUBLIÉE (aEcdh) — B ouvrira avec bEcdh :
    // même secret partagé ECDH des deux côtés (bug croisé corrigé)
    const sealed = await sealTo(aEcdh.privateKey as CryptoKey, b64urlToBytes(bPubRaw), payload);
    {
      const ts = Date.now();
      const msgId = crypto.randomUUID();
      const signature = await A.sign(`${A.pub}|dm2|${B.pub}|${msgId}|1|${sealed.iv}|${sealed.ciphertext}|${ts}`);
      const res = await fetch(`${BASE_URL}/api/dms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderKey: A.pub,
          recipientKey: B.pub,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
          msgId,
          seq: 1,
          ts,
          signature,
        }),
      });
      expect(res.status).toBe(200);
    }

    // B ouvre le dm2 (ECDH), lit le payload, déchiffre l'objet, vérifie TOUT
    const ts2 = Date.now();
    const list2 = await fetch(
      `${BASE_URL}/api/dms?${new URLSearchParams({
        me: B.pub,
        peer: A.pub,
        ts: String(ts2),
        signature: await B.sign(`${B.pub}|dm-read|${A.pub}|${ts2}`),
      })}`
    );
    expect(list2.status).toBe(200);
    const conv = (await list2.json()) as { messages: Array<{ senderKey: string; iv: string; ciphertext: string }> };
    const mine = conv.messages.find((m) => m.senderKey === A.pub && m.iv === sealed.iv);
    expect(mine).toBeTruthy();
    const sealedMsg = mine as { iv: string; ciphertext: string };

    const opened = await openFrom(bEcdh.privateKey as CryptoKey, b64urlToBytes(aPubRaw), sealedMsg);
    const parsed = JSON.parse(opened) as {
      mediaId: string; cek: string; mediaType: string; durationMs: number; peaks: number[];
    };
    expect(parsed.mediaType).toBe("audio/opus");
    expect(parsed.durationMs).toBe(durationMs);
    expect(parsed.peaks).toHaveLength(100);

    const dl = await downloadVoiceNote({
      mediaId: parsed.mediaId,
      cekB64: parsed.cek,
      declaredType: parsed.mediaType,
      me: B.pub,
      sign: B.sign,
    });
    expect(await sha256Hex(new Uint8Array(await dl.blob.arrayBuffer()))).toBe(await sha256Hex(fixture));
    // la waveform voyage CHIFFRÉE : identique côté B (pas de re-décodage requis)
    expect(parsed.peaks).toEqual(peaks);
  });
});
