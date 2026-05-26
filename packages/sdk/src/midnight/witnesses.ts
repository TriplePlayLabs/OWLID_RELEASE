/**
 * INTERNAL — per-kind compiled-contract dispatch + witness binding.
 *
 * Each predicate kind has its own Compact `Contract` class with its own
 * witness signature. This module owns:
 *   - the per-kind `Contract` constructor table
 *   - the per-kind closure that picks the right field off
 *     `PredicateWitness` and surfaces it to circuit-exec
 *   - `buildCompiledContract(kind, witness)` — the single entry point
 *     the assets factory calls
 *
 * Kept separate from `assets.ts` so the artifact-streaming concern
 * (`ZKConfigProvider`) doesn't share a file with the witness wiring.
 */

import { CompiledContract } from '@midnight-ntwrk/compact-js'
import type { createCallTxOptions } from '@midnight-ntwrk/midnight-js-contracts'

import { buildAllowedSetTree, findPathForCountry } from './merkle.js'
import { Contract as AgeContract } from './contracts/age/index.js'
import { Contract as KycContract } from './contracts/kyc/index.js'
import { Contract as ResidencyContract } from './contracts/residency/index.js'
import { Contract as EmailContract } from './contracts/email/index.js'
import { Contract as NationalityContract } from './contracts/nationality/index.js'
import { Contract as AgeRangeContract } from './contracts/age_range/index.js'
import { Contract as PersonhoodContract } from './contracts/personhood/index.js'

import type { PredicateKind, PredicateWitness } from './kinds.js'

/** `CompiledContract` requires a witnesses binding *and* a compiled-assets
 *  token before it is executable. The ZK assets are supplied separately
 *  by the shared `FetchZkConfigProvider`; this label is never resolved
 *  (nothing in the midnight stack calls `getCompiledAssetsPath` — it
 *  only satisfies the builder so the contract type-checks as fully
 *  built). why: keep the label stable and inert; the holder has no
 *  filesystem. */
const compiledAssetsLabel = (kind: PredicateKind): string => `predicate_${kind}`

type ContractCtor = new (witnesses: never) => unknown

const CONTRACT_FACTORIES: Record<PredicateKind, ContractCtor> = {
  age: AgeContract as unknown as ContractCtor,
  kyc: KycContract as unknown as ContractCtor,
  residency: ResidencyContract as unknown as ContractCtor,
  email: EmailContract as unknown as ContractCtor,
  nationality: NationalityContract as unknown as ContractCtor,
  age_range: AgeRangeContract as unknown as ContractCtor,
  personhood: PersonhoodContract as unknown as ContractCtor,
}

type AnyCtx = { privateState: unknown; ledger: unknown }

function require_<T>(v: T | undefined, kind: PredicateKind, field: string): T {
  if (v === undefined) throw new Error(`${kind} witness: no ${field} in credential`)
  return v
}

/** Right-pad an ISO 3166-1 alpha-2 country code into a 32-byte Bytes<32>
 *  slot, matching the Compact `pad(32, "NL")` shape used in the
 *  `residentCountry` / `nationalityCode` / `allowedCountrySet` witnesses. */
function padCountry(code: string): Uint8Array {
  const out = new Uint8Array(32)
  const ascii = new TextEncoder().encode(code.toUpperCase())
  out.set(ascii.subarray(0, Math.min(ascii.length, 32)))
  return out
}

export { padCountry }

function witnessesFor(kind: PredicateKind, w: PredicateWitness): Record<string, unknown> {
  switch (kind) {
    case 'age':
    case 'age_range':
      return {
        ageValue: (ctx: AnyCtx) => [ctx.privateState, require_(w.ageValue, kind, 'ageValue')],
      }
    case 'kyc':
      return {
        kycLevel: (ctx: AnyCtx) => [ctx.privateState, require_(w.kycLevel, kind, 'kycLevel')],
      }
    case 'residency': {
      const country = require_(w.residentCountry, kind, 'residentCountry')
      const set = require_(w.allowedCountrySet, kind, 'allowedCountrySet')
      const vId = require_(w.verifierIdHash, kind, 'verifierIdHash')
      if (vId.length !== 32) {
        throw new Error(`residency witness: verifierIdHash must be 32 bytes, got ${vId.length}`)
      }
      const built = buildAllowedSetTree(set)
      const path = findPathForCountry(built, country)
      return {
        residentCountry: (ctx: AnyCtx) => [ctx.privateState, padCountry(country)],
        verifierIdHash: (ctx: AnyCtx) => [ctx.privateState, vId],
        allowedCountryPath: (ctx: AnyCtx) => [ctx.privateState, path],
      }
    }
    case 'email':
      return {
        emailVerifiedFlag: (ctx: AnyCtx) => [
          ctx.privateState,
          require_(w.emailVerifiedFlag, kind, 'emailVerifiedFlag'),
        ],
      }
    case 'nationality': {
      const country = require_(w.nationalityCode, 'nationality', 'nationalityCode')
      const set = require_(w.allowedCountrySet, kind, 'allowedCountrySet')
      const vId = require_(w.verifierIdHash, kind, 'verifierIdHash')
      if (vId.length !== 32) {
        throw new Error(`nationality witness: verifierIdHash must be 32 bytes, got ${vId.length}`)
      }
      const built = buildAllowedSetTree(set)
      const path = findPathForCountry(built, country)
      return {
        nationalityCode: (ctx: AnyCtx) => [ctx.privateState, padCountry(country)],
        verifierIdHash: (ctx: AnyCtx) => [ctx.privateState, vId],
        allowedCountryPath: (ctx: AnyCtx) => [ctx.privateState, path],
      }
    }
    case 'personhood': {
      const secret = require_(w.personhoodSecret, 'personhood', 'personhoodSecret')
      if (secret.length !== 32) {
        throw new Error(`personhood witness: expected 32 bytes, got ${secret.length}`)
      }
      return {
        personhoodSecret: (ctx: AnyCtx) => [ctx.privateState, secret],
      }
    }
  }
}

/**
 * Compile the per-kind predicate contract with `witness` bound. `C`
 * is invariant in `CompiledContract<C, …>`, so each concrete per-kind
 * type is not assignable to the erased `Contract.Any` the orchestrator
 * interface uses — the cast is the same seam `prove.ts` already applies.
 */
export function buildCompiledContract(
  kind: PredicateKind,
  witness: PredicateWitness,
): Parameters<typeof createCallTxOptions>[0] {
  const Factory = CONTRACT_FACTORIES[kind]
  return CompiledContract.make(`predicate-${kind}`, Factory as never).pipe(
    CompiledContract.withWitnesses(witnessesFor(kind, witness) as never),
    CompiledContract.withCompiledFileAssets(compiledAssetsLabel(kind)),
  ) as unknown as Parameters<typeof createCallTxOptions>[0]
}
