/**
 * Fails the build when the docs drift from the code they document.
 *
 * Six independent checks, each anchored to a source of truth in the repo:
 *
 *   snippets   every ```ts fence is type-checked against packages/sdk/src
 *   links      every relative link + #anchor resolves to a real doc heading
 *   predicates the DCQL claim paths in prose match route_claim() in Rust
 *   routes     the HTTP tables in api.md match paths the crates actually serve
 *   reference  sdk/*.md document exactly the public methods of their class
 *   base URLs  the SDK clients default to the hosts api.md advertises
 *
 * A fence that cannot stand alone as a module (a bare signature or object
 * literal) is skipped with a note; mark it ```ts no-check to silence that.
 *
 * Run: bun run check:docs
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const siteRoot = path.join(here, '..')
const docsRoot = path.join(siteRoot, 'docs')
const repoRoot = path.join(siteRoot, '..', '..')

interface Failure {
  file: string
  line: number
  message: string
}

const failures: Failure[] = []
const notes: string[] = []

function fail(file: string, line: number, message: string) {
  failures.push({ file: path.relative(repoRoot, file), line, message })
}

// ---------------------------------------------------------------------------
// Markdown scanning
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const markdownFiles = walk(docsRoot).sort()

interface Fence {
  file: string
  /** 1-based line of the fence's first code line. */
  line: number
  lang: string
  meta: string
  code: string
}

function extractFences(file: string): Fence[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const fences: Fence[] = []
  let open: { lang: string; meta: string; start: number; body: string[] } | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = /^```(\S*)\s*(.*)$/.exec(lines[i]!)
    if (open) {
      if (/^```\s*$/.test(lines[i]!)) {
        fences.push({
          file,
          line: open.start + 2,
          lang: open.lang,
          meta: open.meta,
          code: open.body.join('\n'),
        })
        open = null
      } else open.body.push(lines[i]!)
    } else if (m && m[1]) {
      open = { lang: m[1], meta: (m[2] ?? '').trim(), start: i, body: [] }
    }
  }
  return fences
}

const allFences = markdownFiles.flatMap(extractFences)

// ---------------------------------------------------------------------------
// Check 1 — type-check every ts fence against the real SDK source
// ---------------------------------------------------------------------------
//
// Snippets are illustrative, so identifiers the reader is expected to supply
// (`showQr`, `holderPublicKeyHex`, `bar`, …) are not errors. They are resolved
// by compiling twice: pass 1 collects "Cannot find name" diagnostics, pass 2
// re-compiles with those names declared as `any`. Anything still failing in
// pass 2 is a genuine mismatch between the docs and the SDK.

const TS_LANGS = new Set(['ts', 'typescript'])
const tsFences = allFences.filter((f) => TS_LANGS.has(f.lang) && !f.meta.includes('no-check'))

const buildDir = path.join(siteRoot, 'node_modules', '.cache', 'docs-typecheck')
fs.rmSync(buildDir, { recursive: true, force: true })
fs.mkdirSync(buildDir, { recursive: true })

/** True when the fence stands alone as a module — fragments (bare object
 *  literals, partial member lists) cannot be type-checked in isolation. */
function isParseable(code: string): boolean {
  const sf = ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  // `parseDiagnostics` is internal but stable, and is the only way to tell a
  // genuine syntax error from a fence that is a bare object-literal fragment.
  return ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length === 0
}

interface SnippetFile {
  fence: Fence
  fileName: string
}

const skipped: Fence[] = []
const snippets: SnippetFile[] = []

// Each fence gets exactly one prepended line, so diagnostic line numbers map
// onto the markdown by subtracting one. Identifiers the reader supplies are
// declared in a shared ambient file rather than injected per snippet.
const AMBIENT = path.join(buildDir, 'reader-supplied.d.ts')
const PREFIX_LINES = 1

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  noEmit: true,
  allowJs: false,
  types: ['node'],
  baseUrl: repoRoot,
  paths: {
    '@owlid/sdk': [path.join(repoRoot, 'packages/sdk/src/index.ts')],
    '@owlid/config': [path.join(repoRoot, 'packages/config/src/index.ts')],
  },
}

