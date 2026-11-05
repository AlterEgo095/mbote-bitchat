# DIMENSIONNEMENT SYBIL (R6) — OPTIONS ET RECOMMANDATION

**Statut** : PROPOSITION — soumise à validation. Objet : résister à la création d'identités de masse (attaque Sybil) sans exclure les usagers légitimes du contexte RDC (couverture réseau inégale, appareils bas de gamme, usages militants sensibles aux faux positifs).

---

## 1. Matrice comparative (5 options × 5 critères)

| Option | Coût | Friction d'acquisition | Impact anti-spam | Complexité d'implémentation | Réversibilité |
|---|---|---|---|---|---|
| **A. Vérification téléphone (OTP SMS/WhatsApp)** | 0,05–0,20 $/compte (1–2 SMS) ; 50–200 k$/an à 1M inscriptions/an | Moyenne : SIM + réception SMS ; exclusion des usagers sans SIM créditée | **Élevé** : SIM RDC = 0,5–2 $ + enregistrement KYC opérateur → Sybil de masse coûteuse (~0,5–3 $/identité) | Moyenne : service OTP, limites de débit, politique de re-vérification | Haute (feature flag ; comptes conservés) |
| **B. Preuve de travail à l'inscription (PoW)** | ~0 $ serveur ; CPU usager (2–5 s sur mobile bas de gamme, ajusté par classe d'appareil) | Faible–moyenne : 2–5 s pendant l'onboarding (pré-calculable en tâche de fond) | **Faible–moyen seul** : botnet/datacenter s'en sort à ~0,001–0,01 $/inscription ; bloque les spammeurs paresseux, pas les fermes | **Basse** : endpoint de challenge + worker client (lib. open source type Altcha) | Très haute (curseur de difficulté) |
| **C. Réputation progressive** | ~0 $ (règles + compteurs existants) | Faible pour l'usager réel (limites invisibles au début), frustration si non expliquée → transparence obligatoire | **Élevé** contre le spam de masse (plafonds de débit), moyen contre le ciblage lent | Moyenne : moteur de règles, compteurs, tests d'abus | Haute (seuils ajustables) |
| **D. Parrainage / vouching (graphe social)** | ~0 $ ; coût de conception anti-jeu | **Élevée au cold-start** (impasse sans contacts) → ne bloquer que les actions privilégiées, jamais le DM de proximité | **Très élevé** contre Sybil coordonné : acheter/faire pousser des comptes âgés coûte 5–50 $/identité | Moyenne–haute : stockage du graphe, score de confiance, anneaux de confiance à contrer, voie d'appel | Moyenne (effets de graphe difficiles à annuler ; seuils ajustables) |
| **E. Preuve de proximité mesh à l'inscription (signature Mbote)** | ~0 $ | Moyenne : nécessite la coprésence physique d'≥ 1 appareil existant (naturel dans les communautés RDC ; chemin de repli requis pour la diaspora) | **Très élevé contre les fermes étrangères** : la coprésence physique ne se falsifie pas à distance — une ferme Sybil devrait être physiquement en RDC | Moyenne : protocole de témoins signés, identifiants BLE rotatifs (anti-traque) | Haute |
| **(Complément) Mesure d'usage** | ~0 $ | nulle | signal secondaire (ratios inscription/DAU, rétention) pour piloter les seuils | Basse | Haute |

---

## 2. Fiches détaillées

### A. Vérification téléphone
- **Coût SMS par pays** : via agrégateurs (Twilio/Vonage/Sinch) : RDC ~0,03–0,12 $/SMS ; OTP WhatsApp ~0,03–0,05 $ ; repli vocal possible. Vérification type Twilio Verify : ~0,05 $ + SMS.
- **Dépendance opérateurs RDC** : MTN, Orange, Vodacom, Africell — livraison SMS correcte en zone urbaine, inégale en zone rurale ; taux de livraison historiquement 85–95 % sur bonnes routes (à valider par mesure, cf. protocole 48 h).
- **Couverture réelle** : exclut les usagers sans crédit/SIM ; en RDC la SIM est déjà enregistrée (KYC opérateur) — signal Sybil intéressant mais excluons-nous les plus précaires, cœur de cible du produit.
- **Reversibilité** : totale.

