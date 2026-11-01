# Monorepo-aware Dockerfile.
# The base image is our public GHCR copy of node:24-alpine, pinned to the upstream index digest
# (vayada-platform "Mirror CI images", VAY-2265): anonymous ECR Public pulls hit "toomanyrequests".
# Build context is the repo root (workflow sets context: .).

# Stage 1: Builder
FROM ghcr.io/vayada-marketplace/ci-node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY . .

RUN npm ci

WORKDIR /app/apps/hotel-sites
RUN npm run build

# Stage 2: Runner — Next.js standalone output
FROM ghcr.io/vayada-marketplace/ci-node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/hotel-sites/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/hotel-sites/.next/static ./apps/hotel-sites/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/hotel-sites/server.js"]
