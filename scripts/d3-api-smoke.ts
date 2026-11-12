/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D3 — SONDE API : les routes répondent 200 comme AVANT les patchs supply
 *       chain (next 16.4.6, sharp 0.35, prisma 6.19.3) — miroir applicatif
 *       du test `docker run` impossible en sandbox (pas de daemon).
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage : bun scripts/d3-api-smoke.ts <BASE_URL>
 *  Sortie : docs/proofs/assets/d3-api-smoke.json — exit 1 si une route KO.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3168";
const ROOT = process.cwd();
const ASSETS = join(ROOT, "docs", "proofs", "assets");
mkdirSync(ASSETS, { recursive: true });

const ROUTES: Array<{ path: string; expect: number; label: string }> = [
  { path: "/api/stats", expect: 200, label: "stats (compteurs publics)" },
  { path: "/api/posts?scope=global&limit=5", expect: 200, label: "fil public" },
  { path: "/api/users", expect: 200, label: "liste identités" },
  { path: "/api/channels", expect: 200, label: "canaux géohash" },
  { path: "/api/search?q=mbote&type=posts", expect: 200, label: "recherche FTS5 (D1)" },
  { path: "/api/identity?pubkey=probe-d3", expect: 200, label: "profil (DTO quota D2)" },
  { path: "/api/push/config", expect: 503, label: "push VAPID (fail-closed sans clés — 503 attendu)" },
];

const results: Array<{ path: string; label: string; expect: number; got: number; ok: boolean }> = [];
for (const r of ROUTES) {
  try {
    const res = await fetch(`${BASE_URL}${r.path}`, { signal: AbortSignal.timeout(10_000) });
    results.push({ ...r, got: res.status, ok: res.status === r.expect });
  } catch (e) {
    results.push({ ...r, got: 0, ok: false });
    console.error(`[d3-smoke] ${r.path} → ERREUR ${String(e).slice(0, 80)}`);
  }
}

const json = {
  measuredAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  routes: results,
  pass: results.every((r) => r.ok),
};
writeFileSync(join(ASSETS, "d3-api-smoke.json"), JSON.stringify(json, null, 2));
for (const r of results) {
  console.log(`[d3-smoke] ${r.ok ? "ok " : "KO "} ${r.path} → ${r.got} (attendu ${r.expect}) — ${r.label}`);
}
console.log(json.pass ? "[d3-smoke] PASS" : "[d3-smoke] FAIL");
if (!json.pass) process.exit(1);
