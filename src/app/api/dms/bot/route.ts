import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";

export const dynamic = "force-dynamic";

/**
 * POST /api/dms/bot — le bot de démonstration.
 * Il détient SA clé privée ECDH côté serveur (uniquement pour la démo),
 * déchiffre le message de l'utilisateur, puis répond en le re-chiffrant
 * vers la clé publique de l'utilisateur. Réponses 100% locales (règles),
 * aucune dépendance externe — parfait pour un déploiement VPS autonome.
 */

const subtle = () => globalThis.crypto.subtle;

function b64urlToBuf(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer;
}

function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64url");
}

async function deriveKey(botPrivJwk: JsonWebKey, peerEcdhPubB64: string): Promise<CryptoKey> {
  const priv = await subtle().importKey(
    "jwk",
    botPrivJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const peerPub = await subtle().importKey(
    "raw",
    b64urlToBuf(peerEcdhPubB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const bits = await subtle().deriveBits({ name: "ECDH", public: peerPub }, priv, 256);
  return subtle().importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function botReply(text: string): string {
  const t = text.toLowerCase();
  if (/^(bonjour|mbote|salut|hello|jambo|hi)\b/.test(t)) {
    return "Mbote ! 🙌 Je suis le bot démo de Mbote Mesh. Écris « aide » pour voir ce que je sais faire.";
  }
  if (t.includes("aide") || t.includes("help")) {
    return (
      "Voici mes sujets : « mesh » (réseau hors-ligne), « chiffrement » (comment tes DM sont protégés), " +
      "« courrier » (les messages en attente), « géohash » (les canaux locaux), « panic » (l'effacement d'urgence)."
    );
  }
  if (t.includes("mesh") || t.includes("hors ligne") || t.includes("offline")) {
    return (
      "Le mesh : chaque appareil relaie les messages de ses voisins par Bluetooth LE, jusqu'à 7 sauts (TTL 7). " +
      "Pas d'internet, pas de serveur — le réseau, c'est nous. 📡"
    );
  }
  if (t.includes("chiffrement") || t.includes("sécurit") || t.includes("crypto")) {
    return (
      "Tes DM sont chiffrés sur TON appareil (ECDH P-256 + AES-GCM 256). Le serveur ne stocke que du ciphertext " +
      "opaque : même compromis, il ne lira jamais tes conversations. 🔒"
    );
  }
  if (t.includes("courrier") || t.includes("attente") || t.includes("queue")) {
    return (
      "Quand tu es hors-ligne (active « Mode mesh » dans l'en-tête), tes publications attendent dans une file locale " +
      "chiffrée — comme les courriers spray-and-wait de BitChat — puis partent automatiquement au retour du réseau. ✉️"
    );
  }
  if (t.includes("géohash") || t.includes("canal") || t.includes("quartier")) {
    return (
      "Les canaux géohash découpent le monde : #bloc (~150 m), #quartier (~1,2 km), #ville (~5 km), #province, #pays. " +
      "Ton salon local existe déjà — il suffit d'écrire le premier message ! 🗺️"
    );
  }
  if (t.includes("panic") || t.includes("wipe") || t.includes("effac")) {
    return (
      "Panic wipe : dans ton Profil, le bouton rouge efface instantanément tes clés et toutes les données locales. " +
      "Comme le triple-tap de BitChat. Tes clés ne vivaient que sur ton appareil de toute façon. 🔥"
    );
  }
  const rotating = [
    "Bien reçu (et chiffré) ! Question de sécurité : sais-tu que ce message a été chiffré sur TON appareil ?",
    "Message déchiffré avec succès côté bot — la démo E2E fonctionne. Essaie « aide » pour explorer.",
    "Noté ! Au fait : ton profil stocke une clé publique, jamais de secret. C'est ça, le modèle sans compte.",
    "OK ! Si tu perds internet, tes messages partiront en file « courrier » et se synchroniseront au retour.",
  ];
  return rotating[text.length % rotating.length];
}

export async function POST(req: NextRequest) {
  try {
    const { meKey, iv, ciphertext } = await req.json();
    if (!meKey || !iv || !ciphertext) {
      return NextResponse.json({ error: "meKey, iv, ciphertext requis" }, { status: 400 });
    }

    const me = await db.user.findUnique({ where: { pubkey: meKey } });
    const bot = await db.user.findFirst({ where: { isBot: true } });
    if (!me || !bot || !bot.botPriv || !bot.ecdhPub || !me.ecdhPub) {
      return NextResponse.json(
        { error: "Bot indisponible ou clés manquantes (relancez /api/seed)" },
        { status: 404 }
      );
    }

    // 1) déchiffrer le message de l'utilisateur
    const botPrivJwk = JSON.parse(bot.botPriv) as JsonWebKey;
    const aesKey = await deriveKey(botPrivJwk, me.ecdhPub);
    let plaintext: string;
    try {
      const pt = await subtle().decrypt(
        { name: "AES-GCM", iv: new Uint8Array(b64urlToBuf(iv)) },
        aesKey,
        b64urlToBuf(ciphertext)
      );
      plaintext = new TextDecoder().decode(pt);
    } catch {
      return NextResponse.json({ error: "Enveloppe illisible (mauvaise clé ?)" }, { status: 400 });
    }

    // 2) stocker le message utilisateur → bot
    await db.directMessage.create({
      data: { senderKey: meKey, recipientKey: bot.pubkey, iv, ciphertext },
    });

    // 3) répondre, chiffré vers l'utilisateur
    const reply = botReply(plaintext.slice(0, 400));
    const rIv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(rIv);
    const rCt = await subtle().encrypt({ name: "AES-GCM", iv: rIv }, aesKey, new TextEncoder().encode(reply));
    const botMessage = await db.directMessage.create({
      data: {
        senderKey: bot.pubkey,
        recipientKey: meKey,
        iv: bufToB64url(rIv.buffer as ArrayBuffer),
        ciphertext: bufToB64url(rCt),
      },
    });

    const messageDto = {
      id: botMessage.id,
      senderKey: botMessage.senderKey,
      recipientKey: botMessage.recipientKey,
      iv: botMessage.iv,
      ciphertext: botMessage.ciphertext,
      createdAt: botMessage.createdAt,
      readAt: botMessage.readAt,
    };
    relayNotify("dm:new", { message: messageDto }, [`dm:${meKey}`, `dm:${bot.pubkey}`]);

    return NextResponse.json({ message: messageDto });
  } catch (e) {
    console.error("POST /api/dms/bot", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