### B. Preuve de travail
- **Coût CPU usager** : cible 2^21 hachages SHA-256 ≈ 2–5 s sur mobile classe Snapdragon 4xx ; difficulté adaptative par classe d'appareil ; pré-calcul pendant l'onboarding.
- **Impact UX mobile bas de gamme** : acceptable à l'inscription (une fois) ; à ne JAMAIS appliquer par message.
- **Limite honnête** : pour un adversaire industrialisé, coût marginal ~nul depuis un datacenter. Ne vaut que cumulée.

### C. Réputation progressive
- **Seuils proposés** :
  - **T0 (0–48 h)** : DM uniquement vers contacts mutuels/proximité mesh, 20 messages/jour, pas de média public, pas de création de groupe, pas de liens.
  - **T1 (48 h + interactions saines)** : médias, 200 messages/jour, groupes rejoints.
  - **T2 (2 semaines + vouch pour les privilèges)** : création de groupes, posts publics, liens.
- **Ce qui reste bloqué avant seuil** : flux de masse, création de groupes en série, liens (anti-phishing), mentions de masse.
- **Garantie de conception non négociable (contexte RDC)** : **T0 doit rester pleinement fonctionnel pour le cas d'usage critique — coordination pendant les coupures via mesh de proximité.** Aucun faux positif ne doit couper un militant de son groupe local. C'est la contrainte qui distingue Mbote d'un réseau social générique.

### D. Parrainage
- 1–2 garants (comptes ≥ 30 jours, record propre) pour les actions privilégiées ; propagation de blâme (score type trust-rank avec décroissance) ; codes d'invitation distribués lors des rencontres mesh.
- **Limites** : fermes de vouching, anneaux de confiance, cold-start ; nécessite voie d'appel humaine.

### E. Preuve de proximité mesh (option signature)
- À l'inscription, ≥ 1 appareil existant constate la coprésence BLE et signe une attestation (identifiants rotatifs pour ne pas créer de traceur).
- **Atout unique de Mbote** : la présence physique est la seule chose qu'une ferme Sybil à distance ne peut pas falsifier.
- Repli diaspora/à distance : option A (téléphone) ou revue manuelle.

---

## 3. Recommandation : empilement par phases (réversible, sans dépendance à un vendeur)

| Phase | Palier | Dispositif |
|---|---|---|
| **Phase 0 (maintenant, 0–10k)** | palier 1 | **B (PoW)** + **C (réputation basique T0/T1)** + rate-limit par IP durci (livraison D5) ; téléphone optionnel pour ceux qui veulent des limites supérieures immédiates |
| **Phase 1 (100k)** | palier 2 | **A (OTP)** exigé pour médias publics/création de groupes ; C affiné ; **E (proximité mesh)** en pilote |
| **Phase 2 (1M)** | mondial | **D (parrainage)** pour les privilèges élevés + E généralisé + pipeline anti-abuse automatisé |

**Coût marginal estimé du Sybil par identité selon la pile** : sans défense ~0 $ ; Phase 0 : ~0,01–0,05 $ (CPU + plafonds) ; Phase 1 : ~0,5–3 $ ; Phase 2 : ~5–50 $ (graphe + coprésence). L'objectif n'est pas zéro Sybil — impossible — mais un coût par fausse identité qui dépasse le gain espéré du spam.

## 4. Métriques de surveillance

- Ratio inscriptions/DAU (pic anormal = alerte)
- Taux de DM non sollicités signalés (route R4)
- Distribution des tiers de réputation ; taux de faux positifs (appels)
- Coût OTP/compte ; taux de livraison SMS par opérateur RDC

## 5. Risque spécifique à éviter

Le pire résultat pour ce produit n'est pas « trop de Sybil » mais **« un usager légitime bloqué au moment d'une coupure réseau »**. Toute règle Sybil doit préserver : (1) le DM de proximité hors-ligne, (2) la réception des messages de groupes existants, (3) une voie de déblocage humaine rapide.
