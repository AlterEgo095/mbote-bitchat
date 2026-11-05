# ARCHITECTURE CIBLE — SERVICES DU PALIER 1
## Médias · Voix · Appels · Groupes MLS · Recherche · Push

**Statut** : PROPOSITION — soumise à validation avant toute implémentation (décision D8 : aucune modification structurelle sans audit, backup vérifié, plan de retour arrière et tests validés).
**Décision couverte** : D1 — tous les services (médias, voix, appels, groupes, recherche, push) sont du travail d'implémentation du **palier 1**, pas du palier 2/3.
**Références** : Recadrage de mission · Décisions D1–D8 (numérotation utilisateur) · `docs/CRYPTO-SPEC-v1.md` §5 (lacunes ①–⑤) · `docs/SCALE-ARCHITECTURE.md` · `docs/HYBRID-TRANSPORT-STACK.md`.

---

## 1. Principe directeur : routage par capacité

Aucun service n'est « tout, partout ». Chaque payload est routé selon le budget du transport réellement disponible :

| Transport | Débit effectif | Budget message | Latence | Usage autorisé |
|---|---|---|---|---|
| **BLE mesh** (GATT multi-sauts, TTL 7, fragmentation existante) | ~20–60 kbps | ~20–40 ko | secondes → minutes selon profondeur | texte, vignettes, notes vocales compressées, enveloppes chiffrées (DM/MLS) |
| **Internet** (HTTPS + relay socket.io) | selon opérateur | illimité | < 1 s | tout, y compris temps réel |
| **DORS** (BLE → internet → outbox durable) | — | — | différé garanti | tout ce qui n'exige pas le temps réel |

**Règle de dégradation automatique** : internet → BLE mesh → DORS (store-carry multi-sauts) → ticket « disponible en ligne ». Remontée automatique dès que la capacité revient (mécanisme outbox déjà éprouvé hors-ligne).

---

## 2. Tableau maître — 8 services obligatoires

