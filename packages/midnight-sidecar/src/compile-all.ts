/**
 * Compile every `contracts/*.compact` into a sibling `managed/<name>/`
 * directory. Iterates the contracts dir so new contracts (e.g. each
 * per-predicate one) are picked up automatically — no list to keep in
 * sync.
 *
 * `--skip-zk` skips ZK key generation (faster iteration; bindings still
 * produced).
 *
 * The Compact CLI manager (`compact`) doesn't always honour the
 * `active-version` file when invoked by package.json scripts, so when
 * `COMPACTC_BIN` is set we shell out to that binary directly. Otherwise
 * we fall back to `compact compile`.
 */

import { readdirSync, statSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { spawnSync } from 'child_process'

const skipZk = process.argv.includes('--skip-zk')
const root = join(import.meta.dir, '..')
const contractsDir = join(root, 'contracts')
const managedDir = join(root, 'managed')
const compactcBin = process.env.COMPACTC_BIN

function compile(name: string, sourcePath: string) {
  const outPath = join(managedDir, name)
  rmSync(outPath, { recursive: true, force: true })

  const args = skipZk
    ? compactcBin
      ? ['--skip-zk', sourcePath, outPath]
      : ['compile', '--skip-zk', sourcePath, outPath]
    : compactcBin
      ? [sourcePath, outPath]
      : ['compile', sourcePath, outPath]
  const cmd = compactcBin ?? 'compact'

  process.stdout.write(`compiling ${name} ... `)
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const ms = Date.now() - t0
  if (r.status !== 0) {
    console.error(`FAIL (${ms}ms)`)
    if (r.stdout?.length) process.stderr.write(r.stdout.toString())
    if (r.stderr?.length) process.stderr.write(r.stderr.toString())
    process.exit(r.status ?? 1)
  }
  console.log(`ok (${ms}ms)`)
}

const entries = readdirSync(contractsDir)
  .filter((f) => f.endsWith('.compact'))
  .filter((f) => statSync(join(contractsDir, f)).isFile())
  .sort()

if (entries.length === 0) {
  console.error(`No .compact files in ${contractsDir}`)
  process.exit(1)
}

console.log(`Compiling ${entries.length} contract(s)${skipZk ? ' (skip-zk)' : ''}`)
console.log(`Using compactc: ${compactcBin ?? '`compact compile` (CLI manager)'}`)
console.log('')

for (const file of entries) {
  const name = basename(file, '.compact')
  compile(name, join(contractsDir, file))
}

console.log('')
console.log('All contracts compiled.')
