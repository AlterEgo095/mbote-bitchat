# syntax=docker/dockerfile:1
# ============================================================
# Mbote Mesh — image unique, déployable sur n'importe quel VPS
# Build : bun (deps + next build en mode standalone)
# Run   : bun + prisma db push automatique au démarrage
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
RUN bun run db:generate && bun run build

# ------------------------------------------------------------
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/app/db/custom.db

# sortie standalone (serveur + modules tracés + static + public)
COPY --from=builder /app/.next/standalone ./
# CLI + client Prisma pour le `db push` au démarrage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/db
VOLUME ["/app/db"]

EXPOSE 3000

# schéma synchronisé, puis serveur Next standalone
CMD ["sh", "-c", "bunx prisma db push --skip-generate && exec bun .next/standalone/server.js"]
