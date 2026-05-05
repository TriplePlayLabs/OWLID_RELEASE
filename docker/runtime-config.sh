#!/bin/sh
# Generate /config.js with runtime values from env vars.
#
# Run this as the container entrypoint BEFORE the static file server starts.
# It writes a small JS file that sets `window.__OWLID_CONFIG__`, which the SDK
# reads at runtime to override the build-time VITE_* defaults baked into the
# bundle. Lets one Docker image serve any deployment.
#
# Recognized env vars (any may be empty / unset; the SDK falls back to its
# own VITE_* build-time defaults, then to its hardcoded localhost defaults):
#   OWLID_VERIFICATION_URL  (or VITE_VERIFICATION_URL)
#   OWLID_ISSUER_URL        (or VITE_ISSUER_URL)
#   OWLID_API_KEY           (or VITE_API_KEY)
#   OWLID_WS_BASE_URL       (or VITE_WS_BASE_URL)
#
# Output path defaults to /usr/share/nginx/html/config.js. Override with
# OWLID_CONFIG_PATH if your image serves from a different directory.
set -eu

OUT="${OWLID_CONFIG_PATH:-/usr/share/nginx/html/config.js}"

VERIFY_URL="${OWLID_VERIFICATION_URL:-${VITE_VERIFICATION_URL:-}}"
ISSUER_URL="${OWLID_ISSUER_URL:-${VITE_ISSUER_URL:-}}"
API_KEY="${OWLID_API_KEY:-${VITE_API_KEY:-}}"
WS_BASE_URL="${OWLID_WS_BASE_URL:-${VITE_WS_BASE_URL:-}}"

# JSON-escape: backslash, double-quote, control chars. Bare URLs are safe but
# guard anyway so a stray quote in env doesn't break the script.
escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/$/\\n/' | tr -d '\n' | sed 's/\\n$//'
}

# Write to a temp file in the same directory, then atomic-rename. This
# guarantees nginx never serves a half-written /config.js if the writer is
# killed mid-flight.
TMP="${OUT}.tmp.$$"
trap 'rm -f "$TMP"' EXIT INT TERM

cat > "$TMP" <<EOF
window.__OWLID_CONFIG__ = {
  verificationUrl: "$(escape "$VERIFY_URL")",
  issuerUrl: "$(escape "$ISSUER_URL")",
  apiKey: "$(escape "$API_KEY")",
  wsBaseUrl: "$(escape "$WS_BASE_URL")"
};
EOF

mv "$TMP" "$OUT"
trap - EXIT INT TERM

# The SDK treats empty strings as falsy and falls through to its build-time
# VITE_* defaults — no need to strip empty fields here.
echo "wrote $OUT (verification=${VERIFY_URL:-<unset>} issuer=${ISSUER_URL:-<unset>})"

# When invoked under nginx's /docker-entrypoint.d/ directory, that runner
# starts nginx itself; we just need to return 0. When invoked as a standalone
# entrypoint (e.g. ENTRYPOINT [...]), exec the rest of CMD.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi
