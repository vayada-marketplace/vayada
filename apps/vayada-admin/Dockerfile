# Monorepo-aware Dockerfile.
# Build context is the repo root (workflow sets context: .).
# Workspace package @vayada/product-onboarding is resolved from packages/.

# Stage 1: Builder
FROM ghcr.io/vayada-marketplace/ci-node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY . .

RUN npm ci
RUN npm --workspace @vayada/domain-hotels run build

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_API_URL
ARG NEXT_PUBLIC_VAYADA_API_URL
ARG NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED
ARG NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED
ARG NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID
ARG NEXT_PUBLIC_BOOKING_URL_TEMPLATE
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_AUTH_API_URL=${NEXT_PUBLIC_AUTH_API_URL}
ENV NEXT_PUBLIC_VAYADA_API_URL=${NEXT_PUBLIC_VAYADA_API_URL}
ENV NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=${NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED}
ENV NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=${NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED}
ENV NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID=${NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID}
ENV NEXT_PUBLIC_BOOKING_URL_TEMPLATE=${NEXT_PUBLIC_BOOKING_URL_TEMPLATE}

WORKDIR /app/apps/vayada-admin
RUN npm run build

# Stage 2: Runner — Next.js standalone output
FROM ghcr.io/vayada-marketplace/ci-node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner
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
