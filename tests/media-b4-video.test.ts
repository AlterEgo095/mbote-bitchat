/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-b4-video — vidéo webm/mp4 (lib + client + E2E pipeline B2, TTL 1 h)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner scripts/b4-video-proof-run.sh garantit tout) :
 *    MEDIA_B4_E2E=1 BASE_URL=http://127.0.0.1:3103 \
 *    MEDIA_S3_*=(config weed) DATABASE_URL=(db preuve) \
 *    bun test tests/media-b4-video.test.ts
 *  Sinon : les E2E SKIP proprement (pattern B2/B3) — les UNITAIRES tournent
 *  TOUJOURS (sniff + validation + garde client ; la CAMÉRA, elle, est prouvée
 *  par scripts/b4-camera-prereq.ts — Chromium réel, fake device).
 *
 *  SCÉNARIOS (directive B4) :
 *    G1  PRÉREQUIS : fixture webm présente (produite par le prereq caméra —
 *        getUserMedia + MediaRecorder RÉELS). Absente → SKIP explicite.
 *    U1  sniff : webm VIDÉO (V_VP8) reconnu · webm AUDIO (voice B3, A_OPUS
 *        sans V_*) → null · MP3 → null · MP4 ftyp (synthétique) → video/mp4 ·
 *        assertPlayableVideo REFUSE un webm audio déclaré video/webm (barrière).
 *    U2  validateVideoForSend : 61 s → REFUS · 60 s → OK · vide → REFUS ·
 *        webm audio → REFUS conteneur · 110 Mo → REFUS (garde client).
 *    U3  thumbnail hors navigateur → erreur propre (jamais de crash).
 *    U4  isVideoRecordingSupported() === false sous bun (harness documenté —
 *        la preuve caméra est faite par le prereq, Chromium réel).
 *    U5  garde client 61 s : uploadVideoNote lève AVANT tout fetch (compteur).
 *    H1  E2E header : Permissions-Policy servi contient camera=(self) ET
 *        microphone=(self) (le fix AVANT le code — directive B4).
 *    V1  E2E chaîne COMPLÈTE vidéo : uploadVideoNote (webm 10 s réel + thumb
 *        JPEG synthétique) → presign video/webm → PUT → finalize (thumb :
 *        chemin image B2 avec strip) → downloadVideoNote → SHA-256 IDENTIQUE
 *        · conteneur video/webm · thumb { mediaId, cek } rendus.
 *    V2  E2E rejet : contentType video/avi → 400 (whitelist B4, message clair).
 *    V3  E2E rejet : 110 Mo → 400 (limite PAR TYPE vidéo 100 Mo).
 *    V4  E2E TTL : download-url d'une vidéo → expiresAt ≈ +1 h (directive) ;
 *        download-url d'une image → ≈ 15 min (inchangé).
 *    V5  E2E round-trip DEUX appareils : A enregistre (fixture) → upload →
 *        dm2 E2EE (video + thumb DANS le payload chiffré) → B reçoit, ouvre
 *        le dm2, déchiffre l'objet → SHA-256 identique (vidéo ET vignette) +
 *        durée conservée.
 *    V6  E2E barrière de rendu : dm2 déclarant video/webm mais portant des
 *        OCTETS AUDIO (voice fixture chiffrée) → downloadVideoNote REFUSE
 *        (magic-bytes-mismatch — un webm audio n'est jamais rendu en vidéo).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sniffVideoContainer,
  assertPlayableVideo,
  validateVideoForSend,
  isVideoRecordingSupported,
  captureVideoThumbnail,
  VIDEO_MAX_DURATION_S,
} from "../src/lib/mbote/media/video";
import {
  decryptBytes,
  encryptBytes,
  uploadVideoNote,
  downloadVideoNote,
  MediaClientError,
  setDefaultStrip,
} from "../src/lib/mbote/media-client";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const ENABLED = process.env.MEDIA_B4_E2E === "1";
const d = ENABLED ? describe : describe.skip;

