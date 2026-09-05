FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY services/prover/package.json services/prover/package-lock.json* ./
RUN npm install --omit=dev

FROM base AS runner
ENV NODE_ENV=production
ENV PROVER_SERVICE_PORT=3003

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 prover

COPY --from=deps --chown=prover:nodejs /app/node_modules ./node_modules
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
