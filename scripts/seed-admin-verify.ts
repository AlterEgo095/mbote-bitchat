/**
 * Seed de vérification locale (DEV UNIQUEMENT — db/custom.db sandbox).
 * Jeu de données minimal pour les 12 vues du panneau admin.
 * Ne JAMAIS exécuter en prod.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const A = "pk-alpha-aaaaaaaaaaaaaaaaaaaaaa";
const B = "pk-bravo-bbbbbbbbbbbbbbbbbbbbbb";
const C = "pk-charlie-cccccccccccccccccccc";

async function main() {
  // idempotent : purge du seed précédent (ordre inverse des dépendances)
  await db.like.deleteMany({ where: { user: { pubkey: { in: [A, B, C] } } } });
  await db.report.deleteMany({ where: { reporterKey: { in: [A, B, C] } } });
  await db.meshIngest.deleteMany({ where: { hash: { startsWith: "seedhash" } } });
  await db.powSpent.deleteMany({ where: { challenge: { startsWith: "seedpow" } } });
  await db.replayCounter.deleteMany({ where: { key: { startsWith: "seedcounter" } } });
  await db.gatewayNode.deleteMany({ where: { id: "gw-1" } });
  await db.pushSubscription.deleteMany({ where: { userId: { in: [A, B, C] } } });
  await db.media.deleteMany({ where: { ownerPubkey: { in: [A, B, C] } } });
  await db.trustedKey.deleteMany({ where: { OR: [{ ownerKey: { in: [A, B, C] } }, { peerKey: { in: [A, B, C] } }] } });
  await db.peerBlock.deleteMany({ where: { OR: [{ blockerKey: { in: [A, B, C] } }, { blockedKey: { in: [A, B, C] } }] } });
  await db.groupEnvelope.deleteMany({});
  await db.groupMessage.deleteMany({});
  await db.groupMember.deleteMany({});
  await db.group.deleteMany({});
  await db.directMessage.deleteMany({ where: { OR: [{ senderKey: { in: [A, B, C] } }, { recipientKey: { in: [A, B, C] } }] } });
  await db.follow.deleteMany({ where: { OR: [{ follower: { pubkey: { in: [A, B, C] } } }, { following: { pubkey: { in: [A, B, C] } } }] } });
  await db.post.deleteMany({ where: { author: { pubkey: { in: [A, B, C] } } } });
  await db.user.deleteMany({ where: { pubkey: { in: [A, B, C] } } });

  const uA = await db.user.create({ data: { pubkey: A, nickname: "Alpha", ecdhPub: "ecdh-alpha", reputationScore: 12 } });
  const uB = await db.user.create({ data: { pubkey: B, nickname: "Bravo", ecdhPub: "ecdh-bravo", reputationScore: 7 } });
  const uC = await db.user.create({ data: { pubkey: C, nickname: "Charlie", reputationScore: 2 } });

  const post = await db.post.create({
    data: { content: "Premier post de vérification du back-office Mbote.", authorId: uA.id, origin: "internet", likeCount: 2, replyCount: 0 },
  });

  await db.like.create({ data: { postId: post.id, userId: uB.id } });

  await db.report.create({
    data: { reporterKey: B, targetKind: "post", targetId: post.id, reason: "spam", details: "Contenu répété 3 fois." },
  });

  await db.follow.create({ data: { followerId: uB.id, followingId: uA.id } });
  await db.follow.create({ data: { followerId: uC.id, followingId: uA.id } });
  await db.follow.create({ data: { followerId: uA.id, followingId: uB.id } });

  // DM : paire A|B (3 messages dont 1 legacy, 1 non-lu) + paire A|C (1 message)
  await db.directMessage.create({ data: { senderKey: A, recipientKey: B, iv: "iv1", ciphertext: "Y2lwaGVydGV4dC1kZW1vLTEyMw==", msgId: "msg-1", seq: 1, createdAt: new Date(Date.now() - 7_200_000) } });
  await db.directMessage.create({ data: { senderKey: B, recipientKey: A, iv: "iv2", ciphertext: "Y2lwaGVydGV4dC1kZW1vLTI=", msgId: "msg-2", seq: 2, createdAt: new Date(Date.now() - 3_600_000), readAt: new Date(Date.now() - 3_500_000) } });
  await db.directMessage.create({ data: { senderKey: A, recipientKey: B, iv: "iv3", ciphertext: "Y2lwaGVydGV4dC1kZW1vLTM=", createdAt: new Date(Date.now() - 600_000) } }); // legacy + non-lu
  await db.directMessage.create({ data: { senderKey: A, recipientKey: C, iv: "iv4", ciphertext: "Y2lwaGVydGV4dC1kZW1vLTQ=", msgId: "msg-4", seq: 1, createdAt: new Date(Date.now() - 90_000) } });

  const group = await db.group.create({
    data: { name: "Vérification MLS", mlsGroupId: "aabbccdd00112233445566778899aabb", creatorKey: A },
  });
  await db.groupMember.create({ data: { groupId: group.id, userKey: A, mlsLeafIndex: 0 } });
  await db.groupMember.create({ data: { groupId: group.id, userKey: B, mlsLeafIndex: 1 } });
  await db.groupMember.create({ data: { groupId: group.id, userKey: C, mlsLeafIndex: 2, leftAt: new Date(Date.now() - 1_800_000) } });
  await db.groupMessage.create({ data: { groupId: group.id, senderKey: A, mlsEpoch: 3n, ciphertext: "bWxzLWNpcGhlcnRleHQtYQ==", createdAt: new Date(Date.now() - 2_400_000) } });
  await db.groupMessage.create({ data: { groupId: group.id, senderKey: B, mlsEpoch: 3n, ciphertext: "bWxzLWNpcGhlcnRleHQtYg==", createdAt: new Date(Date.now() - 1_200_000) } });
  await db.groupEnvelope.create({ data: { groupId: group.id, kind: "commit", payload: "bWxzLWNvbW1pdA==", createdAt: new Date(Date.now() - 2_500_000) } });
  await db.groupEnvelope.create({ data: { groupId: group.id, kind: "welcome", targetKey: B, payload: "bWxzLXdlbGNvbWU=", createdAt: new Date(Date.now() - 2_450_000) } });

  await db.media.create({ data: { objectKey: "media/seed-finalized-1.png", ownerPubkey: A, mediaType: "image/png", sizeBytes: 145_000, plainBytes: 144_000, sha256: "aa11", status: "finalized", finalizedAt: new Date(Date.now() - 4_000_000) } });
  await db.media.create({ data: { objectKey: "media/seed-pending-old-2.jpg", ownerPubkey: B, mediaType: "image/jpeg", sizeBytes: 32_000, plainBytes: 31_500, status: "pending", createdAt: new Date(Date.now() - 26 * 3_600_000) } }); // expiré 24h

  await db.trustedKey.create({ data: { ownerKey: A, peerKey: B, ecdhPubPinned: "ecdh-pinned-b", safetyNumber: "1234-5678-9012-3456-7890-1234-5678-9012", state: "verified", verifiedAt: new Date(Date.now() - 3_600_000) } });
  await db.trustedKey.create({ data: { ownerKey: B, peerKey: C, ecdhPubPinned: "ecdh-pinned-c", safetyNumber: "9876-5432-1098-7654-3210-9876-5432-1098", state: "unverified" } });
  await db.peerBlock.create({ data: { blockerKey: B, blockedKey: C } });

  await db.meshIngest.create({ data: { hash: "seedhash0001", gatewayId: "gw-1", type: 2, hops: 1, createdAt: new Date(Date.now() - 120_000) } });
  await db.meshIngest.create({ data: { hash: "seedhash0002", gatewayId: "gw-1", type: 3, hops: 2, createdAt: new Date(Date.now() - 60_000) } });
  await db.powSpent.create({ data: { challenge: "seedpow0001", consumedAt: new Date(Date.now() - 300_000) } });
  await db.replayCounter.create({ data: { key: "seedcounter0001", senderKey: A, recipientKey: B, epoch: 0n, lastSeq: 2n, updatedAt: new Date() } });

  await db.gatewayNode.create({ data: { id: "gw-1", label: "Passerelle Kinshasa", packetsIn: 4200, packetsOut: 3980, lastSeen: new Date(Date.now() - 45_000) } });

  await db.pushSubscription.create({ data: { userId: A, endpoint: "https://push.example.com/send/abc123-secret-token-uuid", keysP256dh: "p256dh-seed", keysAuth: "auth-seed", userAgent: "Mozilla/5.0 seed" } });
  await db.pushSubscription.create({ data: { userId: C, endpoint: "https://push.example.com/send/def456-dead", keysP256dh: "p256dh-seed-c", keysAuth: "auth-seed-c", disabledAt: new Date(Date.now() - 40 * 86_400_000), lastSeenAt: new Date(Date.now() - 40 * 86_400_000) } });

  console.log("SEED OK — users:3, post:1, dms:4, group+2msg+2env, media:2, keys:2, block:1, ingest:2, gw:1, push:2");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
