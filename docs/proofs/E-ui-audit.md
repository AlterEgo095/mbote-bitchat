# Preuve E — UI-AUDIT (vague E, 2026-11-13)

> **Livrable principal : [`docs/UI-AUDIT.md`](../UI-AUDIT.md)** — audit écran par
> écran, état par état : 78 problèmes (6 Critiques / 42 Majeurs / 30 Mineurs),
> 6 motifs transverses, préparation i18n G, découvertes rendu réel.
> **E identifie. F corrigera. Aucun fix dans E.**

## 1. Ce que cette preuve établit

1. **Les 12 vues du périmètre ont été auditées EN RENDU RÉEL**, pas seulement
   en lecture de code : l'application tourne en **production standalone**
   (:3110), le panneau admin en **production** (:3104, login TOTP réel), sur
   une DB migrée et seedée (`db/ui-audit.db`), avec hub relay :3040 + TURN
   harnais :3478 — le même pattern que les preuves C2/C3 (serveurs réels).
2. **axe-core a tourné sur 18 états de vue** (script rejouable
   `scripts/axe-audit.ts`) — résultats JSON par vue dans `E-axe/` :
   **6 types de violation, 9 nœuds, 0 critical, 9 serious** ; 12 vues à 0.
3. **Les flux critiques de l'app ont été EXERCÉS de bout en bout avec deux
   identités réelles** : DM E2EE aller-retour, appel audio (sonnerie → actif
   + timer TURN → raccroché), groupe MLS (création + invitation), hors-ligne
   (file locale + flush), dégradation relay (SIGSTOP), responsive 375.
4. **Les états critiques ont des captures** dans `assets/E/` (liste §4).

## 2. Résumé chiffré (détail complet dans UI-AUDIT.md §1)

