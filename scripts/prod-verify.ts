/**
 * Vérification de mise en production Mbote — checklist automatisée (Vague 6)
 *
 * Contrôle un déploiement réel (dev, staging ou VPS) point par point :
 *   1. En-têtes de sécurité (F-35) : CSP SANS 'unsafe-eval' en prod, HSTS,
 *      nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy.
 *   2. Santé applicative : /api/stats 200, hub socket.io joignable.
 *   3. Gardes : POST /api/seed refusé sans secret (F-02, en NODE_ENV=production).
 *   4. Variables d'environnement serveur critiques présentes (F-09, F-51, F-29).
 *   5. Migrations Prisma appliquées (table _prisma_migrations à jour).
 *   6. Secret du bot chiffré au repos (`enc:v1:` — F-29) quand MBOTE_BOT_KEY défini.
 *
 * Usage :
 *   bun scripts/prod-verify.ts https://mbote.exemple.tld
 *   bun scripts/prod-verify.ts http://localhost:3000 --local
 *
 * `--local` : tolère une CSP avec 'unsafe-eval' (HMR dev) et un seed ouvert
 * (NODE_ENV≠production). Exit 0 = prêt ; exit 1 = au moins un échec.
 */
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const LOCAL = args.includes("--local");
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
const results: { name: string; status: Status; note: string }[] = [];

function record(name: string, status: Status, note: string): void {
  results.push({ name, status, note });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "WARN" ? "⚠️ " : "⏭️ ";
  console.log(`${icon} ${name} — ${note}`);
}

