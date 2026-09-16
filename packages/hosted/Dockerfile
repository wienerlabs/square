# The hosted agent as an image (square#336): `square-hosted` with its
# configuration in SQUARE_HOSTED_CONFIG and its wallet in SQUARE_PRIVATE_KEY,
# serving the card at /.well-known/agent-registration.json and tasks at /a2a.
# Built from the repository root, like services/*/Dockerfile, because the
# package depends on its siblings by path; docs/deploy/railway.md runs it.
FROM node:22-alpine AS build
WORKDIR /src
COPY packages/did-resolver packages/did-resolver
COPY packages/core packages/core
COPY packages/data packages/data
COPY packages/a2a packages/a2a
COPY packages/policy packages/policy
COPY packages/x402 packages/x402
COPY packages/agent packages/agent
COPY packages/mcp packages/mcp
COPY packages/hosted packages/hosted
# Dependency order; each package's file: links are resolved by the install
# that follows it. --omit=dev from the start and typescript added on its own,
# for the reason services/keeper/Dockerfile gives: a prune afterwards deletes
# the linked packages with the dev dependencies.
RUN for p in packages/did-resolver packages/core packages/data packages/a2a packages/policy packages/x402 packages/agent packages/mcp; do \
      (cd $p && npm install --install-links --omit=dev --ignore-scripts \
        && npm install --install-links --include=dev typescript \
        && npm run build); \
    done
RUN cd packages/hosted \
    && npm install --install-links --omit=dev \
    && npm install --install-links --include=dev typescript \
    && npm run build \
    && rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

FROM node:22-alpine AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 square
WORKDIR /app
COPY --from=build --chown=square:nodejs /src/packages/hosted/node_modules ./node_modules
COPY --from=build --chown=square:nodejs /src/packages/hosted/dist ./dist
COPY --from=build --chown=square:nodejs /src/packages/hosted/package.json ./package.json
# A compliance block's duty state is written beside the working directory's
# policy file; the directory is the agent's, so it can.
RUN mkdir -p /app/state && chown square:nodejs /app/state
WORKDIR /app/state
USER square
EXPOSE 3000

# The card is served once the agent is up and its chain answered; a container
# that never gets there is unhealthy. PORT moves the listener, so the check follows it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/.well-known/agent-registration.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# No path: the configuration comes from SQUARE_HOSTED_CONFIG. Mount a file and
# pass its path to run from one instead.
CMD ["node", "/app/dist/bin.js"]
