'use client'

import { MboteApp } from "@/components/mbote/MboteApp";
import { I18nProvider } from "@/lib/mbote/i18n";

export default function Home() {
  return (
    <I18nProvider>
      <MboteApp />
    </I18nProvider>
  );
}
