/**
 * C2 — serveur TURN du harnais (node-turn, in-process bun) — les credentials
 * doivent matcher TURN_STATIC_CREDENTIALS du runner (c2-user:c2-pass).
 */
const turnModule = (await import("node-turn")) as unknown as { default?: unknown };
const TURNServerCtor = (turnModule.default ?? turnModule) as new (opts: {
  authMech: string;
  credentials: Record<string, string>;
  debug?: (level: string, msg: string) => void;
}) => { start: () => void; stop: () => void };

const turn = new TURNServerCtor({
  authMech: "long-term",
  credentials: { "c2-user": "c2-pass" },
  debug: (level: string, msg: string) => {
    if (process.env.C2_TURN_DEBUG) console.log(`[c2-turn ${level}] ${msg}`);
  },
});
turn.start();
console.log("[c2-turn] serveur TURN de harnais démarré sur :3478 (UDP/TCP)");
setInterval(() => undefined, 60_000); // garde le process vivant

export {}; // module TS (top-level await exigé par le typecheck Next)
