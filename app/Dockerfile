# next.config.ts sets output: "export", so the application is a static bundle.
# This builds it and puts a file server in front of it -- no Node process runs
# in the shipped image, which is also how it is served in production.
#
# NEXT_PUBLIC_ values are read by the browser and are therefore baked in at
# build time. They are endpoints, not addresses: the contract addresses come
# from @squaresdk/core, which is the one place they are declared.
FROM node:22-alpine AS build
WORKDIR /src

COPY packages/did-resolver packages/did-resolver
COPY packages/core packages/core
RUN for p in packages/did-resolver packages/core; do \
      (cd $p && npm install --install-links --omit=dev --ignore-scripts \
        && npm install --install-links --include=dev typescript \
        && npm run build); \
    done

COPY app app
WORKDIR /src/app
# bufferutil and utf-8-validate are ws's native accelerators, reached through a
# wallet connector rather than through an optional dependency, so --omit does
# not skip them and node-gyp has to be able to build them. The toolchain is in
# this stage only; the image that ships is nginx with static files in it.
RUN apk add --no-cache python3 make g++ \
    && npm install --install-links \
    && apk del make g++

ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_INDEXER_URL
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
    NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM nginx:1.27-alpine
# trailingSlash is on, so every route is a directory with an index.html in it
# and nginx's default configuration already serves them.
COPY --from=build /src/app/out /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
