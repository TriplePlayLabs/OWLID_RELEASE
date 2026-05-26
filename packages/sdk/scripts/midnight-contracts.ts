#!/usr/bin/env bun
/**
 * Copy the vendored `src/midnight/contracts/` tree (one compactc ABI
 * module per predicate kind) into `dist/midnight/contracts/` after tsc.
 * Tsc emits `.js` for our own `.ts` files but ignores these inert
 * generator outputs.
 *
 * The reverse direction (sidecar `managed/predicate_<kind>/` →
 * `src/midnight/contracts/<kind>/` + verifier-service
 * `predicate-assets/`) lives at the workspace root
 * (`scripts/sync-midnight-assets.ts`) so both consumers stay in
 * lockstep when compactc reruns.
 *
 *     bun run scripts/midnight-contracts.ts
 */
import { cp, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KINDS = [
  'age',
  'kyc',
  'residency',
  'email',
  'nationality',
  'age_range',
  'personhood',
] as const

const FILES = ['index.js', 'index.d.ts'] as const

const here = dirname(fileURLToPath(import.meta.url))
const sdkRoot = resolve(here, '..')

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function copyAll(): Promise<void> {
  for (const kind of KINDS) {
    const srcDir = join(sdkRoot, 'src', 'midnight', 'contracts', kind)
    const dstDir = join(sdkRoot, 'dist', 'midnight', 'contracts', kind)
    if (!(await exists(srcDir))) {
      throw new Error(`source dir missing: ${srcDir}`)
    }
    await mkdir(dstDir, { recursive: true })
    for (const f of FILES) {
      const from = join(srcDir, f)
      const to = join(dstDir, f)
      if (!(await exists(from))) {
        throw new Error(`source file missing: ${from}`)
      }
      await cp(from, to)
    }
    console.log(`  copied predicate_${kind}`)
  }
}

copyAll().catch((e) => {
  console.error('failed:', e?.message ?? e)
  process.exit(1)
})
