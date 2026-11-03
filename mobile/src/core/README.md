# src/core — cœur du protocole embarqué

`bitchat-protocol.ts` est **copié à l'identique** depuis `src/lib/mbote/bitchat-protocol.ts`
(cœur web/serveur). Il est volontairement **isomorphe** : zéro dépendance DOM,
zéro Buffer, zéro API Node — il tourne tel quel sur Hermes/React Native.

## Synchronisation

Après toute modification du cœur côté web :

```bash
cp ../src/lib/mbote/bitchat-protocol.ts src/core/bitchat-protocol.ts
```

Les signatures et DMs sont **interopérables web ↔ mobile** :
- Identité : ECDSA P-256 (SHA-256), signature brute `r||s` (64 octets) — identique WebCrypto
- DM : ECDH P-256 (secret = coordonnée X 32 octets) + AES-256-GCM — identique WebCrypto
- Enveloppes : JSON signé transporté en payload opaque (modèle BitChat/Nostr)
