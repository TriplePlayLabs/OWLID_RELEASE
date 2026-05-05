/**
 * Copies authoritative markdown sources into the rspress docs tree.
 * Run automatically before `dev` and `build` via package.json hooks.
 *
 * Customer-facing only: integration guides, public HTTP APIs, SDK reference,
 * architecture overview, real-world scenarios. Internal dev / ops docs
 * (deployment, runbook, e2e setup) live in the repo's `docs/` folder and
 * are NOT published on the marketing/docs site.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const docsRoot = resolve(here, '../docs')

const HEADER = '<!-- AUTO-GENERATED — do not edit. Source: '
const HEADER_END = ' -->\n\n'

interface CopyJob {
  from: string
  to: string
}

// `architecture/overview.md` is hand-authored on the docs site (customer-
// facing concept tour) — not synced from the formal SAD in `docs/ARCHITECTURE.md`.
const jobs: CopyJob[] = [
  { from: 'docs/integration/verifier.md', to: 'integration/verifier.md' },
  { from: 'docs/integration/issuer.md', to: 'integration/issuer.md' },
  { from: 'docs/integration/holder.md', to: 'integration/holder.md' },
  { from: 'docs/sdk/verifier.md', to: 'sdk/verifier.md' },
  { from: 'docs/sdk/issuer.md', to: 'sdk/issuer.md' },
  { from: 'docs/sdk/native.md', to: 'sdk/native.md' },
  { from: 'docs/E2E_SCENARIOS.md', to: 'examples/scenarios.md' },
]

let copied = 0
for (const { from, to } of jobs) {
  const src = join(repoRoot, from)
  const dst = join(docsRoot, to)
  if (!existsSync(src)) {
    console.warn(`  [skip] missing ${from}`)
    continue
  }
  mkdirSync(dirname(dst), { recursive: true })
  const body = readFileSync(src, 'utf8')
  writeFileSync(dst, `${HEADER}${from}${HEADER_END}${body}`)
  copied++
}
console.log(`sync-content: copied ${copied} / ${jobs.length} files`)
