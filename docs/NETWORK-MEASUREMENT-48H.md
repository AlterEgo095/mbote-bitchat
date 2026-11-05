# Protocole de mesure réseau 48 h — réseaux mobiles RDC

| | |
|---|---|
| **Projet** | Mbote BitChat (PWA + API) |
| **Cible mesurée** | `https://mbotemesh.aenews.online` (derrière Cloudflare) |
| **Statut** | ✅ Kit prêt — ⛔ **exécution en attente : nécessite des appareils physiques sur les réseaux RDC** |
| **Date** | 2026-11-04 |
| **Outil** | `tools/network-probe/probe.mjs` (sonde Node ≥ 18, sans dépendance) |
| **Guide volontaire** | `tools/network-probe/README-RDC.md` |

> **Condition de la direction :** « Réseau : lancer le protocole de mesure de 48 heures depuis les opérateurs RDC avant toute décision de déplacement d'origine. »
>
> Conformément à cette condition, **aucune décision d'architecture d'origine ne sera prise avant l'exploitation des résultats** de ce protocole.

---

## 1. Objectif

Décider, sur **données réelles**, de l'architecture d'origine de Mbote BitChat :

- **A.** conserver le statu quo (app + API derrière Cloudflare, origine actuelle) ;
- **B.** passer à un **multi-CDN** (Cloudflare + un second CDN mieux peering avec les opérateurs RDC) ;
- **C.** déplacer ou dupliquer l'**origine régionale** (Afrique australe/centrale, ex. Johannesburg, Le Cap, Nairobi) ;
- **D.** toute combinaison (ex. origine régionale + Cloudflare devant).

La question concrète : **comment l'application se comporte-t-elle réellement depuis les réseaux mobiles congolais (Vodacom RDC, Airtel RDC, Orange RDC) ?** Les mesures de disponibilité et de latence collectées par ce protocole alimentent une décision chiffrée (§ 7), pas une impression.

## 2. Périmètre mesuré

- URL mesurée : `GET https://mbotemesh.aenews.online/manifest.webmanifest` (fichier statique léger, toujours déployé, sans authentification). Chaque cycle mesure aussi DNS, TCP et le handshake TLS vers le même hôte.
- Horodatage en **UTC** (la RDC est UTC+2, aucune conversion à faire dans les données).
- Chemin réseau observé : appareil → RAN opérateur → cœur de réseau/transit → edge Cloudflare (`cf_colo`) → (si cache miss) origine.

## 3. Plan d'échantillonnage

