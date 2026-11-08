/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step10-load-light — charge LIGHT (sanity, pas benchmark) — ADM Étape 10
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage (serveurs DÉJÀ DÉMARRÉS par le runner) :
 *    DATABASE_URL="file:…/adm-step10-proof.db" bun scripts/adm-step10-load-light.ts \
 *      --main=http://127.0.0.1:3101 --token=<ADMIN_INTERNAL_TOKEN>
 *
 *  Ce que ça prouve (directive Étape 10) :
 *   L1. 10 admins SIMULTANÉS × 5 actions chacun (queue view · hide · warn ·
 *       suspend · audit view — cibles DISTINCTES par admin) → zéro timeout,
 *       zéro 500, chaque action 2xx ou refus 4xx PROPRE. Le mutex d'écriture
 *       (write-mutex.ts) sérialise les transactions — le constat S3 du stress
 *       (4×500 en 10,3 s) ne doit JAMAIS se reproduire.
 *   L2. 100 requêtes /audit?since=24h EN PARALLÈLE → toutes < 2 s.
 *
 *  Sortie : rapport lisible (min/médiane/p95/max par phase) — le runner le
 *  sauvegarde dans docs/proofs/assets/adm-step10-load-light.txt.
 *  Sessions : création directe en DB (createAdminSession) — l'émission de
 *  session n'est PAS l'objet du test ; les actions passent par le HTTP RÉEL.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { PrismaClient } from "@prisma/client";
import { createAdminSession } from "../src/lib/mbote/admin-auth";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    main: { type: "string", default: "http://127.0.0.1:3101" },
    token: { type: "string" },
    admins: { type: "string", default: "10" },
  },
  strict: true,
});

if (!values.token) {
  console.error("usage : --token=<ADMIN_INTERNAL_TOKEN> [--main=URL] [--admins=N]");
  process.exit(1);
}

const MAIN = values.main;
const TOKEN = values.token;
const N_ADMINS = Number(values.admins);
const db = new PrismaClient();
const JUST = { category: "HARASSMENT", justification: "charge light Étape 10 — sanity de contention" };

interface Outcome {
  admin: number;
  action: string;
  status: number;
  ms: number;
}

async function timedFetch(
  admin: number,
  action: string,
  path: string,
  init: RequestInit & { csrf?: string; actor?: string }
): Promise<Outcome> {
  // ⚠️ MERGE (pas d'écrasement) : le Cookie de session arrive via init.headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-admin-internal": TOKEN,
    ...((init.headers as Record<string, string>) ?? {}),
    ...(init.actor ? { "x-admin-actor": init.actor } : {}),
    ...(init.csrf ? { "x-admin-csrf": init.csrf } : {}),
  };
  const { csrf: _c, actor: _a, ...restInit } = init;
  const start = Date.now();
  let status = 0;
  try {
    const res = await fetch(`${MAIN}${path}`, { ...restInit, headers, signal: AbortSignal.timeout(15_000) });
    status = res.status;
    await res.arrayBuffer(); // consommer le corps (connexion libérée)
  } catch (e) {
    status = -1; // timeout / réseau
  }
  return { admin, action, status, ms: Date.now() - start };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function reportRow(label: string, durations: number[]): string {
  const sorted = [...durations].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const med = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1] ?? 0;
  return `${label.padEnd(34)} n=${String(sorted.length).padStart(3)}  min=${String(min).padStart(5)}ms  médiane=${String(med).padStart(5)}ms  p95=${String(p95).padStart(5)}ms  max=${String(max).padStart(5)}ms`;
}

const results: Outcome[] = [];

