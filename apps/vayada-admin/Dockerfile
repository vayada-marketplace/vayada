# Monorepo-aware Dockerfile.
# Build context is the repo root (workflow sets context: .).
# Workspace package @vayada/hotel-setup-wizard is resolved from packages/.

# Stage 1: Builder
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY . .

RUN npm ci

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BOOKING_API_URL
ARG NEXT_PUBLIC_PMS_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_BOOKING_API_URL=${NEXT_PUBLIC_BOOKING_API_URL}
ENV NEXT_PUBLIC_PMS_URL=${NEXT_PUBLIC_PMS_URL}

WORKDIR /app/apps/vayada-admin
RUN npm run build

# Stage 2: Runner — Next.js standalone output
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/vayada-admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/vayada-admin/.next/static ./apps/vayada-admin/.next/static

USER nextjs

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/vayada-admin/server.js"]
