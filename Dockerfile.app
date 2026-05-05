# Multi-stage build for OwlID Identity App (static SPA)

FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace root
COPY package.json bun.lock* ./
COPY packages/app/package.json packages/app/
COPY packages/sdk/package.json packages/sdk/
COPY packages/native-sdk/package.json packages/native-sdk/

# Create stub npm dirs for workspace resolution (real binaries loaded at runtime in browser)
RUN mkdir -p packages/native-sdk/npm/wasm32-wasi packages/native-sdk/npm/linux-x64-gnu \
    && printf '{"name":"@owlid/native-sdk-wasm32-wasi","version":"1.0.0","main":"owl-id.wasi.cjs","browser":"owl-id.wasi-browser.js"}\n' > packages/native-sdk/npm/wasm32-wasi/package.json \
    && touch packages/native-sdk/npm/wasm32-wasi/owl-id.wasi.cjs packages/native-sdk/npm/wasm32-wasi/owl-id.wasi-browser.js \
    && printf '{"name":"@owlid/native-sdk-linux-x64-gnu","version":"1.0.0","main":"index.node"}\n' > packages/native-sdk/npm/linux-x64-gnu/package.json

RUN bun install

# Copy source
COPY packages/sdk packages/sdk
COPY packages/native-sdk packages/native-sdk
COPY packages/app packages/app

# Build args for frontend env vars (baked into static files)
ARG VITE_ISSUER_URL=http://localhost:8001
ARG VITE_VERIFICATION_URL=http://localhost:8000
ARG VITE_API_KEY=

ENV VITE_ISSUER_URL=$VITE_ISSUER_URL
ENV VITE_VERIFICATION_URL=$VITE_VERIFICATION_URL
ENV VITE_API_KEY=$VITE_API_KEY

# Build SDK first, then app
RUN cd packages/sdk && bun run build 2>&1 || true
RUN cd packages/app && bun run build

# Production: serve with nginx
FROM nginx:alpine
COPY --from=builder /app/packages/app/dist/client /usr/share/nginx/html
COPY docker/nginx-spa.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
