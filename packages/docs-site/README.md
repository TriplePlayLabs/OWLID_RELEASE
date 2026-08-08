# @owlid/docs-site

Marketing site and customer-facing documentation for Owl ID. Built with [rspress](https://rspress.rs).

```bash
bun run dev        # → http://localhost:4001
bun run build      # static export → packages/docs-site/doc_build/
bun run check      # tsc + the docs↔code drift check below
```

## What lives here

This package is the **single home** for all customer-facing documentation —
marketing landing, integration guides, SDK reference, architecture overview,
real-world scenarios. Every page is authored directly under `docs/`. There is
no content-sync step and no upstream source; edit the files here.

Repo-internal docs (operations runbook, deployment guide, local E2E setup,
security audits, planning notes) are **not** part of this site — they live in
the repo-root `docs/` folder for maintainers.

## Layout

```
packages/docs-site/
├── package.json
├── rspress.config.ts        # site config: title, nav, sidebar, theme
├── tsconfig.json
└── docs/
    ├── index.md             # marketing landing (rspress home page)
    ├── overview.md          # what is Owl ID
    ├── quickstart.md        # developer getting started
    ├── _meta.json           # top-level sidebar order
    ├── apps.md
    ├── architecture/        # how Owl ID works (concept tour)
    ├── integration/         # verifier / issuer / holder / bundler guides
    ├── sdk/                 # OwlVerifier / OwlIssuer / SD-JWT VC primitives
    └── examples/            # real-world scenarios
```

## Adding a page

1. Author the markdown file under `docs/`.
2. Add it to the directory's `_meta.json`.
3. Add a sidebar entry in `rspress.config.ts` if it should appear in the left nav.
   The explicit `themeConfig.sidebar` overrides `_meta.json`, so a page listed
   only in `_meta.json` is reachable but invisible in the left nav.
4. Run `bun run dev` to verify locally.

## Staying in sync with the code

`scripts/check-docs.ts` (`just check-docs`, or `bun run check:docs`) fails when
the docs and the code disagree. It runs in CI on every push and takes ~2s. Six
checks, each anchored to a source of truth:

| Check      | Source of truth                                        |
| ---------- | ------------------------------------------------------ |
| snippets   | `packages/sdk/src` — every ` ```ts ` fence is compiled |
| links      | the other markdown files' headings                     |
| predicates | `route_claim()` in `crates/proof-system`               |
| routes     | the axum + utoipa paths the crates register            |
| reference  | the `OwlVerifier` / `OwlIssuer` class declarations     |
| base URLs  | the `DEFAULT_BASE_URL` each SDK client ships           |

Snippets are compiled as real modules against the SDK source, so a renamed
export, a changed signature, or a wrong field name fails the build. Identifiers
the reader supplies (`showQr`, `holderPublicKeyHex`) are auto-declared as `any`
— but names the SDK exports never are, so a snippet cannot quietly use a symbol
its page never imports. Imports accumulate down a page, matching how a reader
reads it.

Two consequences worth knowing when editing:

- Adding a public method to `OwlVerifier` / `OwlIssuer` **fails CI until it has
  a `### \`method(…)\`` heading** on the matching `sdk/*.md` page.
- A fence that is a bare signature or object-literal fragment can't compile on
  its own. Mark it ` ```ts no-check `; anything else gets a note in the output.

## Production

The site is a static export. Drop `doc_build/` behind any CDN or static-file
server. No Node runtime required at serve time.
