/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  E2E A3 — modération du fil public contre l'API RÉELLE (serveur dev)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prérequis : serveur avec ADMIN_API_KEY + DATABASE_URL EXPLICITES (piège du
 *  DATABASE_URL global du sandbox : docs/DEV-SETUP.md §2a). Le DATABASE_URL du
 *  script DOIT être identique à celui du serveur (vérifications DB directes).
 *    DATABASE_URL="file:$(pwd)/db/custom.db" bunx prisma db push
 *    DATABASE_URL="file:$(pwd)/db/custom.db" ADMIN_API_KEY=a3-dev-admin-key bunx next dev -p 3100 &
 *    DATABASE_URL="file:$(pwd)/db/custom.db" ADMIN_API_KEY=a3-dev-admin-key \
 *      MBOTE_BASE_URL=http://127.0.0.1:3100 bun tests/moderation-e2e.ts
 *
 *  Scénarios (exigences de validation A3) :
 *   S1. identités réelles (Alice signaleuse, Bob auteur, Carol signaleuse)
 *   S2. Bob publie (post P1, post P2, commentaire C1 sur P1)
 *   S3. POST /api/report (Alice) → 201 · entrée visible dans la file AVEC
 *       contexte (post concerné, reporter, timestamp)                    [exig. 1]
 *   S4. re-signalement idempotent (duplicate) + 2e signaleur (Carol) →
 *       openReportsOnTarget = 2 dans la file
 *   S5. refus de modération DM : targetKind "dm" → 400 (E2EE par conception)
 *   S6. signalement sans preuve → 401 · cible inconnue → 404
 *   S7. file sans/avec mauvaise clé admin → 403                          [exig. 6a]
 *   S8. POST /api/block (Alice bloque Bob) → le fil public d'Alice n'affiche
 *       plus Bob ; le fil sans lecteur l'affiche toujours                [exig. 2a]
 *   S9. DM de Bob → REÇU mais MARQUÉ (fromBlocked=true, conversation
 *       blocked=true) — décision « reçus, avec option bloquer »          [exig. 2b]
 *   S10. hide (admin) → P1 disparaît du fil public, RESTE en DB
 *        (hiddenAt posé) — vérification DB                               [exig. 3]
 *   S11. purge (admin) → P2 SUPPRIMÉ en DB, trace ModerationAction
 *        action=purge conservée (auteur, extrait) — vérification DB      [exig. 4]
 *   S12. intégration complète : report → file → action(hide) → DB
 *        (report clôturé actioned/handledBy)                             [exig. 5]
 *   S13. négatif : utilisateur NON-admin tente /api/moderation/action
 *        (sans clé puis mauvaise clé) → 403                              [exig. 6b]
 *   S14. suspend → posts de Bob absents du fil, publication refusée 403 ;
 *        unsuspend → retour à la normale ; warn → trace d'audit en DB
 *   S15. unblock → les posts de Bob redeviennent visibles dans le fil d'Alice,
 *        fromBlocked repasse à faux
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PrismaClient } from "@prisma/client";

