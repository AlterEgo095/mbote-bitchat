/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS DURCISSEMENT — break-glass ATOMIQUE (invariant §4d DEV-SETUP)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (le schéma doit être poussé au préalable — runner/CI le font) :
 *    DATABASE_URL="file:$(pwd)/db/ci-test.db" bun test tests/admin-break-glass-tx.test.ts
 *
 *  Écart corrigé (vague durcissement) : les 3 écritures break-glass étaient
 *  séquentielles hors $transaction — crash entre burn et reset = code brûlé
 *  sans re-enrôlement (admin dégradé). Désormais atomique (admin-break-glass
 *  executeBreakGlass) ; ce harnais prouve le ROLLBACK COMPLET.
 *
 *  R1  happy path : burn + revoke + reset TOTP + session + audit, tout présent
 *  R2  crash SIMULÉ entre brûler et révoquer (mock.module — revokeAllAdminSessions
 *      throw APRÈS le burn) → exécution rejetée ET ROLLBACK COMPLET :
 *        - AdminRecoveryCode.usedAt reste null (code TOUJOURS utilisable)
 *        - AdminUser.totpSecret / totpEnrolled INCHANGÉS (TOTP actuel valide)
 *        - AdminSession : AUCUNE révocation persistée, AUCUNE création
 *        - AdminAudit : AUCUNE trace break-glass partielle
 *  R3  structure : executeBreakGlass = withWriteLock + $transaction + tx passé
 *      aux 3 helpers (inspection source — le grep §4d le re-vérifie)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, test, expect, beforeAll, mock } from "bun:test";
import { readFileSync } from "fs";
import { hash as argonHash } from "@node-rs/argon2";
import * as adminAuthReal from "@/lib/mbote/admin-auth";
import { db } from "@/lib/db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let email: string;
let adminUserId: number;
let codeId1: number;
let codeId2: number;
let code1: string;
let totpSecretBefore: string;
let sessionsBefore: number;

async function freshAdmin(): Promise<{ id: number; email: string }> {
  const email = `bg-tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}@mbote.test`;
  const user = await db.adminUser.create({
    data: { email, passwordHash: "x", role: "super-admin" },
  });
  return { id: user.id, email };
}

