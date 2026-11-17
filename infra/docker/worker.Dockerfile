# syntax=docker/dockerfile:1
# Production image for the worker (security plan C-37). Unlike the API it
# cannot be distroless: transcoding needs ffmpeg, so it uses Debian slim with
# only ffmpeg added, and runs as the unprivileged `node` user.

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @mathpath/worker... build \
 && pnpm --filter @mathpath/worker deploy --prod --legacy /out \
 && cp -r config /out/config

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# npm and corepack are not needed at runtime; removing them leaves less to
# patch. /work is ffmpeg's scratch space (a volume in production).
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && install -d -o node -g node /work
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production CONFIG_DIR=/app/config
USER node
CMD ["node", "dist/main.js"]
