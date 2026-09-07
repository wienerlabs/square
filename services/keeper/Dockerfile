FROM node:22-alpine AS build
WORKDIR /src
COPY packages/did-resolver packages/did-resolver
COPY packages/core packages/core
COPY packages/data packages/data
COPY packages/observability packages/observability
COPY services/keeper services/keeper
RUN for p in packages/did-resolver packages/core packages/data packages/observability; do (cd $p && npm install --install-links --omit=dev --ignore-scripts && npm install --install-links --include=dev typescript && npm run build); done
RUN cd services/keeper && npm install --install-links && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 square
WORKDIR /app
COPY --from=build --chown=square:nodejs /src/services/keeper/node_modules ./node_modules
COPY --from=build --chown=square:nodejs /src/services/keeper/dist ./dist
COPY --from=build --chown=square:nodejs /src/services/keeper/package.json ./package.json
USER square
CMD ["node", "dist/main.js"]
