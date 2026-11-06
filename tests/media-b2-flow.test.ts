/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media-b2-flow — harnais E2E B2 (upload présigné → finalize → lecture)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le runner scripts/b2-images-proof-run.sh garantit tout) :
 *    MEDIA_B2_E2E=1 BASE_URL=http://127.0.0.1:3103 \
 *    MEDIA_S3_*=(config weed) DATABASE_URL=(db preuve) \
 *    bun test tests/media-b2-flow.test.ts
 *  Sinon : SKIP propre (jamais de faux rouge — pattern MEDIA_REAL_S3).
 *
 *  PRÉREQUIS runner : weed 3.80 (S3 réel indépendant, §1 B2-images.md) +
 *  app principale standalone :3103 (proxy média actif) + DB preuve.
 *
 *  SCÉNARIOS (directive B2) :
 *    U1  chaîne COMPLÈTE : stripExif(sharp injecté) → encryptBytes (WebCrypto
 *        client) → upload-url → PUT présigné (via proxy même origine) →
 *        finalize → download-url → GET → decryptBytes → SHA-256 IDENTIQUE
 *    U2  EXIF absent APRÈS le voyage complet (GPS de la fixture supprimé)
 *    U3  interop format : enveloppe client lue par decryptMedia socle B1
 *    R1  type application/pdf → 400 · R2  6 Mo → 400
 *    R3  preuve invalide → 401 · R4  rate limit 20/h → 429 sur la 21e
 *    R5  quota : 500 Mo finalized (lignes synthétiques DB) → 429
 *    R6  finalize SANS PUT → 400 (objet absent du bucket)
 *    R7  enveloppe garbage (taille exacte) → finalize 422
 *    R8  fenêtre finalize (> 20 min, DB modifiée) → 410
 *    R9  MIME SPOOFING E2E : PDF chiffré déclaré image/jpeg → finalize 200
 *        (serveur aveugle, assumé §6.7) → decrypt → sniff → REFUS RENDU
 *    R10 download-url sans preuve → 401 · média inconnu → 404
 *    P1  proxy média : chemin hors whitelist → 404 (anti open-proxy)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { stripExif, inspectMetadata } from "../src/lib/mbote/media/exif";
import { decryptMedia } from "../src/lib/mbote/media/crypto";
import {
  encryptBytes,
  decryptBytes,
  sniffImageType,
  assertRenderableImage,
  MediaClientError,
  enqueueOfflineUpload,
  flushUploadQueue,
  uploadQueueSnapshot,
  dequeueOfflineUpload,
  setDefaultStrip,
} from "../src/lib/mbote/media-client";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const ENABLED = process.env.MEDIA_B2_E2E === "1";
const d = ENABLED ? describe : describe.skip;

const db = new PrismaClient({ log: [] });

// ── identité ECDSA P-256 (WebCrypto — même clé que l'app) ────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TestIdentity {
  pub: string;
  sign: (payload: string) => Promise<string>;
}

async function makeIdentity(): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pub = b64url(new Uint8Array(pubRaw));
  const sign = async (payload: string): Promise<string> => {
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      pair.privateKey,
      new TextEncoder().encode(payload)
    );
    return b64url(new Uint8Array(sig));
  };
  return { pub, sign };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── helpers HTTP ─────────────────────────────────────────────────────────────

