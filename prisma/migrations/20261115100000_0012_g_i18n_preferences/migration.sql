-- G (i18n) — préférence de locale par compte (roaming multi-appareils).
-- Écriture signée via POST /api/preferences ; lecture publique.
-- Le LS `mbote_locale` (appareil) reste prioritaire côté client.
ALTER TABLE "User" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'fr';
