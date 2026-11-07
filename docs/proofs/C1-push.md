# C1 — PUSH NOTIFICATIONS (Web Push VAPID, knock sans contenu) : preuves

**Statut** : LIVRÉ et PROUVÉ (chaîne serveur complète + UI + SW) — le
subscribe FCM **navigateur** est NON TESTÉ en sandbox (voir §4, incident
documenté). Branche `feat/b1-media-foundation`, worktree externe
`/home/z/wt-b1` (règle DEV-SETUP §2).

**Directive** : C1 (~2–3 jp) — table `PushSubscription` (userId, endpoint
UNIQUE, keys_p256dh, keys_auth, userAgent, createdAt, lastSeenAt,
disabledAt) ; `/api/push/subscribe` (auth signature, upsert idempotent,
rate limit 10/h/user) ; `/api/push/unsubscribe` (disabledAt) ; service
d'envoi (Web Push VAPID — web-push à ÉVALUER, knock-only
`{ type: "new_message", fromLabel }`, 410 → purge, 429 → backoff) ;
déclencheur non-bloquant sur POST /api/dms (pas de push si en ligne — à
trancher) ; rate limit outbound 1/30s/destinataire ; sw.js handler push +
notificationclick + badge ; UI « Activer les notifications » dans les
paramètres (message explicite si refusée) ; FCM Android reporté (pas de
compte Firebase).

**Arbitrages** (tranchés 2026-11-07, documentés in situ + §4) :
1. **Worktree : wt-b1** (pas de wt-push séparé) — la PWA (sw.js, manifest,
   PwaRegister), /api/dms et le rate store vivent déjà ici ; isoler
   créerait un merge douloureux pour zéro gain.
2. **Bibliothèque : `web-push@4.0.0`** (web-push-libs/web-push) — licence
   RÉELLE **MPL-2.0** (la directive annonçait « MIT » : divergence
   documentée — MPL-2.0 faible copyleft fichier-à-fichier, acceptable pour
   une dépendance NON modifiée) ; RFC 8291/8292 standard de facto,
   maintenance active. L'alternative maison node:crypto (ECDH+HKDF+AES-GCM
   + JWT ES256) est ÉCARTÉE : risque cryptographique sans recul
   communautaire. web-push est **CJS sans export default** — Turbopack
   refuse l'import default (bug attrapé par le harnais, fix import
   namespace).
3. **Knock = `{ type, fromLabel }` STRICT** — pas de senderKey, pas de
   conversationId dans le payload V1 (le routage de la notification →
   `/?view=messages` générique ; la notification précise par conversation
   est C4). Le fromLabel est le nickname PUBLIC (annuaire).
4. **Présence : TOUJOURS envoyer** — le hub relay n'expose pas la présence
   par clé (health = compteurs globaux) ; un push ignoré si l'utilisateur
   est en ligne coûte moins qu'un canal de présence par clé. Dette mineure
   tracée §4.
5. **Unsubscribe = purge DOUCE** (disabledAt, ligne conservée) — cohérent
   avec la purge 410 du sender ; anti-énumération : le désabonnement d'un
   endpoint d'AUTRUI répond 404.
6. **Fail-closed** : sans clés VAPID → `/api/push/config` 503, bouton UI
   masqué, sender no-op (testé §2·5).

---

## 1. Livrables → tests → preuves