async function main(): Promise<void> {
  console.log(`\n═══ Mbote prod-verify — cible : ${BASE}${LOCAL ? " (mode local indulgent)" : ""} ═══\n`);

  // ── 1. En-têtes de sécurité ────────────────────────────────────────────────
  let csp = "";
  try {
    const r = await fetch(BASE, { redirect: "manual" });
    const h = r.headers;
    csp = h.get("content-security-policy") ?? "";

    const checks: [string, boolean, string][] = [
      [
        "CSP présente",
        !!csp,
        csp ? csp.slice(0, 90) + "…" : "absente — next.config.ts headers() non actif ?",
      ],
      [
        "CSP sans 'unsafe-eval'",
        LOCAL || !csp.includes("'unsafe-eval'"),
        csp.includes("'unsafe-eval'")
          ? "présente (acceptable en dev uniquement — HMR)"
          : "absente en prod ✓",
      ],
      [
        "HSTS",
        !!h.get("strict-transport-security"),
        h.get("strict-transport-security") ?? "absent (derrière TLS, voir DEPLOY-VPS §5)",
      ],
      [
        "X-Content-Type-Options",
        h.get("x-content-type-options") === "nosniff",
        h.get("x-content-type-options") ?? "absent",
      ],
      [
        "X-Frame-Options / frame-ancestors",
        h.get("x-frame-options") === "DENY" || csp.includes("frame-ancestors 'none'"),
        h.get("x-frame-options") ?? (csp.includes("frame-ancestors 'none'") ? "via CSP ✓" : "absent"),
      ],
      [
        "Referrer-Policy",
        !!h.get("referrer-policy"),
        h.get("referrer-policy") ?? "absente",
      ],
      [
        "Permissions-Policy",
        !!h.get("permissions-policy"),
        h.get("permissions-policy")?.slice(0, 60) ?? "absente",
      ],
    ];
    for (const [name, ok, note] of checks) record(name, ok ? "PASS" : "FAIL", note);
  } catch (e) {
    record("En-têtes de sécurité", "FAIL", `serveur injoignable : ${e instanceof Error ? e.message : e}`);
  }

  // ── 2. Santé applicative ───────────────────────────────────────────────────
  try {
    const r = await fetch(`${BASE}/api/stats`, { cache: "no-store" });
    const ok = r.ok;
    record("GET /api/stats", ok ? "PASS" : "FAIL", `HTTP ${r.status}${ok ? "" : " — API ou DB en échec"}`);
  } catch (e) {
    record("GET /api/stats", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ── 3. Garde du seed (F-02) ────────────────────────────────────────────────
  try {
    const r = await fetch(`${BASE}/api/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status === 403) {
      record("POST /api/seed sans secret → 403", "PASS", "garde F-02 actif");
    } else if (LOCAL && (r.status === 200 || r.status === 201)) {
      record("POST /api/seed sans secret → 200", "WARN", "ouvert — acceptable en dev (NODE_ENV≠production)");
    } else {
      record("POST /api/seed sans secret", r.status === 401 || r.status === 400 ? "WARN" : "FAIL",
        `HTTP ${r.status} — en production, exiger 403 (définir SEED_SECRET + NODE_ENV=production)`);
    }
  } catch (e) {
    record("POST /api/seed", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ── 4. Variables d'environnement serveur ───────────────────────────────────
  // (évaluées dans LE processus qui lance ce script — en VPS, l'exécuter depuis
  // le conteneur mbote : `docker exec mbote-mesh bun scripts/prod-verify.ts`)
  const envChecks: [string, boolean, string][] = [
    ["DATABASE_URL", !!process.env.DATABASE_URL, "chemin SQLite (file:…)"],
    [
      "RELAY_EMIT_URL",
      !!process.env.RELAY_EMIT_URL,
      process.env.RELAY_EMIT_URL ?? "défaut http://127.0.0.1:3031 (hôte unique)",
    ],
    [
      "RELAY_EMIT_TOKEN (F-51)",
      !!process.env.RELAY_EMIT_TOKEN,
      process.env.RELAY_EMIT_TOKEN
        ? "défini — /emit authentifié ✓"
        : "NON défini — acceptable réseau Docker interne uniquement (warn en prod)",
    ],
    [
      "MBOTE_BOT_KEY (F-29)",
      !!process.env.MBOTE_BOT_KEY,
      process.env.MBOTE_BOT_KEY
        ? "défini — secret du bot chiffrable au repos ✓"
        : "NON défini — secret du bot EN CLAIR dans Identity (démo assumée)",
    ],
    [
      "SEED_SECRET (F-02)",
      !!process.env.SEED_SECRET,
      process.env.SEED_SECRET ? "défini — seed gardé ✓" : "NON défini — seed public en production",
    ],
  ];
  for (const [name, ok, note] of envChecks) {
    record(`env ${name}`, ok ? "PASS" : LOCAL ? "WARN" : "FAIL", note);
  }

  // ── 5. Migrations Prisma appliquées ────────────────────────────────────────
  try {
    const prisma = new PrismaClient();
    const applied = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>
      `SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at ASC`;
    const pending = applied.filter((m) => !m.finished_at);
    record(
      "Migrations Prisma",
      applied.length > 0 && pending.length === 0 ? "PASS" : "FAIL",
      applied.length === 0
        ? "aucune migration enregistrée — exécuter `bun run db:deploy`"
        : pending.length > 0
          ? `${pending.length} migration(s) non finalisée(s) — \`migrate deploy\` interrompu ?`
          : `${applied.length} migration(s) appliquée(s) : ${applied.map((m) => m.migration_name).join(", ")}`
    );
    await prisma.$disconnect();
  } catch {
    record(
      "Migrations Prisma",
      LOCAL ? "WARN" : "FAIL",
      LOCAL
        ? "table _prisma_migrations absente — schéma poussé via `db push` (acceptable en dev ; en prod : `migrate deploy`)"
        : "table _prisma_migrations absente — exécuter `bun run db:deploy` AVANT le boot (Docker CMD)"
    );
  }

  // ── 6. Secret du bot chiffré au repos (F-29) ───────────────────────────────
  // Sonde SQL directe sur User.botPriv : le format au repos doit être `enc:v1:…`.
  try {
    const prisma = new PrismaClient();
    const rows = (await prisma.$queryRawUnsafe<{ botPriv: string }[]>(
      'SELECT botPriv FROM "User" WHERE botPriv IS NOT NULL LIMIT 1'
    )) ?? [];
    await prisma.$disconnect();
    if (rows.length === 0) {
      record("botPriv au repos (F-29)", "SKIP", "aucun botPriv stocké (bot non initialisé)");
    } else {
      const enc = rows[0].botPriv.startsWith("enc:v1:");
      record("botPriv au repos (F-29)", enc ? "PASS" : "WARN",
        enc ? "format enc:v1: (AES-GCM) ✓" : "en clair — définir MBOTE_BOT_KEY puis re-migrer le bot (bot-key.ts migre au boot)");
    }
  } catch (e) {
    record("botPriv au repos (F-29)", "SKIP", `sonde SQL indisponible : ${e instanceof Error ? e.message.slice(0, 60) : e}`);
  }

  // ── verdict ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === "FAIL");
  const warned = results.filter((r) => r.status === "WARN");
  console.log("\n──────────── VERDICT ────────────");
  console.log(`${results.length - failed.length - warned.length}/${results.length} PASS · ${warned.length} WARN · ${failed.length} FAIL`);
  if (failed.length > 0) {
    console.log("\nÉchecs bloquants :");
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.note}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("prod-verify a échoué :", e);
  process.exit(1);
});
