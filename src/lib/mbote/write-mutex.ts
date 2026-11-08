/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  write-mutex — file d'attente d'écriture en-process pour SQLite (ADM Étape 10)
 * ─────────────────────────────────────────────────────────────────────────────
 *  CONSTAT (stress S3, tests/admin-audit-stress.test.ts — ADM-step10 §D) :
 *  sous contention 4-way (2 cancels + 2 approves simultanés), les 4
 *  transactions interactives Prisma se bloquent mutuellement sur BEGIN
 *  IMMEDIATE (SQLite = UN SEUL écrivain) et 3 des 4 dépassent le timeout de
 *  transaction Prisma (défaut 5000 ms) → 500 « Erreur serveur » au lieu d'un
 *  refus propre. Durées observées : 5,3 s / 5,4 s / 10,2 s / 10,3 s — le
 *  quantum 5 s est le timeout $transaction, PAS busy_timeout (monté à 20 s en
 *  expérience : inchangé, la file vit dans la couche Prisma, pas dans SQLite).
 *
 *  FIX : sérialiser les ÉCRIVAINS avant d'ouvrir la transaction. Chaque
 *  transaction admin (rare — actions humaines) court en ~10-50 ms ; les
 *  suivantes attendent en microtasks JS (aucun verrou DB tenu, aucun timeout
 *  Prisma en train de courir). Les lectures (feed public, session lookups)
 *  ne passent PAS par le mutex — WAL les sert en parallèle (src/lib/db.ts).
 *
 *  ⚠️ CHAÎNE SUR globalThis (2ᵉ constat, charge light L1 10-way) : Turbopack
 *  bundle chaque route indépendamment — un module-level `tail` donnerait UNE
 *  chaîne PAR ROUTE (hide ≠ warn ≠ suspend), donc jusqu'à 3 écrivains
 *  concurrents et des P1008 résiduels (2×500 observés). La chaîne vit sur
 *  globalThis (même pattern que globalForPrisma) → UNE seule file partagée
 *  par toutes les routes du process.
 *
 *  INVARIANT DE DÉPLOIEMENT : le mutex est EN-PROCESS. Valide car le conteneur
 *  tourne en UNE instance (docker-compose, pas de scale horizontal — SQLite
 *  l'interdit de toute façon : fichier local). Si un jour un second process
 *  écrivait la même DB, ce mutex ne suffit plus — mais SQLite non plus.
 *
 *  PORTÉE : uniquement les transactions d'ÉCRITURE multi-instructions des
 *  mutations admin (user-moderation, pending-action approve/cancel/expire,
 *  moderation action hide/unhide/dismiss/purge). Les gardes anti-course
 *  (updateMany where status='pending' + count) RESTENT en place — défense en
 *  profondeur si un jour un second process existe.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const globalForMutex = globalThis as unknown as {
  __mboteWriteTail?: Promise<unknown>;
};

/** Exécute `fn` en file d'attente globale : ne démarre que lorsque TOUTES les
 *  écritures précédentes sont terminées (succès OU échec — un rejet ne bloque
 *  pas la file). Retourne la promesse de `fn` (le rejet se propage à
 *  l'appelant seul, jamais à la chaîne). */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (globalForMutex.__mboteWriteTail ?? Promise.resolve()).then(fn, fn);
  // la chaîne elle-même ne doit JAMAIS rejeter (sinon les suivants héritent)
  globalForMutex.__mboteWriteTail = run.catch(() => undefined);
  return run;
}