/** Everything `@owlid/sdk` exports. A name in here is never stubbed, so a
 *  snippet that uses an SDK symbol the page never imports still fails. */
function sdkExportNames(): Set<string> {
  const entry = path.join(repoRoot, 'packages/sdk/src/index.ts')
  const program = ts.createProgram([entry], compilerOptions)
  const sf = program.getSourceFile(entry)
  if (!sf) return new Set()
  const checker = program.getTypeChecker()
  const sym = checker.getSymbolAtLocation(sf)
  if (!sym) return new Set()
  return new Set(checker.getExportsOfModule(sym).map((s) => s.getName()))
}

const sdkExports = sdkExportNames()
if (sdkExports.size === 0) {
  fail(path.join(repoRoot, 'packages/sdk/src/index.ts'), 1, 'could not read @owlid/sdk exports')
}

/** Names a fence already pulls in from `@owlid/sdk`. */
function sdkImportsIn(code: string): Set<string> {
  const sf = ts.createSourceFile('s.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!/@owlid\/sdk/.test(stmt.moduleSpecifier.getText())) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text)
    }
  }
  return names
}

/** Top-level names a fence declares itself — an inherited import of the same
 *  name would collide, so those are dropped from the injected prefix. */
function declaredIn(code: string): Set<string> {
  const sf = ts.createSourceFile('s.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      if (stmt.name) names.add(stmt.name.text)
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text)
      }
    }
  }
  return names
}

// Reference pages import once at the top and then show bare method snippets.
// Reading a page top-to-bottom, every earlier import is still in scope, so
// imports accumulate per page rather than per fence.
const pageImports = new Map<string, Set<string>>()
for (const fence of tsFences) {
  const seen = pageImports.get(fence.file) ?? new Set<string>()
  for (const n of sdkImportsIn(fence.code)) {
    // A name the page imports but the SDK does not export is drift the
    // snippet's own import line already reports — don't re-inject it.
    if (sdkExports.has(n)) seen.add(n)
  }
  pageImports.set(fence.file, seen)
}

tsFences.forEach((fence, idx) => {
  if (!isParseable(fence.code)) {
    skipped.push(fence)
    return
  }
  const shadowed = new Set([...sdkImportsIn(fence.code), ...declaredIn(fence.code)])
  const inherited = [...(pageImports.get(fence.file) ?? [])].filter((n) => !shadowed.has(n)).sort()
  const prefix = inherited.length
    ? `import { ${inherited.join(', ')} } from '@owlid/sdk'`
    : '// no inherited imports'
  const fileName = path.join(buildDir, `snippet-${String(idx).padStart(3, '0')}.ts`)
  // `export {}` keeps a fence with no imports a module, so top-level await
  // stays legal and top-level names don't collide across snippets.
  fs.writeFileSync(fileName, `${prefix}\n${fence.code}\nexport {}\n`)
  snippets.push({ fence, fileName })
})

/** The clients every page instantiates. Declaring them with their real types
 *  keeps method calls checked on pages that don't re-show the constructor. */
const WELL_KNOWN = {
  verifier: 'OwlVerifier',
  issuer: 'OwlIssuer',
  wallet: 'OwlWallet',
} as const

function writeAmbient(names: Iterable<string>) {
  const clients = Object.entries(WELL_KNOWN)
    .map(([id, type]) => `  const ${id}: import('@owlid/sdk').${type}`)
    .join('\n')
  const decls = [...names]
    .filter((n) => !(n in WELL_KNOWN))
    .sort()
    .map((n) => `  const ${n}: any\n  type ${n} = any`)
    .join('\n')
  fs.writeFileSync(AMBIENT, `export {}\ndeclare global {\n${clients}\n${decls}\n}\n`)
}
writeAmbient([])

