# syntax=docker/dockerfile:1
# Production image for the API (security plan C-37): multi-stage build,
# only runtime files in the final image, distroless base, non-root user.

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @mathpath/api... build \
 && pnpm --filter @mathpath/api deploy --prod --legacy /out \
 && cp -r config /out/config

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:39c66687298417dbf3ff2fb8b6012c20554494e16414ef7afd07b9abbb45b501
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production CONFIG_DIR=/app/config
EXPOSE 4000
USER nonroot
CMD ["dist/main.js"]
