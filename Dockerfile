# One image, two entry points. The api and the worker are the SAME build and
# differ only in the command, because they must never drift apart in dependency
# versions - but they run as separate processes, because the api process must
# never register a scheduler. See docs/ARCHITECTURE.md.

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json    packages/shared/
COPY packages/core/package.json      packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/triage/package.json    packages/triage/
COPY packages/api/package.json       packages/api/
COPY packages/worker/package.json    packages/worker/
COPY packages/web/package.json       packages/web/
RUN npm ci --include=dev

FROM deps AS build
COPY . .
RUN npm run build -w @campaign/web

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY . .

# Never run as root.
USER node

# dumb-init reaps zombies and forwards signals, so SIGTERM actually reaches the
# process and a worker gets the chance to finish the row it has claimed.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "tsx", "packages/api/src/index.ts"]