function compile(): ts.Diagnostic[] {
  const program = ts.createProgram([AMBIENT, ...snippets.map((s) => s.fileName)], compilerOptions)
  return snippets.flatMap((s) => {
    const sf = program.getSourceFile(s.fileName)
    if (!sf) return []
    return [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)]
  })
}

// Pass 1 — discover the identifiers the reader is expected to supply. Both
// diagnostics below mean "this name is not defined anywhere": TS2304 for a
// normal reference, TS18004 for an object-literal shorthand property.
const UNDECLARED = new Map([
  [2304, /Cannot find name '([^']+)'/],
  [18004, /shorthand property '([^']+)'/],
])
const stubs = new Set<string>()
for (const d of compile()) {
  const pattern = UNDECLARED.get(d.code)
  if (!pattern) continue
  const name = pattern.exec(ts.flattenDiagnosticMessageText(d.messageText, ''))?.[1]
  if (name && !sdkExports.has(name)) stubs.add(name)
}
writeAmbient(stubs)

// Pass 2 — anything left is real drift.
for (const d of compile()) {
  if (!d.file || d.start === undefined) continue
  const snippet = snippets.find((s) => s.fileName === d.file!.fileName)
  if (!snippet) continue
  const { line } = d.file.getLineAndCharacterOfPosition(d.start)
  fail(
    snippet.fence.file,
    snippet.fence.line + Math.max(line - PREFIX_LINES, 0),
    `snippet: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (TS${d.code})`,
  )
}

for (const fence of skipped) {
  notes.push(
    `${path.relative(repoRoot, fence.file)}:${fence.line} — ts fence is not parseable on its own; ` +
      'not type-checked. Mark it ```ts no-check to silence this.',
  )
}

// ---------------------------------------------------------------------------
// Check 2 — relative links and #anchors resolve
// ---------------------------------------------------------------------------

/** Mirrors rspress's heading-id algorithm: strip markup and punctuation, then
 *  map each remaining whitespace character to one hyphen — so "Wallet — for
 *  holders" keeps the double hyphen left behind by the em dash. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-')
}

/** doc route (e.g. "/integration/holder") -> set of heading slugs */
const anchorsByRoute = new Map<string, Set<string>>()
for (const file of markdownFiles) {
  const rel = path.relative(docsRoot, file).replace(/\.md$/, '')
  const route = '/' + (rel === 'index' ? '' : rel)
  const slugs = new Set<string>()
  let inFence = false
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (raw.startsWith('```')) inFence = !inFence
    if (inFence) continue
    const m = /^#{1,6}\s+(.*)$/.exec(raw)
    if (m) slugs.add(slugify(m[1]!))
    const html = /<h[1-6][^>]*id="([^"]+)"/.exec(raw)
    if (html) slugs.add(html[1]!)
  }
  anchorsByRoute.set(route.replace(/\/$/, '') || '/', slugs)
}

