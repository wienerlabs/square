FROM node:22-alpine AS build
WORKDIR /src
COPY packages/did-resolver packages/did-resolver
COPY packages/core packages/core
COPY packages/data packages/data
COPY packages/observability packages/observability
COPY packages/hardening packages/hardening
COPY services/screener services/screener
RUN for p in packages/did-resolver packages/core packages/data packages/observability packages/hardening; do (cd $p && npm install --install-links --omit=dev --ignore-scripts && npm install --install-links --include=dev typescript && npm run build); done
RUN cd services/screener \
    && npm install --install-links --omit=dev \
    && npm install --install-links --include=dev typescript \
    && npm run build \
    && rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

FROM node:22-alpine AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 square
WORKDIR /app
COPY --from=build --chown=square:nodejs /src/services/screener/node_modules ./node_modules
COPY --from=build --chown=square:nodejs /src/services/screener/dist ./dist
COPY --from=build --chown=square:nodejs /src/services/screener/package.json ./package.json
USER square
EXPOSE 3012

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3012)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main.js"]
