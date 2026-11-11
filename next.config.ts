import type { NextConfig } from "next";

// F-21 : reactStrictMode réactivé (double montage volontaire — révèle les
// effets non idempotents) ; `typescript.ignoreBuildErrors` supprimé : le
// build échoue désormais sur toute erreur TS (tsc doit rester vert).
// Vague 6 : le hub temps réel est EMBARQUÉ dans ce serveur en dev (voir
// src/instrumentation.ts) — plus de mini-service séparé à superviser.

const isDev = process.env.NODE_ENV !== "production";

// F-35 : en-têtes de sécurité. La CSP autorise les styles inline (Next.js),
// les scripts inline (bootstrap Next) et 'unsafe-eval' en dev uniquement
// (HMR). connect-src est étendu au hub temps réel public quand il est défini.
const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL;
const connectSrc = ["'self'", ...(socketUrl ? [socketUrl] : [])].join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // B3 : media-src blob: — les notes vocales se jouent depuis un Blob LOCAL
  // déchiffré (VoiceNote <audio src=objectURL>). Un blob est lié à son
  // origine : aucun chargement média distant n'est ouvert ('self' couvre le
  // reste). Le bug (lecture muette bloquée par la CSP) a été attrapé par la
  // preuve navigateur B3.
  "media-src 'self' blob:",
  `connect-src ${connectSrc}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // B3 : microphone=(self) — les notes vocales (VoiceRecorder) exigent
  // getUserMedia({audio}) SUR LA PAGE APP (même origine). Le durcissement
  // historique `microphone=()` interdisait AU NAVIGATEUR tout accès micro,
  // même consenti — impossible de désactiver par l'UI (header niveau
  // navigateur). B4 : camera=(self) — la vidéo (recorder + thumbnail) exige
  // getUserMedia({video}) : le fix est appliqué AVANT d'écrire le code
  // (directive B4 — le bug microphone=() de B3 ne se reproduira pas).
  // AUDIT EXHAUSTIF (spec MEDIA-ENVELOPE-SPEC §8.4, clarification direction
  // B4) : une directive ABSENTE retombe sur le défaut navigateur (autorisée)
  // — les 20 directives ci-dessous ferment les défauts permissifs
  // (usb/sensors/display-capture/clipboard/bluetooth…) et explicient les
  // usages V1 (camera, microphone, fullscreen). geolocation reste () : dette
  // « recherche proximité » tracée §8.4 (réviser LE JOUR de la feature).
  {
    key: "Permissions-Policy",
    value: [
      "camera=(self)",
      "microphone=(self)",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "accelerometer=()",
      "gyroscope=()",
      "magnetometer=()",
      "fullscreen=(self)",
      "display-capture=()",
      "autoplay=(self)",
      "clipboard-read=()",
      "clipboard-write=()",
      "screen-wake-lock=()",
      "idle-detection=()",
      "bluetooth=()",
      "serial=()",
      "midi=()",
      "nfc=()",
      "hid=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // B2 : les presigned URLs S3 sont MÊME ORIGINE (CSP connect-src 'self' et
  // pas de preflight CORS sur MinIO/SeaweedFS). Le serveur renvoie les URLs au
  // format /media-proxy/<bucket>/media/<uuid>?X-Amz-… (préfixe DÉDIÉ — ne
  // capte jamais /api/media/*), relayées AVEUGLEMENT par /api/media/proxy
  // (whitelist bucket + uuid v4, méthodes PUT/GET, validation SigV4 inchangée
  // — voir route proxy).
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/media-proxy/:bucket/media/:key*",
          destination: "/api/media/proxy/:bucket/media/:key*",
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
