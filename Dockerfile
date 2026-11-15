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

# ── D3 (supply chain 2026-11-13) : durcissement runtime — USER NON-ROOT ────
# UID/GID NUMÉRIQUES 10001:10001 (déploiement 2026-11-15) : la base oven/bun:1
# épinglée (Debian 13 slim) ne contient NI addgroup NI adduser (paquet adduser
# absent des slim variants — échec de build exit 127 au premier déploiement de
# cette image). Le durcissement non-root est conservé à l'identique via
# UID/GID numériques, indépendants de la distro.
# Procédure documentée :
#   1. Ici : /app/db chowné 10001:10001 (le volume Nommé Docker est
#      initialisé AVEC les droits de l'image au premier montage) ;
#   2. Sur le VPS (volume EXISTANT) : chown -R 10001:10001 <chemin du volume
#      mbote-data> AVANT le premier déploiement de cette image (exécuté
#      2026-11-15 — docs/DOCKER-HARDENING.md §procédure VPS) ;
#   3. Vérifier /api/stats en santé après déploiement.
RUN mkdir -p /app/db && chown -R 10001:10001 /app/db
# HOME/BUN_INSTALL dans /tmp (tmpfs read-only-compose) : bunx prisma ne doit
# JAMAIS tenter d'écrire dans un HOME root — toute écriture éphémère part en
# tmpfs, la base seule est persistée dans /app/db.
ENV HOME=/tmp \
    BUN_INSTALL=/tmp/.bun
USER 10001:10001

VOLUME ["/app/db"]

EXPOSE 3000

# F-36 : migrations versionnées (jamais db push --accept-data-loss en prod),
# puis serveur Next standalone (server.js à la racine de /app)
CMD ["sh", "-c", "bunx prisma migrate deploy && exec bun server.js"]
