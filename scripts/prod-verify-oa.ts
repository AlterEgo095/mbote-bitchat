/**
 * Vérification post-déploiement O-A — Mbote « BitChat-like » (G + O-A)
 *
 * Exerce EN RÉEL la nouvelle surface de production, comme un vrai client :
 *   1. Santé : /api/stats 200 + données présentes.
 *   2. Surface API nouvelle en ligne — les gates cryptographiques répondent
 *      (401/400 attendus sans preuve : médias, groupes, MLS, DM, appels).
 *   3. Identité réelle : PoW Sybil (SHA-256 itéré, 20 bits) + ECDSA P-256
 *      → POST /api/identity (2 identités de test : Alice + Bob).
 *   4. Texte signé : POST /api/posts (signature serveur vérifiée).
 *   5. DM E2EE réel : ECDH P-256 → AES-256-GCM, envoi dm2 signé
 *      (msgId+seq opposables), relecture par preuve dm-read de Bob.
 *   6. Médias : presigned PUT + finalize signés (503 = stockage non
 *      provisionné → WARN avec remédiation MEDIA_S3_*).
 *   7. Groupe MLS : création signée + ciphertext MLS OPAQUE (invariant C4 :
 *      aucun plaintext côté serveur) + message de groupe.
 *   8. Préférences (G/i18n) : POST signé locale=en + GET de relecture.
 *   9. Admin : hors portée HTTP publique (bind 127.0.0.1:3001) — commandes
 *      SSH de vérification imprimées (jamais silencieux : pas d'échec masqué).
 *  10. Migrations : commande SSH O-B (lecture seule) imprimée + rappel.
 *
 * Effets de bord assumés (documentés) : 2 identités créées (plafond Sybil
 * 3/h/IP), 1 post, 1 DM, 1 groupe, 1 message de groupe, préférence locale.
 * Aucune donnée réelle d'utilisateur n'est lue ni modifiée.
 *
 * Usage :
 *   bun scripts/prod-verify-oa.ts https://mbotemesh.aenews.online
 *   bun scripts/prod-verify-oa.ts http://127.0.0.1:3390 --local
 *
 * Exit 0 = prêt (WARN documentés tolérés) ; exit 1 = au moins un FAIL.
 */
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const LOCAL = args.includes("--local");
const BASE = (args.find((a) => !a.startsWith("--")) ?? "https://mbotemesh.aenews.online").replace(/\/$/, "");

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
const results: { name: string; status: Status; note: string }[] = [];

function record(name: string, status: Status, note: string): void {
  results.push({ name, status, note });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "WARN" ? "⚠️ " : "⏭️ ";
  console.log(`${icon} ${name} — ${note}`);
}

// ───────────────────────── utilitaires crypto (client réel) ─────────────────────────

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const u = new Uint8Array(n);
  globalThis.crypto.getRandomValues(u);
  return u;
}

/** Copie stricte vers ArrayBuffer (BufferSource TS — lib DOM 2026). */
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function newIdentityKey(): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function exportPubB64url(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtle.exportKey("raw", key));
  return b64url(raw);
}

async function signMessage(priv: CryptoKey, message: string): Promise<string> {
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(message)));
  return b64url(sig);
}

/** PoW Sybil : SHA-256(`${pubkey}|pow|${ts}:${nonce}`) → 20 bits à zéro (5 « 0 » hex). */
function solvePow(pubkey: string, ts: number): number {
  const target = "00000";
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const hex = createHash("sha256").update(`${pubkey}|pow|${ts}:${nonce}`).digest("hex");
    if (hex.startsWith(target)) return nonce;
  }
  throw new Error("PoW 20 bits introuvable (improbable) — abandon");
}

// ───────────────────────── helpers HTTP ─────────────────────────

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: unknown; text: string }> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text };
}

