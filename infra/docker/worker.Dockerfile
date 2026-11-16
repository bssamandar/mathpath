# syntax=docker/dockerfile:1
# Production image for the worker (security plan C-37). Unlike the API it
# cannot be distroless: transcoding needs ffmpeg, so it uses Debian slim with
# only ffmpeg added, and runs as the unprivileged `node` user.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @mathpath/worker... build \
 && pnpm --filter @mathpath/worker deploy --prod --legacy /out \
 && cp -r config /out/config

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production CONFIG_DIR=/app/config
USER node
CMD ["node", "dist/main.js"]
