# Back-office complet — annuaires métadonnées DM / groupes / médias / sécurité / infra / réseau + four-eyes étendu (2026-11)

Directive : « un panneau d'administration vrai, qui gère tout, voit ce que l'admin ne voyait pas,
et permet de supprimer côté user ce qui ne mérite pas d'y rester — tout en gardant toutes les
informations disponibles ». Livraison : le panneau couvre désormais **tous les modèles de données**
détenu par le serveur, dans le respect de l'invariant E2EE §1.4 (le contenu chiffré reste
illisible : l'admin voit des MÉTADONNÉES, jamais plus).

## 1. Ce que l'admin voit maintenant (6 nouveaux annuaires)

| Vue | Endpoint interne | RBAC | Contenu |
|---|---|---|---|
| `/dms` | `GET /api/internal/admin/dms` + `/dms/messages` | support | Paires DM agrégées (compteurs, non-lus, octets de ciphertext, legacy), enveloppes par paire (sens, lu/non-lu, msgId/seq). JAMAIS iv/ciphertext. Badge « E2EE — métadonnées ». |
| `/groups` + `/groups/[id]` | `GET …/groups`, `GET …/groups/[id]` | support | Shell MLS (membres actifs/exclus, mlsLeafIndex), messages (epoch, taille), enveloppes TreeKEM (commit/welcome). |
| `/media` | `GET+POST …/media` | lecture support · purge moderator | Inventaire objets chiffrés (owner, type, tailles, pending expirés 24 h), purge unitaire + batch avec justification §6. |
| `/security` | `GET …/security` | support | TrustedKeys (par état), PeerBlocks, gardes anti-rejeu (actives/expirées + compteurs), MeshIngest (par type), PoW. Read-only. |
| `/infra` | `GET+POST …/infra` | lecture support · purge moderator | Passerelles mesh (paquets, lastSeen), abonnements Web Push (endpoints tronqués — aucun token complet exposé), purge des désactivés. |
| `/network` | `GET …/network` | support | Graphe social : liens, paires mutuelles, top suivis (barres), crédits. Read-only. |

Chaque vue : bandeau E2EE explicite, cartes de totaux, filtres + recherche, pagination cursor
keyset (garde de vue `k` par annuaire, cursorReset), gestion 401/403/502 identique aux vues
existantes (pattern users/queue/posts).

## 2. Four-eyes étendu (É9) — purges de contenus E2EE

`PENDING_ACTION_TYPES` élargi : `purge_dm_pair` et `purge_group_messages` (src/lib/mbote/
pending-action.ts, exécuteurs dans src/lib/mbote/e2ee-purge.ts).

- **Demande** : super-admin depuis `/dms` (bouton par paire) ou `/groups/[id]` — catégorie §6 +
  justification ≥ 20 caractères, figées dans l'intention.
- **Exécution** : approbation par un SECOND super-admin (id ≠ ET session ≠), dans l'heure, une
  transaction : suppression des ciphertexts + ModerationAction + AdminAudit (métadonnées
  uniquement — compteurs/tailles, aucun contenu n'existe en clair).
- `purge_group_messages` conserve le shell du groupe et ses membres (l'exclusion reste le
  mécanisme `leftAt` dédié) ; seuls messages + enveloppes chiffrées sont détruits.
- Cycle audité : `pendingaction_created` + `purge` = 2 lignes AdminAudit exactement.

## 3. Nettoyage côté utilisateurs (l'admin garde tout)

Issues de l'audit conservateur (aucune fonctionnalité supprimée, transparence conservée) :

- **Dédoublonnage accueil** : ligne « identités en direct » de la sidebar retirée (la pill header
  reste) ; stats footer visibles mobile uniquement (`md:hidden`, desktop a la carte Réseau).
- **Vue Réseau** : journal d'ingestion du bridge supprimé (doublon exact du journal des décisions
  du RouteurPanel) ; hex dump plus auto-ouvert, toggle manuel ajouté ; « en-tête décodé » repliée
  dans le bloc hex ; légende outbox réécrite (le « arrive en P2 » périmé est remplacé).
- **Recherche** : note de rate-limit serveur retirée ; `search.footerNote` réécrite sans jargon
  (« FTS5 » → formulation utilisateur).
