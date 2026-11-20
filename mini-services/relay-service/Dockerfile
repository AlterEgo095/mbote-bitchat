# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# ↑ frontend BuildKit épinglé 2026-11-04 — vérifié via registry API (docker-content-digest)
# Épinglage par digest (condition 6 : build reproductible) :
# oven/bun:1 == sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
# (épinglé 2026-11-04 — vérifié via registry API)
FROM oven/bun:1@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
WORKDIR /app
# bun.lock copié + --frozen-lockfile (condition 6) : le lockfile existait déjà
# dans le dépôt mais `bun install` seul l'IGNORAIT → versions résolues à la
# volée, build non reproductible. Désormais l'image n'installe que les
# versions verrouillées (échec explicite si package.json et bun.lock divergent).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY hub.ts ./
COPY index.ts ./
# D3 — durcissement : utilisateur non-root (relay sans état : aucune écriture
# disque — /tmp tmpfs suffit pour les éphémères).
# USER NUMÉRIQUE 10002:10002 (déploiement 2026-11-15) : la base oven/bun:1
# épinglée (Debian 13 slim) ne contient NI addgroup NI adduser (paquet adduser
# absent des slim variants — échec de build exit 127 au premier déploiement de
# cette image). Un UID/GID numérique fournit le même durcissement non-root,
# indépendant de la distro — préférence documentée si la base change.
ENV HOME=/tmp BUN_INSTALL=/tmp/.bun
USER 10002:10002

EXPOSE 3030 3031

# DS-0026 (security.yml Trivy, audit 2026-11 §4.9) : HEALTHCHECK au niveau
# image — le compose définit un healthcheck (identique ici) qui PRÉVAUT à
# l'exécution ; celui-ci sert de garde-fou hors compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "await fetch('http://127.0.0.1:3031/health').then(r => { if (!r.ok) throw new Error('unhealthy: ' + r.status); })"

CMD ["bun", "index.ts"]
