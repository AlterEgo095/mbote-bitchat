# syntax=docker/dockerfile:1
# ============================================================
# Mbote Mesh — image unique, déployable sur n'importe quel VPS
# Build : bun (deps + next build en mode standalone)
# Run   : bun + prisma migrate deploy (F-36) au démarrage
# ============================================================

FROM oven/bun:1 AS builder
WORKDIR /app

# dépendances (cache-friendly)
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# sources
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# F-09 : NEXT_PUBLIC_SOCKET_URL est inlinée dans le bundle client à la
# compilation. Vide en sandbox (mode passerelle Caddy XTransformPort),
# fournie par docker-compose (build.args) / CI en prod VPS.
ARG NEXT_PUBLIC_SOCKET_URL=""
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
RUN bun run db:generate && bun run build

# ------------------------------------------------------------
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/app/db/custom.db

# sortie standalone (serveur + modules tracés). server.js atterrit à la
# racine /app (COPY dest = ./). Les chunks clients et public ne font PAS
# partie de la sortie standalone : les copier explicitement (sinon 404 CSS/JS).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# CLI + client Prisma pour les migrations au démarrage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/db
VOLUME ["/app/db"]

EXPOSE 3000

# F-36 : migrations versionnées (jamais db push --accept-data-loss en prod),
# puis serveur Next standalone (server.js à la racine de /app)
CMD ["sh", "-c", "bunx prisma migrate deploy && exec bun server.js"]
