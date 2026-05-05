#!/usr/bin/env bash
# T-013: Generate self-signed CA + service certificates for development mTLS
#
# Usage: ./scripts/generate-dev-certs.sh [output_dir]
#
# Generates:
#   ca.key, ca.pem              - Self-signed CA
#   verification-service.key    - Verification service private key
#   verification-service.pem    - Verification service certificate
#   issuer-service.key          - Issuer service private key
#   issuer-service.pem          - Issuer service certificate

set -euo pipefail

OUTPUT_DIR="${1:-./certs}"
mkdir -p "$OUTPUT_DIR"

echo "Generating development certificates in $OUTPUT_DIR..."

# Generate CA key and certificate
openssl req -x509 -newkey rsa:4096 -keyout "$OUTPUT_DIR/ca.key" -out "$OUTPUT_DIR/ca.pem" \
    -days 365 -nodes -subj "/CN=OwlID Dev CA/O=OwlID/C=NL" 2>/dev/null

echo "  CA certificate generated"

# Generate verification service cert
openssl req -newkey rsa:2048 -keyout "$OUTPUT_DIR/verification-service.key" \
    -out "$OUTPUT_DIR/verification-service.csr" -nodes \
    -subj "/CN=verification-service/O=OwlID/C=NL" 2>/dev/null

openssl x509 -req -in "$OUTPUT_DIR/verification-service.csr" \
    -CA "$OUTPUT_DIR/ca.pem" -CAkey "$OUTPUT_DIR/ca.key" -CAcreateserial \
    -out "$OUTPUT_DIR/verification-service.pem" -days 365 \
    -extfile <(printf "subjectAltName=DNS:localhost,DNS:verification-service,IP:127.0.0.1") 2>/dev/null

rm -f "$OUTPUT_DIR/verification-service.csr"
echo "  Verification service certificate generated"

# Generate issuer service cert
openssl req -newkey rsa:2048 -keyout "$OUTPUT_DIR/issuer-service.key" \
    -out "$OUTPUT_DIR/issuer-service.csr" -nodes \
    -subj "/CN=issuer-service/O=OwlID/C=NL" 2>/dev/null

openssl x509 -req -in "$OUTPUT_DIR/issuer-service.csr" \
    -CA "$OUTPUT_DIR/ca.pem" -CAkey "$OUTPUT_DIR/ca.key" -CAcreateserial \
    -out "$OUTPUT_DIR/issuer-service.pem" -days 365 \
    -extfile <(printf "subjectAltName=DNS:localhost,DNS:issuer-service,IP:127.0.0.1") 2>/dev/null

rm -f "$OUTPUT_DIR/issuer-service.csr" "$OUTPUT_DIR/ca.srl"
echo "  Issuer service certificate generated"

echo ""
echo "Development certificates generated successfully!"
echo ""
echo "To enable mTLS, set these environment variables:"
echo "  export TLS_ENABLED=true"
echo "  export TLS_CERT_PATH=$OUTPUT_DIR/verification-service.pem"
echo "  export TLS_KEY_PATH=$OUTPUT_DIR/verification-service.key"
echo "  export TLS_CA_CERT_PATH=$OUTPUT_DIR/ca.pem"
