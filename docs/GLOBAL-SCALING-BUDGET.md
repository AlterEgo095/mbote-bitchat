# CHIFFRAGE MONDIAL — BUDGET TOTAL DE LA CIBLE « MONDIAL »

**Statut** : PROPOSITION pour décision Go/No-Go. Ordres de grandeur argumentés, fourchettes ±50 %. Devise : USD.
**Décision couverte** : cible « mondial » du recadrage — sans ce chiffrage, « mondial » reste un slogan non finançable.
**Portée** : paliers 10k / 100k / 1M+ DAU, conformité, modération, pentests, astreinte, équipe. Hors budget ponctuel d'exécution du palier 1 (§8).

---

## 0. Hypothèses explicites (A1–A8)

| # | Hypothèse |
|---|---|
| A1 | Équipe mixte : cœur de développement en RDC (1,5–3,5 k$/mois selon séniorité) ; SRE/sécurité seniors internationaux remote (6–12 k$/mois) |
| A2 | Paliers de charge : 10k / 100k / 1M+ DAU |
| A3 | Média : ~3 Mo net/usager/mois de croissance après compression (mobile-first RDC, option Wi-Fi par défaut pour le lourd) |
| A4 | Appels : 2–4 % des DAU passent ≥ 1 appel/jour, 3 min en moyenne ; audio 24–48 kbps, vidéo 400–800 kbps ; TURN requis pour 40–60 % des appels (CGNAT RDC) |
| A5 | Egress média ≈ 0 (R2 + Cloudflare, egress gratuit) ; l'egress TURN est le principal poste bande passante |
| A6 | Hors monétisation : budget = dépense, pas P&L |
| A7 | Conformité : RDC toujours ; UE/US uniquement en cas de lancement ciblé |
| A8 | Fourchettes : la borne basse suppose une équipe majoritairement RDC et de l'auto-hébergement ; la borne haute des prestations managées |

---

## 1. Infrastructure par palier de DAU

### 1.1 — 10k DAU (palier 1, régime établi)

| Poste | $/mois |
|---|---|
| App + relay (VPS classe actuelle, 2 conteneurs existants) | 50–120 |
| TURN coturn (même VPS au début) | 0–40 |
| Base de données (SQLite → Postgres managé dès ce palier) | 15–60 |
| R2 stockage (~0,5 To an 1) + ops | 8–15 |
| Backups externalisés chiffrés (décision D4) | 5–20 |
| Monitoring/logs | 0–20 |
| **Sous-total** | **80–275 $/mois → 2–4 k$/an** |

### 1.2 — 100k DAU

| Poste | $/mois |
|---|---|
| 3 nœuds app + répartiteur | 100–250 |
| Postgres managé HA | 100–300 |
| Redis (file + pub/sub relay) | 30–80 |
| Relay cluster 2 nœuds | 80–150 |
| TURN 2 zones (auto-hébergé) | 100–300 |
| R2 (~5 To) | 75 |
| Observabilité + logs | 50–150 |
| Outillage sécurité/WAF | 100–250 |
| Backups externalisés | 20–50 |
| **Sous-total** | **~0,8–1,8 k$/mois → 10–22 k$/an** |

### 1.3 — 1M+ DAU (multi-région : UE + edge Afrique via Cloudflare ; US optionnel)

