#!/usr/bin/env bun
/**
 * Sync compactc-generated Midnight artifacts from the sidecar's
 * `managed/predicate_<kind>/` directories into the two downstream
 * consumers:
 *
 *   1. `crates/verification-service/predicate-assets/` — the
 *      `.bzkir`/`.prover`/`.verifier` triple per attest circuit,
 *      embedded via `include_bytes!` and served at `/predicate-zk/`.
 *   2. `packages/sdk/src/midnight/contracts/<kind>/` — the small
 *      compactc ABI module (`index.js` + `index.d.ts`) the SDK
 *      vendors so the holder app builds without a sidecar dep.
 *
 * Run after the sidecar recompiles any predicate Compact contract:
 *
 *     bun run scripts/sync-midnight-assets.ts
 *
 * Idempotent. Fails loud on a missing source file so a partial
 * compactc run can't ship a half-synced asset set.
 */
import { cp, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sidecarManaged = resolve(repoRoot, 'packages', 'midnight-sidecar', 'managed')
const verifierAssetDir = resolve(repoRoot, 'crates', 'verification-service', 'predicate-assets')
const sdkContractsDir = resolve(repoRoot, 'packages', 'sdk', 'src', 'midnight', 'contracts')

/** Per kind: the compactc circuit name that the .bzkir/.prover/.verifier
 *  triple uses. Lockstepped with `crates/verification-service/src/predicate_assets.rs`
 *  and the sidecar contract names. */
const CIRCUIT_BY_KIND: Record<string, string> = {
  age: 'attestAgeGte',
  kyc: 'attestKycGte',
  residency: 'attestResidencyIn',
  email: 'attestEmailVerified',
  nationality: 'attestNationalityIn',
  age_range: 'attestAgeRange',
  personhood: 'attestUniquePersonhood',
}

const KINDS = Object.keys(CIRCUIT_BY_KIND)
const ASSET_EXTS = ['bzkir', 'prover', 'verifier'] as const
const CONTRACT_FILES = ['index.js', 'index.d.ts'] as const

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function copyVerifierAssets(): Promise<void> {
  await mkdir(verifierAssetDir, { recursive: true })
  for (const kind of KINDS) {
    const circuit = CIRCUIT_BY_KIND[kind]
    const srcRoot = join(sidecarManaged, `predicate_${kind}`)
    for (const ext of ASSET_EXTS) {
      // `.bzkir` lives under `zkir/`; `.prover` + `.verifier` under `keys/`.
      const subdir = ext === 'bzkir' ? 'zkir' : 'keys'
      const from = join(srcRoot, subdir, `${circuit}.${ext}`)
      const to = join(verifierAssetDir, `${circuit}.${ext}`)
      if (!(await exists(from))) {
        throw new Error(`source asset missing: ${from}`)
      }
      await cp(from, to)
    }
    console.log(`  verifier ← ${circuit} (.bzkir + .prover + .verifier)`)
  }
}

async function copySdkContracts(): Promise<void> {
  for (const kind of KINDS) {
    const srcDir = join(sidecarManaged, `predicate_${kind}`, 'contract')
    const dstDir = join(sdkContractsDir, kind)
    await mkdir(dstDir, { recursive: true })
    for (const f of CONTRACT_FILES) {
      const from = join(srcDir, f)
      const to = join(dstDir, f)
      if (!(await exists(from))) {
        throw new Error(`source contract file missing: ${from}`)
      }
      await cp(from, to)
    }
    console.log(`  sdk ← predicate_${kind}/contract/ (index.js + index.d.ts)`)
  }
}

async function main(): Promise<void> {
  console.log('Syncing Midnight artifacts:')
  console.log(`  from: ${sidecarManaged}`)
  console.log(`  to verifier-service: ${verifierAssetDir}`)
  console.log(`  to sdk:              ${sdkContractsDir}`)
  console.log()
  await copyVerifierAssets()
  await copySdkContracts()
  console.log('\nDone. Rebuild verification-service to embed the new bytes.')
}

main().catch((e) => {
  console.error('\nsync failed:', e?.message ?? e)
  process.exit(1)
})
