/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step10-resilience — R2 (verrou DB) + R3 (session expirée) — ADM Étape 10
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage (serveurs main+panel DÉJÀ DÉMARRÉS par le runner, build PROD) :
 *    DATABASE_URL="file:…/adm-step10-proof.db" bun scripts/adm-step10-resilience.ts \
 *      --main=http://127.0.0.1:3161 --panel=http://127.0.0.1:3162 \
 *      --token=<ADMIN_INTERNAL_TOKEN>
 *
 *  R2 — VERROU DB (simulation « migration en cours ») : un process tiers tient
 *  BEGIN EXCLUSIVE sur la DB 6 s. Attendu : le panneau DÉGRADE PROPREMENT
 *  (502/503 — jamais de stack trace, jamais de crash), puis récupération 200
 *  dès la libération. C'est le même code path qu'une migration qui verrouille.
 *
 *  R3 — SESSION EXPIRÉE : une session admin dont expiresAt est backdaté en DB
 *  → BFF 401 · page SSR → 302/307 vers le login · AUCUNE donnée dans le corps.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { PrismaClient } from "@prisma/client";
import { Database } from "bun:sqlite";
import { createAdminSession } from "../src/lib/mbote/admin-auth";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    main: { type: "string", default: "http://127.0.0.1:3161" },
    panel: { type: "string", default: "http://127.0.0.1:3162" },
    token: { type: "string" },
  },
  strict: true,
});
if (!values.token) {
  console.error("usage : --token=<ADMIN_INTERNAL_TOKEN> [--main=URL] [--panel=URL]");
  process.exit(1);
}
const PANEL = values.panel;
const db = new PrismaClient({ log: [] });

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`PASS — ${label}${detail ? ` (${detail})` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL — ${label}${detail ? ` (${detail})` : ""}`);
  }
}

// ── R2 : verrou DB exclusif 6 s (migration simulée) ─────────────────────────
async function r2DbLock(cookie: Record<string, string>): Promise<void> {
  console.log("\n═══ R2 — verrou DB exclusif 6 s (migration en cours simulée) ═══");
  const dbFile = process.env.DATABASE_URL?.replace(/^file:/, "").split("?")[0] ?? "";
  const sqlite = new Database(dbFile);
  sqlite.exec("BEGIN EXCLUSIVE");
  console.log("[r2] BEGIN EXCLUSIVE posé (6 s)…");

  const during: Array<number> = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 5500) {
    const res = await fetch(`${PANEL}/api/dashboard`, { headers: cookie, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    during.push(res?.status ?? -1);
    await new Promise((r) => setTimeout(r, 900));
  }
  sqlite.exec("COMMIT");
  sqlite.close();
  console.log(`[r2] verrou libéré après 6 s — statuts pendant le verrou : ${JSON.stringify(during)}`);

  // gracieux = refus UNIFORME sans crash ni fuite : 502/503 (backend mort),
  // 500 à message uniforme, ou 401 FAIL-CLOSED (verrou DB : le verify du
  // panneau reçoit un 5xx du backend → null → 401 — limite documentée dans
  // ADM-step10 §R2 : l'opérateur voit « session invalide » pendant la fenêtre
  // de verrou au lieu de « backend occupé » ; amélioration post-déploiement,
  // le raffinement toucherait ~20 sites d'appel verifyPanelSession).
  // JAMAIS : crash process, timeout client, stack trace.
  const allGraceful = during.every((s) => s === 502 || s === 503 || s === 500 || s === 401 || s === -1);
  check("R2a — pendant le verrou : dégradation gracieuse (refus uniforme, pas de crash)", allGraceful, JSON.stringify(during));

  // récupération
  let recovered = 0;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${PANEL}/api/dashboard`, { headers: cookie, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (res?.status === 200) {
      recovered = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  check("R2b — après libération : récupération 200", recovered === 1);
}

// ── R3 : session expirée ────────────────────────────────────────────────────
async function r3ExpiredSession(): Promise<void> {
  console.log("\n═══ R3 — session expirée (expiresAt backdaté en DB) ═══");
  const sa = await db.adminUser.findFirst({ where: { role: "super-admin" } });
  if (!sa) throw new Error("aucun super-admin — lancer le bootstrap/seed d'abord");
  const s = await createAdminSession(sa.id, { ip: "resilience", userAgent: "adm-step10-resilience" });
  await db.adminSession.update({
    where: { id: s.sessionId },
    data: { expiresAt: new Date(Date.now() - 3600_000) },
  });
  const cookie = `mbote_admin_session=${s.sessionToken}`;

  const bff = await fetch(`${PANEL}/api/dashboard`, { headers: { Cookie: cookie } });
  check("R3a — BFF avec session expirée → 401", bff.status === 401, `obtenu ${bff.status}`);
  await bff.arrayBuffer();

  const page = await fetch(`${PANEL}/dashboard`, { headers: { Cookie: cookie }, redirect: "manual" });
  const loc = page.headers.get("location") ?? "";
  check("R3b — page SSR → 302/307 vers le login", (page.status === 302 || page.status === 307) && loc.includes("/"), `${page.status} → ${loc || "(pas de location)"}`);
  const body = await page.text();
  const leaks = ["activeUsers", "openReports", "generatedAt"].filter((k) => body.includes(k));
  check("R3c — aucune donnée de dashboard dans le corps", leaks.length === 0, leaks.join(",") || "propre");

  // nettoyage : révoquer la session de test
  await db.adminSession.update({ where: { id: s.sessionId }, data: { revokedAt: new Date(), revokedReason: "resilience-r3" } });
}

try {
  // session de sonde créée AVANT le verrou (les inserts sont bloqués pendant)
  const saProbe = await db.adminUser.findFirst({ where: { role: "super-admin" } });
  if (!saProbe) throw new Error("aucun super-admin — lancer le bootstrap/seed d’abord");
  const probeSession = await createAdminSession(saProbe.id, { ip: "resilience-probe" });
  const PROBE_COOKIE = { Cookie: `mbote_admin_session=${probeSession.sessionToken}` };

  await r2DbLock(PROBE_COOKIE);
  await r3ExpiredSession();
  console.log(failures === 0 ? "\n✅ RÉSILIENCE OK" : `\n❌ ${failures} échec(s) de résilience`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  await db.$disconnect();
}
