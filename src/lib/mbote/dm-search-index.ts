/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D1 — index LOCAL de recherche des messages privés (IndexedDB)
 * ─────────────────────────────────────────────────────────────────────────────
 *  FRONTIÈRE E2EE (constitutive, spec D1) : les DM sont chiffrés de bout en
 *  bout — le serveur ne stocke que du ciphertext et NE RECHERCHE JAMAIS leur
 *  contenu (garde-fou route : /api/search?type=dms → 400). La recherche des
 *  DM est donc 100 % LOCALE : ce module indexe en IndexedDB les textes
 *  DÉCHIFFRÉS que l'UI affiche déjà (aucune donnée nouvelle n'est persistée,
 *  seul son emplacement change — du state éphémère vers le disque local de
 *  l'appareil, comme le texte affiché à l'écran).
 *
 *  • base `mbote-dm-search`, store `messages`, clé `conversationId:messageId` ;
 *  • sémantique REBUILD par conversation : chaque refetch réussi d'une
 *    conversation (fenêtre serveur = 200 messages les plus anciens, route
 *    /api/dms GET) REMPLIT les entrées de cette conversation — l'index est
 *    toujours le miroir exact de ce que le client a pu déchiffrer, jamais un
 *    résidu obsolète ;
 *  • « boot 重建 » : au démarrage, pruneDmConversations() retire les
 *    conversations qui n'existent plus dans la liste serveur ; chaque
 *    conversation restante est reconstruite à sa prochaine ouverture ;
 *  • diacritiques : normalisation NFD + retrait des signes combinants +
 *    lowercase → « ecole » trouve « école » (même sémantique que FTS5
 *    unicode61 remove_diacritics 2 côté serveur) ;
 *  • recherche 100 % hors-ligne : searchLocalDm n'émet AUCUNE requête réseau
 *    (preuve grep D1 : ce fichier ne contient AUCUN appel réseau — la preuve
 *     formelle est l'asset d1-grep-frontiere-dm.txt, généré par le runner) ;
 *  • PANIC WIPE : clearDmSearchIndex() est branché sur panicWipe (identity.ts)
 *    — les textes déchiffrés ne survivent jamais à un wipe.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DB_NAME = "mbote-dm-search";
const DB_VERSION = 1;
const STORE = "messages";
const SNIPPET_CHARS = 60; // spec : snippet 60 caractères
const DEFAULT_LIMIT = 20;

export interface DmIndexEntry {
  /** conversation = clé publique du pair */
  conversationId: string;
  messageId: string;
  /** texte déchiffré (identique à ce que l'UI affiche) */
  text: string;
  /** texte normalisé (sans diacritiques, lowercase) — champ de recherche */
  norm: string;
  createdAt: string; // ISO
}

export interface DmSearchHit {
  conversationId: string;
  messageId: string;
  /** extrait ≤ 60 caractères centré sur le premier terme trouvé */
  snippet: string;
  createdAt: string;
}

// ───────────────────────── connexion (singleton) ─────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDmSearchDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB indisponible"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: "key" });
        st.createIndex("byConv", "conversationId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("ouverture IndexedDB échouée"));
  });
  return dbPromise;
}

/** Ferme la connexion (panic wipe : débloque deleteDatabase). */
export function closeDmSearchDb(): void {
  dbPromise = null; // la prochaine ouverture recrée la connexion
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("opération IndexedDB échouée"));
  });
}

// ───────────────────────── normalisation diacritiques ─────────────────────────

/** NFD → retrait des signes combinants → lowercase (pure). « école » → « ecole ». */
export function normDmText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// ───────────────────────── écriture (rebuild par conversation) ───────────────

/**
 * REBUILD de l'index d'UNE conversation — remplace TOUTES ses entrées par la
 * fenêtre fraîchement déchiffrée (miroir exact du fetch serveur).
 * Appelé par MessagesView après chaque cycle fetch+déchiffrement réussi.
 */
export async function replaceDmConversation(
  conversationId: string,
  entries: Array<{ messageId: string; text: string; createdAt: string }>
): Promise<void> {
  if (!conversationId) return;
  const db = await openDmSearchDb();
  const tx = db.transaction(STORE, "readwrite");
  const st = tx.objectStore(STORE);
  const idx = st.index("byConv");
  const cursorReq = idx.openCursor(IDBKeyRange.only(conversationId));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  for (const e of entries) {
    const text = e.text ?? "";
    if (!text) continue; // rien d'exploitable (indéchiffrable → pas indexé)
    st.put({
      key: `${conversationId}:${e.messageId}`,
      conversationId,
      messageId: e.messageId,
      text,
      norm: normDmText(text),
      createdAt: e.createdAt,
    } satisfies DmIndexEntry & { key: string });
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("écriture index DM échouée"));
    tx.onabort = () => reject(tx.error ?? new Error("écriture index DM annulée"));
  });
}

/** Boot : retire les conversations qui n'existent plus côté serveur. */
export async function pruneDmConversations(keepConversationIds: string[]): Promise<void> {
  const db = await openDmSearchDb();
  const keep = new Set(keepConversationIds);
  const tx = db.transaction(STORE, "readwrite");
  const idx = tx.objectStore(STORE).index("byConv");
  const cursorReq = idx.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    if (!keep.has(cursor.key as string)) cursor.delete();
    cursor.continue();
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("purge index DM échouée"));
  });
}

/** PANIC WIPE — détruit la base entière (branché sur identity.ts panicWipe). */
export async function clearDmSearchIndex(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  closeDmSearchDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // best-effort : le wipe ne doit pas échouer
    req.onblocked = () => resolve(); // onglet concurrent : on part quand même
  });
}

// ───────────────────────── recherche locale ─────────────────────────

/** Extrait un snippet ≤ 60 caractères centré sur la première occurrence. */
function buildSnippet(text: string, norm: string, terms: string[]): string {
  // la normalisation peut changer la longueur (formes NFD en entrée) :
  // on ne projette l'index norm → text QUE si longueurs égales
  const projectable = norm.length === text.length;
  let at = -1;
  for (const t of terms) {
    const i = norm.indexOf(t);
    if (i >= 0 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - 20);
  const source = projectable ? text : norm;
  const raw = source.slice(start, start + SNIPPET_CHARS);
  return (start > 0 ? "…" : "") + raw + (start + SNIPPET_CHARS < source.length ? "…" : "");
}

/**
 * Recherche LOCALE des messages privés — 100 % IndexedDB, ZÉRO réseau.
 * Tous les termes (normalisés) doivent être présents (ET implicite, même
 * sémantique que la recherche serveur). Tri : plus récents d'abord.
 */
export async function searchLocalDm(
  query: string,
  limit = DEFAULT_LIMIT
): Promise<DmSearchHit[]> {
  const qNorm = normDmText(query);
  const terms = qNorm.split(/\s+/).filter(Boolean).slice(0, 8);
  if (terms.length === 0) return [];

  const db = await openDmSearchDb();
  const all = await wrap(
    db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<
      (DmIndexEntry & { key: string })[]
    >
  );
  const hits = all
    .filter((e) => terms.every((t) => e.norm.includes(t)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((e) => ({
      conversationId: e.conversationId,
      messageId: e.messageId,
      snippet: buildSnippet(e.text, e.norm, terms),
      createdAt: e.createdAt,
    }));
  return hits;
}

/** Comptage (diagnostic / preuve D1). */
export async function countDmIndex(): Promise<number> {
  const db = await openDmSearchDb();
  return wrap(db.transaction(STORE, "readonly").objectStore(STORE).count());
}