async function postUploadUrl(
  id: TestIdentity,
  mediaType: string,
  sizeBytes: number,
  sha256?: string,
  signWith: TestIdentity = id
): Promise<Response> {
  const ts = Date.now();
  const signature = await signWith.sign(`${id.pub}|media-upload|${mediaType}|${sizeBytes}|${ts}`);
  return fetch(`${BASE_URL}/api/media/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaType, sizeBytes, sha256, ts, signature }),
  });
}

async function postFinalize(
  id: TestIdentity,
  mediaId: string,
  plainBytes: number
): Promise<Response> {
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-finalize|${mediaId}|${ts}`);
  return fetch(`${BASE_URL}/api/media/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ me: id.pub, mediaId, plainBytes, ts, signature }),
  });
}

async function getDownloadUrl(id: TestIdentity, mediaId: string): Promise<Response> {
  const ts = Date.now();
  const signature = await id.sign(`${id.pub}|media-dl|${mediaId}|${ts}`);
  return fetch(`${BASE_URL}/api/media/download-url?${new URLSearchParams({ me: id.pub, mediaId, ts: String(ts), signature })}`);
}

/** PUT présigné via le CHEMIN relatif (proxy même origine — jamais l'host S3). */
async function putPresigned(uploadUrl: string, envelope: string): Promise<Response> {
  const u = new URL(uploadUrl, BASE_URL);
  return fetch(`${BASE_URL}${u.pathname}${u.search}`, { method: "PUT", body: envelope });
}

/** Chaîne complète — retourne toutes les étapes pour inspection (reprise/queue). */
async function _fullUploadReserved(
  id: TestIdentity,
  originalBytes: Uint8Array,
  declaredType: string,
  opts?: { putBody?: string; skipPut?: boolean }
) {
  const stripped = await stripExif(originalBytes);
  const enc = await encryptBytes(stripped.bytes);
  const presign = await postUploadUrl(id, declaredType, enc.sizeBytes, enc.sha256);
  if (!presign.ok) return { stage: "presign" as const, res: presign, enc, stripped };
  const body = (await presign.json()) as { mediaId: string; uploadUrl: string };
  if (opts?.skipPut) return { stage: "presign" as const, res: presign, enc, stripped, ...body };
  const putBody = opts?.putBody ?? enc.envelope;
  const put = await putPresigned(body.uploadUrl, putBody);
  return { stage: "put" as const, res: put, enc, stripped, ...body, put };
}

beforeAll(async () => {
  if (!ENABLED) return;
  // strip par défaut du harness : sharp (le canvas web n'existe pas sous bun)
  setDefaultStrip(async (b) => (await stripExif(b)).bytes);
  const res = await fetch(`${BASE_URL}/api/stats`);
  if (!res.ok) throw new Error(`app non prête sur ${BASE_URL} (HTTP ${res.status})`);
});

d("B2 — chaîne complète upload → finalize → lecture (weed réel + proxy)", () => {
test("U1+U2 — 500 Ko GPS : SHA-256 identique, EXIF/GPS absent après le voyage complet", async () => {
  const id = await makeIdentity();
  const fixture = readFileSync(join(import.meta.dir, "fixtures", "media-gps-sample.jpg"));
  const before = await sha256Hex(fixture);

  const stripped = await stripExif(fixture);
  const enc = await encryptBytes(stripped.bytes);

  // 1. upload-url (whitelist jpeg, taille = ciphertext)
  const presign = await postUploadUrl(id, "image/jpeg", enc.sizeBytes, enc.sha256);
  expect(presign.status).toBe(201);
  const pres = (await presign.json()) as {
    mediaId: string;
    objectKey: string;
    uploadUrl: string;
    expiresAt: string;
  };
  expect(pres.objectKey.startsWith("media/")).toBe(true);
  // TTL 15 min (900 s ±5)
  const expiresIn = (new Date(pres.expiresAt).getTime() - Date.now()) / 1000;
  expect(expiresIn).toBeGreaterThan(895);
  expect(expiresIn).toBeLessThanOrEqual(900);

  // 2. PUT présigné via le PROXY (même origine) — Content-Length lié
  const put = await putPresigned(pres.uploadUrl, enc.envelope);
  expect(put.status).toBe(200);

  // 3. finalize — existence + taille + enveloppe
  const fin = await postFinalize(id, pres.mediaId, stripped.bytes.length);
  expect(fin.status).toBe(200);
  const finBody = (await fin.json()) as { downloadUrl: string; mediaId: string };
  void finBody;

  // 4. download-url → GET → decrypt client → intégrité E2EE
  const dl = await getDownloadUrl(id, pres.mediaId);
  expect(dl.status).toBe(200);
  const dlBody = (await dl.json()) as { downloadUrl: string; mediaType: string };
  const du = new URL(dlBody.downloadUrl, BASE_URL);
  const get = await fetch(`${BASE_URL}${du.pathname}${du.search}`);
  expect(get.status).toBe(200);
  const envelope = await get.text();

  // 4a. interop : le SOCLE B1 (node:crypto) lit l'enveloppe client
  const plainB1 = decryptMedia(envelope, Buffer.from(b64urlToBytes(enc.cekB64)));
  expect(await sha256Hex(plainB1)).toBe(await sha256Hex(stripped.bytes));

  // 4b. le CLIENT déchiffre aussi (WebCrypto)
  const plain = await decryptBytes(envelope, enc.cekB64);
  const after = await sha256Hex(plain);
  expect(after).not.toBe(before); // strip a changé les octets (GPS retiré)
  expect(after).toBe(await sha256Hex(stripped.bytes)); // round-trip exact

  // 5. EXIF absent APRÈS le voyage complet (le GPS de la fixture est mort)
  const meta = await inspectMetadata(plain);
  expect(meta.exif == null || Object.keys(meta.exif).length === 0).toBe(true);

  // 6. magic bytes post-decrypt : jpeg sniffé
  expect(sniffImageType(plain)).toBe("image/jpeg");
});

test("U3 — interop : decryptMedia socle B1 lit EXACTEMENT une enveloppe encryptBytes client", async () => {
  const msg = new Uint8Array(4096).map(() => Math.floor(Math.random() * 256));
  const enc = await encryptBytes(msg);
  const cekBytes = b64urlToBytes(enc.cekB64);
  const plain = decryptMedia(enc.envelope, Buffer.from(cekBytes));
  expect([...plain]).toEqual([...msg]);
});
});

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

d("B2 — refus d'entrée (serveur)", () => {
test("R1 — application/pdf → 400", async () => {
  const id = await makeIdentity();
  const res = await postUploadUrl(id, "application/pdf", 1000);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("whitelist");
});

test("R2 — 6 Mo → 400", async () => {
  const id = await makeIdentity();
  const res = await postUploadUrl(id, "image/jpeg", 6 * 1024 * 1024);
  expect(res.status).toBe(400);
});

test("R3 — preuve invalide (signée par une AUTRE clé) → 401", async () => {
  const id = await makeIdentity();
  const impostor = await makeIdentity();
  const res = await postUploadUrl(id, "image/jpeg", 1000, undefined, impostor);
  expect(res.status).toBe(401);
});

test("R10 — download-url sans preuve → 401 · média inconnu → 404", async () => {
  const noProof = await fetch(`${BASE_URL}/api/media/download-url?me=x&mediaId=y&ts=1&signature=z`);
  expect(noProof.status).toBe(401);
  const id = await makeIdentity();
  const res = await getDownloadUrl(id, "nonexistent-media-id");
  expect(res.status).toBe(404);
});
});

d("B2 — finalize : contrôles serveur (aveugle)", () => {
test("R6 — finalize SANS PUT → 400 objet absent", async () => {
  const id = await makeIdentity();
  const enc = await encryptBytes(new Uint8Array(2048).fill(7));
  const presign = await postUploadUrl(id, "image/jpeg", enc.sizeBytes);
  expect(presign.status).toBe(201);
  const { mediaId } = (await presign.json()) as { mediaId: string };
  const fin = await postFinalize(id, mediaId, 2048);
  expect(fin.status).toBe(400);
  expect(((await fin.json()) as { error: string }).error).toContain("absent");
});

test("R7 — enveloppe garbage (taille exacte liée) → finalize 422", async () => {
  const id = await makeIdentity();
  const garbageSize = 2048;
  const presign = await postUploadUrl(id, "image/jpeg", garbageSize);
  const { mediaId, uploadUrl } = (await presign.json()) as { mediaId: string; uploadUrl: string };
  const put = await putPresigned(uploadUrl, "x".repeat(garbageSize));
  expect(put.status).toBe(200); // le bucket accepte la TAILLE signée…
  const fin = await postFinalize(id, mediaId, garbageSize);
  expect(fin.status).toBe(422); // …mais l'enveloppe n'est pas une v1 → REFUS
});

test("R8 — fenêtre finalize > 20 min → 410", async () => {
  const id = await makeIdentity();
  const enc = await encryptBytes(new Uint8Array(1024).fill(3));
  const presign = await postUploadUrl(id, "image/jpeg", enc.sizeBytes);
  const { mediaId, uploadUrl } = (await presign.json()) as { mediaId: string; uploadUrl: string };
  await putPresigned(uploadUrl, enc.envelope);
  // horizon artificiel : la ligne date de 21 min (DB directe — harnais)
  await db.$executeRawUnsafe(
    `UPDATE Media SET createdAt = datetime('now', '-21 minutes') WHERE id = ?`,
    mediaId
  );
  const fin = await postFinalize(id, mediaId, 1024);
  expect(fin.status).toBe(410);
});
});

d("B2 — MIME spoofing (arbitrage §6.7 : barrière AU RENDU)", () => {
test("R9 — PDF chiffré déclaré image/jpeg : finalize 200 puis RENDU REFUSÉ", async () => {
  const id = await makeIdentity();
  // un vrai PDF (renommé .jpg) — bytes signés %PDF-
  const pdf = new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"
  );
  const enc = await encryptBytes(pdf);
  const presign = await postUploadUrl(id, "image/jpeg", enc.sizeBytes, enc.sha256);
  expect(presign.status).toBe(201); // le client MALVEILLANT déclare jpeg
  const { mediaId, uploadUrl } = (await presign.json()) as { mediaId: string; uploadUrl: string };
  const put = await putPresigned(uploadUrl, enc.envelope);
  expect(put.status).toBe(200);
  const fin = await postFinalize(id, mediaId, pdf.length);
  expect(fin.status).toBe(200); // serveur AVEUGLE : enveloppe valide (assumé §6.7)

  // LE DESTINATAIRE : download → decrypt → sniff → REFUS du rendu
  const dl = await getDownloadUrl(id, mediaId);
  const { downloadUrl } = (await dl.json()) as { downloadUrl: string };
  const du = new URL(downloadUrl, BASE_URL);
  const get = await fetch(`${BASE_URL}${du.pathname}${du.search}`);
  const envelope = await get.text();
  const plain = await decryptBytes(envelope, enc.cekB64);
  expect(sniffImageType(plain)).toBeNull(); // pas une image
  expect(() => assertRenderableImage(plain, "image/jpeg")).toThrow(MediaClientError);
  try {
    assertRenderableImage(plain, "image/jpeg");
    expect.unreachable();
  } catch (e) {
    expect((e as MediaClientError).code).toBe("magic-bytes-mismatch");
  }
});
});

d("B2 — rate limit + quota", () => {
test("R4 — 21e upload de l'heure → 429 (20/h/utilisateur)", async () => {
  const id = await makeIdentity(); // identité DÉDIÉE (compteur vierge)
  const enc = await encryptBytes(new Uint8Array(512).fill(1));
  let last = 0;
  for (let i = 0; i < 20; i++) {
    const res = await postUploadUrl(id, "image/jpeg", enc.sizeBytes);
    expect(res.status).toBe(201);
    last = res.status;
  }
  const over = await postUploadUrl(id, "image/jpeg", enc.sizeBytes);
  expect(over.status).toBe(429);
  expect(((await over.json()) as { error: string }).error).toContain("Limite");
  void last;
});

test("R5 — quota : owner à 501 Mo finalized → 429", async () => {
  const id = await makeIdentity();
  // 501 Mo de lignes SYNTHÉTIQUES finalized (aucun objet réel — DB directe)
  const chunk = 20 * 1024 * 1024; // 20 Mo
  for (let i = 0; i < 26; i++) {
    const tail = String(i).padStart(12, "0");
    await db.media.create({
      data: {
        objectKey: `media/00000000-0000-4000-8000-${tail}`,
        ownerPubkey: id.pub,
        mediaType: "image/jpeg",
        sizeBytes: chunk,
        plainBytes: chunk,
        status: "finalized",
        finalizedAt: new Date(),
      },
    });
  }
  const enc = await encryptBytes(new Uint8Array(1024).fill(2));
  const res = await postUploadUrl(id, "image/jpeg", enc.sizeBytes);
  expect(res.status).toBe(429);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("Quota");
});
});

d("B2 — proxy média (anti open-proxy)", () => {
test("P1 — chemin hors whitelist (bucket fantôme / clé non uuid) → 404 · routes API NON captées", async () => {
  // les routes API ne sont JAMAIS captées par le rewrite (préfixe /media-proxy/ dédié)
  const route = await fetch(`${BASE_URL}/api/media/download-url?me=x&mediaId=y&ts=1&signature=z`);
  expect(route.status).toBe(401); // pas 404 « chemin média invalide » : la route vit
  // chemin proxy : bucket fantôme → 404 (whitelist)
  const ghostBucket = await fetch(`${BASE_URL}/media-proxy/mbote-media-fantome/media/00000000-0000-4000-8000-000000000001?X-Amz-Algorithm=AWS4-HMAC-SHA256`);
  expect(ghostBucket.status).toBe(404);
  // traversée de chemin refusée
  const badKey = await fetch(`${BASE_URL}/../etc/passwd`);
  expect([404, 400].includes(badKey.status)).toBe(true);
});
});

// ── U4 : DEUX appareils simulés (directive B2 E2E) ───────────────────────────

async function deriveAesKey(priv: CryptoKey, peerPubRaw: Uint8Array): Promise<CryptoKey> {
  const peerPub = await crypto.subtle.importKey("raw", peerPubRaw as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, priv, 256);
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

d("B2 — E2E deux appareils simulés (émetteur → serveur → destinataire)", () => {
test("U4 — A upload + dm2 E2EE → B reçoit, déchiffre le dm2 ET l'image, SHA-256 identique", async () => {
  const A = await makeIdentity();
  const B = await makeIdentity();

  // clés ECDH complètes des deux « appareils »
  const aPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const bPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const aPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", aPair.publicKey));
  const bPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", bPair.publicKey));

  // 1. les DEUX identités sont publiées (le serveur exige sender ET recipient
  // enregistrés pour acheminer un dm2 — /api/dms 404 sinon)
  await publishIdentity(A, `A-src-${Date.now() % 100000}`, b64url(aPubRaw));
  await publishIdentity(B, `B-dest-${Date.now() % 100000}`, b64url(bPubRaw));

  // 2. A upload une image (chaîne complète comme U1)
  const fixture = readFileSync(join(import.meta.dir, "fixtures", "media-gps-sample.jpg"));
  const stripped = await stripExif(fixture);
  const plainSha = await sha256Hex(stripped.bytes);
  const enc = await encryptBytes(stripped.bytes);
  const presign = await postUploadUrl(A, "image/jpeg", enc.sizeBytes, enc.sha256);
  expect(presign.status).toBe(201);
  const { mediaId, uploadUrl } = (await presign.json()) as { mediaId: string; uploadUrl: string };
  expect((await putPresigned(uploadUrl, enc.envelope)).status).toBe(200);
  expect((await postFinalize(A, mediaId, stripped.bytes.length)).status).toBe(200);

  // 3. A scelle le payload MÉDIA (CEK DANS le dm2 — §7.3) et l'envoie à B
  const payload = JSON.stringify({
    kind: "media",
    text: "photo de preuve",
    mediaId,
    cek: enc.cekB64,
    mediaType: "image/jpeg",
    bytes: stripped.bytes.length,
    objectKey: "",
  });
  const sealed = await sealTo(aPair.privateKey, bPubRaw, payload);
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

  // 4. B lit SA boîte (preuve dm-read de B) → 1 dm2 média
  let dm: { iv: string; ciphertext: string };
  {
    const ts = Date.now();
    const signature = await B.sign(`${B.pub}|dm-read|${A.pub}|${ts}`);
    const res = await fetch(`${BASE_URL}/api/dms?${new URLSearchParams({ me: B.pub, peer: A.pub, ts: String(ts), signature })}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { iv: string; ciphertext: string }[] };
    expect(body.messages.length).toBeGreaterThan(0);
    dm = body.messages[body.messages.length - 1];
  }

  // 5. B déchiffre le dm2 avec SA clé ECDH → payload → mediaId + CEK
  const opened = await openFrom(bPair.privateKey, aPubRaw, dm);
  const media = JSON.parse(opened) as { kind: string; mediaId: string; cek: string; mediaType: string; bytes: number };
  expect(media.kind).toBe("media");
  expect(media.mediaId).toBe(mediaId);

  // 6. B demande la lecture (SA preuve media-dl) → decrypt → magic bytes → hash
  const dl = await getDownloadUrl(B, media.mediaId);
  expect(dl.status).toBe(200);
  const { downloadUrl } = (await dl.json()) as { downloadUrl: string };
  const du = new URL(downloadUrl, BASE_URL);
  const get = await fetch(`${BASE_URL}${du.pathname}${du.search}`);
  expect(get.status).toBe(200);
  const envelope = await get.text();
  const plain = await decryptBytes(envelope, media.cek);
  expect(await sha256Hex(plain)).toBe(plainSha); // intégrité E2EE inter-appareils
  expect(sniffImageType(plain)).toBe("image/jpeg");
});
});

