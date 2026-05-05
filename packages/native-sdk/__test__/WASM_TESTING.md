# WASM Testing Guide for owl-id

This guide explains how to test the WASM (WebAssembly) build of owl-id in the browser.

## Prerequisites

1. Build the WASM module:

   ```bash
   bun run build:wasm
   ```

   This will generate:
   - `owl-id.wasm32-wasi.wasm` - The compiled WASM binary
   - `owl-id.wasi-browser.js` - Browser wrapper for the WASM module
   - `wasi-worker-browser.mjs` - Web Worker for thread support

## Running Browser Tests

1. Start the test server:

   ```bash
   bun run test:browser
   ```

2. Open your browser to:

   ```
   http://localhost:3000
   ```

3. The browser test page will automatically:
   - Load the WASM module
   - Run comprehensive tests for all owl-id features
   - Display results with pass/fail indicators

## Required Browser Headers

The WASM module uses `SharedArrayBuffer` for thread support, which requires these HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The test server (`__test__/serve.ts`) automatically sets these headers.

## What Gets Tested

The browser tests verify:

1. **WASM Module Loading** - Can the browser load and initialize the module
2. **KeyPair Generation** - Ed25519 keypair creation works in browser
3. **Sign and Verify** - Cryptographic signatures work correctly
4. **Hash Functions** - SHA-256 and BLAKE3 hashing
5. **Document Creation** - Creating and issuing proof documents
6. **Selective Disclosure** - Token creation with privacy-preserving disclosure
7. **Serialization** - ProofDocument and Token JSON serialization

## Browser Compatibility

The WASM build requires:

- Modern browsers with `SharedArrayBuffer` support
- Secure context (HTTPS or localhost)
- WebAssembly threads support

Tested browsers:

- Chrome 91+
- Firefox 89+
- Safari 15.2+
- Edge 91+

## Troubleshooting

### "SharedArrayBuffer is not defined"

Ensure the server is setting the required CORS headers. The test server does this automatically.

### Module not loading

Check browser console for errors. Common issues:

- WASM file not found (rebuild with `bun run build:wasm`)
- Missing `@napi-rs/wasm-runtime` dependency (run `bun install`)

### Worker errors

Ensure `wasi-worker-browser.mjs` is accessible at the same path as the main WASM file.

## Performance

The WASM build provides native-like performance in browsers, typically within 2-3x of native speed for cryptographic operations. This is significantly faster than pure JavaScript implementations.
