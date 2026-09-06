# did:aip v2 driver for the DIF Universal Resolver.
#
# Build context is packages/, not this directory: the driver depends on
# ../did-resolver by path and Docker cannot reach outside its context.
#
#   docker build -f did-aip-driver/Dockerfile -t driver-did-aip .
#
# Two things here are load-bearing and easy to get wrong:
#
#   * The resolver is built from source in the builder. Its dist/ is gitignored,
#     so a clean checkout does not have one, and a `file:` dependency that
#     resolves to a package with no build output installs fine and fails at
#     import time.
#
#   * `npm install --install-links` COPIES file: dependencies instead of
#     symlinking them. Without it node_modules/@squaresdk/did-resolver is a
#     symlink out of /app, the runtime stage copies only /app, and the container
#     dies with ERR_MODULE_NOT_FOUND on first request. The image builds and the
#     health check never comes up.

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /build

# Build the resolver first: the driver's file: dependency needs its dist/.
COPY did-resolver/package.json did-resolver/package-lock.json* ./did-resolver/
RUN cd did-resolver && npm ci --ignore-scripts
COPY did-resolver/tsconfig.json did-resolver/tsconfig.build.json ./did-resolver/
COPY did-resolver/src ./did-resolver/src
RUN cd did-resolver && npm run build && npm prune --omit=dev --ignore-scripts

WORKDIR /build/driver
COPY did-aip-driver/package.json ./
# --install-links copies the resolver in rather than symlinking to it.
RUN npm install --ignore-scripts --install-links
COPY did-aip-driver/tsconfig.json did-aip-driver/tsconfig.build.json ./
COPY did-aip-driver/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --install-links

# ---- runtime ----
FROM node:20-alpine AS runtime

# Without image.source the package page on GitHub shows no link back to the
# code and no README. That page is the first thing a Universal Resolver
# reviewer opens, so an image with no route to its source is a weaker
# submission than it needs to be. The link 404s for anyone outside the org
# while the repository is private, and starts working by itself the moment it
# is not; pointing it somewhere else in the meantime would just be wrong twice.
LABEL org.opencontainers.image.source="https://github.com/wienerlabs/square" \
      org.opencontainers.image.description="DIF Universal Resolver driver for did:aip v2" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
ENV NODE_ENV=production \
    DRIVER_PORT=8080 \
    RPC_5042002=https://rpc.testnet.arc.io
COPY --from=builder --chown=node:node /build/driver/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/driver/dist ./dist
COPY --chown=node:node did-aip-driver/package.json ./
EXPOSE 8080
USER node
# Node core http — alpine has no curl or wget, and this needs no dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.DRIVER_PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/server.js"]