- **Upload** : bandeau simplifié « Chiffrement & envoi… N % » (les 6 étages pipeline ne sont
  plus montrés à l'utilisateur ; l'admin garde le détail dans l'audit/les logs).
- **Nav mobile** : `grid-cols-5` → `grid-cols-6` (le 6ᵉ item ne wrappe plus).
- **Dead code** : props `PostCard.forceOffline`, `Composer.canPost`, `Avatar.className`,
  bloc « fermer le fil » inatteignable — supprimés.
- **i18n** : 9 clés `common.*` orphelines + `search.rateLimitNote` + `bridge.a11yJournal*`
  supprimées (fr/en symétriques 699/699) ; `chat.uploadWorking` + `bridge.a11yHexToggle`
  ajoutées.

## 4. Infra panneau

- `AdminNav` partagé (12 pages) avec état actif `aria-current` — fin de la duplication des blocs
  nav ; fiches de détail gardent leur nav contextuelle.
- `admin/src/lib/admin-format.ts` : helpers partagés (fmtBytes, fmtRel, fmtDate, shortKey…).
- `DashboardMetrics` : refs lues au rendu → state (react-hooks/refs, 24 erreurs lint corrigées).

## 5. Vérification (locale, agent-browser)

- `tsc --noEmit` vert (app principale + admin) ; `eslint` vert des deux côtés.
- Seed de vérification idempotent (`scripts/seed-admin-verify.ts`, DEV uniquement).
- Login super-admin TOTP → les 12 vues balayées : aucun crash, données du seed rendues aux
  bons endroits (2 paires DM, groupe MLS avec membre exclu, 2 médias, trusted keys, passerelle,
  graphe social). Captures : `docs/proofs/assets/ADMIN/`.
- Cycle four-eyes E2E : intention `purge_dm_pair` créée (201), garde doublon 409 avec id
  affiché, rendu dans la file `/pending-actions` (badge PURGE PAIRE DM, payload lisible,
  « Annuler (demandeur) » — pas d'auto-approbation possible).
- App utilisateur : landing + /chat rendent, APIs 200, aucune erreur console.
- Corrigé en chemin de vérification : flux four-eyes des nouvelles vues n'envoyaient pas la
  `category` §6 (422) et ne traitaient pas le 201 — alignés sur PostDetailView.

## 6. Écarts connus

- **GC bucket S3** : `purge_media` supprime la ligne DB (coupe l'accès) mais pas l'objet
  chiffré orphelin du bucket — `media/storage.ts` n'expose aucun DELETE. À prévoir si l'on
  veut récupérer les octets (meta `fileDeleted:false` tracé en audit).
- **Purge four-eyes en prod** : mécanisme identique à purge_post (vérifié en prod É9) ; le
  cycle complet avec second approbateur n'est PAS rejoué ici (impossible en local avec un
  seul admin) — les gardes anti-auto-approbation sont actives et testées.
- Compteurs ReplayCounter : le sweep de rétention de l'app purge les epochs expirés — les
  vues sécurité ne montrent que les gardes vivantes (comportement correct).

## 7. Correctifs post-déploiement (2026-11-17, constat opérateur)

Constat : « la page ne charge pas après connexion ». Reproduction locale complète
(build standalone = conteneur Docker, compte admin de vérification, agent-browser) :

- **Cause 1 (blocante)** — l'accueil rendait nav + hub CÔTÉ SERVEUR selon la session,
  mais le login réussi ne provoquait aucun re-rendu serveur : la nav et le hub
  n'apparaissaient qu'après un rechargement manuel. Fix : `router.refresh()` après
  login ET après logout (miroir : la nav restait affichée après destruction de la
  session). Le CSRF de session (`verify` → `initial.csrfToken`) est désormais passé
  au panneau : sans lui, les mutations post-refresh (dont logout) tombaient en 403.
- **Cause 2 (course à l'hydratation, durcissement)** — un clic sur « Se connecter »
  avant la fin de l'hydratation déclenche la soumission NATIVE du formulaire : GET
  avec `?email=&password=&totp=` dans l'URL (jamais aboutissable — le login est un
  POST fetch). L'accueil purge désormais ces paramètres par `redirect("/")`
  immédiat (constaté : URL nettoyée). Reproduction du flux complet après fix :
  login → nav + hub visibles SANS reload → clic carte « Tableau de bord » →
  `/dashboard` rend → logout → nav + hub disparaissent immédiatement.
- Accueil livré d'abord incomplet (5 liens codés à la main au lieu de la nav 12
  sections) — corrigé en amont de ces deux points (hub groupé + AdminNav partagé).
