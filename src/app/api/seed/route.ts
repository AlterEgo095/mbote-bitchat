import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encodeGeohash } from "@/lib/mbote/geohash";

export const dynamic = "force-dynamic";

/**
 * POST /api/seed — données de démonstration (idempotent).
 * Utilisateurs de démo (pubkeys fixes factices), bot avec vraie paire ECDH,
 * publications réparties sur des canaux géohash réels, réponses, likes, follows.
 */

const subtle = () => globalThis.crypto.subtle;

function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64url");
}

const DEMO_USERS = [
  {
    pubkey: "demo-pubkey-mapendo-goma-0a1b2c3d4e5f60718293",
    nickname: "Mapendo",
    bio: "Infirmière à Goma · coordonnatrice bénévoles · mesh = nos radios ne meurent jamais 📡",
    isBot: false,
  },
  {
    pubkey: "demo-pubkey-bofenda-kin-1b2c3d4e5f60718293a4",
    nickname: "Bofenda",
    bio: "Chauffeur Matatus, Kinshasa · je poste l'état du trafic chaque matin",
    isBot: false,
  },
  {
    pubkey: "demo-pubkey-kalala-lubu-2c3d4e5f60718293a4b5",
    nickname: "Kalala",
    bio: "Dev JavaScript à Lubumbashi · online quand loadshedding le permet",
    isBot: false,
  },
  {
    pubkey: "demo-pubkey-nadine-kin-3d4e5f60718293a4b5c6",
    nickname: "Nadine K.",
    bio: "Commerçante au marché Gambela · écrans, tissus, bonnes affaires",
    isBot: false,
  },
  {
    pubkey: "demo-pubkey-yannick-matadi-4e5f60718293a4b5c6d7",
    nickname: "Yannick O.",
    bio: "Pêcheur Matadi · le fleuve raconte tout, il suffit d'écouter",
    isBot: false,
  },
];

const DEMO_POSTS: { authorIdx: number; content: string; geohash: string; precision: number }[] = [];

function buildPosts() {
  const kinCity = encodeGeohash(-4.325, 15.322, 5);
  const kinNeigh = encodeGeohash(-4.325, 15.322, 6);
  const gomaCity = encodeGeohash(-1.6829, 29.2244, 5);
  const lubuCity = encodeGeohash(-11.6647, 27.4794, 5);
  const matadiCity = encodeGeohash(-5.825, 13.451, 5);
  const drc = encodeGeohash(-4.325, 15.322, 2);

  DEMO_POSTS.push(
    {
      authorIdx: 1,
      content:
        "Mbote everyone ! Petit rappel du matin : boulevard du 30 Juin totalement bouché entre Gare et Rond-point Ngaba. Prenez Kasa-Vubu. 🚐",
      geohash: kinCity,
      precision: 5,
    },
    {
      authorIdx: 3,
      content:
        "Nouvel arrivage de pagnes wax au marché Gambela, qualité supérieure. Passage au bloc ce weekend, demandez Nadine. 🧵",
      geohash: kinNeigh,
      precision: 6,
    },
    {
      authorIdx: 0,
      content:
        "Exercice de simulation éruption ce samedi à Goma : le mesh Bluetooth reste le seul canal fiable si les antennes tombent. Formez vos voisins à installer l'app. 🌋",
      geohash: gomaCity,
      precision: 5,
    },
    {
      authorIdx: 2,
      content:
        "Loadshedding de 6h ce matin… tant pis, je code mon prototype de passerelle mesh→Nostr sur batterie. Qui veut tester ? ⚡",
      geohash: lubuCity,
      precision: 5,
    },
    {
      authorIdx: 4,
      content:
        "Le fleuve est généreux aujourd'hui, capitaine Nsenga débarque à 16h au port. Tilapia frais, premiers arrivés, premiers servis. 🐟",
      geohash: matadiCity,
      precision: 5,
    },
    {
      authorIdx: 0,
      content:
        "À toutes les RDC : on organise une grande collecte de téléphones anciens pour les transformer en nœuds relais mesh pour les zones rurales. Donnez vos vieux Android ! 📱❤️",
      geohash: drc,
      precision: 2,
    },
    {
      authorIdx: 1,
      content:
        "Quelqu'un a vu mon portefeuille dans un bus Lingwala ↔ Gare ? Il contient mes documents. Récompense garantie. 🙏",
      geohash: kinCity,
      precision: 5,
    }
  );
}

