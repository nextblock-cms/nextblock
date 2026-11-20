# syntax=docker/dockerfile:1.7
#
# Production image for a standalone NextBlock CMS project (single Next.js app, not a monorepo).
# Built with Next.js standalone output, gated on DOCKER_BUILD so a normal `npm run build` / a
# Vercel deploy is unaffected. Driven by docker-compose.yml (`npm run docker:setup`).

###############################################################################
# Stage 1 — deps
###############################################################################
FROM node:26-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json ./
RUN npm install --no-audit --no-fund

###############################################################################
# Stage 2 — builder (Next.js standalone output)
###############################################################################
FROM node:26-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=true \
    DOCKER_BUILD=true \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time. Server-only secrets are
# NOT baked in — they arrive at runtime from docker-compose.yml.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_URL
ARG NEXT_PUBLIC_R2_PUBLIC_URL
ARG NEXT_PUBLIC_R2_BASE_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_IS_SANDBOX
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_URL=$NEXT_PUBLIC_URL \
    NEXT_PUBLIC_R2_PUBLIC_URL=$NEXT_PUBLIC_R2_PUBLIC_URL \
    NEXT_PUBLIC_R2_BASE_URL=$NEXT_PUBLIC_R2_BASE_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_IS_SANDBOX=$NEXT_PUBLIC_IS_SANDBOX

RUN npm run build

###############################################################################
# Stage 3 — runner (hardened, non-root)
###############################################################################
FROM node:26-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat socat \
    && addgroup -g 1001 -S nodejs \
    && adduser -u 1001 -S nextjs -G nodejs
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # ipv4first so localhost resolves to the socat IPv4 listener; the larger header limit absorbs
    # Supabase auth cookies (on localhost they aren't port-scoped, so they pile onto every request).
    NODE_OPTIONS="--dns-result-order=ipv4first --max-http-header-size=65536"

# A single-app project traces to its own root, so server.js sits at the top of .next/standalone.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Loopback proxy: the browser-facing localhost URLs (Supabase :8000, MinIO :9000) are inlined into
# the build, but server-side code + next/image run INSIDE this container. Forward those ports to the
# compose services so SSR + image optimization work, and so the Supabase auth cookie key (derived
# from the URL host) matches between browser and server. Override targets with LOOPBACK_PROXIES.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  ': "${LOOPBACK_PROXIES:=8000:kong:8000 9000:minio:9000}"' \
  'for p in $LOOPBACK_PROXIES; do' \
  '  socat "TCP4-LISTEN:${p%%:*},fork,reuseaddr,bind=127.0.0.1" "TCP:${p#*:}" 2>/dev/null &' \
  'done' \
  'exec node "$(cat .server-entry 2>/dev/null || echo server.js)"' \
  > /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