const LINK_RE = /\[[^\]]*\]\((\/[^)\s]*)\)|href="(\/[^"#]*(?:#[^"]*)?)"/g
for (const file of markdownFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((raw, i) => {
    for (const m of raw.matchAll(LINK_RE)) {
      const target = m[1] ?? m[2]
      if (!target) continue
      const [routeRaw, anchor] = target.split('#')
      const route = (routeRaw ?? '').replace(/\.html$/, '').replace(/\/$/, '') || '/'
      const slugs = anchorsByRoute.get(route)
      if (!slugs) {
        fail(file, i + 1, `link target does not exist: ${target}`)
        continue
      }
      if (anchor && !slugs.has(anchor)) {
        fail(file, i + 1, `anchor not found on ${route}: #${anchor}`)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Check 3 — DCQL predicate claim paths match the Rust router
// ---------------------------------------------------------------------------

const routingSrc = fs.readFileSync(
  path.join(repoRoot, 'crates/proof-system/src/predicate_routing.rs'),
  'utf8',
)
const routeFn = /pub fn route_claim\([\s\S]*?\n}/.exec(routingSrc)?.[0] ?? ''
const routedPaths = new Set([...routeFn.matchAll(/^\s*"([a-z_]+)"\s*=>/gm)].map((m) => m[1]!))
if (routedPaths.size === 0) {
  fail(
    path.join(repoRoot, 'crates/proof-system/src/predicate_routing.rs'),
    1,
    'could not parse route_claim() — the predicate check is not running',
  )
}

// Claim paths the docs actually put on the wire.
for (const fence of allFences) {
  if (!TS_LANGS.has(fence.lang)) continue
  fence.code.split('\n').forEach((raw, i) => {
    for (const m of raw.matchAll(/path:\s*\[\s*'([^']+)'\s*\]/g)) {
      const claim = m[1]!
      // A claim is either a routed predicate or a plain SD-JWT disclosure.
      // Only flag the trap: issuer-stamped booleans that read like a
      // predicate (`age_over_18`, `resident`) but are ordinary disclosures,
      // so requesting them yields the issuer's word instead of a ZK proof.
      if (routedPaths.has(claim)) continue
      const looksRouted = [...routedPaths].find(
        (p) => claim !== p && (claim.startsWith(`${p}_`) || `${claim}_in` === p),
      )
      if (looksRouted) {
        fail(
          fence.file,
          fence.line + i,
          `DCQL claim '${claim}' is a plain disclosure, not a routed predicate. ` +
            `Did you mean '${looksRouted}'?`,
        )
      }
    }
  })
}

// Every routed path must be documented somewhere, so new predicates cannot
// ship without docs.
const docsText = markdownFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
for (const routed of routedPaths) {
  if (!docsText.includes(`\`${routed}\``)) {
    fail(
      path.join(docsRoot, 'examples/scenarios.md'),
      1,
      `predicate claim path '${routed}' is routable in Rust but documented nowhere`,
    )
  }
}

// ---------------------------------------------------------------------------
// Check 4 — HTTP route tables in api.md match the utoipa annotations
// ---------------------------------------------------------------------------

/** Every path a crate serves: the axum `.route(...)` registrations (the real
 *  surface) unioned with the utoipa `path = "..."` annotations (the OpenAPI
 *  surface). A route missing from either list is still served. */
function servedPaths(crate: string): Set<string> {
  const found = new Set<string>()
  const stack = [path.join(repoRoot, 'crates', crate, 'src')]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith('.rs')) {
        const src = fs.readFileSync(full, 'utf8')
        for (const m of src.matchAll(/\.route\(\s*"([^"]+)"/g)) found.add(m[1]!)
        for (const m of src.matchAll(/path\s*=\s*"(\/[^"]*)"/g)) found.add(m[1]!)
      }
    }
  }
  return found
}

const servicePaths = new Set([
  ...servedPaths('verification-service'),
  ...servedPaths('issuer-service'),
])

const apiMd = path.join(docsRoot, 'api.md')
if (servicePaths.size === 0) {
  fail(apiMd, 1, 'could not read any utoipa path annotations — the route check is not running')
} else {
  fs.readFileSync(apiMd, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      const m = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/.exec(raw)
      if (!m) return
      const route = m[2]!
      if (!servicePaths.has(route)) {
        fail(apiMd, i + 1, `documented route not served by any crate: ${m[1]} ${route}`)
      }
    })
}

// ---------------------------------------------------------------------------
// Check 5 — SDK reference pages cover exactly the public class surface
// ---------------------------------------------------------------------------
//
// The reference pages claim to list every method. Comparing their `###`
// headings against the class declaration means a new public method cannot
// ship undocumented, and a renamed one cannot linger in the docs.

const REFERENCE_PAGES: Array<{ page: string; className: string }> = [
  { page: 'sdk/verifier.md', className: 'OwlVerifier' },
  { page: 'sdk/issuer.md', className: 'OwlIssuer' },
]

function publicMethodsOf(className: string): Set<string> {
  const entry = path.join(repoRoot, 'packages/sdk/src/index.ts')
  const program = ts.createProgram([entry], compilerOptions)
  const found = new Set<string>()
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.includes('/packages/sdk/src/')) continue
    ts.forEachChild(sf, (node) => {
      if (!ts.isClassDeclaration(node) || node.name?.text !== className) return
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue
        const mods = ts.getModifiers(member) ?? []
        const hidden = mods.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
        )
        const name = member.name.getText(sf)
        if (!hidden && !name.startsWith('#')) found.add(name)
      }
    })
  }
  return found
}