export async function POST() {
  try {
    buildPosts();

    // 1) utilisateurs : bot (clé ECDH réelle) + comptes démo — créés s'ils manquent
    const botPair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const botPrivJwk = await subtle().exportKey("jwk", botPair.privateKey);
    const botPubRaw = await subtle().exportKey("raw", botPair.publicKey);

    const bot = await db.user.upsert({
      where: { pubkey: "demo-pubkey-mbote-bot-99a8b7c6d5e4f3120" },
      update: {},
      create: {
        pubkey: "demo-pubkey-mbote-bot-99a8b7c6d5e4f3120",
        nickname: "Mbote Bot",
        bio: "Bot de démonstration · répond en chiffré de bout en bout · écris « aide »",
        isBot: true,
        ecdhPub: bufToB64url(botPubRaw),
        botPriv: JSON.stringify(botPrivJwk),
      },
    });

    const users = [bot];
    for (const u of DEMO_USERS) {
      users.push(
        await db.user.upsert({
          where: { pubkey: u.pubkey },
          update: {},
          create: {
            pubkey: u.pubkey,
            nickname: u.nickname,
            bio: u.bio,
            isBot: u.isBot,
          },
        })
      );
    }

    // 2) publications : uniquement si absentes (idempotent par table)
    const postCount = await db.post.count();
    if (postCount > 0) {
      return NextResponse.json({
        seeded: false,
        reason: "déjà initialisé",
        users: users.length,
        posts: postCount,
      });
    }

    const createdPosts: { id: string; authorIdx: number }[] = [];
    for (const p of DEMO_POSTS) {
      const post = await db.post.create({
        data: {
          authorId: users[p.authorIdx + 1].id, // +1 : index 0 = bot
          content: p.content,
          geohash: p.geohash,
          precision: p.precision,
          signature: "demo-signature-seed",
        },
      });
      createdPosts.push({ id: post.id, authorIdx: p.authorIdx });
    }

    // 4) réponses
    await db.post.create({
      data: {
        authorId: users[2].id, // Bofenda
        content: "Confirmé ! Je contourne par Kasa-Vubu, 10 minutes de gagnées. Merci chef 🙏",
        parentId: createdPosts[0].id,
        geohash: DEMO_POSTS[0].geohash,
        precision: DEMO_POSTS[0].precision,
      },
    });
    await db.post.create({
      data: {
        authorId: users[1].id, // Mapendo
        content: "Excellent initiative ! Je peux fournir 12 vieux téléphones de l'hôpital. Je t'écris en DM chiffré.",
        parentId: createdPosts[5].id,
        geohash: DEMO_POSTS[5].geohash,
        precision: DEMO_POSTS[5].precision,
      },
    });

    // 5) likes + follows
    const likeTargets = createdPosts.slice(0, 5);
    for (let i = 0; i < likeTargets.length; i++) {
      const liker = users[(i % (users.length - 1)) + 1];
      await db.like.upsert({
        where: {
          postId_userId: { postId: likeTargets[i].id, userId: liker.id },
        },
        update: {},
        create: { postId: likeTargets[i].id, userId: liker.id },
      });
    }

    const followPairs: [number, number][] = [
      [1, 2], [2, 1], [1, 3], [3, 1], [4, 1], [5, 1], [2, 4],
    ];
    for (const [a, b] of followPairs) {
      await db.follow.upsert({
        where: {
          followerId_followingId: { followerId: users[a].id, followingId: users[b].id },
        },
        update: {},
        create: { followerId: users[a].id, followingId: users[b].id },
      });
    }

    return NextResponse.json({
      seeded: true,
      users: users.length,
      posts: createdPosts.length + 2,
    });
  } catch (e) {
    console.error("POST /api/seed", e);
    return NextResponse.json({ error: "Erreur seed" }, { status: 500 });
  }
}
