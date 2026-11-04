# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# ↑ frontend BuildKit épinglé 2026-11-04 — vérifié via registry API (docker-content-digest)
# ============================================================
# Mbote Mesh — image unique, déployable sur n'importe quel VPS
# Build : bun (deps + next build en mode standalone)
# Run   : bun + prisma migrate deploy (F-36) au démarrage
#
# Supply chain (condition 6) : images de base ÉPINGLÉES PAR DIGEST.
# oven/bun:1 == sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
# (épinglé 2026-11-04 — vérifié via registry API)
# ============================================================

FROM oven/bun:1@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
# ↑ épinglé 2026-11-04 — vérifié via registry API
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
FROM oven/bun:1@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runner
# ↑ épinglé 2026-11-04 — vérifié via registry API
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

# Métadonnées OCI (traçabilité supply chain)
LABEL org.opencontainers.image.title="Mbote BitChat" \
      org.opencontainers.image.source="https://github.com/AlterEgo095/mbote-bitchat" \
      org.opencontainers.image.description="Messagerie offline-first (Next.js standalone + relay socket.io) — migrations Prisma appliquées au démarrage"

# TODO(F-supply-chain) : USER non-root volontairement NON ajouté pour l'instant.
# Raison : le volume /app/db est créé par root et appartient à root — passer à
# un utilisateur dédié rendrait la base SQLite illisible/immuable et casserait
# la prod (migrations Prisma + écritures au démarrage).
# Procédure future (release coordonnée, pas un hotfix) :
#   1. Ici : RUN adduser --system --uid 10001 mbote \
#        && chown -R mbote:mbote /app/db  puis  USER mbote
#   2. Sur le VPS : docker compose down && chown -R 10001:<gid> <volume hôte /app/db>
#        && docker compose up -d (migration des droits du volume existant)
#   3. Vérifier /api/stats en santé après déploiement avant de supprimer ce TODO.

RUN mkdir -p /app/db
VOLUME ["/app/db"]

EXPOSE 3000

# F-36 : migrations versionnées (jamais db push --accept-data-loss en prod),
# puis serveur Next standalone (server.js à la racine de /app)
CMD ["sh", "-c", "bunx prisma migrate deploy && exec bun server.js"]