for (const { page, className } of REFERENCE_PAGES) {
  const file = path.join(docsRoot, page)
  if (!fs.existsSync(file)) {
    fail(file, 1, `reference page for ${className} is missing`)
    continue
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const documented = new Map<string, number>()
  lines.forEach((raw, i) => {
    if (!/^#{2,4}\s/.test(raw)) return
    // One heading may cover several methods, e.g.
    // "### `listCircuitDatasets()` / `getCircuitDataset(name)`".
    for (const m of raw.matchAll(/`([A-Za-z_$][\w$]*)\s*\(/g)) documented.set(m[1]!, i + 1)
  })
  const actual = publicMethodsOf(className)
  if (actual.size === 0) {
    fail(file, 1, `could not read the ${className} class — the reference check is not running`)
    continue
  }
  for (const [name, line] of documented) {
    if (!actual.has(name)) {
      fail(file, line, `documents \`${name}()\`, which ${className} does not have`)
    }
  }
  for (const name of actual) {
    if (!documented.has(name)) {
      fail(file, 1, `${className}.${name}() is public but no heading documents it`)
    }
  }
}

// ---------------------------------------------------------------------------
// Check 6 — the SDK clients default to the base URLs api.md advertises
// ---------------------------------------------------------------------------
//
// The two services serve disjoint route sets, so a client pointed at the
// wrong default 404s every call while still type-checking.

const BASE_URL_OWNERS: Array<{ service: string; source: string }> = [
  { service: 'Verification', source: 'packages/sdk/src/verifier/index.ts' },
  { service: 'Issuer', source: 'packages/sdk/src/issuer.ts' },
]

const documentedBaseUrls = new Map<string, { url: string; line: number }>()
fs.readFileSync(apiMd, 'utf8')
  .split('\n')
  .forEach((raw, i) => {
    const m = /^\|\s*(Verification|Issuer)\s*\|\s*`(https?:\/\/[^`]+)`/.exec(raw)
    if (m) documentedBaseUrls.set(m[1]!, { url: m[2]!, line: i + 1 })
  })

for (const { service, source } of BASE_URL_OWNERS) {
  const documented = documentedBaseUrls.get(service)
  if (!documented) {
    fail(apiMd, 1, `no base URL row for the ${service} service — the base-URL check is not running`)
    continue
  }
  const sourceFile = path.join(repoRoot, source)
  const m = /const DEFAULT_BASE_URL = '([^']+)'/.exec(fs.readFileSync(sourceFile, 'utf8'))
  if (!m) {
    fail(sourceFile, 1, 'no DEFAULT_BASE_URL — the base-URL check is not running')
    continue
  }
  if (m[1] !== documented.url) {
    fail(
      sourceFile,
      1,
      `DEFAULT_BASE_URL is ${m[1]}, but api.md advertises ${documented.url} ` +
        `for the ${service} service`,
    )
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const note of notes) console.warn(`note: ${note}`)

if (failures.length === 0) {
  console.log(
    `docs check passed — ${tsFences.length} snippets, ${markdownFiles.length} pages, ` +
      `${routedPaths.size} predicates, ${servicePaths.size} routes.`,
  )
  process.exit(0)
}

failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
for (const f of failures) console.error(`${f.file}:${f.line}  ${f.message}`)
console.error(`\n${failures.length} docs check failure(s).`)
process.exit(1)
