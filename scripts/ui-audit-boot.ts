/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ui-audit-boot — infrastructure RÉELLE pour l'audit UI (vague E)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Démarre, sur la DB dédiée db/ui-audit.db :
 *    · le hub relay mini-service        :3040 (socket public) / :3041 (emit)
 *    · le serveur TURN d'harnais (C2)   :3478  (états CallView : sonnerie/actif)
 *    · l'app principale (next dev)      :3100  — MBOTE
 *    · le panneau admin (next dev)      :3103  — ADMIN
 *  puis seede le contenu de l'audit (users, posts, reports open/actioned,
 *  pending-actions 4-yeux, audit trail, comptes admin).
 *
 *  Commande :  bun scripts/ui-audit-boot.ts        (rester en vie, bg + nohup)
 *  Arrêt    :  kill -TERM <pid>   (tuer les enfants proprement)
 *
 *  Identifiants admin — E2E LOCAL UNIQUEMENT (jamais prod, convention harness
 *  admin-auth-e2e.test.ts : les creds de test sont des constantes de repo) :
 *    sa@ui-audit.test  / UiAudit-Passw0rd!  (super-admin, TOTP enrôlé)
 *    mod@ui-audit.test / UiAudit-Passw0rd!  (moderator, pour 4-yeux)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync, writeFileSync, createWriteStream } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const ROOT = process.cwd();
if (!ROOT.endsWith("wt-adm")) {
  console.error("ui-audit-boot doit être lancé depuis /home/z/wt-adm (cwd=" + ROOT + ")");
  process.exit(1);
}

const DB_PATH = join(ROOT, "db", "ui-audit.db");
const DB_URL = `file:${DB_PATH}`;
const PORT_MAIN = 3100;
const PORT_PANEL = 3103;
const PORT_HUB = 3040;
const PORT_EMIT = 3041;
const PORT_TURN = 3478;
const MAIN_URL = `http://127.0.0.1:${PORT_MAIN}`;
const PANEL_URL = `http://127.0.0.1:${PORT_PANEL}`;
const HUB_URL = `http://127.0.0.1:${PORT_HUB}`;

// jetons E2E locaux (constantes de repo, convention harness)
const RELAY_EMIT_TOKEN = "0e4f1d9c2b7a63584f1e2d3c4b5a6978e5f4d3c2b1a097866554433221100ffaa";
const ADMIN_INTERNAL_TOKEN = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233";
const SEED_SECRET = "b7e5c3a1908f7d6b5a4938271605f4e3d2c1b0a9988776655443322110ffeedd";
const ADMIN_API_KEY = "c9d8e7f6a5b4c3d2e1f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2";
const MBOTE_BOT_KEY = "d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4b5a69";

let db: PrismaClient;
const procs: { name: string; p: ChildProcess }[] = [];

function spawnChild(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const log = join(ROOT, "docs", "proofs", `E-${name}.log`);
  const stream = createWriteStream(log, { flags: "a" });
  p.stdout?.pipe(stream);
  p.stderr?.pipe(stream);
  p.on("exit", (code) => console.log(`[ui-audit-boot] ${name} exit code=${code}`));
  procs.push({ name, p });
  console.log(`[ui-audit-boot] ${name} pid=${p.pid} (log: ${log})`);
  return p;
}

