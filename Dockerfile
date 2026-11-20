# syntax=docker/dockerfile:1.7
#
# Multi-stage production image for the NextBlock CMS app (apps/nextblock) built out of the Nx
# monorepo with Next.js standalone output. Used by docker-compose.yml (`npm run docker:setup`).
# Vercel/cloud builds never see this file; output:'standalone' is gated on DOCKER_BUILD.

###############################################################################
# Stage 1 — deps: install workspace dependencies in a cache-friendly layer.
###############################################################################
FROM node:26-alpine AS deps
WORKDIR /workspace
RUN apk add --no-cache libc6-compat
# Copy only the manifests first so this layer is reused until dependencies change.
COPY package.json package-lock.json ./
# Prefer a reproducible `npm ci`, but fall back to `npm install` when the lockfile has drifted
# (common during active development) so the local sandbox image still builds.
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

###############################################################################
# Stage 2 — builder: compile the Next.js app into a standalone server tree.
###############################################################################
FROM node:26-alpine AS builder
WORKDIR /workspace
RUN apk add --no-cache libc6-compat
ENV NEXT_TELEMETRY_DISABLED=1 \
    NX_DAEMON=false \
    NX_CLOUD_DISTRIBUTED_EXECUTION=false \
    CI=true \
    DOCKER_BUILD=true \
    NODE_ENV=production

COPY --from=deps /workspace/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they must be present
# now (docker compose passes them from the generated .env). Server-only secrets are NOT baked in.
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

RUN npx nx build nextblock --skip-nx-cache

# Assemble a minimal runtime tree at /runtime. With output:'standalone', Next emits a pruned
# node_modules + a server.js that, in a monorepo, nests under the app's path (apps/nextblock).
# .next/static and public are NOT traced, so copy them in beside server.js. We DETECT the server
# location instead of assuming it, so the image is robust to Next/Nx layout changes; the resolved
# entry path is written to /runtime/.server-entry for the runtime CMD.
RUN set -eux; \
    if [ -d "dist/apps/nextblock/.next/standalone" ]; then BUILT="dist/apps/nextblock"; \
    elif [ -d "apps/nextblock/.next/standalone" ]; then BUILT="apps/nextblock"; \
    else echo "standalone output not found; standalone dirs present:"; find . -type d -name standalone -not -path '*/node_modules/*'; exit 1; fi; \
    STD="$BUILT/.next/standalone"; \
    REL="$(cd "$STD" && find . -maxdepth 4 -name server.js -not -path './node_modules/*' | head -n1 | sed 's|^\./||; s|/server.js$||; s|^server.js$||')"; \
    mkdir -p /runtime; cp -r "$STD"/. /runtime/; \
    TARGET="/runtime"; [ -n "$REL" ] && TARGET="/runtime/$REL"; \
    mkdir -p "$TARGET/.next"; \
    cp -r "$BUILT/.next/static" "$TARGET/.next/static"; \
    if [ -d "$BUILT/public" ]; then cp -r "$BUILT/public" "$TARGET/public"; \
    elif [ -d apps/nextblock/public ]; then cp -r apps/nextblock/public "$TARGET/public"; fi; \
    if [ -n "$REL" ]; then echo "$REL/server.js" > /runtime/.server-entry; else echo "server.js" > /runtime/.server-entry; fi; \
    echo "resolved server entry: $(cat /runtime/.server-entry)"

###############################################################################
# Stage 3 — runner: hardened, non-root, just the standalone server.
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

COPY --from=builder --chown=nextjs:nodejs /runtime ./

# Loopback proxy: in Docker the browser-facing localhost URLs (Supabase :8000 and MinIO :9000) get
# inlined into the build, but server-side code + next/image run INSIDE this container where localhost
# has nothing. Forward those ports to the compose services so SSR and image optimization work — and
# so the Supabase auth cookie key (derived from the URL host) stays identical on browser and server,
# which is what keeps the session readable server-side. Override targets with LOOPBACK_PROXIES.
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
# Starts the loopback proxies, then the standalone server (.server-entry = apps/nextblock/server.js).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
