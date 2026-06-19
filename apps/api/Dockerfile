# syntax=docker/dockerfile:1

FROM node:24-slim AS build

ENV HUSKY=0

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
RUN npm --workspace vayada-api run build
RUN npm --workspace @vayada/backend-migration run build
RUN npm prune --omit=dev

FROM node:24-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8003

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

EXPOSE 8003

CMD ["npm", "--workspace", "vayada-api", "run", "start"]