| Livrable | Test | Preuve |
|---|---|---|
| `PushSubscription` (migration `20261107094500_0008_c1_push`, endpoint UNIQUE, indexes userId+disabledAt) | harnais S1/S4 | `assets/c1-db-subscriptions.json` (18 lignes : 16 actives, 2 disabled — purge 410 visible) |
| `/api/push/subscribe` : auth par signature `${me}\|push-sub\|endpoint\|p256dh\|auth\|ts` | harnais S2 (signature invalide → 401) | `assets/c1-harness-output.txt` (12/12) |
| UPSERT idempotent par endpoint (2 appels → 1 ligne, réactivation) | harnais S4 (findMany = 1) | idem |
| Rate limit 10/h/user | harnais S5 (user DÉDIÉ — saturer Bob cassait S7, bug run 2) | idem |
| `/api/push/unsubscribe` : disabledAt + idempotent + anti-énumération | harnais S7 (404 autrui, ligne intacte) | idem |
| `/api/push/config` : clé publique VAPID | harnais S8 (200 + key) | `assets/c1-config-503.txt` (503 SANS clés — fail-closed) |
| Sender VAPID : knock `{ type, fromLabel }` | **P1 — fil capté** | `assets/c1-server-log.txt` (`[push:sender] payload knock → {"type":"new_message","fromLabel":"Alice-Push"}` — **AUCUN contenu du message**) |
| **Payload chiffré SUR LE FIL (Wireshark-like)** | P1 (mini push service HTTPS réel) | `assets/c1-wire-capture.jsonl` : `authorization: vapid t=<JWT ES256> k=…` (RFC 8292), `content-encoding: aes128gcm` (RFC 8291), body = **binaire chiffré** (garde : `SECRET-E2EE` ABSENT du fil) |
| Rate limit OUTBOUND 1/30s/destinataire | P2 (2 DM → 1 SEUL knock sur le fil ; les 2 DM passent) | harnais P2 |
| 410 Gone → purge douce (disabledAt) | P3 (push service réel répondant 410) | c1-db-subscriptions.json (disabled=2) |
| 429 push service → backoff passif sans crash | P4 (DM reste 200) | harnais P4 |
| Déclencheur non-bloquant dans POST /api/dms | P1-P4 (les DMs restent 200 quoi que fasse le push service) | harnais |
| sw.js v6 : handler push + notificationclick + badge | navigateur (canal DEBUG même fonction) | `assets/c1-browser.txt` (`renderedNotification: [{title:"Mbote", body:"Nouveau message de Bob (preuve navigateur)", data:{url:"/?view=messages"}}]`) |
| UI « Activer les notifications » (paramètres) | navigateur | `assets/c1-profile-card.png` (carte + bouton) |
| **Refusée → message explicite** (directive) | navigateur contexte A | `assets/c1-push-denied.png` (« Notifications bloquées — réautorisez-les dans les réglages du site (icône cadenas) ») |
| État UI = RÉEL (invariant §1.8) | navigateur contexte B | `assets/c1-push-enabled.png` + c1-browser.txt (`notice` = le message d'échec RÉEL du push service interne — l'UI n'a jamais prétendu « activées » sans 2xx) |
| FCM Android | — | **NON TESTÉ** (pas de compte Firebase — reporté, §4) |

## 2. Suites exécutées

```
PUSH_C1_E2E=1 BASE_URL=http://127.0.0.1:3203 PUSH_TEST_PORT=3204 \
DATABASE_URL="file:$(pwd)/db/push-c1-e2e-test.db" bun test tests/push-c1.test.ts
  → 12 pass · 0 fail (S1-S8, P1-P4 + C1g unitaire)
# non-régression (unitaires b1) :
media-foundation + moderation + anti-replay + safety-number + media-b4-video
  → 65 pass · 8 skip (gates E2E) · 0 fail

bash scripts/c1-push-proof-run.sh → EXIT 0
  (build standalone TOUJOURS + app :3103 VAPID + navigateur + fail-closed 503)
```

**Bugs réels attrapés par le harnais** (5) :
1. `import webpush from "web-push"` → Turbopack : « The export default was
   not found » (CJS sans default) — fix import namespace.
2. Fixtures `p256dh` arbitraires → « Public key is not valid for specified
   curve » (web-push valide la courbe) — fix : VRAIES clés ECDH P-256.
3. web-push **force HTTPS** (EPROTO sur endpoint http) — fix : mini push
   service HTTPS + cert auto-signé + NODE_TLS_REJECT_UNAUTHORIZED=0
   (harnais ONLY).
4. Rate limit outbound PAR DESTINATAIRE : partager Bob entre P1 et P2
   consommait le créneau — fix : destinataire dédié par test.
5. Rate limit subscribe PAR USER (1 h) : saturer Bob en S5 cassait S7 —
   fix : utilisateur dédié.

## 3. Preuves navigateur (runner EXIT 0)

- `c1-profile-card.png` — carte « Notifications push » (bouton « Activer les
  notifications » ; l'état opératoire du bouton = la SUBSCRIPTION, pas la
  permission seule — un navigateur granté sans abonnement propose Activer).
- `c1-push-denied.png` — permission refusée → **message explicite** rouge
  (directive).
- `c1-push-enabled.png` + `c1-browser.txt` — flux Activer complet ; l'état
  suit le RÉEL (notice = message d'échec du push service interne en sandbox).
- `c1-notification-rendered.png` + c1-browser.txt — la notification est
  RÉELLEMENT rendue par le service worker (title `Mbote`, body
  `Nouveau message de Bob (preuve navigateur)`, click → `/?view=messages`).

## 4. NON TESTÉ (explicite)

- **Subscribe FCM navigateur réel** : le Chromium OSS de Playwright n'a pas
  les Google API keys → son push service interne refuse l'abonnement
  (« Registration failed - permission denied ») quel que soit le mode
  (headless shell, headless=new, non-headless sous Xvfb — incident runs
  11-12 documenté). **Classe « dépendance externe »** : à tester manuellement
  sur un Chrome/Edge réel (PWA installée, device réel — même jalon que la
  directive « PWA installée »). La CHAÎNE SERVEUR est intégralement prouvée
  par le harnais (mini push service HTTPS réel local).
- **FCM Android** : pas de compte Firebase — reporté (vague dédiée).
- **Notification device réelle** (clic → focus + navigate SPA) : le
  notificationclick handler est codé (postMessage NAVIGATE → location.assign,
  outbox persistée intacte) — non testé sans device réel.
- **Filtrage présence** (pas de push si en ligne) : tranché TOUJOURS envoyer
  (le relay n'expose pas la présence par clé) — un canal de présence par clé
  du relay = dette mineure, à évaluer en C4.
- **Charge réelle** (1000 push simultanés) : rate limits posés, pas de
  benchmark de charge.
- **iOS Safari PWA** (16.4+) : support partiel — test manuel requis (même
  jalon WASM §8 SCALE-ARCHITECTURE).
- **Retry backoff en condition réelle** : le 429 est backoff passif (log,
  pas de retry actif) — le prochain DM rejoue naturellement.
