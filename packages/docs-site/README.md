# @owlid/docs-site

Marketing site and customer-facing documentation for OwlID. Built with [rspress](https://rspress.rs).

```bash
bun run dev:docs        # → http://localhost:4001
bun run build:docs      # static export → packages/docs-site/doc_build/
```

## What lives here

Customer-facing only. Marketing landing, integration guides, public HTTP API reference, SDK reference, architecture overview, real-world scenarios.

**Not** on the docs site (these are repo-internal — read them in the repo `docs/` folder):

- Operations runbook
- Deployment guide
- Local end-to-end setup with the Midnight devnet
- Security audits and TODOs
- Internal planning artifacts

## Content sync

`scripts/sync-content.ts` copies authoritative markdown out of the codebase into `docs/`. It runs automatically on `predev` and `prebuild`. Source-of-truth files remain alongside the code they describe — the rspress tree never forks content.

| Source                                  | Site path                |
| --------------------------------------- | ------------------------ |
| `docs/ARCHITECTURE.md`                  | `/architecture/overview` |
| `docs/INTEGRATION.md`                   | `/integration/verifier`  |
| `crates/verification-service/README.md` | `/api/verification`      |
| `crates/issuer-service/README.md`       | `/api/issuer`            |
| `packages/sdk/README.md`                | `/sdk/overview`          |
| `packages/native-sdk/README.md`         | `/sdk/native`            |
| `docs/E2E_SCENARIOS.md`                 | `/examples/scenarios`    |

`docs/index.md`, `docs/overview.md`, and `docs/quickstart.md` are hand-authored on this site (no upstream source).

## Layout

```
packages/docs-site/
├── package.json
├── rspress.config.ts        # site config: title, nav, sidebar, theme
├── tsconfig.json
├── scripts/
│   └── sync-content.ts      # copies markdown from repo into docs/
└── docs/
    ├── index.md             # marketing landing (rspress home page)
    ├── overview.md          # what is OwlID — hand-authored
    ├── quickstart.md        # 3-persona quickstart — hand-authored
    ├── _meta.json           # top-level sidebar order
    ├── architecture/
    ├── integration/
    ├── api/
    ├── sdk/
    └── examples/
```

## Adding a page

1. Either author it under `docs/` directly (hand-written) or add a copy job to `scripts/sync-content.ts` (sourced from elsewhere).
2. Add the page to the appropriate `_meta.json` for its directory.
3. Add a sidebar entry in `rspress.config.ts` if it should appear in the left nav.
4. Run `bun run dev:docs` to verify locally.

## Production

The site is a static export. Drop `doc_build/` behind any CDN or static-file server. No Node runtime required at serve time.