d("break-glass atomique (invariant §4d)", () => {
  beforeAll(async () => {
    const { id } = await freshAdmin();
    adminUserId = id;
    email = `bg-tx@${id}.mbote.test`;
    await db.adminUser.update({ where: { id }, data: { email } });

    // 2 codes de secours (comme au bootstrap) + 1 session active + TOTP enrôlé
    code1 = "MBOTE-CODE-1-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const code2 = "MBOTE-CODE-2-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const c1 = await db.adminRecoveryCode.create({
      data: { adminUserId: id, codeHash: await argonHash(code1) },
    });
    const c2 = await db.adminRecoveryCode.create({
      data: { adminUserId: id, codeHash: await argonHash(code2) },
    });
    codeId1 = c1.id;
    codeId2 = c2.id;

    totpSecretBefore = "JBSWY3DPEHPK3PXP-ORIGINAL-" + id;
    await db.adminUser.update({
      where: { id },
      data: { totpSecret: totpSecretBefore, totpEnrolled: true, totpLastCounter: 42 },
    });
    await adminAuthReal.createAdminSession(id, { ip: "127.0.0.1", userAgent: "harness" });
    sessionsBefore = await db.adminSession.count({ where: { adminUserId: id, revokedAt: null } });
    expect(sessionsBefore).toBeGreaterThanOrEqual(1);
  });

  test("R1 — happy path : burn + revoke + reset + session + audit atomiques", async () => {
    const { executeBreakGlass } = await import("@/lib/mbote/admin-break-glass");
    const out = await executeBreakGlass({
      adminUserId,
      adminRole: "super-admin",
      recoveryCodeId: codeId1,
      ip: "127.0.0.1",
      userAgent: "harness-r1",
    });

    expect(out.sessionsRevoked).toBe(sessionsBefore); // toutes les sessions actives révoquées
    expect(out.newSecret).not.toBe(totpSecretBefore); // NOUVEAU secret
    expect(out.sessionToken.length).toBeGreaterThan(20);

    const code = await db.adminRecoveryCode.findUnique({ where: { id: codeId1 } });
    expect(code?.usedAt).not.toBeNull(); // brûlé
    const user = await db.adminUser.findUnique({ where: { id: adminUserId } });
    expect(user?.totpSecret).toBe(out.newSecret); // secret régénéré
    expect(user?.totpEnrolled).toBe(false); // ré-enrôlement forcé
    const audit = await db.adminAudit.findFirst({
      where: { actorId: adminUserId, action: "break-glass" },
      orderBy: { id: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit?.afterJson ?? "{}").recoveryCodeId).toBe(codeId1);
  });

  test("R2 — crash simulé entre burn et revoke → ROLLBACK COMPLET", async () => {
    // État avant : le 2ᵉ code est intact, 0 session active (R1 les a révoquées),
    // le TOTP est le secret de R1. On recrée une session active pour prouver
    // qu'un crash ne la révoque pas, et on ré-enrôle le TOTP (R1 l'a
    // légitimement désenrôlé) — c'est CET état que le crash doit préserver.
    await db.adminUser.update({
      where: { id: adminUserId },
      data: { totpEnrolled: true, totpLastCounter: 42 },
    });
    await adminAuthReal.createAdminSession(adminUserId, { ip: "127.0.0.1", userAgent: "harness-r2" });
    const activeBefore = await db.adminSession.count({ where: { adminUserId, revokedAt: null } });
    const userBefore = await db.adminUser.findUnique({ where: { id: adminUserId } });
    expect(userBefore).not.toBeNull();
    const secretBefore = userBefore?.totpSecret ?? "";

    // mock : revokeAllAdminSessions throw APRÈS le burn (crash simulé)
    mock.module("@/lib/mbote/admin-auth", () => ({
      ...adminAuthReal,
      revokeAllAdminSessions: async (): Promise<number> => {
        throw new Error("CRASH SIMULÉ burn→revoke (harness R2)");
      },
    }));
    // import FRAIS après patch — bind à la version mockée
    const { executeBreakGlass: bgCrash } = await import("@/lib/mbote/admin-break-glass");

    let threw: unknown = null;
    try {
      await bgCrash({
        adminUserId,
        adminRole: "super-admin",
        recoveryCodeId: codeId2,
        ip: "127.0.0.1",
        userAgent: "harness-r2-crash",
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(String((threw as Error)?.message)).toContain("CRASH SIMULÉ");

    // ROLLBACK COMPLET — rien de ce qui précède le crash ne persiste :
    const code = await db.adminRecoveryCode.findUnique({ where: { id: codeId2 } });
    expect(code?.usedAt).toBeNull(); // code TOUJOURS utilisable
    const user = await db.adminUser.findUnique({ where: { id: adminUserId } });
    expect(user?.totpSecret).toBe(secretBefore); // secret INCHANGÉ
    expect(user?.totpEnrolled).toBe(true); // toujours enrôlé
    const activeAfter = await db.adminSession.count({ where: { adminUserId, revokedAt: null } });
    expect(activeAfter).toBe(activeBefore); // AUCUNE révocation persistée
    const auditCrash = await db.adminAudit.findFirst({
      where: { actorId: adminUserId, action: "break-glass" },
      orderBy: { id: "desc" },
    });
    // la dernière trace break-glass est celle de R1 (pas de trace partielle)
    expect(auditCrash).not.toBeNull();
    expect(JSON.parse(auditCrash?.afterJson ?? "{}").recoveryCodeId).toBe(codeId1);

    // restauration : registre = implémentation réelle (pas de fuite vers
    // les fichiers de test suivants dans le même process bun)
    mock.module("@/lib/mbote/admin-auth", () => ({ ...adminAuthReal }));
  });

  test("R3 — structure : withWriteLock + $transaction + tx aux helpers", () => {
    const src = readFileSync("src/lib/mbote/admin-break-glass.ts", "utf8");
    expect(src.includes("withWriteLock")).toBe(true);
    expect(src.includes("db.$transaction")).toBe(true);
    expect(src.includes("revokeAllAdminSessions(args.adminUserId, \"break-glass\", tx)")).toBe(true);
    expect(src.includes("createAdminSession(")).toBe(true);
    expect(src.includes("writeAdminAudit({")).toBe(true);
    expect(src.includes("tx,")).toBe(true);
    // aucun appel via le client global dans la tx ouverte (occurrence 1 §4d)
    expect(src.includes("db.admin")).toBe(false); // uniquement tx.* dans le callback
    const route = readFileSync("src/app/api/internal/admin/break-glass/route.ts", "utf8");
    expect(route.includes("executeBreakGlass")).toBe(true);
  });
});
