# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# ============================================================
# mbote-admin — image du panneau d'administration (3e service compose)
# Miroir du Dockerfile principal (supply chain identique : oven/bun épinglé
# par digest, build standalone), SANS prisma ni DB : l'app admin ne touche
# jamais la base (docs/specs/ADMIN-RBAC.md §1 — invariant vérifiable ici :
# aucune étape ne copie prisma/, aucun migrate au démarrage).
# ============================================================

FROM oven/bun:1@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
# ↑ épinglé 2026-11-04 — vérifié via registry API (même digest que l'app principale)
WORKDIR /app

# dépendances (cache-friendly)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# sources (le contexte est ./admin — voir docker-compose.yml)
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ------------------------------------------------------------
FROM oven/bun:1@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runner
# ↑ épinglé 2026-11-04 — vérifié via registry API
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0

# sortie standalone (serveur + modules tracés) — pas de node_modules complet :
# aucune dépendance runtime au-delà du serveur standalone lui-même.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

LABEL org.opencontainers.image.title="Mbote Admin" \
      org.opencontainers.image.source="https://github.com/AlterEgo095/mbote-bitchat" \
      org.opencontainers.image.description="Panneau d'administration Mbote Mesh — BFF sans état, zéro accès DB direct"

EXPOSE 3001

CMD ["bun", "server.js"]