| Paramètre | Valeur |
|---|---|
| Opérateurs | Vodacom RDC, Airtel RDC, Orange RDC (les 3, sans exception) |
| Appareils | **≥ 2 par opérateur** (≥ 6 appareils au total ; 3 par opérateur = 9 est l'idéal) |
| Villes cibles suggérées | **Kinshasa** (capitale, densité d'utilisateurs), **Lubumbashi** (sud minier), **Goma** (est) |
| Durée par appareil | **≥ 48 h continus** (2 cycles complets jour/nuit, week-end inclus si possible) |
| Cadence | 1 mesure / **5 min** (`PROBE_INTERVAL_S=300`) |
| Volume attendu | ≈ **576 mesures par appareil** (12/h × 48 h) → ≥ **3 456 points** avec 6 appareils |
| Étiquetage | `<operateur>-<ville>-<numero-appareil>` (ex. `airtel-rdc-lubumbashi-2`), attribué par le coordinateur, sans redondance possible |

Matériel et lancement : voir `tools/network-probe/README-RDC.md` (Android/Termux ou ordinateur avec Node ≥ 18). La sonde reprend seule après une coupure réseau et après un redémarrage (fichier `.end-at`).

## 4. Métriques (définitions précises)

Chaque cycle produit une ligne CSV (`probe-data/probe-<label>-<date>.csv`) :

| Colonne | Définition exacte |
|---|---|
| `timestamp_iso` | Instant du début du cycle, ISO 8601 UTC. |
| `label` | Étiquette de l'appareil (opérateur-ville-numéro). |
| `dns_ms` | Durée de la résolution DNS (`dns.promises.lookup`, getaddrinfo) du host — résolution récursive complète, connexion non comprise. |
| `dns_ip` | Première IP renvoyée par la résolution. |
| `tcp_ms` | Durée d'établissement TCP (SYN → SYN-ACK/ACK) vers le port 443. |
| `tls_ms` | Durée du **handshake TLS seul** (`secureConnect` − `connect`) : négociation cryptographique et validation du certificat. |
| `edge_ip` | IP du edge TCP/TLS réellement utilisée par le socket. |
| `http_ms` | Durée **totale** du `GET /manifest.webmanifest` avec `cache: no-store` (envoi de la requête → corps complet reçu). Le TTFB seul n'est pas mesurable nativement avec `fetch` ; la sonde mesure le total, choix assumé (simplicité et robustesse). |
| `status` | Code HTTP de la réponse. **Succès = 2xx.** |
| `bytes` | Taille du corps de réponse en octets. |
| `cf_colo` | Code **IATA du datacenter Cloudflare** qui a répondu, extrait de `cf-ray` (format réel `<hex>-<IATA>`, ex. `…-JNB`). **Colonne clé : elle révèle quel edge dessert l'opérateur.** |
| `cf_cache_status` | Comportement du cache Cloudflare (`HIT`, `MISS`, `DYNAMIC`…). |
| `cf_age` | Âge (s) de l'objet en cache au edge. |
| `server` | En-tête `server` (attendu : `cloudflare`). |
| `icmp_ms` | Contrôle : ping ICMP vers `1.1.1.1` (si la plateforme le permet ; vide sinon). Distingue « le réseau d'accès est coupé » de « le chemin vers l'app est dégradé ». |
| `error` | Message d'erreur du cycle (`fetch failed`, timeout DNS/TLS/HTTP…). Vide si le cycle est complet. |

**Indicateurs dérivés** (calculés à l'analyse, jamais pendant la collecte) :

1. **Taux de succès HTTP** = lignes avec `status` 2xx ÷ total des lignes.
2. **Disponibilité** = lignes sans `error` ÷ total.
3. **p50 / p95 / p99** de `dns_ms`, `tcp_ms`, `tls_ms`, `http_ms`, par opérateur, par ville et global. La médiane (p50) décrit l'expérience typique ; le p95/p99 décrit les pires cas, qui font fuir les utilisateurs.
4. **Distribution des `cf_colo`** : quel(s) edge(s) Cloudflare servent chaque opérateur/ville (ex. JNB Johannesburg, LOS Lagos, LHR/CDG/AMS/FRA = Europe → latence structurelle).
5. **Corrélation avec les coupures** : trous dans la série (intervalle > 2 × cadence = coupure probable) croisés avec `icmp_ms` vide/élevé → distinguer coupure d'accès (réseau) vs dégradation du chemin applicatif.

## 5. Analyse attendue

- Tableau par opérateur × ville : n mesures, taux de succès, disponibilité, p50/p95/p99 de `http_ms` (et `dns_ms`/`tcp_ms`/`tls_ms`).
- Distribution cumulée des `cf_colo` par opérateur.
- Courbe temporelle de `http_ms` sur 48 h (mise en évidence des heures de congestion).
- Liste des fenêtres de coupure (> 10 min) par appareil.

## 6. Règles de décision chiffrées

> ⚠️ **Ces seuils sont des hypothèses de travail à valider par le comité d'architecture avant exploitation.** Ils sont proposés pour cadrer la décision, pas pour la précéder.

| Règle | Condition (constatée sur l'ensemble du plan d'échantillonnage) | Décision proposée |
|---|---|---|
| **R1** | p95 `http_ms` < **800 ms** **ET** taux de succès ≥ **99 %** sur chacun des 3 opérateurs | **Conserver Cloudflare en l'état** (statu quo). Réévaluer dans 6 mois ou en cas d'évolution du peering. |
| **R2** | Taux de succès < **95 %** pour **un** opérateur (les 2 autres ≥ 99 %) | Investiguer cet opérateur : envisager un **point de présence alternatif / multi-CDN** ciblé, ou une négociation de peering avec l'opérateur concerné. |
| **R3** | p95 `http_ms` ≥ **1500 ms** de façon persistante sur **≥ 2 opérateurs** | Étudier sérieusement une **origine régionale** (Afrique australe/centrale) ou un CDN avec des PoP plus proches des utilisateurs RDC. |
| **R4** | Majorité des `cf_colo` observés **hors d'Afrique** (ex. Europe) | La latence est structurelle (trajet intercontinental) → argument fort pour C (origine régionale) ou un CDN présent localement, même si R1 n'est pas déclenchée. |
| **R5** | Écarts marqués entre villes (ex. Kinshasa OK, Goma dégradée) | Stratégie différenciée ; privilégier les solutions CDN/edge plutôt qu'une seule origine unique. |

La décision finale est prise par le comité, **documentée dans le journal (§ 8)**, avec les chiffres qui l'appuient.

## 7. Limites honnêtes — à lire avant d'interpréter

1. **L'exécution exige des appareils physiques sur les réseaux RDC.** Personne ne peut la faire à leur place : depuis un datacenter, un sandbox ou l'Europe, on mesure un autre chemin réseau et les résultats ne sont pas transposables. Tant que les volontaires n'ont pas tourné 48 h, le protocole est **prêt mais non exécuté**.
2. **Mesures de volontaires ≠ sondes déployées.** Pas de SLA sur l'appareil de mesure : smartphone personnel, coupures d'électricité, mouvement du porteur. C'est un échantillon d'expérience réelle, pas un banc d'essai contrôlé.
3. **Biais de couverture.** Les volontaires sont urbains, équipés, alphabétisés ; les zones rurales et les réseaux les plus dégradés sont **sous-représentés**. Les résultats sont donc plutôt *optimistes*.
4. **Variabilité des appareils.** Node/Termux, puce radio, bande 2G/3G/4G diffèrent ; ≥ 2 appareils par opérateur atténue (sans supprimer) ce biais.
5. **ICMP parfois indisponible** (droits `cap_net_raw` sur certains Termux) : la colonne `icmp_ms` peut rester vide — la sonde est conçue pour le tolérer.
6. **`/manifest.webmanifest` est un petit fichier statique, souvent en cache edge** (`cf-cache-status: HIT`) : ce protocole mesure très bien le **chemin jusqu'au edge Cloudflare** (DNS, TCP, TLS, réponse edge), mais il ne remplace pas une mesure de charge des routes API dynamiques. Extension possible : un second `PROBE_TARGET` pointant une route API légère.
7. **48 h ≠ toutes les saisons.** Congestion, facturation forfaitaire en fin de mois, pluies/coupures : la fenêtre retenue doit être notée et le protocole peut être rejoué.

## 8. Journal des décisions bloquées en attendant les résultats

| Date | Décision | Statut | Débloquée par |
|---|---|---|---|
| 2026-11-04 | Choix de l'architecture d'origine (Cloudflare seul / multi-CDN / origine régionale) | ⛔ **BLOQUÉE** | Résultats du protocole 48 h + règles § 6 |
| 2026-11-04 | Budget et dimensionnement d'un serveur d'origine régional | ⛔ **BLOQUÉE** | idem (déclenchée notamment par R3/R4) |
| 2026-11-04 | Négociation peering avec opérateurs RDC / CDN alternatif | ⛔ **BLOQUÉE** | idem (déclenchée notamment par R2) |
| 2026-11-04 | Tout déplacement/sortie du proxy Cloudflare actuel | ⛔ **BLOQUÉE** | idem (R1 = non-décision, statu quo conservé) |

*Chaque déblocage consignera ici : date, chiffres clés, règle(s) appliquée(s), décision prise.*

## 9. Option complémentaire — sondes GitHub Actions (baseline uniquement)

En parallèle, des sondes planifiées **GitHub Actions** (cron toutes les 15 min, même `probe.mjs`) peuvent tourner depuis des runners hors RDC (États-Unis/Europe).

- **Utilité :** groupe de contrôle — comparer « depuis l'étranger bien connecté » vs « depuis la RDC » pour isoler ce qui est dû au réseau congolais.
- **Limite :** ces mesures **ne comptent pas** pour les règles de décision § 6 (elles ne passent pas par les réseaux mobiles congolais). Baseline seulement.

## Annexe — Configuration de la sonde

| Variable | Défaut | Rôle |
|---|---|---|
| `PROBE_TARGET` | `https://mbotemesh.aenews.online` | Origine/hôte mesuré |
| `PROBE_INTERVAL_S` | `300` | Cadence (s) — 300 s = 1 mesure/5 min |
| `PROBE_LABEL` | `sans-label` | Étiquette opérateur-ville-appareil (obligatoire en pratique) |
| `PROBE_DURATION_H` | `48` | Durée du protocole (h) — fractions acceptées |
| `PROBE_OUT` | `./probe-data` | Dossier de sortie des CSV et du fichier `.end-at` |
