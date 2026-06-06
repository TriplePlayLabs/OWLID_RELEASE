# @owlid/docs-site

Marketing site and customer-facing documentation for Owl ID. Built with [rspress](https://rspress.rs).

```bash
bun run dev        # → http://localhost:4001
bun run build      # static export → packages/docs-site/doc_build/
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
4. Run `bun run dev` to verify locally.

## Production

The site is a static export. Drop `doc_build/` behind any CDN or static-file
server. No Node runtime required at serve time.
