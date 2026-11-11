-- ─────────────────────────────────────────────────────────────────────────────
--  0009_d1_post_fts — index FTS5 des posts PUBLICS (D1 — recherche)
-- ─────────────────────────────────────────────────────────────────────────────
--  PRÉREQUIS VALIDÉ (scripts/d1-fts5-probe.ts, preuve D1) : le SQLite embarqué
--  de Prisma compile FTS5 — CREATE VIRTUAL TABLE … USING fts5(tokenize='unicode61
--  remove_diacritics 2') fonctionne, « ecole » matche « école », snippet() et
--  bm25() disponibles.
--
--  CHOIX DE CONCEPTION (D1 spec : « FTS5 n'indexe que les posts publics ») :
--  index EXPLICITE (contenu dupliqué dans PostFTS) et non le mode external
--  content — car le mode external indexerait AUSSI les posts masqués
--  (hiddenAt != null) et il faudrait les filtrer à la lecture. Ici le contenu
--  masqué est RETIRÉ de l'index inversé au moment du hide (trigger sur
--  hiddenAt) : un post masqué n'est plus recherchable, même en contournant la
--  couche applicative. Coût : contenu stocké 2× (documenté, palier 1).
--
--  MODÈLE DE VISIBILITÉ (aligné exactement sur le fil public, route.ts posts
--  GET where) : la visibilité du CONTENU = hiddenAt IS NULL (terminal, géré
--  par triggers) ; la visibilité de l'AUTEUR = suspension temporaire + ban
--  (réversible) → filtrée À LA LECTURE dans /api/search, pas dans l'index
--  (ré-indexer à chaque suspension/lift serait un trigger de plus et un état
--  transitoire faux). Résultat : un post d'auteur suspendu est dans l'index
--  mais introuvable via l'API — même sémantique que le fil.
--
--  Les posts sont IMMUTABLES (signature ECDSA, idempotence) : le contenu n'est
--  jamais UPDATE — seul hiddenAt change (modération A3). Un trigger sur
--  UPDATE OF hiddenAt suffit donc ; UPDATE OF content ne se déclenchera jamais
--  en pratique mais resterait correct (delete + reinsert conditionnel).
--
--  La table virtuelle et les triggers ne sont PAS dans schema.prisma (même
--  précédent que les triggers append-only 0004 : contrainte moteur en SQL
--  brut, invisible du client Prisma, jamais contournable par le code
--  applicatif).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS PostFTS USING fts5(
  content,
  postId UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- INSERT : n'indexer que les posts publics (hiddenAt IS NULL)
CREATE TRIGGER IF NOT EXISTS PostFTS_ai AFTER INSERT ON Post
WHEN NEW.hiddenAt IS NULL
BEGIN
  INSERT INTO PostFTS(content, postId) VALUES (NEW.content, NEW.id);
END;

-- UPDATE OF hiddenAt (modération A3) : masquer = retirer de l'index ;
-- un-hide (jamais fait en pratique, mais correct si un jour livré) = ré-indexer
CREATE TRIGGER IF NOT EXISTS PostFTS_au AFTER UPDATE OF hiddenAt ON Post
BEGIN
  DELETE FROM PostFTS WHERE postId = OLD.id;
  INSERT INTO PostFTS(content, postId)
    SELECT NEW.content, NEW.id WHERE NEW.hiddenAt IS NULL;
END;

-- DELETE (purge, cascade replies) : retirer de l'index
CREATE TRIGGER IF NOT EXISTS PostFTS_ad AFTER DELETE ON Post
BEGIN
  DELETE FROM PostFTS WHERE postId = OLD.id;
END;

-- Backfill : les posts déjà existants au moment de la migration
INSERT INTO PostFTS(content, postId)
  SELECT content, id FROM Post WHERE hiddenAt IS NULL;
