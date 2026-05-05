# Multi-stage Docker build for OwlID Verification Service

# Stage 1: Builder
FROM rust:1.91-slim as builder

WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace files
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

# Build the verification service in release mode
RUN cargo build --release -p owl-verification-service

# Stage 2: Runtime
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy the binary from builder
COPY --from=builder /app/target/release/owl-verification-service /app/owl-verification-service

# Expose port
EXPOSE 3000

# Set environment variables
ENV RUST_LOG=info

# Run the service
CMD ["/app/owl-verification-service"]