| Poste | $/mois |
|---|---|
| Ferme de calcul (8–20 nœuds) | 2 000–6 000 |
| Postgres HA multi-AZ + réplicas lecture (partitionnement requis au-delà de ~10–50 M msgs/jour — mur ① de l'audit) | 1 000–3 000 |
| Redis cluster | 300–800 |
| R2 (~50 To) | 750 |
| TURN : auto-hébergé 200–600 / managé (Cloudflare Calls/Twilio) 1 000–3 000 | 200–3 000 |
| Observabilité 24/7 | 300–1 000 |
| WAF avancé + sécurité | 200–500 |
| Backups externalisés multi-région | 100–300 |
| **Sous-total** | **~6–15 k$/mois → 70–180 k$/an** |

---

## 2. Conformité par juridiction (obligations concrètes chiffrées)

| Juridiction | Obligations concrètes | Coût |
|---|---|---|
| **RDC (toujours)** | Loi n° 23/010 du 13/03/2023 (protection des données) : enregistrement des traitements auprès de l'APD, conseil juridique local, politique de confidentialité FR/Lingala/Swahili ; analyse d'obligations additionnelles (voix/crypto) par un conseil local | 2–10 k$ (mise en place) + 5–15 k$/an |
| **UE (si lancement)** | RGPD : registre des traitements, DPIA (messagerie E2EE + profils), DPO externe (art. 37), représentant UE (art. 27) si établi hors UE ; transparence de modération (bonnes pratiques DSA, seuil VLOP 45 M MAU très au-delà) | 20–55 k$/an |
| **US (si lancement)** | COPPA (portail < 13 ans), CCPA/CPRA selon seuils ; export crypto : auto-classification License Exception ENC (mass market) — dossier one-time | 10–30 k$/an + 5–15 k$ one-time |
| **Total mondial (RDC+UE+US)** | | **35–100 k$/an** en régime |

---

## 3. Modération 24/7 (équipe + outils + escalade)

| Palier | Dispositif | Coût/an |
|---|---|---|
| 10k | fondateurs + panneau admin + auto-modération (API de classification ~0,5–2 k$) ; **route de signalement obligatoire (R4)** | 0–10 k$ |
| 100k | 3–4 modérateurs RDC (0,8–1,5 k$/mois) couverture étendue ; outils + file d'escalade | 30–80 k$ |
| 1M+ | 10–15 modérateurs + 2 responsables T&S + escalade juridique ; couverture 24/7 réelle sur 3 fuseaux ; auto-modération à l'échelle | 150–430 k$ |

## 4. Pentests annuels (externe + interne)

| Palier | Dispositif | Coût/an |
|---|---|---|
| 10k | pentest externe biennal (mobile + backend) | 4–8 k$ |
| 100k | pentest externe annuel scoping mobile + backend + infra | 15–30 k$ |
| 1M+ | 2 pentests externes/an (25–60 k$) + bug bounty privé (10–30 k$) + ingénieur sécurité interne (compté dans l'équipe) | 40–90 k$ |

## 5. Astreinte 24/7

| Palier | Dispositif | Coût/an |
|---|---|---|
| 10k | best-effort | 0 |
| 100k | astreinte passive, 3–4 ingénieurs en rotation, prime 200–500 $/mois + PagerDuty | 8–27 k$ |
| 1M+ | astreinte 24/7 formalisée, 4–6 ingénieurs, prime 300–600 $/mois + outillage | 17–51 k$ |

---

## 6. Équipe cible (effectifs par rôle)

| Rôle | 10k | 100k | 1M+ | Coût unitaire mensuel |
|---|---|---|---|---|
| Backend | 1 | 2 | 3–4 | 1,5–3,5 k$ (RDC) |
| SRE / Infra | 0,5 | 1 | 2 | 6–12 k$ (international) |
| Mobile (iOS+Android+BLE natif) | 1 | 2 | 3 | 1,5–3,5 k$ (RDC) |
| Sécurité | contractor | 0,5 | 1–2 | 6–12 k$ (international) |
| Modération / T&S | 0 | 3–4 | 10–15 | 0,8–1,5 k$ (RDC) |
| Conformité / juridique | 0 | 0,5 | 1 + conseil externe | 2–5 k$ |
| Support usagers | 0 | 1 | 3–5 | 0,8–1,5 k$ (RDC) |
| Produit / design | 0,5 | 1 | 1–2 | 2–4 k$ |
| Lead / architecte | 1 | 1 | 1 | 3–6 k$ |
| **Total effectifs** | **~3** | **6–8** | **25–35** | |

Masse salariale annuelle : 10k → 30–90 k$ ; 100k → 150–300 k$ ; 1M+ → 550–1 200 k$.

---

## 7. Budget annuel total — synthèse

| Palier | Infra | Équipe | Modération | Pentest | Conformité | Astreinte | **TOTAL/an** |
|---|---|---|---|---|---|---|---|
| **10k DAU** | 2–4 k$ | 30–90 k$ | 0–10 k$ | 4–8 k$ | 5–15 k$ | 0 | **≈ 40–125 k$** |
| **100k DAU** | 10–22 k$ | 150–300 k$ | 30–80 k$ | 15–30 k$ | 10–25 k$ | 8–27 k$ | **≈ 220–480 k$** |
| **1M+ DAU** | 70–180 k$ | 550–1 200 k$ | 150–430 k$ | 40–90 k$ | 35–100 k$ | 17–51 k$ | **≈ 0,9–2,0 M$** |

## 8. Budget ponctuel d'exécution du palier 1 (hors régime)

Livraison des services D1 (28–44 PM, cf. `docs/TARGET-SERVICES-PALIER1.md`) :
- Équipe de 4 pendant 7–11 mois à taux RDC (2–3,5 k$/mois) : **70–155 k$**
- Infra de dev, Apple Dev, pentest de clôture, outils : **15–25 k$**
- **Total ponctuel : ≈ 90–180 k$ (une fois)**

## 9. Facteurs de bascule des fourchettes

**Vers la borne haute** : TURN managé, modération multilingue réelle (FR/EN/Swahili/Lingala), multi-région actif-actif, croissance vidéo, lancement UE/US simultanés.
**Vers la borne basse** : équipe majoritairement RDC, TURN auto-hébergé, vidéo limitée au Wi-Fi, conformité RDC seule en premier, pas de monétisation à porter.

## 10. Verdict financier (Go/No-Go)

1. « Mondial » (1M+ DAU) = engagement stable **≥ ~0,9 M$/an**, plausible 2 M$/an, plus ~90–180 k$ d'exécution palier 1 en amont.
2. Trajectoire finançable par étapes : **palier 1 (40–125 k$/an + 90–180 k$ ponctuel) → 100k DAU (220–480 k$/an) → décision mondiale avec financement dédié identifié.**
3. Sans financement ≥ ~1 M$/an identifiable à l'horizon 1M DAU, l'objectif « mondial » n'est pas exécutable : l'architecture reste conçue pour scaler à coûts quasi-linéaires maîtrisés, et le lancement mondial attend son financement. C'est la conclusion honnête de ce chiffrage.