async function waitFor(what: string, url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        console.log(`[ui-audit-boot] prêt : ${what} (${url})`);
        return;
      }
    } catch {
      /* pas encore */
    }
    // garde : tous les enfants vivants ?
    for (const { name, p } of procs) {
      if (p.exitCode !== null && p.signalCode === null) {
        throw new Error(`${name} est mort avant de devenir prêt (code ${p.exitCode})`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout : ${what} injoignable (${url})`);
}

async function seed(): Promise<void> {
  // ── comptes admin (pattern harness admin-auth-e2e) ─────────────────────────
  const sa = await db.adminUser.upsert({
    where: { email: "sa@ui-audit.test" },
    create: {
      email: "sa@ui-audit.test",
      role: "super-admin",
      passwordHash: await argon2Hash("UiAudit-Passw0rd!"),
      totpSecret: generateTotpSecret(),
      totpEnrolled: true,
    },
    update: { totpEnrolled: true, disabledAt: null, totpLastCounter: null },
  });
  const mod = await db.adminUser.upsert({
    where: { email: "mod@ui-audit.test" },
    create: {
      email: "mod@ui-audit.test",
      role: "moderator",
      passwordHash: await argon2Hash("UiAudit-Passw0rd!"),
      totpSecret: generateTotpSecret(),
      totpEnrolled: true,
    },
    update: { totpEnrolled: true, disabledAt: null, totpLastCounter: null },
  });
  for (const admin of [sa, mod]) {
    await db.adminRecoveryCode.deleteMany({ where: { adminUserId: admin.id } });
    for (const code of ["UIAUDITCODEAAAA0", "UIAUDITCODEBBBB1"]) {
      await db.adminRecoveryCode.create({
        data: { adminUserId: admin.id, codeHash: await argon2Hash(code) },
      });
    }
  }

  // ── utilisateurs + posts du fil public ─────────────────────────────────────
  const bob = await db.user.upsert({
    where: { pubkey: "ui-audit-bob-pubkey" },
    create: { pubkey: "ui-audit-bob-pubkey", nickname: "Bob E2E", bio: "Compte de seed audit UI" },
    update: { suspendedAt: null, suspendedUntil: null },
  });
  const carol = await db.user.upsert({
    where: { pubkey: "ui-audit-carol-pubkey" },
    create: { pubkey: "ui-audit-carol-pubkey", nickname: "Carol E2E", bio: "Cible de signalements" },
    update: { suspendedAt: null, suspendedUntil: null },
  });
  const dave = await db.user.upsert({
    where: { pubkey: "ui-audit-dave-pubkey" },
    create: { pubkey: "ui-audit-dave-pubkey", nickname: "Dave Mesh" },
    update: {},
  });

  const mkPost = async (authorId: string, content: string, geohash?: string, precision?: number) =>
    db.post.create({ data: { authorId, content, geohash, precision, origin: "web" } });

  await mkPost(bob.id, "Premier message de seed — audit UI du fil public.", undefined, undefined);
  const p2 = await mkPost(carol.id, "Message signalé (harassment) — visible dans la file admin.", undefined, undefined);
  await mkPost(dave.id, "Posté depuis la passerelle mesh (origin=mesh, 2 sauts).", undefined, undefined);
  const p4 = await mkPost(bob.id, "Canal géographique #dr5rsj7 — pour la vue canaux.", "dr5rsj7", 6);
  const p5 = await mkPost(carol.id, "Post cible d'une purge 4-yeux en attente d'approbation.");

  // ── signalements (file de modération /queue) ───────────────────────────────
  await db.report.create({
    data: { reporterKey: "ui-audit-alice-pubkey", targetKind: "post", targetId: p2.id, reason: "harassment", details: "Seed : insultes répétées." },
  });
  await db.report.create({
    data: { reporterKey: "ui-audit-dave-pubkey", targetKind: "post", targetId: p2.id, reason: "spam", details: "Seed : publicité massive." },
  });
  await db.report.create({
    data: { reporterKey: "ui-audit-bob-pubkey", targetKind: "post", targetId: p4.id, reason: "other", details: "Seed : déjà traité.", status: "actioned", handledAt: new Date(), handledById: sa.id },
  });

  // ── actions 4-yeux (/pending-actions) ─────────────────────────────────────
  await db.pendingAction.create({
    data: {
      actionType: "ban_user", targetType: "user", targetId: carol.pubkey,
      payloadJson: JSON.stringify({ nickname: carol.nickname }),
      justification: "HARASSMENT: à répétition après trois avertissements (seed audit UI)",
      createdById: sa.id, createdBySessionId: "ui-audit-seed-session-1",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await db.pendingAction.create({
    data: {
      actionType: "purge_post", targetType: "post", targetId: p5.id,
      payloadJson: JSON.stringify({ snippet: p5.content.slice(0, 60) }),
      justification: "ILLEGAL: contenu signalé deux fois en une heure (seed audit UI)",
      createdById: sa.id, createdBySessionId: "ui-audit-seed-session-1",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await db.pendingAction.create({
    data: {
      actionType: "purge_post", targetType: "post", targetId: p4.id,
      payloadJson: JSON.stringify({ snippet: p4.content.slice(0, 60) }),
      justification: "SPAM: considéré après vérification comme légitime (seed)",
      status: "cancelled", createdById: sa.id, createdBySessionId: "ui-audit-seed-session-2",
      expiresAt: new Date(Date.now() - 1_800_000),
    },
  });

  // ── journal d'audit (/audit) ───────────────────────────────────────────────
  await db.adminAudit.create({
    data: { actorId: sa.id, actorRole: "super-admin", action: "report.actioned", targetType: "post", targetId: p4.id, justification: "OTHER: vérifié, sans fondement (seed audit UI)", ip: "127.0.0.1", userAgent: "ui-audit-boot" },
  });
  await db.adminAudit.create({
    data: { actorId: sa.id, actorRole: "super-admin", action: "post.hidden", targetType: "post", targetId: p2.id, justification: "HARASSMENT: masquage conservatoire (seed audit UI)", ip: "127.0.0.1", userAgent: "ui-audit-boot" },
  });
  await db.adminAudit.create({
    data: { actorId: mod.id, actorRole: "moderator", action: "pendingaction_cancelled", targetType: "pending-action", targetId: "seed", justification: "SPAM: annulé après relecture du contexte (seed audit UI)", ip: "127.0.0.1", userAgent: "ui-audit-boot" },
  });

  console.log(`[ui-audit-boot] seed ok — users=${3} posts=5 reports=3 pending=3 audit=3 admins=2`);
}

async function main(): Promise<void> {
  // 1. DB fraîche + migrations
  rmSync(DB_PATH, { force: true });
  rmSync(DB_PATH + "-wal", { force: true });
  rmSync(DB_PATH + "-shm", { force: true });
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  console.log("[ui-audit-boot] migrations ok");

  // 2. services
  spawnChild("hub", "bun", ["mini-services/relay-service/index.ts"], ROOT, {
    RELAY_PORT: String(PORT_HUB),
    EMIT_PORT: String(PORT_EMIT),
    RELAY_EMIT_HOST: "127.0.0.1",
    RELAY_EMIT_TOKEN,
    RELAY_ALLOWED_ORIGIN: MAIN_URL,
  });
  spawnChild("turn", "bun", ["scripts/c2-turn-server.ts"], ROOT, {});

  const appEnv = {
    DATABASE_URL: DB_URL,
    NEXT_TELEMETRY_DISABLED: "1",
    MBOTE_EMBED_RELAY: "0",
    NEXT_PUBLIC_SOCKET_URL: HUB_URL,
    RELAY_EMIT_URL: `http://127.0.0.1:${PORT_EMIT}`,
    RELAY_EMIT_TOKEN,
    ADMIN_INTERNAL_TOKEN,
    SEED_SECRET,
    ADMIN_API_KEY,
    MBOTE_BOT_KEY,
    TURN_URLS: `turn:127.0.0.1:${PORT_TURN}`,
    TURN_STATIC_CREDENTIALS: "ui-audit-user:ui-audit-pass",
  };
  spawnChild("app", "bunx", ["next", "dev", "-p", String(PORT_MAIN)], ROOT, appEnv);
  spawnChild("panel", "bunx", ["next", "dev", "-p", String(PORT_PANEL)], join(ROOT, "admin"), {
    ...appEnv,
    DATABASE_URL: "", // le panneau n'a PAS de DB propre (BFF pur)
    BACKEND_INTERNAL_URL: MAIN_URL,
  });

  // 3. attentes (hub d'abord — socket.io polling, puis app, puis panel)
  await waitFor("hub", `${HUB_URL}/?EIO=4&transport=polling`, 60_000);
  await waitFor("app /api/stats", `${MAIN_URL}/api/stats`, 180_000);
  await waitFor("panel /api/health", `${PANEL_URL}/api/health`, 180_000);

  // 4. seed
  await seed();

  // 5. manifeste pour les scripts de l'audit (axe-audit, agent-browser)
  writeFileSync(
    join(ROOT, "docs", "proofs", "E-axe", "infra.json"),
    JSON.stringify(
      {
        main: MAIN_URL,
        panel: PANEL_URL,
        hub: HUB_URL,
        db: DB_PATH,
        adminEmail: "sa@ui-audit.test",
        adminModeratorEmail: "mod@ui-audit.test",
        adminPassword: "UiAudit-Passw0rd!",
        bootedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("[ui-audit-boot] PRÊT — manifeste: docs/proofs/E-axe/infra.json");

  // rester en vie ; SIGTERM/SIGINT = arrêt propre des enfants
  const shutdown = (): void => {
    console.log("[ui-audit-boot] arrêt…");
    for (const { name, p } of procs) {
      if (!p.pid) continue;
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        try {
          p.kill("SIGKILL");
        } catch {
          /* déjà mort */
        }
      }
      console.log(`[ui-audit-boot] ${name} terminé`);
    }
    void db?.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => undefined, 1 << 30); // keep-alive
}

main().catch((e) => {
  console.error("[ui-audit-boot] ÉCHEC:", e);
  for (const { p } of procs) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* rien */
    }
  }
  process.exit(1);
});
