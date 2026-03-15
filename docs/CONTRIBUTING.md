# Contributing

This repo is a browser-first OpenSCAD IDE and runtime. The current stack is:

- Lit for UI
- Vite for app and worker bundling
- Vitest for unit tests
- Playwright for browser E2E
- explicit Node build scripts for wasm, fonts, and packaged SCAD libraries

## Prerequisites

- Node.js `>=24`
- npm
- git
- `zip`
- `curl` or `wget`
- Docker only if you intend to rebuild the OpenSCAD wasm from source

## First-Time Setup

```bash
npm install
npm run build:libs
```

Start the app locally:

```bash
npm run start
```

The default local dev URL is `http://localhost:4000/`.

## Common Commands

Core verification:

```bash
npm run verify
```

Focused checks:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
npm run test:e2e
npm run test:e2e:dev
```

Generated asset pipeline:

```bash
npm run build:libs
npm run build:libs:clean
npm run build:libs:wasm
npm run build:libs:fonts
npm run build:libs:libraries
```

Production-style local smoke test:

```bash
npm run start:production
```

## Expected Workflow

1. install dependencies
2. prepare generated assets with `npm run build:libs`
3. make the code change
4. run the smallest relevant verification locally while iterating
5. run `npm run verify` before shipping broad changes
6. run Playwright for user-facing runtime changes

For changes that affect startup, rendering, library delivery, or worker behavior, also run:

```bash
npm run test:e2e
```

For debugging a browser failure against the Vite dev server, use:

```bash
npm run test:e2e:dev
```

## CI Expectations

The main CI workflow currently enforces:

- lint
- format check
- unit tests
- typecheck
- production build
- production-path Playwright E2E
- performance comparison against the committed baseline

If your change affects shipped assets, build behavior, worker loading, service worker behavior, or URL/base-path handling, assume CI will exercise it.

## Generated Files and Asset Sources

This repo intentionally ships generated and prepared assets alongside source code. In particular:

- `src/fs/zip-archives.generated.ts` is generated from `libs-config.json`
- `src/wasm/` is produced by the asset pipeline
- `public/libraries/` is populated by the asset pipeline

Do not hand-edit generated outputs unless there is a very specific reason and the change is immediately backed by the source-of-truth config or build script.

## Library Additions and Updates

Bundled library changes must update all of:

- `libs-config.json`
- `src/fs/zip-archives.generated.ts`
- `LICENSE.md`

That keeps packaging metadata, runtime registry metadata, and third-party notices aligned.

## Performance and Bundle Changes

If your change impacts startup, bundle shape, delivery policy, or heavy runtime dependencies:

- review [docs/PERFORMANCE.md](./PERFORMANCE.md)
- treat `perf-baseline.json` as CI-owned
- avoid silently widening bootstrap or precache behavior

The Phase 14 bundle audit identified Monaco loading, service worker precache scope, and library bootstrap prefetch scope as especially sensitive areas.

## Deployment-Sensitive Changes

If you touch any of the following, also read [docs/DEPLOYMENT.md](./DEPLOYMENT.md):

- `vite.config.ts`
- `package.json` build or start scripts
- `scripts/build-sw.mjs`
- service worker registration
- runtime asset URL resolution
- worker bootstrap or wasm delivery

If the change touches URL parsing, service worker behavior, `postMessage`, external fetching, or `_blank` navigation, also read [docs/SECURITY.md](./SECURITY.md).

## Coding Notes

- The repo standard is LF line endings, enforced by `.gitattributes`
- `working/` contains local planning material and is intentionally not part of the shipped repo history
- third-party notices are centralized in `LICENSE.md`

## Need a Full Wasm Rebuild?

If you want to rebuild the OpenSCAD wasm instead of using the fetched prebuilt runtime:

```bash
npm run build:libs:wasm
```

Then rerun:

```bash
npm run build:libs
```
