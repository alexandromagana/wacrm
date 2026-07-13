# syntax=docker/dockerfile:1

# ============================================================
# wacrm — production image for EasyPanel (Next.js 16 standalone)
# ============================================================
# Multi-stage build:
#   1. deps    — install node_modules from the lockfile (cached layer)
#   2. builder — `next build` → self-contained .next/standalone
#   3. runner  — minimal runtime, non-root, just the standalone output
#
# The engines field pins Node >=20; we use the current 22-LTS alpine.
ARG NODE_VERSION=22-alpine

# ------------------------------------------------------------
# 1. Dependencies
# ------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
# libc6-compat: some native deps (and Next's SWC binary) expect glibc
# symbols on Alpine's musl. Cheap insurance against "cannot find module".
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install against the committed lockfile only — reproducible, cache-friendly.
COPY package.json package-lock.json ./
RUN npm ci

# ------------------------------------------------------------
# 2. Builder
# ------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# --- Public build-time config -------------------------------------------
# NEXT_PUBLIC_* values are inlined into the client bundle during
# `next build`, so they MUST be present here (not just at runtime).
# In EasyPanel set these under "Build" → Build Args. They are public
# by design (anon key, canonical URL) — no secrets belong in this list.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE

# Skip telemetry, build to .next/standalone (output: "standalone").
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ------------------------------------------------------------
# 3. Runner
# ------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# The standalone server bundles its own trimmed node_modules and server.js.
# `public` and `.next/static` are NOT copied by standalone automatically —
# copy them in so server.js can serve assets without a separate CDN.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# server.js honours PORT / HOSTNAME (set above) and listens on 0.0.0.0
# so EasyPanel's proxy can reach the container.
CMD ["node", "server.js"]
