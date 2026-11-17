# syntax=docker/dockerfile:1
# Production image for the Next.js apps (web or studio), security plan C-37.
#
#   docker build -f infra/docker/next.Dockerfile --build-arg APP=web .
#   docker build -f infra/docker/next.Dockerfile --build-arg APP=studio .
#
# Next.js traces the files the server needs into .next/standalone, so the
# final image holds that server, the static assets and Node.js only:
# distroless, no shell, non-root. One Dockerfile for both apps, because they
# are built the same way (ADR-0009).

ARG APP=web

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ARG APP
# Public site key, inlined into the browser bundle at build time (not a secret).
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
WORKDIR /repo
RUN corepack enable
COPY . .
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY}
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@mathpath/${APP}..." build \
 && mkdir /out \
 && cp -r "apps/${APP}/.next/standalone/." /out/ \
 && cp -r "apps/${APP}/.next/static" "/out/apps/${APP}/.next/static"

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
ARG APP
# Files stay owned by root, so the app cannot change its own code. Next.js
# writes only to .next/cache, which compose mounts as a tmpfs.
COPY --from=build /out /app
WORKDIR /app/apps/${APP}
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
USER nonroot
CMD ["server.js"]
