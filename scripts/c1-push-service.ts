/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  c1-push-service — MINI PUSH SERVICE de preuve (C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Process SÉPARÉ (stable — un Bun.serve dans le process du harnais meurt
 *  inopinément, incident documenté ADM-step9-style) qui joue le rôle du push
 *  service (FCM/Mozilla) : web-push (côté app) lui envoie RÉELLEMENT les
 *  knocks en HTTPS (cert auto-signé généré au boot — le harnais lance l'app
 *  avec NODE_TLS_REJECT_UNAUTHORIZED=0, harnais ONLY).
 *
 *  Il CAPTE chaque requête sur le fil (preuve « Wireshark-like » de la
 *  directive) dans db/push-c1-capture.jsonl : { path, headers, body, at }.
 *
 *  Réponses pilotées par le path de l'endpoint de subscription :
 *    /push/201/…  → 201 Created (succès)
 *    /push/410/…  → 410 Gone (le sender doit purger : disabledAt)
 *    /push/429/…  → 429 Too Many Requests (backoff passif du sender)
 *
 *  Usage : bun scripts/c1-push-service.ts <port> <capture.jsonl>
 */

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const port = Number(process.argv[2] ?? 3204);
const captureFile = process.argv[3] ?? join(process.cwd(), "db", "push-c1-capture.jsonl");

const tlsDir = mkdtempSync(join(tmpdir(), "c1-tls-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(tlsDir, "key.pem"),
  "-out", join(tlsDir, "cert.pem"),
  "-subj", "/CN=127.0.0.1",
  "-days", "2",
], { stdio: "pipe" });

rmSync(captureFile, { force: true });

Bun.serve({
  port,
  idleTimeout: 0, // vivre tout le harnais (un idle kill a tué le run 3)
  tls: {
    cert: Bun.file(join(tlsDir, "cert.pem")),
    key: Bun.file(join(tlsDir, "key.pem")),
  },
  async fetch(req) {
    const u = new URL(req.url);
    if (!u.pathname.startsWith("/push/")) {
      return new Response("", { status: 404 });
    }
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // CAPTE LE FIL — preuve Wireshark-like (le body est CHIFFRÉ aes128gcm :
    // aucun contenu lisible n'y apparaît — c'est le point de la preuve)
    appendFileSync(
      captureFile,
      `${JSON.stringify({ path: u.pathname, headers, body, at: new Date().toISOString() })}\n`
    );
    if (u.pathname.startsWith("/push/410/")) return new Response("Gone", { status: 410 });
    if (u.pathname.startsWith("/push/429/")) return new Response("Too Many Requests", { status: 429 });
    return new Response("", { status: 201 });
  },
});

console.log(`[push-service] écoute https://127.0.0.1:${port} — capture → ${captureFile}`);
console.log(`[push-service] PID ${process.pid}`);