function post(path: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

// ───────────────────────── programme ─────────────────────────

async function main(): Promise<void> {
  console.log(`\n═══ Mbote prod-verify O-A — cible : ${BASE}${LOCAL ? " (mode local)" : ""} ═══\n`);
  const ts = () => Date.now();

  // ── 1. Santé ────────────────────────────────────────────────────────────
  try {
    const { status, json } = await api("/api/stats");
    const s = json as { users?: number; posts?: number; dms?: number } | null;
    if (status === 200 && s && (s.users ?? 0) > 0) {
      record("Santé /api/stats", "PASS", `200 OK — users=${s.users} posts=${s.posts} dms=${s.dms}`);
    } else {
      record("Santé /api/stats", "FAIL", `status=${status} body=${JSON.stringify(json)?.slice(0, 120)}`);
    }
  } catch (e) {
    record("Santé /api/stats", "FAIL", `injoignable : ${(e as Error).message}`);
    finish();
    return;
  }

  // ── 2. Surface API nouvelle : gates actifs (sans preuve → refus propre) ──
  const gates: [string, Promise<{ status: number }>][] = [
    ["POST /api/media/upload-url (gate)", post("/api/media/upload-url", {})],
    ["POST /api/groups (gate)", post("/api/groups", {})],
    ["POST /api/dms (gate)", post("/api/dms", {})],
    ["POST /api/groups/unknown/messages (gate)", post("/api/groups/0000000000000000/messages", {})],
    ["POST /api/call-knock (gate)", post("/api/call-knock", {})],
    ["GET /api/turn-credentials (gate)", api("/api/turn-credentials")], // route GET-only (POST = 405) — sonde GET
    ["GET /api/preferences?pubkey=invalide (gate)", api("/api/preferences?pubkey=invalide")],
  ];
  for (const [name, p] of gates) {
    try {
      const { status } = await p;
      if ([400, 401, 403, 405, 429, 503].includes(status)) {
        record(name, "PASS", `status ${status} — endpoint vivant et gardé (refus propre sans preuve)`);
      } else if (status === 404) {
        record(name, "FAIL", "404 — route absente : la version déployée n'est PAS la nouvelle");
      } else if (status === 503) {
        record(name, "PASS", "503 propre (dépendance externe non configurée — endpoint vivant)");
      } else {
        record(name, "WARN", `status ${status} inattendu sans preuve — à inspecter`);
      }
    } catch (e) {
      record(name, "FAIL", `erreur réseau : ${(e as Error).message}`);
    }
  }

  // ── 3. Identités réelles (PoW + ECDSA) ──────────────────────────────────
  const stamp = Date.now().toString(36);
  type Id = {
    nickname: string;
    pubkey: string; // clé ECDSA publique (identité signante)
    priv: CryptoKey; // ECDSA privée
    ecdhPriv: CryptoKey; // ECDH privée (chiffrement DM)
    ecdhPubBytes: Uint8Array; // ECDH publique brute — importable par le pair
  };
  const makeIdentity = async (nick: string): Promise<Id> => {
    const pair = await newIdentityKey();
    const pubkey = await exportPubB64url(pair.publicKey);
    const ecdhPair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const ecdhPubRaw = new Uint8Array(await subtle.exportKey("raw", ecdhPair.publicKey));
    const ecdhPub = b64url(ecdhPubRaw);
    const t = ts();
    const nonce = solvePow(pubkey, t);
    const signature = await signMessage(
      pair.privateKey,
      `${pubkey}|identity|${nick}|prod-verify O-A|${ecdhPub}|${t}`
    );
    const { status, json } = await post("/api/identity", {
      pubkey,
      nickname: nick,
      bio: "prod-verify O-A",
      ecdhPub,
      ts: t,
      signature,
      pow: { nonce: String(nonce) }, // contrat serveur : nonce ENTIER DÉCIMAL SOUS FORME DE CHAÎNE (isPlausibleNonce /^[0-9]+$/ — number JS = 403)
    });
    if (status !== 200 && status !== 201) {
      record(`Identité ${nick}`, "FAIL", `POST /api/identity → ${status} : ${JSON.stringify(json)?.slice(0, 160)}`);
      throw new Error("identité refusée — suite des scénarios E2EE impossible");
    }
    record(`Identité ${nick}`, "PASS", `créée (PoW 20 bits + ECDSA vérifiés serveur) — pubkey ${pubkey.slice(0, 12)}…`);
    return { nickname: nick, pubkey, priv: pair.privateKey, ecdhPriv: ecdhPair.privateKey, ecdhPubBytes: ecdhPubRaw };
  };

  let alice: Awaited<ReturnType<typeof makeIdentity>> | null = null;
  let bob: Awaited<ReturnType<typeof makeIdentity>> | null = null;
  try {
    alice = await makeIdentity(`probe-A-${stamp}`);
    bob = await makeIdentity(`probe-B-${stamp}`);
  } catch (e) {
    record("Identités de test", "WARN", `${(e as Error).message} — scénarios signés 4-8 passent en SKIP (plafond Sybil 3/h/IP ou PoW refusé)`);
  }

  // ── 4. Texte signé (feed public) ────────────────────────────────────────
  if (alice) {
    const t = ts();
    const content = `Vérification O-A — texte signé ${stamp}`;
    const signature = await signMessage(alice.priv, `${alice.pubkey}|${content}|${t}`);
    const { status, json } = await post("/api/posts", { pubkey: alice.pubkey, content, ts: t, signature });
    if (status === 200 || status === 201) {
      record("Texte signé POST /api/posts", "PASS", `status ${status} — signature serveur vérifiée`);
    } else {
      record("Texte signé POST /api/posts", "FAIL", `${status} : ${JSON.stringify(json)?.slice(0, 160)}`);
    }
  } else {
    record("Texte signé POST /api/posts", "SKIP", "identité indisponible");
  }

  // ── 5. DM E2EE réel (ECDH → AES-GCM → dm2 signé → relecture dm-read) ─────
  if (alice && bob) {
    try {
      // ECDH P-256 réel : Alice importe la publique ECDH de Bob et dérive le
      // secret ; clé AES = SHA-256 du secret (dérivation démo — le client réel
      // passe par src/lib/mbote/crypto.ts ; le serveur traite le ciphertext
      // comme OPAQUE : invariant E2EE, aucun plaintext côté serveur).
      const bobPub = await subtle.importKey("raw", ab(bob.ecdhPubBytes), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: bobPub }, alice.ecdhPriv, 256));
      const keyMat = new Uint8Array(await subtle.digest("SHA-256", shared));
      const aesKey = await subtle.importKey("raw", ab(keyMat), { name: "AES-GCM" }, false, ["encrypt"]);
      const iv = randomBytes(12);
      const plaintext = enc.encode(`DM E2EE de vérification O-A ${stamp}`);
      const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, ab(plaintext)));
      const msgId = b64url(randomBytes(24));
      const t = ts();
      const signature = await signMessage(
        alice.priv,
        `${alice.pubkey}|dm2|${bob.pubkey}|${msgId}|0|${b64url(iv)}|${b64url(ct)}|${t}`
      );
      const { status, json } = await post("/api/dms", {
        senderKey: alice.pubkey,
        recipientKey: bob.pubkey,
        iv: b64url(iv),
        ciphertext: b64url(ct),
        msgId,
        seq: 0,
        ts: t,
        signature,
      });
      if (status === 200 || status === 201) {
        record("DM E2EE envoi (dm2 signé)", "PASS", `status ${status} — ciphertext opaque stocké (serveur sans plaintext)`);
        // relecture par Bob (preuve dm-read)
        const tr = ts();
        const rsig = await signMessage(bob.priv, `${bob.pubkey}|dm-read|${alice.pubkey}|${tr}`);
        const r = await api(`/api/dms?me=${encodeURIComponent(bob.pubkey)}&peer=${encodeURIComponent(alice.pubkey)}&ts=${tr}&signature=${rsig}`);
        const rows = (r.json as { dms?: unknown[]; messages?: unknown[] } | null) ?? null;
        const count = rows ? (rows.dms?.length ?? rows.messages?.length ?? 0) : -1;
        if (r.status === 200 && count > 0) {
          record("DM E2EE relecture (dm-read Bob)", "PASS", `200 OK — ${count} message(s) visible(s) par le destinataire seul`);
        } else if (r.status === 200) {
          record("DM E2EE relecture (dm-read Bob)", "WARN", `200 OK mais 0 message lisible (forme de réponse à inspecter : ${r.text.slice(0, 120)})`);
        } else {
          record("DM E2EE relecture (dm-read Bob)", "FAIL", `${r.status} : ${r.text.slice(0, 160)}`);
        }
      } else {
        record("DM E2EE envoi (dm2 signé)", "FAIL", `${status} : ${JSON.stringify(json)?.slice(0, 160)}`);
      }
    } catch (e) {
      record("DM E2EE (bout en bout)", "FAIL", `erreur crypto/réseau : ${(e as Error).message}`);
    }
  } else {
    record("DM E2EE (bout en bout)", "SKIP", "identités indisponibles");
  }

  // ── 6. Médias (presigned PUT + finalize) ────────────────────────────────
  if (alice) {
    // PNG 1×1 valide (67 octets) — upload réel si le stockage est configuré.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    const t = ts();
    const signature = await signMessage(alice.priv, `${alice.pubkey}|media-upload|image/png|${png.length}|${t}`);
    const { status, json } = await post("/api/media/upload-url", {
      me: alice.pubkey,
      mediaType: "image/png",
      sizeBytes: png.length,
      ts: t,
      signature,
    });
    if (status === 503) {
      record("Médias (upload-url)", "WARN", "503 stockage non configuré — provisionner MEDIA_S3_* (R2/S3) puis re-run (remédiation §6 DEPLOY-AND-MOBILE.md)");
    } else if (status === 201) {
      const up = json as { mediaId?: string; uploadUrl?: string } | null;
      if (!up?.mediaId || !up?.uploadUrl) {
        record("Médias (upload-url)", "FAIL", `201 sans mediaId/uploadUrl : ${JSON.stringify(json)?.slice(0, 140)}`);
      } else {
        const put = await fetch(`${BASE}${up.uploadUrl}`, {
          method: "PUT",
          body: png,
          headers: { "content-type": "application/octet-stream" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!put.ok) {
          record("Médias (PUT presigned)", "FAIL", `PUT ${put.status} sur ${up.uploadUrl.slice(0, 60)}`);
        } else {
          const tf = ts();
          const fsig = await signMessage(alice.priv, `${alice.pubkey}|media-finalize|${up.mediaId}|${tf}`);
          const fin = await post("/api/media/finalize", { me: alice.pubkey, mediaId: up.mediaId, ts: tf, signature: fsig });
          record("Médias (PUT + finalize)", fin.status === 200 || fin.status === 201 ? "PASS" : "FAIL",
            `PUT ${put.status} · finalize ${fin.status} — rond complet média effectué`);
        }
      }
    } else {
      record("Médias (upload-url)", "FAIL", `${status} : ${JSON.stringify(json)?.slice(0, 160)}`);
    }
  } else {
    record("Médias (upload-url)", "SKIP", "identité indisponible");
  }

  // ── 7. Groupe MLS (création + ciphertext opaque) ────────────────────────
  if (alice) {
    const mlsGroupId = Array.from(randomBytes(16)).map((b) => b.toString(16).padStart(2, "0")).join(""); // hex LOWERCASE strict — contrat serveur /^[0-9a-f]{32,128}$/ (le filtre case-insensitive laissait des A-F majuscules = 400)
    const t = ts();
    const name = `Vérif O-A ${stamp}`;
    const signature = await signMessage(alice.priv, `${alice.pubkey}|group-create|${mlsGroupId}|${t}`); // défaut latent #3 : le ts FINAL fait partie de la chaîne signée (verifyGroupProof → verifySignedMessage `${msg}|${ts}`, aucun fallback — 401 sinon, découvert au re-test MLS réel 2026-11-15)
    const cr = await post("/api/groups", { me: alice.pubkey, mlsGroupId, name, ts: t, signature });
    if (cr.status === 200 || cr.status === 201) {
      record("Groupe MLS création (signée)", "PASS", `status ${cr.status} — group ${mlsGroupId.slice(0, 8)}…`);
      const gj = cr.json as { id?: string; group?: { id?: string } } | null;
      const gid = gj?.id ?? gj?.group?.id ?? "";
      if (!gid) {
        record("Message de groupe", "WARN", `id de groupe absent de la réponse (${JSON.stringify(cr.json)?.slice(0, 120)}) — POST message non tenté`);
      } else {
        const tg = ts();
        const gsig = await signMessage(alice.priv, `${alice.pubkey}|group-msg|${gid}|${tg}`); // même contrat : `${msg}|${ts}` final
        const gm = await post(`/api/groups/${encodeURIComponent(gid)}/messages`, {
          me: alice.pubkey,
          ciphertext: b64url(randomBytes(64)), // wire MLS opaque — le serveur ne voit AUCUN plaintext (C4)
          mlsEpoch: 1,
          ts: tg,
          signature: gsig,
        });
        record("Message de groupe (ciphertext MLS)", gm.status === 200 || gm.status === 201 ? "PASS" : "FAIL",
          `status ${gm.status} ${gm.status === 200 || gm.status === 201 ? "— ciphertext opaque stocké" : ": " + JSON.stringify(gm.json)?.slice(0, 140)}`);
      }
    } else if (cr.status === 409 || cr.status === 429) {
      record("Groupe MLS création (signée)", "WARN", `${cr.status} (rate limit/idempotence) — scénario à re-tenter`);
    } else {
      record("Groupe MLS création (signée)", "FAIL", `${cr.status} : ${JSON.stringify(cr.json)?.slice(0, 160)}`);
    }
  } else {
    record("Groupe MLS création (signée)", "SKIP", "identité indisponible");
  }

  // ── 8. Préférences (G/i18n) ─────────────────────────────────────────────
  if (alice) {
    const t = ts();
    const signature = await signMessage(alice.priv, `${alice.pubkey}|preferences|en|${t}`);
    const { status, json } = await post("/api/preferences", { pubkey: alice.pubkey, locale: "en", ts: t, signature });
    if (status === 200 || status === 201) {
      const g = await api(`/api/preferences?pubkey=${encodeURIComponent(alice.pubkey)}`);
      const loc = (g.json as { locale?: string } | null)?.locale;
      record("Préférences i18n (POST + GET)", loc === "en" ? "PASS" : "WARN",
        `POST ${status} · GET → locale=${String(loc)} ${loc === "en" ? "(persistée ✓)" : "(lecture à inspecter)"}`);
    } else {
      record("Préférences i18n (POST + GET)", "FAIL", `${status} : ${JSON.stringify(json)?.slice(0, 160)}`);
    }
  } else {
    record("Préférences i18n (POST + GET)", "SKIP", "identité indisponible");
  }

  // ── 9. Admin (hors HTTP public) — commandes SSH imprimées ───────────────
  record("Admin panel (127.0.0.1:3001)", "SKIP",
    "non public par conception (nginx + Cloudflare Access) — vérifier via SSH : `docker exec mbote-admin bun -e \"await fetch('http://localhost:3001/api/health').then(r=>console.log(r.status))\"` + section §7 DEPLOY-AND-MOBILE.md");

  // ── 10. Migrations (commande O-B lecture seule imprimée) ────────────────
  record("Migrations (état réel)", "SKIP",
    "lancer la commande O-B §2 DEPLOY-AND-MOBILE.md (SELECT readonly _prisma_migrations — la dernière ligne doit être 0012_g_i18n_preferences après deploy)");

  finish();
}

async function finish(): Promise<void> {
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  const skips = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n═══ Bilan : ${results.length - fails - warns - skips} PASS · ${warns} WARN · ${skips} SKIP · ${fails} FAIL ═══`);
  if (fails > 0) {
    console.log("❌ ÉCHEC — voir les lignes ❌ ci-dessus (jamais silencieux : chaque échec est explicite)");
    process.exit(1);
  }
  console.log(warns > 0 ? "⚠️  PASS avec réserves (WARN documentés) — traiter les remédiations listées" : "✅ PRÊT");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ erreur fatale :", e);
  process.exit(1);
});
