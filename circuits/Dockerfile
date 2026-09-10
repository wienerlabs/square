# Builds the circuit artifacts the prover needs: payment.wasm and payment.zkey.
#
# They are not in the repository -- the zkey is gitignored and the 5 MB wasm is
# generated -- so something has to produce them before the prover can answer a
# request. Doing it here means `docker compose up` needs nothing on the host but
# Docker: no Rust toolchain, no circom, no snarkjs.
#
# The image is linux/amd64 because that is the only Linux binary iden3 publishes
# for circom 2.2.3. On an arm64 host it runs under emulation, which costs about
# 40 seconds for the whole build (measured on Apple Silicon, Docker 29.1.3) and
# then never runs again: the result is cached as an image layer.
#
# The key this produces is a DEVELOPMENT key. Phase 1 is the adopted Perpetual
# Powers of Tau contribution 80, hash-checked by scripts/fetch-ptau.mjs; phase 2
# is a single unattested contribution, and square#16 is what replaces it. See
# docs/disclosure/zk-setup-status.md.
FROM --platform=linux/amd64 node:22-bookworm-slim AS build

ARG CIRCOM_VERSION=v2.2.3
# sha256 of circom-linux-amd64 for the version above, taken from the release
# asset on 2026-09-09. A mismatch stops the build rather than proving with a
# compiler nobody checked.
ARG CIRCOM_SHA256=85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /usr/local/bin/circom \
      "https://github.com/iden3/circom/releases/download/${CIRCOM_VERSION}/circom-linux-amd64" \
    && echo "${CIRCOM_SHA256}  /usr/local/bin/circom" | sha256sum -c - \
    && chmod +x /usr/local/bin/circom \
    && circom --version

WORKDIR /circuits
COPY circuits/package.json circuits/package-lock.json* ./
RUN npm ci --silent

COPY circuits/ ./
RUN npm run build

# The stage that ships: the two artifacts and nothing that made them.
FROM --platform=linux/amd64 node:22-bookworm-slim
WORKDIR /artifacts-src
COPY --from=build /circuits/build/payment.zkey ./payment.zkey
COPY --from=build /circuits/build/payment_js/payment.wasm ./payment.wasm
COPY --from=build /circuits/build/payment_vk.json ./payment_vk.json

# Publishing into the shared volume is the whole job; compose waits for the
# exit code, so a failed copy stops the prover from starting on stale files.
CMD ["sh", "-c", "set -e; cp payment.zkey payment.wasm payment_vk.json /artifacts/; ls -l /artifacts"]