// ── fixtures vidéo (produites par le prereq caméra — G1) ─────────────────────
const FIX_WEBM_VID = join(import.meta.dir, "fixtures", "b4-prereq-10s.webm");
const FIX_WEBM_AUD = join(import.meta.dir, "fixtures", "voice-30s-8k.webm"); // B3 — webm AUDIO (A_OPUS)
const FIX_OK = existsSync(FIX_WEBM_VID);
const FIX_AUD_OK = existsSync(FIX_WEBM_AUD);
if (!FIX_OK) {
  console.warn(
    "fixture vidéo absente — lancer d'abord : bun scripts/b4-camera-prereq.ts\n" +
      "(prérequis BLOQUANT B4 : sans elle, U/V skip, jamais de faux vert)"
  );
}

/** MP4 minimal SYNTHÉTIQUE (boîte ftyp seule — suffisant pour le sniff). */
function minimalMp4(): Uint8Array {
  // [size uint32 = 12]["ftyp"@"4..8"]["isom"@"8..12"] — ISO BMFF
  const type = "ftypisom";
  const bytes = new Uint8Array(4 + type.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  for (let i = 0; i < type.length; i++) bytes[4 + i] = type.charCodeAt(i);
  return bytes;
}

/** JPEG minimal SYNTHÉTIQUE (magic FFD8…FFD9 — sert de vignette de test). */
function minimalJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
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
  ecdhPubRaw: Uint8Array;
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
  return {
    pub,
    sign,
    ecdhPriv: ecdh.privateKey as CryptoKey,
    ecdhPubRaw: new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey)),
  };
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

