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
# and payment.wasm is generated — so they are mounted rather than copied in.
# compose.yaml fills the volume from circuits/Dockerfile, which compiles the
# circuit and produces the key; anything else that mounts a directory holding
# payment.wasm and payment.zkey works the same way.
ENV PROVER_ARTIFACTS_DIR=/artifacts
VOLUME ["/artifacts"]

USER prover
EXPOSE 3003

# /health checks that the artifacts above are readable, so an empty or unmounted
# /artifacts shows up as an unhealthy container rather than as a failed proof on
# the first request.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PROVER_SERVICE_PORT||3003)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/index.js"]