d("B2 — file hors-ligne (re-orchestration)", () => {
test("R11 — queue : flush rejoue (re-strip/re-chiffre/re-signe) → upload réussi ; item invalide → failed", async () => {
  const id = await makeIdentity();
  const fixture = readFileSync(join(import.meta.dir, "fixtures", "media-gps-sample.jpg"));
  const ok = enqueueOfflineUpload("photo-preuve.jpg", new Uint8Array(fixture), "image/jpeg");
  const bad = enqueueOfflineUpload("notes.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");

  const done = await flushUploadQueue(id.pub, id.sign);
  if (done.length === 0) {
    console.log("[R11 diag] lastErrors:", uploadQueueSnapshot().map((q) => `${q.name}: ${q.lastError}`));
  }
  expect(done).toContain(ok.ref);
  // l'item succès est sorti de la file
  expect(uploadQueueSnapshot().find((q) => q.ref === ok.ref)).toBeUndefined();
  // l'item invalide est marqué failed avec l'erreur
  const failed = uploadQueueSnapshot().find((q) => q.ref === bad.ref);
  expect(failed?.status).toBe("failed");
  expect(failed?.lastError).toContain("whitelist");
  dequeueOfflineUpload(bad.ref); // nettoyage (abandon utilisateur)
  expect(uploadQueueSnapshot()).toHaveLength(0);
});
});
