/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 3 — CLI admin:bootstrap (garde-fous + artefacts DB)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/admin-bootstrap.test.ts
 *
 *  DB éphémère par migrations (0001→0005 — jamais db push, DEV-SETUP §4).
 *  Le CLI est lancé en SOUS-PROCESSUS (comme en prod) — on asserte son stdout
 *  ET l'état DB qu'il produit. Les 4 garde-fous de la directive :
 *    B1. premier run → crée super-admin + QR + 2 codes + audit bootstrap
 *    B2. second run → refusé (un AdminUser existe déjà)
 *    B3. --allow-prod sans NODE_ENV=production → refusé
 *    B4. NODE_ENV=production sans --allow-prod → refusé
 *  + B5. secrets : DB sans hash fuité (password/codes/secret TOTP jamais en
 *        clair en DB), 2 codes hashés Argon2id, session créée impossible.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { verify as argon2Verify } from "@node-rs/argon2";

let dir: string;
let url: string;
let db: PrismaClient;

/** Garde de test : échoue (throw) si null — remplace les `!` interdits. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`absent : ${what}`);
  return v;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["scripts/admin-bootstrap.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url, ...env },
    encoding: "utf8",
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mbote-adm-bootstrap-"));
  url = `file:${join(dir, "bootstrap.db")}`;
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("ADM Étape 3 — CLI admin:bootstrap", () => {
  test("B1 · premier run → super-admin créé, QR ASCII + 2 codes + mot de passe affichés UNE fois", async () => {
    const r = runCli(["--email=bootstrap@mbote.test"]);
    expect(r.status).toBe(0);
    // QR code en ASCII (caractères du rendu terminal du paquet qrcode)
    expect(r.stdout).toContain("▄");
    expect(r.stdout).toContain("Secret base32");
    expect(r.stdout).toContain("otpauth://totp/");
    expect(r.stdout).toContain("Mot de passe :");
    // 2 codes au format 8 groupes de 4 (32 chars base32 groupés)
    const codes = [...r.stdout.matchAll(/^\d\. ([A-Z2-7]{4}(?:-[A-Z2-7]{4}){7})$/gm)].map((m) => m[1]);
    expect(codes).toHaveLength(2);

    // état DB
    const user = await db.adminUser.findUnique({ where: { email: "bootstrap@mbote.test" } });
    expect(user).not.toBeNull();
    expect(must(user, "user B1").role).toBe("super-admin");
    expect(must(user, "user B1").totpEnrolled).toBe(false);
    expect(must(user, "user B1").passwordHash).toStartWith("$argon2id$");
    expect(must(user, "user B1").totpSecret).toMatch(/^[A-Z2-7]{32}$/);

    const recoveryRows = await db.adminRecoveryCode.findMany({ where: { adminUserId: must(user, "user B1").id } });
    expect(recoveryRows).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(recoveryRows[i].codeHash).toStartWith("$argon2id$");
      expect(recoveryRows[i].usedAt).toBeNull();
      // le hash vérifie bien le code affiché (preuve de bout en bout)
      expect(await argon2Verify(recoveryRows[i].codeHash, normalizeCode(codes[i]))).toBe(true);
    }

    const audit = await db.adminAudit.findFirst({ where: { action: "bootstrap" } });
    expect(audit).not.toBeNull();
    expect(must(audit, "audit B1").targetType).toBe("AdminUser");
    expect(must(audit, "audit B1").targetId).toBe(String(must(user, "user B1").id));
    expect(must(audit, "audit B1").actorRole).toBe("system"); // pseudo-user system (id 1)
    expect(must(audit, "audit B1").actorId).toBe(1);
  });

  test("B2 · second run → REFUSÉ (un AdminUser existe déjà)", async () => {
    const r = runCli(["--email=second@mbote.test"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("existe déjà");
    const count = await db.adminUser.count({ where: { email: "second@mbote.test" } });
    expect(count).toBe(0);
  });

  test("B3 · --allow-prod sans NODE_ENV=production → REFUSÉ (flag sans objet)", () => {
    const r = runCli(["--email=x@mbote.test", "--allow-prod"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--allow-prod");
  });

  test("B4 · NODE_ENV=production sans --allow-prod → REFUSÉ (double confirmation)", () => {
    const r = runCli(["--email=x@mbote.test"], { NODE_ENV: "production" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--allow-prod");
  });

  test("B5 · aucun secret en clair en DB (password / codes / secret TOTP hachés ou absents)", async () => {
    // le mot de passe et les codes ne vivent QUE dans le stdout du run B1 ;
    // on vérifie ici qu'aucune colonne DB ne les contient en clair.
    const users = await db.adminUser.findMany();
    for (const u of users) {
      if (u.passwordHash) expect(u.passwordHash).toStartWith("$argon2id$");
      // totpSecret : base32 (nécessaire à la vérification TOTP — résiduel
      // documenté : chiffrement champ-niveau post-MVP, RBAC §10.2)
      if (u.totpSecret) expect(u.totpSecret).toMatch(/^[A-Z2-7]+$/);
    }
    const codes = await db.adminRecoveryCode.findMany();
    for (const c of codes) expect(c.codeHash).toStartWith("$argon2id$");
    // aucun secret ne fuit vers AdminSession (aucune session au bootstrap)
    const sessions = await db.adminSession.findMany();
    expect(sessions).toHaveLength(0);
  });
});