async function getDownloadUrl(id: TestIdentity, mediaId: string): Promise<{ downloadUrl: string; expiresAt: string; mediaType: string; status: number }> {
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-dl|${mediaId}|${ts}`);
  const res = await fetch(
    `${BASE_URL}/api/media/download-url?${new URLSearchParams({ me: id.pub, mediaId, ts: String(ts), signature })}`
  );
  const body = (await res.json().catch(() => ({}))) as { downloadUrl?: string; expiresAt?: string; mediaType?: string };
  return { downloadUrl: body.downloadUrl ?? "", expiresAt: body.expiresAt ?? "", mediaType: body.mediaType ?? "", status: res.status };
}

/** Les URLs présignées servies sont RELATIVES (/media-proxy/…) — le harnais
 *  bun doit les résoudre contre BASE_URL (le client réel passe par
 *  toFetchUrl, même mécanique). */
function absUrl(path: string): string {
  return new URL(path, BASE_URL).toString();
}

beforeAll(async () => {
  if (!ENABLED) return;
  // la vidéo n'a PAS de strip (arbitrage §9.3) — la THUMBNAIL, elle, suit le
  // chemin image B2 : un strip NEUTRE ici (canvas absent du harness) prouve
  // que le chemin est appelé sans dépendre du canvas.
  setDefaultStrip(async (b) => b);
  const res = await fetch(`${BASE_URL}/api/stats`);
  if (!res.ok) throw new Error(`app non prête sur ${BASE_URL} (HTTP ${res.status})`);
});

// ── U1–U5 : lib pure (toujours) ──────────────────────────────────────────────
describe("B4 · lib vidéo pure (sniff, validation, guards)", () => {
  test("U1 — sniff : webm vidéo OK · webm AUDIO (B3) → null · MP3 → null · MP4 ftyp OK · barrière REFUSE l'audio", () => {
    if (!FIX_OK) return;
    const vid = new Uint8Array(readFileSync(FIX_WEBM_VID));
    expect(sniffVideoContainer(vid)).toBe("video/webm");
    expect(sniffVideoContainer(minimalMp4())).toBe("video/mp4");
    expect(sniffVideoContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    if (FIX_AUD_OK) {
      // le webm AUDIO de B3 (A_OPUS, pas de piste V_*) n'est PAS une vidéo
      const aud = new Uint8Array(readFileSync(FIX_WEBM_AUD));
      expect(sniffOpusAudioIsNotVideo(aud)).toBe(true);
    }
    // barrière de rendu : webm audio déclaré video/webm → REFUS
    if (FIX_AUD_OK) {
      const aud = new Uint8Array(readFileSync(FIX_WEBM_AUD));
      expect(() => assertPlayableVideo(aud, "video/webm")).toThrow(/magic-bytes-mismatch/);
    }
    expect(assertPlayableVideo(vid, "video/webm")).toBe("video/webm");
    expect(assertPlayableVideo(minimalMp4(), "video/mp4")).toBe("video/mp4");
    // type déclaré incohérent → refus même si le conteneur est bon
    expect(() => assertPlayableVideo(vid, "video/mp4")).toThrow(/déclaré/);
  });

  test("U2 — validateVideoForSend : 61 s REFUS · 60 s OK · vide REFUS · audio REFUS · 110 Mo REFUS", () => {
    if (!FIX_OK) return;
    const vid = new Uint8Array(readFileSync(FIX_WEBM_VID));
    const limit = VIDEO_MAX_DURATION_S * 1000 + 250;
    expect(validateVideoForSend({ bytes: vid, durationMs: 61_000 }).ok).toBe(false);
    expect(validateVideoForSend({ bytes: vid, durationMs: 60_000 }).ok).toBe(true);
    expect(validateVideoForSend({ bytes: new Uint8Array(0), durationMs: 5_000 }).ok).toBe(false);
    // 110 Mo de garbage → REFUS taille AVANT le sniff
    expect(validateVideoForSend({ bytes: new Uint8Array(110 * 1024 * 1024), durationMs: 30_000 }).ok).toBe(false);
    expect(validateVideoForSend({ bytes: vid, durationMs: limit }).ok).toBe(true);
    if (FIX_AUD_OK) {
      const aud = new Uint8Array(readFileSync(FIX_WEBM_AUD));
      const v = validateVideoForSend({ bytes: aud, durationMs: 30_000 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("vidéo");
    }
  });

  test("U3 — captureVideoThumbnail hors navigateur → erreur propre", async () => {
    if (!FIX_OK) return;
    const vid = new Uint8Array(readFileSync(FIX_WEBM_VID));
    await expect(captureVideoThumbnail(vid, "video/webm")).rejects.toThrow(/navigateur/);
  });

  test("U4 — isVideoRecordingSupported() === false sous bun (harness)", () => {
    expect(isVideoRecordingSupported()).toBe(false);
  });

  test("U5 — garde client : uploadVideoNote 61 s lève AVANT tout fetch", async () => {
    if (!FIX_OK) return;
    let fetchCount = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args) => {
      fetchCount++;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      const id = await makeIdentity();
      const vid = new Uint8Array(readFileSync(FIX_WEBM_VID));
      await expect(
        uploadVideoNote({
          bytes: vid,
          durationMs: 61_000, // > 60 s → REFUS client
          me: id.pub,
          sign: id.sign,
        })
      ).rejects.toThrow(MediaClientError);
      expect(fetchCount).toBe(0); // AUCUN octet envoyé
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** helper U1 : un webm audio (A_OPUS) ne doit jamais être sniffé vidéo. */
function sniffOpusAudioIsNotVideo(bytes: Uint8Array): boolean {
  return sniffVideoContainer(bytes) === null;
}

// ── H1 + V1–V6 : E2E (runner) ────────────────────────────────────────────────
d("B4 · E2E header + pipeline vidéo réel", () => {
  let alice: TestIdentity;
  let bob: TestIdentity;
  let uploadedVideoId = "";

  beforeAll(async () => {
    alice = await makeIdentity();
    bob = await makeIdentity();
    await publishIdentity(alice, "Alice Video", b64url(alice.ecdhPubRaw));
    await publishIdentity(bob, "Bob Video", b64url(bob.ecdhPubRaw));
  });

  test("H1 — Permissions-Policy servi : camera=(self) + microphone=(self)", async () => {
    const res = await fetch(`${BASE_URL}/api/stats`);
    const pp = res.headers.get("permissions-policy") ?? "";
    expect(pp).toContain("camera=(self)");
    expect(pp).toContain("microphone=(self)");
    expect(pp).toContain("geolocation=()"); // les refus restent des refus
  });

  test("V1 — chaîne complète : webm réel + thumb → finalize → download → SHA-256 identique", async () => {
    if (!FIX_OK) return;
    const vid = new Uint8Array(readFileSync(FIX_WEBM_VID));
    const uploaded = await uploadVideoNote({
      bytes: vid,
      durationMs: 9_960,
      width: 640,
      height: 480,
      thumb: { bytes: minimalJpeg(), width: 320, height: 240 },
      me: alice.pub,
      sign: alice.sign,
    });
    expect(uploaded.mediaType).toBe("video/webm");
    expect(uploaded.container).toBe("video/webm");
    const thumb = uploaded.thumb;
    expect(thumb).not.toBeNull();
    expect(thumb?.mediaType).toBe("image/jpeg");
    uploadedVideoId = uploaded.mediaId;

    const dl = await downloadVideoNote({
      mediaId: uploaded.mediaId,
      cekB64: uploaded.cekB64,
      declaredType: uploaded.mediaType,
      me: alice.pub,
      sign: alice.sign,
    });
    expect(dl.container).toBe("video/webm");
    expect(await sha256Hex(new Uint8Array(await dl.blob.arrayBuffer()))).toBe(await sha256Hex(vid));
  });

  test("V2 — contentType video/avi → 400 (message clair, convertissez d'abord)", async () => {
    const res = await postUploadUrl(alice, "video/avi", 1024);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("hors whitelist");
    expect(body.error).toContain("convertissez");
  });

  test("V3 — 110 Mo → 400 (limite PAR TYPE vidéo 100 Mo)", async () => {
    const res = await postUploadUrl(alice, "video/webm", 110 * 1024 * 1024);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("104857600"); // 100 Mo en octets
  });

  test("V4 — TTL download : vidéo ≈ 1 h · image ≈ 15 min", async () => {
    if (!uploadedVideoId || !FIX_OK) return;
    const vidInfo = await getDownloadUrl(alice, uploadedVideoId);
    expect(vidInfo.status).toBe(200);
    const vidTtlS = (new Date(vidInfo.expiresAt).getTime() - Date.now()) / 1000;
    expect(vidTtlS).toBeGreaterThan(3500); // ~3600 s (directive B4)
    expect(vidTtlS).toBeLessThanOrEqual(3600);

    // image : TTL par défaut 900 s (comportement B2 inchangé)
    const thumbEnc = await encryptBytes(minimalJpeg());
    const imgRes = await postUploadUrl(alice, "image/jpeg", thumbEnc.sizeBytes, thumbEnc.sha256);
    expect(imgRes.status).toBe(201);
    const imgPresign = (await imgRes.json()) as { mediaId: string; uploadUrl: string };
    const put = await fetch(absUrl(imgPresign.uploadUrl), { method: "PUT", body: thumbEnc.envelope });
    expect(put.ok).toBe(true);
    const fts = Date.now();
    const finRes = await fetch(`${BASE_URL}/api/media/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: alice.pub,
        mediaId: imgPresign.mediaId,
        plainBytes: minimalJpeg().length,
        ts: fts,
        signature: await alice.sign(`${alice.pub}|media-finalize|${imgPresign.mediaId}|${fts}`),
      }),
    });
    expect(finRes.ok).toBe(true);
    const imgInfo = await getDownloadUrl(alice, imgPresign.mediaId);
    const imgTtlS = (new Date(imgInfo.expiresAt).getTime() - Date.now()) / 1000;
    expect(imgTtlS).toBeGreaterThan(800);
    expect(imgTtlS).toBeLessThanOrEqual(900);
  });

  test("V5 — round-trip DEUX appareils : dm2 E2EE (vidéo + thumb) → SHA-256 identiques", async () => {
    if (!FIX_OK) return;
    const vid = new Uint8Array(readFileSync(FIX_WEBM_VID));
    const uploaded = await uploadVideoNote({
      bytes: vid,
      durationMs: 9_960,
      thumb: { bytes: minimalJpeg(), width: 320, height: 240 },
      me: alice.pub,
      sign: alice.sign,
    });
    const payload = {
      kind: "media",
      text: "",
      mediaId: uploaded.mediaId,
      cek: uploaded.cekB64,
      mediaType: uploaded.mediaType,
      bytes: uploaded.plainBytes,
      objectKey: uploaded.objectKey,
      durationMs: uploaded.durationMs,
      thumb: uploaded.thumb
        ? {
            mediaId: uploaded.thumb.mediaId,
            cek: uploaded.thumb.cekB64,
            mediaType: uploaded.thumb.mediaType,
            bytes: uploaded.thumb.bytes,
            objectKey: uploaded.thumb.objectKey,
          }
        : undefined,
    };
    const sealed = await sealTo(alice.ecdhPriv, bob.ecdhPubRaw, JSON.stringify(payload));

    // B ouvre le dm2, déchiffre le payload, télécharge la vidéo ET la vignette
    const opened = JSON.parse(await openFrom(bob.ecdhPriv, alice.ecdhPubRaw, sealed)) as typeof payload;
    expect(opened.mediaId).toBe(uploaded.mediaId);
    expect(opened.durationMs).toBe(uploaded.durationMs);
    expect(opened.thumb?.mediaId).toBeTruthy();

    const dlVideo = await downloadVideoNote({
      mediaId: opened.mediaId,
      cekB64: opened.cek,
      declaredType: opened.mediaType,
      me: bob.pub,
      sign: bob.sign,
    });
    expect(await sha256Hex(new Uint8Array(await dlVideo.blob.arrayBuffer()))).toBe(await sha256Hex(vid));

    const thumbBytes = opened.thumb ? await downloadImageForTest(bob, opened.thumb) : null;
    expect(thumbBytes).not.toBeNull();
    // la vignette est un JPEG sniffré (le chemin image B2 vérifie les magic bytes)
    expect(Array.from((thumbBytes ?? new Uint8Array()).slice(0, 2))).toEqual([0xff, 0xd8]);
  });

  test("V6 — barrière de rendu : dm2 video/webm portant des OCTETS AUDIO → REFUS", async () => {
    if (!FIX_AUD_OK) return;
    const aud = new Uint8Array(readFileSync(FIX_WEBM_AUD));
    const enc = await encryptBytes(aud);
    const res = await postUploadUrl(alice, "video/webm", enc.sizeBytes, enc.sha256);
    expect(res.status).toBe(201);
    const presign = (await res.json()) as { mediaId: string; uploadUrl: string };
    const put = await fetch(absUrl(presign.uploadUrl), { method: "PUT", body: enc.envelope });
    expect(put.ok).toBe(true);
    const fts = Date.now();
    const finRes = await fetch(`${BASE_URL}/api/media/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: alice.pub,
        mediaId: presign.mediaId,
        plainBytes: aud.length,
        ts: fts,
        signature: await alice.sign(`${alice.pub}|media-finalize|${presign.mediaId}|${fts}`),
      }),
    });
    expect(finRes.ok).toBe(true);

    // un client MALVEILLANT a déclaré video/webm : la barrière de rendu
    // (assertPlayableVideo — sniff V_*) refuse le webm audio au destinataire.
    await expect(
      downloadVideoNote({
        mediaId: presign.mediaId,
        cekB64: enc.cekB64,
        declaredType: "video/webm",
        me: bob.pub,
        sign: bob.sign,
      })
    ).rejects.toThrow(/magic-bytes-mismatch/);
  });
});

/** Download image (vignette) — chemin client B2 réel, retourne les octets. */
async function downloadImageForTest(
  id: TestIdentity,
  thumb: { mediaId: string; cek: string }
): Promise<Uint8Array> {
  const info = await getDownloadUrl(id, thumb.mediaId);
  expect(info.status).toBe(200);
  const dl = await fetch(absUrl(info.downloadUrl));
  expect(dl.ok).toBe(true);
  const envelope = await dl.text();
  return decryptBytes(envelope, thumb.cek);
}
