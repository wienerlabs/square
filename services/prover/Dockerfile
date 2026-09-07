FROM node:22-alpine AS build
WORKDIR /src
COPY packages/observability packages/observability
COPY services/prover services/prover
RUN cd packages/observability && npm install --ignore-scripts && npm run build && npm prune --omit=dev
RUN cd services/prover && npm install --omit=dev --install-links

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PROVER_SERVICE_PORT=3003

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 prover

WORKDIR /app
COPY --from=build --chown=prover:nodejs /src/services/prover/node_modules ./node_modules
COPY --chown=prover:nodejs services/prover/src ./src
COPY --chown=prover:nodejs services/prover/package.json ./package.json

# The circuit artifacts are not in the repository — payment.zkey is gitignored
# and payment.wasm is generated. Mount them at run time, or add a build stage
# that compiles the circuit, and point PROVER_ARTIFACTS_DIR at the result.
ENV PROVER_ARTIFACTS_DIR=/artifacts
VOLUME ["/artifacts"]

USER prover
EXPOSE 3003

CMD ["node", "src/index.js"]
