FROM node:22-alpine AS build
WORKDIR /src
COPY packages/did-resolver packages/did-resolver
COPY packages/core packages/core
COPY packages/data packages/data
COPY packages/observability packages/observability
# The keeper's package-lock records @squaresdk/indexer as a file: link. It is a
# devDependency, used only by the anvil test, but npm resolves every link in the
# lockfile before it decides what to omit, so the directory has to be here.
COPY services/indexer services/indexer
COPY services/keeper services/keeper
RUN for p in packages/did-resolver packages/core packages/data packages/observability; do (cd $p && npm install --install-links --omit=dev --ignore-scripts && npm install --install-links --include=dev typescript && npm run build); done
# --omit=dev from the start rather than a prune at the end. `npm install
# --install-links` copies the file: dependencies in as real directories, and
# `npm prune --omit=dev` then deletes every one of them -- node_modules/@squaresdk
# comes out empty and the service cannot start. Installing production
# dependencies once, and adding only the compiler the build needs, avoids it.
RUN cd services/keeper \
    && npm install --install-links --omit=dev \
    && npm install --install-links --include=dev typescript \
    && npm run build \
    && rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

FROM node:22-alpine AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 square
WORKDIR /app
COPY --from=build --chown=square:nodejs /src/services/keeper/node_modules ./node_modules
COPY --from=build --chown=square:nodejs /src/services/keeper/dist ./dist
COPY --from=build --chown=square:nodejs /src/services/keeper/package.json ./package.json
USER square
EXPOSE 3011

# The service answers /health from @squaresdk/observability, which returns 503
# when a check marked critical fails -- for the keeper that is the database and
# the RPC endpoint. PORT moves the listener, so the check follows it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3011)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main.js"]