| Mesure | Valeur |
|---|---|
| Problèmes totaux | **78** |
| Critiques (bloquent l'ouverture publique) | **6** — #1 panic wipe sans confirmation, #2 publication identité silencieuse, #15 feed sans état d'erreur, #39 sélection groupe inaccessible clavier, #47 invitation MLS invisible chez l'invité, #72 bug email === rôle pending-actions |
| Majeurs | **42** |
| Mineurs | **30** |
| Vues axe auditées | 18 états |
| Violations axe | 6 types / 9 nœuds / **0 critical** / 9 serious |
| Vues à 0 violation axe | 12 / 18 |
| Littéraux FR codés en dur (préparation G) | ≈ 350 sur ≈ 25 fichiers |

## 3. Scores axe-core par vue (cible ≥ 90 : proxy = 0 violation)

| Vue (état) | Violations | Détail |
|---|---|---|
| onboarding (PoW visible) | 0 | progressbar ARIA correcte |
| feed | 0 | — |
| messages-vide | 0 | B2-fix re-vérifié en rendu |
| dm-conversation-alice / -bob | 0 / 0 | flux réel |
| messages-offline | 1 (2 nœuds) | color-contrast : badge ambre + hint 10px |
| profile | 0 | — |
| groups-vide / groupe-cree | 1 / 1 | label-in-name « Créer un groupe » vs « Nouveau groupe » (2.5.3) |
| channels / network / recherche-dialog | 0 / 0 / 0 | — |
| call-entrant / call-actif | 1 / 1 | label-in-name (« Terminer l'appel » vs « Raccrocher ») ; bouton « Nouveau groupe » sous l'overlay pour l'entrant |
| admin-dashboard / queue / users / audit | 0 / 0 / 0 / 0 | SSR + bandeaux role="alert" |
| admin-pending-actions | 1 (3 nœuds) | color-contrast text-zinc-400 (n° intentions, dates) |

Sortie du script (passe finale) : `bun scripts/axe-audit.ts` →
`[axe-audit] TERMINÉ — 18 vues, 6 types de violation, 9 nœuds` — JSON :
`docs/proofs/E-axe/<vue>.json` (cibles CSS + HTML + failureSummary inclus),
résumé : `docs/proofs/E-axe/resume.json`, manifeste infra :
`docs/proofs/E-axe/infra.json`.

## 4. Captures des Critiques et des flux réels (`assets/E/`)

| Capture | Ce qu'elle montre | Problème(s) lié(s) |
|---|---|---|
| `onboarding-pow-alice.png` | PoW visible : progressbar + % + explication 20 bits | (positif — #3/#2 restent sur les échecs) |
| `feed-post-sent.png` | post publié via composer, rendu dans le fil | (positif) |
| `dm-conversation-alice.png` | conversation Bob : bulles, bandeau « Premier contact — numéro de sécurité non vérifié », boutons appel | #27-29, #32 |
| `dm-recu-bob.png` / `dm-conversation-bob.png` | réception réelle E2EE côté Bob | (positif) |
| `messages-offline-bulle.png` | pastille « Mesh · file locale (1) », toast courrier, bulle « En attente » + hint, placeholder composer hors-ligne | **#31 (contraste axe sur cette vue)** |
| `call-ringing-bob.png` | overlay sonnerie « Appel entrant » Rejeter/Répondre 48px | (positif) |
| `call-active-bob.png` | appel actif : timer, « Relais TURN actif (CGNAT) », Micro/Raccrocher | **#49 (label-in-name sur Raccrocher)** |
| `group-created-alice.png` | groupe MLS créé, badge « MLS actif » | (positif) |
| `group-not-visible-bob.png` | **le groupe n'apparaît PAS chez l'invité** (25 s, vue groupes ouverte) | **#47 (Critique)** |
| `relay-degrade-header.png` | pastille « relay… » après SIGSTOP hub | (positif §e) |
| `admin-dashboard.png` | 4 métriques + seuils, session super-admin réelle | (positif) |
| `admin-queue-justification.png` | formulaire justification : catégorie, compteur n/20, 410/403 mappés | #62, #63 |
| `admin-pending-actions.png` | intentions 4-yeux, countdown, badges | **#73 (contraste axe)**, #72, #74 |
| `responsive-375-feed.png` / `-messages` / `-profile` | viewport 375 réel | **#5 (6ᵉ onglet), #6 (recherche absente)** |

Les Critiques « code » sans capture visuelle dédiée (#1 panic wipe au menu,
#15 état d'erreur absent = capture impossible d'un écran qui n'existe pas,
#72 branche inatteignable) sont prouvés par les littéraux et lignes cités
dans UI-AUDIT.md §3 — conformément à la méthodologie (capture pour les
Critiques **visuels** ; ceux-ci sont des absences de comportement).

## 5. Flux réels exercés (horodatage boot → passe finale)

```
[1] onboarding Alice + PoW visible            → identité publiée (ecdhPub ✓)
[2] composer feed → post rendu dans le fil    → succès
[3] like optimiste (aria-pressed)             → succès
[4] vues messages-vide/profile/groups/channels/network + axe → OK
[5] DM Alice↔Bob (2 identités réelles)        → aller-retour E2EE ✓
[5bis] hors-ligne : bulle « En attente »      → ✓ + flush reconnexion ✓
[6bis] keypackages Bob (visite vue groupes)   → publiés (3)
[6] appel audio : sonnerie → actif + timer    → ✓ (WebRTC + TURN :3478)
[7] groupe MLS : création + invitation        → ✓ créé / ⚠ non visible chez Bob
[9] SIGSTOP hub → pastille « relay… »         → ✓ observée, reconnexion auto
[10] responsive 375 (4 captures)              → ✓ (2 défauts confirmés)
[11] admin : login TOTP 200 → 5 vues + formulaire justification → ✓
```

Infra de la passe : `scripts/ui-audit-boot.ts` (rejouable — hub/TURN/app/panel
+ seed), app en `bun run build` standalone + `admin` en `next start`.
**La garde anti-Sybil D2 (3 créations/heure/IP) impose ≤ 2 identités par
passe** — respectée dans le script final (leçon des passes 2-5, cf. §6.2 du
document principal).

## 6. Découvertes rendu réel documentées dans UI-AUDIT.md §6

1. **`next dev` du checkout wt-adm ne s'hydrate pas** (app + panel) —
   production standalone saine ; cause non identifiée, DX seulement.
2. **Publication d'identité 429 silencieuse** (garde D2 fonctionnelle, UI
   muette) — promu Critique #2.
3. **Invitation MLS invisible chez l'invité** — promu Critique #47.

## 7. NON TESTÉ (honnêteté)

- Safari/Firefox (Chromium sandbox uniquement) ; lecteurs d'écran réels
  (VoiceOver/NVDA) — axe-core ne les remplace pas ; device physique
  responsive ; safe-areas iOS.
- Contrastes : validés par axe uniquement (5 combinaisons) — pas de mesure
  manuelle AA exhaustive.
- États admin « backend down » rendus (le hub mbote a été dégradé pour
  l'état relay ; le BFF admin n'a pas été coupé).
- Charge réelle : pagination profonde, 200+ messages en fenêtre, instabilité
  réseau réelle (setOffline/SIGSTOP synthétiques uniquement).
- Diagnostics exacts de #47 (welcome MLS) et du stall dev — constatés, non
  isolés (F).

## 8. Artifacts

| Artefact | Chemin |
|---|---|
| Document principal | `docs/UI-AUDIT.md` |
| Script d'audit (rejouable) | `scripts/axe-audit.ts` |
| Script d'infra (rejouable) | `scripts/ui-audit-boot.ts` |
| Résultats axe (18 vues) | `docs/proofs/E-axe/<vue>.json` + `resume.json` + `infra.json` |
| Captures (25+) | `docs/proofs/assets/E/*.png` |
| Logs serveurs | `docs/proofs/E-{hub,turn,app,panel,app-prod,panel-prod,boot}.log` — **locaux (gitignorés `*.log`), rejouables via les deux scripts** |
