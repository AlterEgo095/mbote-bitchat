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
EXPOSE 3030 3031
CMD ["bun", "index.ts"]
