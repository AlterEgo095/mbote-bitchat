# SPÉCIFICATION — NUMÉRO DE SÉCURITÉ (A2, authentification des clés)

**Statut** : documenté AVANT implémentation (exigence : « algorithme documenté, référence Signal »).
**Référence de conception** : Signal — *Fingerprint specifications* (signal.org/docs/specifications/fingerprint) — numéro de sécurité numérique à 60 chiffres, obtenu par hachage itéré des deux identités.
**Portée Mbote** : les paires échangées sont (clé d'identité ECDSA P-256, clé de chiffrement ECDH P-256) des DEUX parties — le numéro couvre donc à la fois l'identité stable et la clé DM chiffrable (la surface d'attaque L-3 : substitution d'`ecdhPub` servie par le serveur).

---

## 1. Entrées

| Champ | Encodage | Taille |
|---|---|---|
| `version` | octet unique `0x00` | 1 o |
| `iterations` | uint32 **big-endian** | 4 o |
| clé identité (sk) | clé publique ECDSA P-256 brute `0x04‖X‖Y`, base64url → octets | 65 o |
| identifiant (id) | clé publique ECDH brute (même encodage) | 65 o |

Le couple `(sk, id)` de chaque partie est ordonné **lexicographiquement par octets de `sk‖id`** avant hachage → le numéro est **symétrique** (A,B ≡ B,A) : les deux côtés affichent la même valeur sans négociation.

## 2. Calcul (SHA-512 itéré)

```
FINGERPRINT(version, iterations, sk1, id1, sk2, id2):
  data := version ‖ iterations ‖ sk1 ‖ id1 ‖ sk2 ‖ id2
  hash := SHA-512(data)
  pour n de 0 à iterations−1 :
      hash := SHA-512( hash ‖ n )          # n en uint32 big-endian
  renvoyer hash[0..29]                     # troncature à 30 octets
```

- `iterations = 5200` (référence Signal) — rend l'inversion et la recherche de collision affichage coûteuses même pour un adversaire rapide.
- La troncature à 30 octets (240 bits) alimente l'affichage ; l'entropie du **numéro affiché** est ≈ 30 × log₂(100) ≈ 199 bits — très au-delà de toute force brute humaine.

## 3. Affichage

```
displayString(fingerprint):
  chaque octet → 2 chiffres : chiffres_i = octet_i mod 100, sur 2 digits (ex. 07)
  30 octets → 60 chiffres, affichés en 12 groupes de 5 :
  « 12345 67890 24680 13579 86420 97531 01234 56789 98765 43210 55555 00000 »
```

Format aligné sur l'usage Signal : comparable de vive voix ou par QR, 2 lignes de 6 groupes dans l'UI.

## 4. Propriétés exigées (et testées — `tests/safety-number.test.ts`)

1. **Déterminisme** : mêmes entrées → même numéro (stable dans le temps, cache possible).
2. **Symétrie** : (A,B) = (B,A) grâce à l'ordonnancement — les deux appareils affichent l'identique.
3. **Sensibilité totale (avalanche)** : changer UN bit d'une seule clé change ~tous les chiffres — une substitution est toujours détectable par comparaison.
4. **Non-inversibilité** : le numéro ne révèle aucune clé (hachage à sens unique).
5. **Format** : 60 chiffres, 12 groupes de 5.

## 5. Protocol de confiance (détection de substitution)

- **Premier contact** : le numéro est calculé et affiché, état = `unverified` — bannière d'information (jaune). Pas de blocage (sinon impasse cold-start), mais invitation à vérifier.
- **Vérification hors-bande** : les deux parties comparent les 60 chiffres en présentiel (ou par un canal déjà authentifié) → « J'ai vérifié » → état = `verified` (épinglage local + serveur).
- **Substitution APRÈS établissement** : toute divergence entre la clé épinglée et la clé servie → état = `changed` → **ALERTE ROUGE BLOQUANTE** : envoi E2EE suspendu jusqu'à re-vérification explicite du NOUVEAU numéro. C'est le verrou exigé : aucun média E2EE ne peut partir vers une clé non ré-épinglee.
- **Nouvel appareil légitime** : même chemin que la substitution (c'est structurellement le même événement) — la re-vérification du nouveau numéro est le flux de re-confiance.
- **Limites assumées (modèle Signal)** : un serveur PLEINEMENT malveillant peut servir des clés différentes à chaque partie — seul le comparage hors-bande des 60 chiffres le détecte. L'épinglage local (par appareil, `trust-client.ts`) détecte toute rotation vue par CET appareil, indépendamment du serveur ; l'état serveur (`TrustedKey`) assure l'audit et la détection inter-appareils.

## 6. Note d'interopérabilité

L'algorithme suit la spécification Signal (structure, itérations 5200, troncature 30 octets, affichage 30×5). Les encodages de compteurs (`uint32 BE`) et l'ordonnancement des paires sont ceux documentés ICI — l'interopérabilité binaire avec les implémentations libsignal n'est PAS revendiquée tant qu'un vecteur croisé n'a pas été généré. Aucune conséquence sécurité : le numéro n'est qu'une fonction d'affichage comparative entre clients Mbote (web + mobile partagent cette implémentation isomorphe).

**Implémentation** : `src/lib/mbote/safety-number.ts` (isomorphe, WebCrypto uniquement).
