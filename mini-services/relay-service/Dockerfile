# syntax=docker/dockerfile:1
FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install
COPY index.ts ./
EXPOSE 3030 3031
CMD ["bun", "index.ts"]
