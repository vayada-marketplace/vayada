# Stage 1: Dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

ARG NEXT_PUBLIC_AUTH_API_URL
ENV NEXT_PUBLIC_AUTH_API_URL=${NEXT_PUBLIC_AUTH_API_URL}

ARG NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED
ENV NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=${NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED}

RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./app/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./apps/affiliate-dashboard/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/public ./app/public
COPY --from=builder --chown=nextjs:nodejs /app/public ./apps/affiliate-dashboard/public

USER nextjs

EXPOSE 3005

ENV PORT=3005
ENV HOSTNAME="0.0.0.0"

CMD ["sh", "-c", "if [ -f server.js ]; then exec node server.js; fi; if [ -f app/server.js ]; then exec node app/server.js; fi; exec node apps/affiliate-dashboard/server.js"]