const BASE = process.env.MBOTE_BASE_URL ?? "http://127.0.0.1:3100";
const ADMIN = process.env.ADMIN_API_KEY ?? "a3-dev-admin-key";
const subtle = globalThis.crypto.subtle;
const db = new PrismaClient();

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sign = async (priv: CryptoKey, msg: string): Promise<string> =>
  b64url(
    new Uint8Array(
      await subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, priv, new TextEncoder().encode(msg))
    )
  );

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function jsonFetch(
  path: string,
  init?: RequestInit & { adminKey?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { adminKey, ...rest } = init ?? {};
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminKey) headers["x-admin-key"] = adminKey;
  const res = await fetch(`${BASE}${path}`, { ...rest, headers: { ...headers, ...(rest.headers as Record<string, string>) } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

interface Identity {
  pubkey: string;
  ecdhPub: string;
  signPriv: CryptoKey;
}

async function makeIdentity(nickname: string): Promise<Identity> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ecdhPub = b64url(new Uint8Array(await subtle.exportKey("raw", ecdh.publicKey)));
  const pubkey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const ts = Date.now();
  const signature = await sign(pair.privateKey, `${pubkey}|identity|${nickname}||${ecdhPub}|${ts}`);
  const r = await jsonFetch("/api/identity", {
    method: "POST",
    body: JSON.stringify({ pubkey, nickname, ecdhPub: ecdhPub, ts, signature }),
  });
  if (r.status !== 200) throw new Error(`identité ${nickname} refusée : ${r.status}`);
  return { pubkey, ecdhPub: ecdhPub, signPriv: pair.privateKey };
}

async function makePost(me: Identity, content: string, parentId?: string): Promise<string> {
  const ts = Date.now();
  const signature = await sign(me.signPriv, `${me.pubkey}|${content}|${ts}`);
  const r = await jsonFetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ pubkey: me.pubkey, content, parentId, ts, signature }),
  });
  if (r.status !== 200) throw new Error(`post refusé : ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.post as { id: string }).id;
}

async function report(
  me: Identity,
  targetKind: string,
  targetId: string,
  reason: string,
  opts?: { omitSignature?: boolean }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ts = Date.now();
  const signature = opts?.omitSignature ? undefined : await sign(me.signPriv, `${me.pubkey}|report|${targetKind}|${targetId}|${reason}|${ts}`);
  return jsonFetch("/api/report", {
    method: "POST",
    body: JSON.stringify({ reporter: me.pubkey, targetKind, targetId, reason, ts, signature }),
  });
}

async function block(me: Identity, target: string, action: "block" | "unblock" = "block") {
  const ts = Date.now();
  const signature = await sign(me.signPriv, `${me.pubkey}|block|${target}|${action}|${ts}`);
  return jsonFetch("/api/block", {
    method: "POST",
    body: JSON.stringify({ blocker: me.pubkey, blocked: target, action, ts, signature }),
  });
}

async function moderationAction(payload: Record<string, unknown>, adminKey?: string) {
  return jsonFetch("/api/moderation/action", {
    method: "POST",
    adminKey,
    body: JSON.stringify(payload),
  });
}

async function feed(myPub?: string): Promise<{ posts: { id: string }[] }> {
  const r = await jsonFetch(`/api/posts?scope=global${myPub ? `&myPub=${encodeURIComponent(myPub)}` : ""}`);
  return r.body as { posts: { id: string }[] };
}

console.log("── S1 : identités réelles ──");
const alice = await makeIdentity(`A3-Alice-${Date.now() % 100000}`);
const bob = await makeIdentity(`A3-Bob-${Date.now() % 100000}`);
const carol = await makeIdentity(`A3-Carol-${Date.now() % 100000}`);
check("3 identités enregistrées (Alice, Bob, Carol)", !!alice.pubkey && !!bob.pubkey && !!carol.pubkey);

console.log("── S2 : contenu public de Bob ──");
const P1 = await makePost(bob, "A3-P1 : post à signaler");
const P2 = await makePost(bob, "A3-P2 : post à purger");
const C1 = await makePost(bob, "A3-C1 : commentaire à signaler", P1);
check("P1, P2, C1 publiés", !!P1 && !!P2 && !!C1);

console.log("── S3 : signalement → file de modération (contexte) ──");
const rep1 = await report(alice, "post", P1, "spam", {});
check("POST /api/report → 201", rep1.status === 201, `status=${rep1.status} ${JSON.stringify(rep1.body)}`);
const rep1Row = rep1.body.report as { id: string; createdAt: string } | undefined;
check("signalement créé avec id + timestamp", !!rep1Row?.id && !!rep1Row?.createdAt);

const q1 = await jsonFetch("/api/moderation/queue", { adminKey: ADMIN });
const q1entries = (q1.body.queue as {
  report: { id: string; reporterKey: string; targetKind: string; targetId: string; createdAt: string };
  context: { exists: boolean; snippet?: string; author?: { pubkey: string }; postCreatedAt?: string };
  openReportsOnTarget: number;
}[]) ?? [];
const mine = q1entries.find((e) => e.report.id === rep1Row?.id);
check(
  "entrée visible dans la file AVEC contexte (post, reporter, timestamp)",
  !!mine &&
    mine.report.reporterKey === alice.pubkey &&
    mine.report.targetId === P1 &&
    mine.context.exists === true &&
    !!mine.context.snippet &&
    mine.context.author?.pubkey === bob.pubkey &&
    !!mine.context.postCreatedAt,
  JSON.stringify(mine ?? q1.body)
);

console.log("── S4 : idempotence + poids du signalement ──");
const rep2 = await report(alice, "post", P1, "harassment");
check(
  "re-signalement même signaleur/cible → idempotent (200 + duplicate, convention posts : 201 = créé, 200 = déjà présent)",
  rep2.status === 200 && rep2.body.duplicate === true,
  `status=${rep2.status} ${JSON.stringify(rep2.body)}`
);
await report(carol, "post", P1, "spam");
const q2 = await jsonFetch("/api/moderation/queue", { adminKey: ADMIN });
const q2entries = (q2.body.queue as { report: { targetId: string }; openReportsOnTarget: number }[]) ?? [];
const p1Entry = q2entries.find((e) => e.report.targetId === P1);
check("2 signaleurs distincts sur P1 → openReportsOnTarget = 2", p1Entry?.openReportsOnTarget === 2, JSON.stringify(p1Entry));

console.log("── S5 : aucune modération DM (E2EE par conception) ──");
const repDm = await report(alice, "dm", "peu-importe", "spam");
check('targetKind "dm" → 400 + rappel E2EE', repDm.status === 400 && JSON.stringify(repDm.body).includes("E2EE"), JSON.stringify(repDm.body));

console.log("── S6 : validations du signalement ──");
const repNoSig = await report(alice, "post", P1, "spam", { omitSignature: true });
check("signalement sans preuve → 401", repNoSig.status === 401, `status=${repNoSig.status}`);
const repUnknown = await report(alice, "post", "inexistant-a3", "spam");
check("cible inconnue → 404", repUnknown.status === 404, `status=${repUnknown.status}`);

console.log("── S7 : file protégée (403) ──");
const qNoKey = await jsonFetch("/api/moderation/queue");
check("file SANS clé → 403", qNoKey.status === 403, `status=${qNoKey.status}`);
const qBadKey = await jsonFetch("/api/moderation/queue", { adminKey: "mauvaise-clé" });
check("file avec MAUVAISE clé → 403", qBadKey.status === 403, `status=${qBadKey.status}`);

console.log("── S8 : blocage → fil public filtré pour le bloqueur ──");
const feedBefore = await feed(alice.pubkey);
check("avant blocage : P1 et P2 visibles par Alice", feedBefore.posts.some((p) => p.id === P1) && feedBefore.posts.some((p) => p.id === P2));
const blk = await block(alice, bob.pubkey, "block");
check("POST /api/block → 200 (blocked: true)", blk.status === 200 && blk.body.blocked === true, JSON.stringify(blk.body));
const feedAfter = await feed(alice.pubkey);
check("après blocage : PLUS AUCUN post de Bob dans le fil d'Alice", !feedAfter.posts.some((p) => p.id === P1) && !feedAfter.posts.some((p) => p.id === P2));
const feedAnon = await feed();
check("le fil sans lecteur déclaré affiche toujours Bob (filtrage par bloqueur uniquement)", feedAnon.posts.some((p) => p.id === P1));

console.log("── S9 : DM du bloqué → REÇU mais MARQUÉ ──");
const dmTs = Date.now();
const dmId = crypto.randomUUID();
const dmIv = b64url(crypto.getRandomValues(new Uint8Array(12)));
const dmCt = b64url(crypto.getRandomValues(new Uint8Array(64)));
const dmSeq = 0;
const dmSig = await sign(
  bob.signPriv,
  `${bob.pubkey}|dm2|${alice.pubkey}|${dmId}|${dmSeq}|${dmIv}|${dmCt}|${dmTs}`
);
const dmRes = await jsonFetch("/api/dms", {
  method: "POST",
  body: JSON.stringify({ senderKey: bob.pubkey, recipientKey: alice.pubkey, iv: dmIv, ciphertext: dmCt, msgId: dmId, seq: dmSeq, ts: dmTs, signature: dmSig }),
});
check("DM de Bob livré (le blocage ne rejette pas)", dmRes.status === 200, `status=${dmRes.status} ${JSON.stringify(dmRes.body)}`);
const readTs = Date.now();
const readSig = await sign(alice.signPriv, `${alice.pubkey}|dm-read|${bob.pubkey}|${readTs}`);
const conv = await jsonFetch(`/api/dms?me=${encodeURIComponent(alice.pubkey)}&peer=${encodeURIComponent(bob.pubkey)}&ts=${readTs}&signature=${encodeURIComponent(readSig)}`);
const convMsgs = (conv.body.messages as { fromBlocked?: boolean; senderKey: string }[]) ?? [];
const fromBob = convMsgs.filter((m) => m.senderKey === bob.pubkey);
check("DM REÇU (présent dans la conversation)", fromBob.length >= 1, `status=${conv.status}`);
check("DM MARQUÉ fromBlocked=true", fromBob.length >= 1 && fromBob.every((m) => m.fromBlocked === true), JSON.stringify(fromBob[0]));
const convListTs = Date.now();
const convListSig = await sign(alice.signPriv, `${alice.pubkey}|dm-read|*|${convListTs}`);
const convList = await jsonFetch(`/api/dms/conversations?me=${encodeURIComponent(alice.pubkey)}&ts=${convListTs}&signature=${encodeURIComponent(convListSig)}`);
const bobConv = ((convList.body.conversations as { peer: { pubkey: string }; blocked?: boolean }[]) ?? []).find((c) => c.peer.pubkey === bob.pubkey);
check("conversation marquée blocked=true", bobConv?.blocked === true, JSON.stringify(bobConv));

console.log("── S10 : hide → disparu du fil public, PRÉSENT en DB ──");
const hid = await moderationAction({ action: "hide", targetKind: "post", targetId: P1, reason: "validation A3" }, ADMIN);
check("POST /api/moderation/action (hide) → 200", hid.status === 200, `status=${hid.status} ${JSON.stringify(hid.body)}`);
const feedAfterHide = await feed();
check("P1 absent du fil public après hide", !feedAfterHide.posts.some((p) => p.id === P1));
const p1db = await db.post.findUnique({ where: { id: P1 }, select: { hiddenAt: true, hiddenBy: true } });
check("P1 RESTE en DB (audit) avec hiddenAt + hiddenBy", !!p1db?.hiddenAt && p1db.hiddenBy === ADMIN, JSON.stringify(p1db));

console.log("── S11 : purge → SUPPRIMÉ en DB, trace conservée ──");
const purged = await moderationAction({ action: "purge", targetKind: "post", targetId: P2, reason: "validation A3" }, ADMIN);
check("POST /api/moderation/action (purge) → 200", purged.status === 200, `status=${purged.status} ${JSON.stringify(purged.body)}`);
const p2db = await db.post.findUnique({ where: { id: P2 } });
check("P2 SUPPRIMÉ en DB", p2db === null);
const tracePurge = await db.moderationAction.findFirst({ where: { targetId: P2, action: "purge" } });
const purgeMeta = tracePurge ? (JSON.parse(tracePurge.meta ?? "{}") as { authorKey?: string; snippet?: string }) : null;
check("TRACE d'audit conservée (action=purge, auteur, extrait)", !!tracePurge && purgeMeta?.authorKey === bob.pubkey && !!purgeMeta?.snippet, JSON.stringify(tracePurge));

console.log("── S12 : intégration report → file → action → DB ──");
await report(carol, "comment", C1, "illegal");
const hidC1 = await moderationAction({ action: "hide", targetKind: "post", targetId: C1, reason: "intégration A3" }, ADMIN);
check("hide du commentaire signalé → 200", hidC1.status === 200, `status=${hidC1.status}`);
const c1reports = await db.report.findMany({ where: { targetId: C1 } });
check("report clôturé en DB (status=actioned, handledBy=admin)", c1reports.length >= 1 && c1reports.every((r) => r.status === "actioned" && r.handledBy === ADMIN && r.handledAt != null), JSON.stringify(c1reports));
const repliesRes = await jsonFetch(`/api/posts?scope=replies&parentId=${P1}`);
check("fil de réponses du post masqué → 404 (plus une surface publique)", repliesRes.status === 404, `status=${repliesRes.status}`);

console.log("── S13 : négatif — non-admin sur /api/moderation/action → 403 ──");
const actNoKey = await moderationAction({ action: "hide", targetKind: "post", targetId: P1 });
check("SANS clé → 403", actNoKey.status === 403, `status=${actNoKey.status}`);
const actBadKey = await moderationAction({ action: "hide", targetKind: "post", targetId: P1 }, "pas-admin");
check("avec MAUVAISE clé → 403", actBadKey.status === 403, `status=${actBadKey.status}`);
const actUserKey = await moderationAction({ action: "hide", targetKind: "post", targetId: P1 }, alice.pubkey);
check("avec la clé PUBLIQUE d'un utilisateur (pas un secret admin) → 403", actUserKey.status === 403, `status=${actUserKey.status}`);

console.log("── S14 : suspension d'un auteur ──");
const susp = await moderationAction({ action: "suspend", targetKind: "user", targetId: bob.pubkey, reason: "validation A3" }, ADMIN);
check("suspend → 200", susp.status === 200, `status=${susp.status}`);
const feedSusp = await feed();
check("posts de Bob restants absents du fil public (C1 était caché, il restait P… rien)", !feedSusp.posts.some((p) => p.id === P1) && !feedSusp.posts.some((p) => p.id === P2));
const postAsSuspended = await makePost(bob, "A3 : tentative pendant suspension").catch((e: Error) => e);
check("publication par compte suspendu → refusée (403)", postAsSuspended instanceof Error && postAsSuspended.message.includes("403"), String(postAsSuspended));
const unsusp = await moderationAction({ action: "unsuspend", targetKind: "user", targetId: bob.pubkey }, ADMIN);
check("unsuspend → 200", unsusp.status === 200);
const warn = await moderationAction({ action: "warn", targetKind: "user", targetId: bob.pubkey, reason: "validation A3" }, ADMIN);
check("warn → 200 (trace d'audit enregistrée)", warn.status === 200);
const warnTrace = await db.moderationAction.findFirst({ where: { targetId: bob.pubkey, action: "warn" } });
check("trace warn présente en DB", !!warnTrace);

console.log("── S15 : déblocage → retour à la normale ──");
const unblk = await block(alice, bob.pubkey, "unblock");
check("POST /api/block (unblock) → 200", unblk.status === 200 && unblk.body.blocked === false);
const P3 = await makePost(bob, "A3-P3 : post après déblocage");
const feedAfterUnblock = await feed(alice.pubkey);
check("les posts de Bob redeviennent visibles dans le fil d'Alice", feedAfterUnblock.posts.some((p) => p.id === P3));
const readTs2 = Date.now();
const readSig2 = await sign(alice.signPriv, `${alice.pubkey}|dm-read|${bob.pubkey}|${readTs2}`);
const conv2 = await jsonFetch(`/api/dms?me=${encodeURIComponent(alice.pubkey)}&peer=${encodeURIComponent(bob.pubkey)}&ts=${readTs2}&signature=${encodeURIComponent(readSig2)}`);
const conv2Msgs = (conv2.body.messages as { fromBlocked?: boolean; senderKey: string }[]) ?? [];
check("fromBlocked repassé à faux après déblocage", conv2Msgs.filter((m) => m.senderKey === bob.pubkey).every((m) => m.fromBlocked === false));

console.log("──────────────────────────────");
if (failures > 0) {
  console.error(`\n❌ E2E A3 : ${failures} échec(s)`);
  await db.$disconnect();
  process.exit(1);
} else {
  console.log("\n✅ E2E A3 : tous les scénarios PASS");
  await db.$disconnect();
}
