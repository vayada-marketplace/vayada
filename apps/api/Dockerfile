# syntax=ghcr.io/vayada-marketplace/ci-dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM ghcr.io/vayada-marketplace/ci-node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build

ENV HUSKY=0

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
RUN npm --workspace vayada-api run build
RUN npm --workspace @vayada/backend-migration run build
RUN npm prune --omit=dev
COPY engineering/fixtures/c1-staging-rehearsal-replay ./engineering/fixtures/c1-staging-rehearsal-replay
COPY scripts/c1-rehearsal-replay-fixtures.mjs ./scripts/c1-rehearsal-replay-fixtures.mjs
COPY scripts/start-next-api.sh ./scripts/start-next-api.sh

FROM ghcr.io/vayada-marketplace/ci-node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime

ARG API_RUNTIME=
ARG APPLICATION_RELEASE=unversioned

ENV NODE_ENV=production
ENV API_RUNTIME=${API_RUNTIME}
ENV APPLICATION_RELEASE=${APPLICATION_RELEASE}
ENV HOST=0.0.0.0
ENV PORT=8003

LABEL org.opencontainers.image.revision=${APPLICATION_RELEASE}

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/engineering/fixtures/c1-staging-rehearsal-replay ./engineering/fixtures/c1-staging-rehearsal-replay
COPY --from=build /app/scripts/c1-rehearsal-replay-fixtures.mjs ./scripts/c1-rehearsal-replay-fixtures.mjs
COPY --from=build /app/scripts/start-next-api.sh ./scripts/start-next-api.sh
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
RUN cd apps/api && node --input-type=module --eval "await import('./dist/domains/financeFolioKms.js')"

EXPOSE 8003

CMD ["./scripts/start-next-api.sh"]