try {
  // ── seed léger : 10 cibles (user + post + report) — DISTINCTES par admin ──
  console.log(`[load] seed ${N_ADMINS} cibles distinctes…`);
  const targets: Array<{ pubkey: string; postId: string }> = [];
  for (let i = 0; i < N_ADMINS; i++) {
    const u = await db.user.create({ data: { pubkey: `load-target-${Date.now()}-${i}`, nickname: `load-target-${i}` } });
    const p = await db.post.create({ data: { authorId: u.id, content: `post de charge #${i} (Étape 10)` } });
    await db.report.create({
      data: { targetKind: "post", targetId: p.id, reason: "charge light", reporterKey: `load-reporter-${i}` },
    });
    targets.push({ pubkey: u.pubkey, postId: p.id });
  }

  // ── N sessions admin (création directe — l'émission n'est pas l'objet) ─────
  // RÔLE : super-admin OBLIGATOIRE — l'audit viewer a une porte EXACTE
  // (auditor + super-admin, arbitrage §14.1) : un moderator → 403 PROPRE sur
  // audit-view/L2 (la porte fonctionne, mais la charge mesurerait des 403).
  console.log(`[load] création de ${N_ADMINS} sessions admin (super-admin)…`);
  const adminUser = await db.adminUser.findFirst({ where: { role: "super-admin" }, select: { id: true } });
  if (!adminUser) throw new Error("aucun AdminUser super-admin — lancer le bootstrap/seed d'abord");
  const sessions = [] as Array<{ token: string; csrf: string; actor: string }>;
  for (let i = 0; i < N_ADMINS; i++) {
    const s = await createAdminSession(adminUser.id, { ip: "load-light", userAgent: "adm-step10-load-light" });
    sessions.push({ token: s.sessionToken, csrf: s.csrfToken, actor: String(adminUser.id) });
  }

  // ── ÉCHAUFFEMENT (1 admin × 5 actions, séquentiel) ────────────────────────
  // CONSTAT (1ʳᵉ vague prod, ADM-step10 §E) : le PREMIER hit de chaque route
  // charge ses chunks dynamiques (dont `await import()` DANS les transactions)
  // → la 1ʳᵉ tx de chaque route dépassait 5 s (P2028) → 500 au démarrage à
  // froid. Un test de charge mesure l'ÉTAT STATIONNAIRE — on échauffe chaque
  // route AVANT la vague mesurée (pattern échauffement des harnais É5-É9).
  console.log("[load] échauffement (1 admin × 5 actions, séquentiel)…");
  const warm = sessions[0];
  const warmTarget = targets[0];
  await timedFetch(0, "warmup", "/api/internal/admin/queue?period=7d", { method: "GET", headers: { Cookie: `mbote_admin_session=${warm.token}` }, actor: warm.actor });
  await timedFetch(0, "warmup", "/api/moderation/action", { method: "POST", headers: { Cookie: `mbote_admin_session=${warm.token}` }, actor: warm.actor, csrf: warm.csrf, body: JSON.stringify({ targetKind: "post", targetId: warmTarget.postId, action: "hide", ...JUST }) });
  await timedFetch(0, "warmup", `/api/internal/admin/users/${warmTarget.pubkey}/warn`, { method: "POST", headers: { Cookie: `mbote_admin_session=${warm.token}` }, actor: warm.actor, csrf: warm.csrf, body: JSON.stringify(JUST) });
  await timedFetch(0, "warmup", `/api/internal/admin/users/${warmTarget.pubkey}/suspend`, { method: "POST", headers: { Cookie: `mbote_admin_session=${warm.token}` }, actor: warm.actor, csrf: warm.csrf, body: JSON.stringify({ ...JUST, duration: "24h" }) });
  await timedFetch(0, "warmup", "/api/internal/admin/audit?since=7d&limit=20", { method: "GET", headers: { Cookie: `mbote_admin_session=${warm.token}` }, actor: warm.actor });
  console.log("[load] échauffement terminé.");

  // ── L1 : N admins simultanés × 5 actions chacun ───────────────────────────
  console.log(`[load] L1 : ${N_ADMINS} admins × 5 actions, tous simultanés…`);
  const t1 = Date.now();
  await Promise.all(
    sessions.map(async (s, i) => {
      const target = targets[i];
      // chaque admin : 5 actions SÉQUENTIELLES entre elles (un opérateur réel),
      // les 10 opérateurs SONT simultanés entre eux.
      results.push(await timedFetch(i, "queue-view", `/api/internal/admin/queue?period=7d`, { method: "GET", headers: { Cookie: `mbote_admin_session=${s.token}` }, actor: s.actor }));
      results.push(
        await timedFetch(i, "hide", "/api/moderation/action", {
          method: "POST",
          headers: { Cookie: `mbote_admin_session=${s.token}` },
          actor: s.actor,
          csrf: s.csrf,
          body: JSON.stringify({ targetKind: "post", targetId: target.postId, action: "hide", ...JUST }),
        })
      );
      results.push(
        await timedFetch(i, "warn", `/api/internal/admin/users/${target.pubkey}/warn`, {
          method: "POST",
          headers: { Cookie: `mbote_admin_session=${s.token}` },
          actor: s.actor,
          csrf: s.csrf,
          body: JSON.stringify(JUST),
        })
      );
      results.push(
        await timedFetch(i, "suspend", `/api/internal/admin/users/${target.pubkey}/suspend`, {
          method: "POST",
          headers: { Cookie: `mbote_admin_session=${s.token}` },
          actor: s.actor,
          csrf: s.csrf,
          body: JSON.stringify({ ...JUST, duration: "24h" }),
        })
      );
      results.push(await timedFetch(i, "audit-view", `/api/internal/admin/audit?since=7d&limit=20`, { method: "GET", headers: { Cookie: `mbote_admin_session=${s.token}` }, actor: s.actor }));
    })
  );
  const totalL1 = Date.now() - t1;

  const bad = results.filter((r) => r.status >= 500 || r.status === -1);
  const ok = results.filter((r) => r.status >= 200 && r.status < 500);

  console.log("");
  console.log("═══ L1 — 10 admins simultanés × 5 actions (50 requêtes) ═══");
  console.log(`durée totale de la vague : ${totalL1} ms`);
  for (const action of ["queue-view", "hide", "warn", "suspend", "audit-view"]) {
    console.log(reportRow(`  ${action}`, results.filter((r) => r.action === action).map((r) => r.ms)));
  }
  const l1hist = results.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`statuts : ${ok.length}/${results.length} en 2xx-4xx propre, ${bad.length} en 5xx/timeout — histogramme : ${JSON.stringify(l1hist)}`);
  if (bad.length > 0) {
    console.log("ÉCHECS :", JSON.stringify(bad));
  }
  if (bad.length > 0) {
    console.error("❌ L1 ÉCHOUÉ — 5xx ou timeout détecté");
    process.exit(1);
  }

  // ── L2 : 100 requêtes /audit parallèles < 2 s ─────────────────────────────
  console.log("");
  console.log("═══ L2 — 100 requêtes /audit?since=24h en parallèle ═══");
  const s0 = sessions[0];
  const t2 = Date.now();
  const auditResults = await Promise.all(
    Array.from({ length: 100 }, (_, i) => timedFetch(Math.floor(i / 20), "audit-100", `/api/internal/admin/audit?since=24h&limit=20`, { method: "GET", headers: { Cookie: `mbote_admin_session=${s0.token}` }, actor: s0.actor }))
  );
  const totalL2 = Date.now() - t2;
  const auditDurations = auditResults.map((r) => r.ms);
  console.log(reportRow("  /audit?since=24h", auditDurations));
  const maxAudit = Math.max(...auditDurations);
  const auditBad = auditResults.filter((r) => r.status !== 200);
  const statusHist = auditResults.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`durée totale de la vague : ${totalL2} ms · statuts : ${JSON.stringify(statusHist)}`);
  if (maxAudit >= 2000 || auditBad.length > 0) {
    console.error(`❌ L2 ÉCHOUÉ — max=${maxAudit}ms (attendu < 2000ms) ou ${auditBad.length} non-200`);
    process.exit(1);
  }
  console.log(`✅ L2 OK — max=${maxAudit}ms < 2000ms, 100/200`);
  console.log("");
  console.log("✅ CHARGE LIGHT OK — aucune action perdue, aucun 500, aucun timeout");
} finally {
  await db.$disconnect();
}
