import type { Metadata } from "next";

import { Landing } from "@/components/mbote/Landing";
import { I18nProvider } from "@/lib/mbote/i18n";

export const metadata: Metadata = {
  title: "Mbote Mesh — La messagerie qui survit aux coupures",
  description:
    "Messagerie chiffrée de bout en bout (E2EE) avec réseau mesh Bluetooth hors-ligne : sans compte, sans numéro, sans publicité — aucune donnée personnelle sur nos serveurs. Mbote fonctionne même quand internet tombe.",
  openGraph: {
    title: "Mbote Mesh — La messagerie qui survit aux coupures",
    description:
      "Chiffrement de bout en bout, réseau mesh Bluetooth hors-ligne, aucune donnée personnelle sur nos serveurs. Mbote fonctionne même quand internet tombe.",
    images: ["/mbote/hero.webp"],
  },
};

export default function HomePage() {
  return (
    <I18nProvider>
      <Landing />
    </I18nProvider>
  );
}
