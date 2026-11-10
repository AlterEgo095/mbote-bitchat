/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CLARIFICATION 1 (D1+C2) — une opération de config DB ratée au boot LÈVE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/db-boot-pragma.test.ts
 *
 *  Classe de bug visée (constat Étape 10) : $executeRawUnsafe('PRAGMA
 *  journal_mode=WAL') rejette « Execute returned results » SANS lever — 4
 *  instances de module par process échouaient en silence. Le fix db.ts
 *  expose verifyBootPragmas() qui :
 *    1. utilise $queryRawUnsafe (le PRAGMA retourne une ligne),
 *    2. VALIDE le résultat (assertBootPragmaResult) — mode inattendu = throw,
 *    3. propage tout échec de transport (SQLITE_BUSY, fichier illisible).
 *
 *  Scénarios :
 *   S1. Validation pure : mode inattendu (« delete », ligne manquante) → throw.
 *   S2. Happy path : DB fraîche en DELETE → verifyBootPragmas passe et le mode
 *       PERSISTANT de la DB vaut désormais « wal ».
 *   S3. Contention réelle : DB verrouillée en EXCLUSIVE par un PROCESS TIERS
 *       (bun:sqlite + Prisma dans le même process ne se disputent JAMAIS un
 *       verrou — POSIX advisory locks sont par-process, constat probe D1) →
 *       $queryRawUnsafe rejette (SQLITE_BUSY « database is locked ») →
 *       verifyBootPragmas REJETE — exactement l'erreur qui, au boot, doit être
 *       LOUD (fail-fast) au lieu du silence console.error d'avant.
 *   S4. Fichier illisible (répertoire inexistant) → rejet immédiat.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { rmSync } from "fs";
import { join } from "path";
import {
  assertBootPragmaResult,
  verifyBootPragmas,
} from "../src/lib/db";

const TMP = join(process.cwd(), "db");

/** Enfant qui verrouille la DB en EXCLUSIVE (DELETE mode + write) pendant 12 s.
 *  ⚠️ `bun -e SCRIPT arg` : l'arg arrive en argv[1] (le script n'est PAS dans argv). */
const LOCKER_SCRIPT = `
import { Database } from "bun:sqlite";
const path = process.argv[1] ?? process.argv[2];
const db = new Database(path);
db.exec("PRAGMA journal_mode=DELETE");
db.exec("BEGIN EXCLUSIVE");
db.exec("INSERT INTO t VALUES (1)");
console.log("LOCKED");
setTimeout(() => { try { db.exec("ROLLBACK"); } catch {} db.close(); }, 12000);
`;

describe("db boot pragmas (Clarification 1)", () => {
  test("S1 — assertBootPragmaResult : mode inattendu → throw (jamais silencieux)", () => {
    expect(() => assertBootPragmaResult([{ journal_mode: "delete" }])).toThrow(
      /journal_mode/
    );
    expect(() => assertBootPragmaResult([{ journal_mode: "WAL" }])).not.toThrow(); // casse insensible
    expect(() =>
      assertBootPragmaResult([{}] as Array<Record<string, unknown>>)
    ).toThrow(/journal_mode/);
    expect(() =>
      assertBootPragmaResult([] as Array<Record<string, unknown>>)
    ).toThrow(/journal_mode/);
  });

  test("S2 — happy path : DB fraîche → WAL posé et persistant", async () => {
    const p = join(TMP, `pragma-ok-${Date.now()}.db`);
    const pc = new PrismaClient({
      datasources: { db: { url: `file:${p}` } },
    });
    try {
      const before = await pc.$queryRawUnsafe<Array<{ journal_mode: string }>>(
        "PRAGMA journal_mode"
      );
      expect(before[0].journal_mode.toLowerCase()).toBe("delete"); // défaut sans WAL
      await verifyBootPragmas(pc); // NE DOIT PAS rejeter
      const after = await pc.$queryRawUnsafe<Array<{ journal_mode: string }>>(
        "PRAGMA journal_mode"
      );
      expect(after[0].journal_mode.toLowerCase()).toBe("wal"); // persistant au fichier
    } finally {
      await pc.$disconnect();
      rmSync(p, { force: true });
    }
  }, 20000);

  test("S3 — DB verrouillée EXCLUSIVE par un PROCESS TIERS → verifyBootPragmas REJETE (fail-fast)", async () => {
    // ⚠️ Les verrous POSIX advisory sont PAR-PROCESS : bun:sqlite + Prisma dans
    // le même process ne se disputent JAMAIS un verrou (constat probe D1). Le
    // verrou doit venir d'un vrai process séparé — comme un backup/lecteur en
    // prod. Scénario : un enfant tient BEGIN EXCLUSIVE (DELETE mode + write),
    // le PRAGMA boot doit rejeter SQLITE_BUSY au lieu de passer en silence.
    const p = join(TMP, `pragma-locked-${Date.now()}.db`);
    rmSync(p, { force: true });
    const seed = new Database(p, { create: true });
    seed.exec("CREATE TABLE t(x)");
    seed.close();

    const proc = Bun.spawn(["bun", "-e", LOCKER_SCRIPT, p], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Promise((r) => setTimeout(r, 800)); // laisse l'enfant verrouiller
    const pc = new PrismaClient({
      datasources: { db: { url: `file:${p}` } },
    });
    try {
      let rejected = false;
      try {
        await verifyBootPragmas(pc);
      } catch (e) {
        rejected = true;
        // L'erreur doit être VISIBLE et typée SQLite (busy/lock) — pas un
        // swallow : c'est ce rejet qui, au boot, devient crash loud.
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg.toLowerCase()).toMatch(/lock|busy|timed out/);
      }
      expect(rejected).toBe(true);
    } finally {
      proc.kill(9);
      await proc.exited;
      await pc.$disconnect();
      rmSync(p, { force: true });
    }
  }, 30000);

  test("S4 — fichier DB illisible (répertoire absent) → rejet immédiat", async () => {
    const pc = new PrismaClient({
      datasources: { db: { url: "file:/nonexistent-dir-pragma/nope.db" } },
    });
    try {
      await expect(verifyBootPragmas(pc)).rejects.toThrow();
    } finally {
      await pc.$disconnect();
    }
  }, 20000);

  afterAll(() => {
    // hygiène : la DB de sonde FTS5 (pré-check D1) ne doit pas traîner
    for (const f of ["fts5-probe.db", "fts5-probe.db-wal", "fts5-probe.db-shm"])
      rmSync(join(TMP, f), { force: true });
  });
});
