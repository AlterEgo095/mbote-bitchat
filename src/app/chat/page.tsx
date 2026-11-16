import type { Metadata } from "next";

import { MboteApp } from "@/components/mbote/MboteApp";
import { I18nProvider } from "@/lib/mbote/i18n";

export const metadata: Metadata = {
  title: "Mbote Mesh — Messagerie",
  description: "Messagerie chiffrée Mbote Mesh : canaux, messages, groupes.",
};

export default function ChatPage() {
  return (
    <I18nProvider>
      <MboteApp />
    </I18nProvider>
  );
}
