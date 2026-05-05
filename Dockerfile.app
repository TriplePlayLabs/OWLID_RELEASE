# Multi-stage build for OwlID Identity App (TanStack Start SSR via Nitro v2)
#
# NATIVE_SDK_IMAGE points at a pre-built native-sdk-builder image
# (see Dockerfile.native-sdk-builder). Override at build time:
#   --build-arg NATIVE_SDK_IMAGE=europe-west1-docker.pkg.dev/.../native-sdk-builder:<sha>

ARG NATIVE_SDK_IMAGE=europe-west1-docker.pkg.dev/owlid-491411/owlid/native-sdk-builder:latest
FROM ${NATIVE_SDK_IMAGE} AS native-sdk

FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/app/package.json packages/app/
COPY packages/sdk/package.json packages/sdk/
COPY packages/verifier-client/package.json packages/verifier-client/
COPY packages/issuer-client/package.json packages/issuer-client/
COPY packages/admin-client/package.json packages/admin-client/
COPY packages/native-sdk/package.json packages/native-sdk/
COPY packages/config/package.json packages/config/
COPY packages/ui/package.json packages/ui/

# Pre-built native-sdk artifacts (WASM + .node + JS bindings) from the
# native-sdk-builder image — brings the WASM file the SPA needs into the
# workspace before bun install resolves it.
COPY --from=native-sdk /native-sdk packages/native-sdk

RUN bun install

# Source for the rest of the workspace.
COPY packages/config packages/config
COPY packages/ui packages/ui
COPY packages/sdk packages/sdk
COPY packages/verifier-client packages/verifier-client
COPY packages/issuer-client packages/issuer-client
COPY packages/admin-client packages/admin-client
COPY packages/app packages/app

# Build-time env vars baked into the bundle. URL values can be overridden
# at runtime via OWLID_VERIFICATION_URL etc. (runtime-config.sh writes
# /config.js → window.__OWLID_CONFIG__).
ARG VITE_ISSUER_URL=http://localhost:8001
ARG VITE_VERIFICATION_URL=http://localhost:8000
ENV VITE_ISSUER_URL=$VITE_ISSUER_URL
ENV VITE_VERIFICATION_URL=$VITE_VERIFICATION_URL

# Build TS workspace deps in dependency order, then the app itself.
RUN cd packages/config && bun run build \
    && cd ../verifier-client && bun run build \
    && cd ../issuer-client && bun run build \
    && cd ../admin-client && bun run build \
    && cd ../sdk && bun run build
RUN cd packages/app && bun run build

# Production: TanStack Start Nitro server under Node.
#
# Node is used (not Bun) because react-dom's exports map resolves "bun"
# condition to ./server.bun.js, but Nitro only vendors ./server.node.js into
# .output/server/node_modules. Node's resolver picks server.node.js — works.
FROM node:lts-slim
WORKDIR /app

COPY --from=builder /app/packages/app/.output /app/.output
COPY docker/runtime-config.sh /usr/local/bin/runtime-config.sh
RUN chmod +x /usr/local/bin/runtime-config.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV OWLID_CONFIG_PATH=/app/.output/public/config.js
EXPOSE 3000

# Generate /config.js from runtime env on each cold start, then exec Nitro.
ENTRYPOINT ["/usr/local/bin/runtime-config.sh"]
CMD ["node", ".output/server/index.mjs"]
