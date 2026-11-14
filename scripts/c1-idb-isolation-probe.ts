/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  c1-idb-isolation-probe — Clarification 1 (artefact harnais) : DIAGNOSTIC
 *  décisif de la cause racine de la perte d'identité en contexte partagé.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Question : dans ce Chromium (chromium-1200, headless), IndexedDB est-elle
 *  PARTAGÉE entre deux browserContexts Playwright ? Si oui, le `deleteDb
 *  ("mbote-secure")` du panic-wipe exécuté dans un contexte jetable détruit
 *  AUSSI les clés du contexte de travail (méta LS survivante →
 *  loadIdentity()=null → onboarding) — exactement l'artefact famille #47
 *  observé : re-onboard de secours, republication sous le garde D2 réel
 *  (3/h/IP), dialog bloqué, audit messages-offline sauté.
 *
 *  Protocole :
 *   1. ctx1 + ctx2 (même navigateur) ; écriture d'un record IDB « probe-db »
 *      dans les deux contexts.
 *   2. deleteDatabase("probe-db") dans ctx2.
 *   3. Relecture dans ctx1 : record présent (contextes isolés) ou absent
 *      (IDB partagée) ?
 *
 *  Usage : bun scripts/c1-idb-isolation-probe.ts
 *  Exit 0 dans les deux cas — la conclusion est le JSON imprimé (jamais
 *  silencieux : la conclusion fait foi, pas l'exit).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { chromium } from "playwright-core";
import { homedir } from "node:os";

const EXE = `${homedir()}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;

async function idbWrite(page: import("playwright-core").Page, val: string): Promise<void> {
  await page.evaluate(async (v: string) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("probe-db", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => {
        const tx = req.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put(v, "k");
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, val);
}

async function idbRead(page: import("playwright-core").Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const req = indexedDB.open("probe-db", 1);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction("kv", "readonly");
            const get = tx.objectStore("kv").get("k");
            get.onsuccess = () => { db.close(); resolve((get.result as string | undefined) ?? null); };
            get.onerror = () => { db.close(); resolve(null); };
          } catch {
            db.close();
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      })
  );
}

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });

// origine HTTP réelle (IndexedDB indisponible sur about:blank / data:)
const srv = Bun.serve({
  port: 0,
  fetch: () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
});
const ORIGIN = `http://127.0.0.1:${srv.port}`;

const ctx1 = await browser.newContext();
const ctx2 = await browser.newContext();
const p1 = await ctx1.newPage();
const p2 = await ctx2.newPage();
await p1.goto(ORIGIN, { waitUntil: "domcontentloaded" });
await p2.goto(ORIGIN, { waitUntil: "domcontentloaded" });

await idbWrite(p1, "depuis-ctx1");
await idbWrite(p2, "depuis-ctx2");

// lecture croisée AVANT suppression : ctx1 voit-il la valeur écrite par ctx2 ?
const beforeCtx1 = await idbRead(p1);
// suppression dans ctx2
await p2.evaluate(
  () =>
    new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("probe-db");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    })
);
await new Promise((r) => setTimeout(r, 500));
const afterCtx1 = await idbRead(p1);
const afterCtx2 = await idbRead(p2);

console.log(
  JSON.stringify(
    {
      crossReadBeforeDelete: beforeCtx1,
      ctx1AfterCtx2Delete: afterCtx1,
      ctx2AfterDelete: afterCtx2,
      conclusion:
        afterCtx1 === null
          ? "IndexedDB PARTAGÉE entre contexts → le wipe dans un contexte jetable détruit les clés du contexte de travail (cause racine confirmée : un contexte jetable NE SUFFIT PAS, il faut un navigateur séparé pour le test destructeur)"
          : "IndexedDB isolée par contexte → la perte d'identité vient d'ailleurs (le contexte jetable suffit)",
    },
    null,
    2
  )
);
await browser.close();
srv.stop(true);