| Service | Transport | Codec / format + justification | Stockage | Chiffrement | Fallback si transport indisponible | Effort (PM) | Dépendances externes | Risques identifiés |
|---|---|---|---|---|---|---|---|---|
| **Notes vocales** | mesh BLE (basse qualité) + internet (haute qualité) + DORS (différé) | **Opus 6–12 kbps** en mesh (frames 250–400 o) / Opus 16–32 kbps Ogg via internet — seul codec speech intelligible ≤ 12 kbps, libre (RFC 6716), encodeurs natifs Android/iOS | blob chiffré R2 + CDN (qualité complète) ; cache local chiffré | CEK AES-256-GCM par note, distribuée **dans** l'enveloppe E2EE (DM ou MLS) ; public = clair-signé | DORS store-carry multi-sauts ; au-delà du budget mesh : ticket « disponible en ligne » (tier mesh plafonné à 60 s/note) | 3,5–5 | libopus (licence BSD, embarquée) ; R2 | 30 s à 8 kbps ≈ 30 ko → minutes en mesh profond ; duty-cycle de scan iOS ; UX d'attente à gérer |
| **Images** | vignette via mesh (~10–20 ko) + original via internet (ticket pull) | **WebP/AVIF** vignette 320 px q50 ; original WebP/JPEG — meilleur ratio qualité/octet, décodage universel | R2 + CDN ; cache local chiffré | CEK par image dans l'enveloppe ; EXIF/GPS stripés avant envoi | vignette seule, puis téléchargement différé (DORS) | 2–3 | R2 + CDN | coût data côté usager (option « Wi-Fi uniquement ») ; vie privée métadonnées |
| **Vidéo** (clips ≤ 5 min) | **internet exclusivement** — exclu du mesh par conception ; mesh = vignette + ticket | MP4 H.264 + HLS — compatibilité maximale ; V1 sans transcodage (stockage as-is) ; AV1 plus tard | R2 + CDN, policies de cycle de vie | CEK par vidéo ; segments HLS AES-128 enveloppés par la CEK | aucun flux vidéo en mesh — vignette + « rejoindre internet pour voir » | 3–5 | R2 + CDN | réseau RDC instable → **upload reprenable (resumable) obligatoire** ; croissance du stockage |
| **Appels audio 1:1** | internet temps réel uniquement ; mesh = notification « appel manqué » différée | **Opus adaptatif 6–64 kbps + DTLS-SRTP** (pile WebRTC standard, non artisanale) | aucun (pas d'enregistrement en V1 — décision produit qui réduit l'exposition légale) | DTLS-SRTP ; empreinte de clé du pair échangée via enveloppe E2EE (liaison identité) | après 2 échecs d'établissement → bascule note vocale | 5–7 | STUN gratuit ; TURN coturn auto-hébergé ; Apple Developer | CGNAT généralisé RDC, UDP parfois filtré → **TURN sur TCP 443 + TLS obligatoires dès V1** ; batterie ; arrière-plan iOS (CallKit) |
| **Appels vidéo 1:1** | internet (Wi-Fi recommandé, plancher 240p) | VP8/H.264 + Opus (pile WebRTC native), ABR 240p→720p | aucun | DTLS-SRTP | → appel audio → note vocale | 2–3 | idem appels audio | coût data usager (défaut « Wi-Fi uniquement ») ; appels de **groupe** = SFU, documenté palier 2 |
| **Groupes privés (MLS)** | messages MLS (commits/Welcome ~0,5–2 ko) via relay internet ; opaques → transportables en mesh/DORS | **MLS RFC 9420 via OpenMLS** (implémentation de référence, Rust, FFI Kotlin/Swift + WASM) — implémentation maison interdite (D2) | serveur = **Delivery Service MLS** (ciphertext opaque + index de groupe) ; état de groupe local chiffré | MLS complet : **forward secrecy + post-compromise security** | interim V1 : pairwise (décision D3) plafonné à 8 membres ; bascule MLS derrière la même interface | 6–10 | OpenMLS (open source, 0 $) | complexité FFI ; ordre des epochs à préserver côté Delivery Service ; taille des Welcome à 50+ membres |
| **Recherche** | locale à l'appareil (contenu E2EE) ; serveur = contenu public uniquement | **SQLite FTS5** (tokenizer unicode61, pliage diacritiques FR) côté mobile ; index inversé léger IndexedDB côté web ; FTS5 serveur pour posts publics signés | index local chiffré (dérivé du contenu déjà déchiffré) ; index serveur = public seul | aucun nouveau mécanisme — la recherche serveur de contenu chiffré est un problème ouvert **non résolu, assumé** : recherche locale uniquement pour l'E2EE | le cache local reste recherchable hors-ligne par construction | 1,5–2,5 | aucune | taille d'index sur appareils bas de gamme (plafond + incrémental) ; tokenisation Lingala approximative (délimitation par espaces acceptable) |
| **Notifications push** | internet (APNs/FCM/Web Push) ; mesh = notification locale en premier plan ; le push est un **knock sans contenu** | FCM (Android) / APNs (iOS) / **Web Push VAPID RFC 8291+8292** pour la PWA (iOS 16.4+) | registre de tokens côté serveur ; zéro contenu dans le push (métadonnée minimale anti-fuite) | payload web chiffré RFC 8291 ; natif = knock seul, contenu récupéré via DORS au réveil | polling à l'ouverture ; badge outbox ; notification mesh locale | 2–3,5 | FCM (gratuit) ; APNs (Apple Dev 99 $/an) ; web-push (OSS) | tueurs de tâches Tecno/Infinix (guide d'exemption autostart requis) ; joignabilité FCM variable selon opérateur (à mesurer via le test 48 h) |
| **Socle transverse** (enveloppe médias, CEK, URLs présignées, EXIF, anti-rejeu ④, auth clés ③, tests adversariaux) | — | — | — | — | — | 3–5 | R2 | **prérequis bloquant D2** (voir §3) |

**Total : ≈ 28–44 personnes-mois.**
- Équipe de 4 (2 mobile, 1 backend, 1 fullstack + sécurité externe ponctuel) : **7–11 mois**.
- Équipe de 6 : **5–8 mois**.

---

## 3. Socle transverse et correction des 5 lacunes de `CRYPTO-SPEC-v1.md` §5

L'architecture médias **intègre** les corrections — elle ne les ignore pas :

| Lacune §5 | Correction dans cette architecture | Statut |
|---|---|---|
| ① ECDH statique-statique | Trajectoire DM → libsignal (X3DH/double ratchet, bibliothèque audité) ; en attendant, clé éphémère d'envoi par message | spécifié, condition D2 |
| ② Pas de forward secrecy | couvert par ① côté DM et par MLS (FS native) côté groupes | spécifié, condition D2 |
| ③ Pas d'authentification des clés | numéros de sécurité + vérification QR en présentiel — **prérequis bloquant avant expédition E2EE médias** | spécifié, condition D2 |
| ④ Anti-rejeu incomplet | époques + compteurs par clé + déduplication persistante (extension du SHA-256 6 h actuel) | spécifié |
| ⑤ Zéro MLS | MLS RFC 9420 (OpenMLS) — service « Groupes privés » ci-dessus | ce livrable |

