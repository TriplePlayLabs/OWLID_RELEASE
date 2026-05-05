/**
 * `@owlid/sdk/native` — explicit, opt-in re-export of the Rust/WASM native
 * SDK. Importing this subpath is what triggers the WASM module to load.
 *
 * Apps that need to **generate** proofs or tokens (holders, custom proof
 * tools) import from here:
 *
 *     import { Token, Credential, blake3 } from '@owlid/sdk/native'
 *
 * Apps that only call REST endpoints (verifier dashboards, admin consoles,
 * marketing sites) should NOT import this subpath — the root `@owlid/sdk`
 * gives them config + types + presentation helpers without the WASM
 * payload.
 */
export * from '@owlid/native-sdk'

// WASM-only proving-key loader. Exported from this subpath because it
// imports `@owlid/native-sdk` (which is what triggers the WASM load).
// Verifier dashboards / marketing sites that import only from
// `@owlid/sdk` never see this and pay no WASM cost.
//
// Apps don't need to call `ensureProvingKeys*` directly — the holder
// helpers (signToken, signTokenWithPasskey, respondToPresentation) load
// the right keys before proving. Use `configureProvingKeys` only to
// override how/where keys come from (custom loader, bundled bytes,
// alternate base URL).
export {
  configureProvingKeys,
  getProvingKeyConfig,
  ensureProvingKeys,
  ensureProvingKeysFor,
  circuitsForPredicates,
  type ZkCircuit,
  type ProvingKeyConfig,
} from './proving-keys.js'
