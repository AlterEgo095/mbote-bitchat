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
 *  transaction admin (rare — actions humaines) court en ~10-20 ms ; les
 *  suivantes attendent en microtasks JS (aucun verrou DB tenu, aucun timeout
 *  Prisma en train de courir). Les lectures (feed public, session lookups)
 *  ne passent PAS par le mutex — WAL continue de les servir en parallèle.
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

/** Chaîne des écrivains : chaque transaction s'accroche à la fin. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Exécute `fn` en file d'attente : ne démarre que lorsque TOUTES les écritures
 * précédentes sont terminées (succès OU échec — un rejet ne bloque pas la
 * file). Retourne la promesse de `fn` (le rejet se propage à l'appelant seul).
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  // la chaîne elle-même ne doit JAMAIS rejeter (sinon les suivants héritent)
  tail = run.catch(() => undefined);
  return run;
}