**Verrou produit** : aucun flux E2EE médias ne passe en production tant que ③ et ④ ne sont pas fermés et que les tests adversariaux ne sont pas passés (D2 + D8).

Mécanismes du socle :
- **Enveloppe média** : les octets servis par R2/CDN sont un blob opaque chiffré ; le serveur ne voit ni le plaintext ni la clé.
- **CEK** : clé de contenu AES-256-GCM par objet, générée par l'expéditeur, distribuée **dans** l'enveloppe E2EE du message. Un lien média sans sa CEK ne déchiffre rien.
- **Accès** : URLs présignées (PUT d'upload, GET de téléchargement, TTL court) — aucun bucket public.
- **Hygiène** : strip EXIF/GPS avant envoi ; policies R2 ; cache local chiffré.
- **Public** : contenu clair **signé** (ECDSA existante) — pas de chiffrement, authentification d'origine conservée.

---

## 4. Points d'ingénierie décisifs

### 4.1 Notes vocales — la seule vraie contrainte mesh
- 30 s à 8 kbps ≈ 30 ko ; 1 write GATT ≈ 180–220 o utiles → ~150 writes → secondes en direct, **minutes en multi-sauts profonds**.
- Décisions : 60 s max par note en tier mesh ; qualité complète (16–32 kbps) uploadée via DORS dès qu'internet apparaît ; lecture en streaming au fil des chunks reçus.
- Codec unique Opus : encodeurs natifs Android/iOS ; web : AAC pour le tier internet, lecture Opus native.

### 4.2 Appels — topologie NAT en RDC
- CGNAT généralisé + UDP parfois filtré : STUN seul ne suffit pas → **TURN/TCP 443 + TURN/TLS obligatoires dès la V1** (coturn auto-hébergé sur VPS).
- Signalisation : relay socket.io existant (offre/réponse/ICE transportés dans des enveloppes E2EE).
- Appels de groupe : exige un SFU — **palier 2 documenté**, hors périmètre D1 (appels 1:1 au palier 1).

### 4.3 Groupes MLS — rôle du serveur
- Le backend joue le **Delivery Service** MLS : files par groupe, ordre préservé, aucun accès au contenu. Pas de nouvelle infrastructure — réutilise relay + base existante.
- Interim D3 : pairwise plafonné à 8 membres ; bascule MLS derrière le même contrat d'interface.

### 4.4 Upload vidéo en réseau incertain
- Découpage en blocs avec registre de reprise côté serveur (resume after cut). Sans cela, l'upload vidéo est inutilisable en conditions réelles RDC.

---

## 5. Dépendances externes consolidées (coûts fixes)

| Dépendance | Coût | Services concernés |
|---|---|---|
| Apple Developer | 99 $/an | app native, APNs, CallKit |
| FCM / Google Play | 0 $ (Play : 25 $ une fois) | push |
| Cloudflare R2 + CDN | ~0,015 $/Go-mois, egress gratuit | images, vidéo, notes HQ |
| TURN (coturn auto-hébergé) | VPS + bande passante | appels audio/vidéo |
| OpenMLS, libopus, WebRTC, FTS5 | open source, 0 $ | MLS, voix, appels, recherche |

## 6. Séquencement proposé (après validation seulement)

**socle transverse → images → notes vocales → push → recherche → appels audio → appels vidéo → MLS**

Justification : chaque étape prouve l'infrastructure de la suivante (pipeline média → voix → temps réel → crypto de groupe). Chaque étape livrée viendra avec ses preuves (D8).

## 7. Risques transverses

| Risque | Mitigation |
|---|---|
| Budget BLE mesh surestimé sur le terrain | budgets mesurés dès le socle ; dégradation ticket « en ligne » systématique |
| Opportunité de régulation (crypto, voix) en RDC | conformité chiffrée au livrable « budget mondial » (§ juridictions) |
| Dérive de périmètre (« tout, partout ») | routage par capacité non négociable ; refus produit documenté |
| Validation adversariale E2EE plus longue que prévu | le verrou D2 est conçu pour retarder l'expédition, pas l'implémentation |
