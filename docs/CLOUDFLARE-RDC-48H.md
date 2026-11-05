# TEST CLOUDFLARE RDC — 48 H (D7) — PROTOCOLE D'EXÉCUTION RÉELLE

**Statut** : kit exécutable livré — l'exécution sur le terrain reste à faire (elle ne peut être faite ni depuis le VPS ni depuis ce poste : elle mesure les opérateurs mobiles RDC).
**Décision couverte** : D7 — mesure de 48 h depuis les opérateurs RDC avant toute décision de déplacement d'origine. Complète `docs/NETWORK-MEASUREMENT-48H.md` (kit initial) par une **voie simplifiée exécutable en 5 min depuis un téléphone**.

---

## 1. La voie retenue : protocole simplifié sur téléphone (option a)

**Page de mesure** : `https://mbotemesh.aenews.online/cf-measure.html` (fichier statique `public/cf-measure.html`, aucune dépendance, aucun backend, résultats stockés localement sur le téléphone).

### Protocole en 4 gestes (≈ 5 min par session)

1. **Ouvrir** la page sur le téléphone en 4G/3G (**pas en Wi-Fi** — on mesure l'opérateur).
2. **Choisir l'opérateur** (MTN / Orange / Vodacom / Africell / Wi-Fi / Autre) — mémorisé.
3. **Taper « Lancer un test »** : la page mesure séquentiellement 4 cibles (timeout 8 s chacune, ~15 s au total) :
   - `mbotemesh.aenews.online/cdn-cgi/trace` — **notre zone Cloudflare** (la question qui bloque l'architecture) ;
   - `www.cloudflare.com/cdn-cgi/trace` — Cloudflare générique ;
   - `1.1.1.1/cdn-cgi/trace` — edge Cloudflare ;
   - `www.google.com/generate_204` — **contrôle hors Cloudflare** (distingue « internet coupé » de « Cloudflare injoignable »).
4. **Répéter puis exporter** : « Exporter CSV » produit `cf-rdc-48h_<opérateur>_<date>.csv`.

### Cadence sur 48 h

- 6 à 10 sessions/jour, **à heures variées** : matin (6–9), journée (9–17), soirée (18–23), **nuit (23–6)** — la nuit est la tranche la plus informative sur le peering.
- Idéalement : 2 téléphones sur 2 opérateurs différents en parallèle (chaque téléphone exporte son propre CSV ; la colonne `operateur` permet de tout concaténer).
- Option « répéter toutes les 10 min » disponible sur la page (maintien d'écran via Wake Lock) pour une mesure continue en une session posée.

### Colonnes du CSV

`ts_iso, unix_ms, operateur, type_reseau, downlink_mbps, rtt_indice_ms, batterie_pct, en_charge, target, label, ok, http_status, latence_ms, erreur, mode`

- `type_reseau/downlink/rtt` : Network Information API quand disponible (4G/3G, estimation débit/RTT).
- `mode` : `cors` (statut HTTP lisible) ou `no-cors`/`opaque` (joignabilité prouvée, statut illisible — limite documentée §6).
- `erreur` : `AbortError` = timeout 8 s ; `TypeError` = échec réseau/DNS.

---

## 2. Règles de décision (seuils argumentés)

Après concaténation des CSV, par opérateur et par tranche horaire :

| Verdict | Critère (sur cibles Cloudflare) | Décision d'architecture |
|---|---|---|
| **VERT** | disponibilité ≥ 97 % et latence médiane ≤ 1,5 s et p95 ≤ 3 s | Rester sur Cloudflare ; le multi-région se joue au niveau CF (edge), origine unique acceptable |
| **ORANGE** | disponibilité 90–97 %, ou p95 3–6 s | Garder Cloudflare **mais** préparer un repli origine directe (DNS secondaire/IP directe, résolution applicative) + CDN alternatif en veille ; relancer Cloudflare avec les données |
| **ROUGE** | disponibilité < 90 %, ou p95 > 6 s, **ou** CF significativement pire que le contrôle Google | Activer le plan de déplacement d'origine (multi-CDN / PoP régional — Nairobi, Johannesburg, UE) ; le test 48 h devient la pièce justificative |

**Lecture de contrôle obligatoire** : si Google 204 échoue en même temps que Cloudflare, c'est l'accès internet général qui est coupé — pas Cloudflare. Ces points ne comptent pas contre CF (c'est exactement ce que le contrôle est là pour prouver).

---

## 3. Option (b) — service cloud multi-opérateur : faisabilité vérifiée en direct

Relevé **réel** de l'API publique RIPE Atlas (sondes `Connected`), effectué lors de cette livraison :

| Pays | Sondes connectées | Pays | Sondes connectées |
|---|---|---|---|
| **RDC (CD)** | **3** (AS328452, AS328796, AS327875) | Nigeria (NG) | 15 |
| Congo-Brazzaville (CG) | 2 | Kenya (KE) | 17 |
| Cameroun (CM) | 2 | Angola (AO) | 11 |
| Zambie (ZM) | 5 | Tanzanie (TZ) | 7 |
| Ghana (GH) | 4 | Sénégal (SN) | 3 |

**Verdict option (b)** :
- **RIPE Atlas** : 3 sondes seulement en RDC, opérateurs non garantis et non distinguables (ASN à confirmer via bgp.tools) — inutilisable pour une mesure **par opérateur** (MTN vs Orange vs Vodacom vs Africell), donc insuffisant pour trancher D7. Utilisable au mieux comme signal grossier « internet depuis la RDC ».
- **Catchpoint / Datadog Synthetics** : agents multi-opérateurs fiables mais contrats entreprise (ordre de grandeur : plusieurs k$ à dizaines de k$/mois) et **aucun agent garanti sur les opérateurs mobiles RDC** — non pertinent pour cette question précise.
- **Conclusion** : la voie (a) sur téléphone est la seule qui mesure réellement ce que vivront les usagers. À terme (palier 2), une télémétrie opt-in intégrée à l'app remplacera la mesure manuelle.

---

## 4. Ce que ce test débloque (rappel de l'enjeu)

- **VERT** → l'architecture multi-région reste « Cloudflare edge + origine unique » : économies massives (pas de cluster multi-région au palier 1/2).
- **ORANGE/ROUGE** → le chiffrage « mondial » doit intégrer multi-CDN + repli origine (impact direct sur le poste infra de `docs/GLOBAL-SCALING-BUDGET.md`).
- Bonus : ajouter sur la même page une cible de test de joignabilité **FCM** à la phase 1 (dépendance push, cf. `docs/TARGET-SERVICES-PALIER1.md` §push) — cible volontairement non ajoutée dans cette version pour rester strictement dans le périmètre demandé.

## 5. Limites méthodologiques (assumées)

1. `no-cors` prouve la joignabilité et la latence, pas le code HTTP exact (les endpoints trace acceptent GET anonyme : biais négligeable).
2. Un portail captif opérateur peut répondre à la place de la cible : le contrôle Google limite ce biais (deux domaines différents devront être interceptés simultanément).
3. Un appareil = un opérateur : la cadence 6–10 sessions/jour sur 48 h donne ~12–20 points/cible/opérateur — suffisant pour une décision VERT/ORANGE/ROUGE, insuffisant pour des p99. C'est assumé : on décide, on ne publie pas un papier.
4. Le VPN/proxy du téléphone invalide la mesure : désactiver tout VPN pendant les sessions.

## 6. Exécution et preuve attendue

- Qui : un ou plusieurs opérateurs humains en RDC (l'exécution ne peut pas être simulée depuis le VPS — c'est le principe même de D7).
- Livrable de preuve : CSV bruts + tableau de synthèse par opérateur/tranche (dispo %, médiane, p95) + verdict VERT/ORANGE/ROUGE.
- Où ça mène : entrée « Réseau » du dossier d'architecture multi-région ; alimente la décision d'origine avant tout changement structurel (D8).
