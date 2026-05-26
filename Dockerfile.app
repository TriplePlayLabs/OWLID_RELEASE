# Multi-stage build for OwlID Identity App (TanStack Start SSR via Nitro v2)

FROM oven/bun:1.3.14 AS builder
WORKDIR /app

# Node alongside Bun. `bun install` resolves the workspace (bun.lock,
# workspace:*); the `vite build` itself runs under Node because
# vite-plugin-top-level-await uses Node's `Module.prototype.require`,
# which Bun does not implement.
COPY --from=node:lts-slim /usr/local /usr/local

# Every workspace manifest — so `bun install` resolves the full monorepo
# dependency graph exactly as a local install does. The midnight stack
# pulls transitive peers (e.g. @midnight-ntwrk/wallet-sdk-*) that are
# only satisfied when every package's manifest is present.
COPY package.json bun.lock* bunfig.toml ./
COPY packages/app/package.json packages/app/
COPY packages/admin/package.json packages/admin/
COPY packages/verifier-app/package.json packages/verifier-app/
COPY packages/docs-site/package.json packages/docs-site/
COPY packages/midnight-sidecar/package.json packages/midnight-sidecar/
COPY packages/sdk/package.json packages/sdk/
COPY packages/verifier-client/package.json packages/verifier-client/
COPY packages/issuer-client/package.json packages/issuer-client/
COPY packages/admin-client/package.json packages/admin-client/
COPY packages/config/package.json packages/config/
COPY packages/ui/package.json packages/ui/

RUN bun install

# Source for the workspace packages the app actually builds against.
COPY packages/config packages/config
COPY packages/ui packages/ui
COPY packages/sdk packages/sdk
COPY packages/verifier-client packages/verifier-client
COPY packages/issuer-client packages/issuer-client
COPY packages/admin-client packages/admin-client
COPY packages/app packages/app

# Build-time env vars baked into the bundle. URL values can be overridden
# at runtime via OWLID_VERIFICATION_URL etc. (runtime-config.sh writes
# /config.js -> window.__OWLID_CONFIG__).
ARG VITE_ISSUER_URL=http://localhost:8001
ARG VITE_VERIFICATION_URL=http://localhost:8000
ENV VITE_ISSUER_URL=$VITE_ISSUER_URL
ENV VITE_VERIFICATION_URL=$VITE_VERIFICATION_URL

# TS workspace deps build under Bun (tsc). The app's vite build runs
# under Node — see the note on the node COPY above.
RUN cd packages/config && bun run build \
    && cd ../verifier-client && bun run build \
    && cd ../issuer-client && bun run build \
    && cd ../admin-client && bun run build \
    && cd ../sdk && bun run build
RUN cd packages/app && npx --no-install vite build

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
