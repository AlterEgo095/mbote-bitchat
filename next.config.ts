import type { NextConfig } from "next";

// F-21 : reactStrictMode réactivé (double montage volontaire — révèle les
// effets non idempotents) ; `typescript.ignoreBuildErrors` supprimé : le
// build échoue désormais sur toute erreur TS (tsc doit rester vert).

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
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
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
