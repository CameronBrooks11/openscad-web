# OpenSCAD Web

[Open the Demo](https://cameronbrooks11.github.io/openscad-web/)

OpenSCAD Web is a browser-based OpenSCAD editor, previewer, and customizer built around a headless WebAssembly build of OpenSCAD. The app uses Lit for the UI shell, Monaco for editing, Three.js for 3D viewing, BrowserFS for the virtual filesystem, and Vite for app and worker bundling.

Licensing and bundled third-party notices live in [LICENSE.md](./LICENSE.md).

## Highlights

- Automatic preview on edit and full render on demand
- Monaco-based SCAD editor with syntax highlighting and completions
- Three.js-based OFF viewer with persisted camera state
- Customizer and embed URL modes
- Bundled SCAD library corpus with BrowserFS-backed virtual mounts
- Installable PWA with offline support via Workbox-generated service worker

## Current Toolchain

- Lit web components for the application shell
- Vite for app and worker bundling
- Vitest for unit tests
- Playwright for browser E2E
- explicit Node build scripts for WASM, font, and library packaging from `libs-config.json`
- Workbox `generateSW` for production service worker generation

Runtime notes:

- runtime asset URLs resolve through `import.meta.env.BASE_URL`
- the OpenSCAD runtime JS/WASM now flows through the Vite asset graph
- BrowserFS is bundled into the app and worker runtime instead of loaded from a standalone public script
- editor mode eagerly mounts libraries on the main thread for browsing and completions
- embed and customizer flows continue to rely on demand-loaded libraries in compile paths

## Prerequisites

- Node.js `>=24`
- npm
- git
- `zip`
- `curl` or `wget`
- Docker with amd64 container support only if you need to rebuild the OpenSCAD wasm from source

## Quick Start

Install dependencies and prepare the generated assets:

```bash
npm install
npm run build:libs
```

Start the Vite dev server:

```bash
npm run start
# http://localhost:4000/
```

Run the broad local verification path:

```bash
npm run verify
```

Run the full verification path, including browser checks for both the hosted app and the publish artifact:

```bash
npx playwright install chromium
npm run verify:full
```

Run a local production-style build and serve it from `/dist/`:

```bash
npm run start:production
# http://localhost:3000/dist/
```

## Testing

Assembly and deploy-tooling tests:

```bash
npm run test:assembly
```

Unit tests:

```bash
npm run test:unit
```

Browser E2E against the canonical production-style path:

```bash
npx playwright install chromium
npm run test:e2e
```

Browser E2E against the Vite dev server:

```bash
npx playwright install chromium
npm run test:e2e:dev
```

Browser E2E against the publish artifact:

```bash
npx playwright install chromium
npm run test:e2e:publish
```

## Build and Deploy

Prepare all generated assets and compile the app:

```bash
npm run build:all
```

The app is deployed as a static `dist/` directory. The build path is controlled by `PUBLIC_URL`, and the checked-in default deployment root is also reflected in `package.json#homepage`.

For deployment details, self-hosting notes, and GitHub Pages behavior, see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).
For publishing OpenSCAD projects into GitHub Pages or another static-site tree, see [docs/PUBLISHING.md](./docs/PUBLISHING.md).

Security assumptions, CSP guidance, and external-source loading policy are documented in [docs/SECURITY.md](./docs/SECURITY.md).

## Contributing

Contributor workflow, verification expectations, and repo conventions are documented in [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).

Performance baseline usage is documented in [docs/PERFORMANCE.md](./docs/PERFORMANCE.md).

## Asset Pipeline

The library and runtime asset pipeline is driven by [libs-config.json](./libs-config.json).

Useful commands:

- `npm run build:libs` - build all generated assets
- `npm run build:libs:clean` - remove generated asset outputs
- `npm run build:libs:wasm` - refresh only the OpenSCAD wasm/runtime artifacts
- `npm run build:libs:fonts` - refresh only packaged font assets
- `npm run build:libs:libraries` - rebuild only packaged library ZIPs and generated registry metadata

Adding a new bundled library requires updating:

- [libs-config.json](./libs-config.json)
- [src/fs/zip-archives.generated.ts](./src/fs/zip-archives.generated.ts)
- [LICENSE.md](./LICENSE.md)

## Building Your Own OpenSCAD Wasm

If you need to rebuild the OpenSCAD wasm instead of using the fetched prebuilt runtime:

```bash
npm run build:libs:wasm
```

Then rebuild the rest of the asset pipeline and run the app normally:

```bash
npm run build:libs
npm run start
```
