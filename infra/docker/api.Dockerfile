# syntax=docker/dockerfile:1
# Production image for the API (security plan C-37): multi-stage build,
# only runtime files in the final image, distroless base, non-root user.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @mathpath/api... build \
 && pnpm --filter @mathpath/api deploy --prod --legacy /out \
 && cp -r config /out/config

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production CONFIG_DIR=/app/config
EXPOSE 4000
USER nonroot
CMD ["dist/main.js"]
