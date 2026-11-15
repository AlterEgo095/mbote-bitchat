-- G (i18n) — préférence de locale par compte (roaming multi-appareils).
-- Écriture signée via POST /api/preferences ; lecture publique.
-- Le LS `mbote_locale` (appareil) reste prioritaire côté client.
-- localeExplicit : la locale n'est adoptée par un autre appareil que si elle
-- a été CHOISIE explicitement (le défaut 'fr' n'écrase jamais la détection
-- navigateur d'un nouvel appareil — bug détecté par le harnais G).
ALTER TABLE "User" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'fr';
ALTER TABLE "User" ADD COLUMN "localeExplicit" BOOLEAN NOT NULL DEFAULT 0;
