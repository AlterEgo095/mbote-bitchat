import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/mbote/Providers";
import { PwaRegister } from "@/components/mbote/PwaRegister";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mbote Mesh — Réseau social décentralisé, déployable sur VPS",
  description:
    "Réseau social complet inspiré du protocole BitChat : identités par clés locales, canaux géohash, messages chiffrés de bout en bout (ECDH + AES-GCM), file d'attente « courrier » hors-ligne et panic wipe. Zéro compte, zéro numéro.",
  keywords: [
    "bitchat",
    "mesh",
    "nostr",
    "réseau social décentralisé",
    "geohash",
    "e2e",
    "webcrypto",
    "next.js",
  ],
  authors: [{ name: "Mbote Mesh" }],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Mbote Mesh",
  },
  openGraph: {
    title: "Mbote Mesh — le réseau social qui survit aux coupures",
    description:
      "Canaux géographiques, DM chiffrés de bout en bout, mode mesh hors-ligne. Déployable sur votre VPS.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0f0d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <PwaRegister />
      </body>
    </html>
  );
}
