# Changelog

This changelog was backfilled from git history on 2026-03-15.

The repository did not previously maintain a changelog or publish version tags, so the entries below are grouped by major delivery milestones and maintenance windows rather than formal releases.

Latest update represented here: 2026-03-15 (`74e184a`, `tighten accessibility semantics across the app shell`).

## 2026-03-11 to 2026-03-15

Major platform modernization, bundler migration, and production hardening.

- Platform and CI: renamed the package to `openscad-web`, raised the baseline to Node 24, tracked `package-lock.json`, added GitHub Actions CI and Pages deploy workflows, added `verify`, `typecheck`, and Prettier gates, and hardened deploy/test caching.
- Runtime architecture: introduced an explicit runner/runtime boundary, rebuilt the filesystem layer around canonical BrowserFS mounts and generated library metadata, and fixed worker lifecycle, timer, and initial-preview boot issues.
- Product features: added URL modes and customizer publishing, an inline 2D SVG viewer with DXF placeholder handling, and a faster immediate boot preview path.
- UI rewrite: migrated the application shell and panels from the legacy React/PrimeReact structure to Lit web components, then completed the viewer transition from `model-viewer` to Three.js.
- Testing and tooling: added a proper unit-test harness, raised coverage, migrated unit tests from Jest to Vitest, migrated browser E2E from `jest-puppeteer` to Playwright, and added production performance capture/baseline tooling.
- Build pipeline: extracted asset packaging and service worker generation into explicit Node scripts, then cut over app and worker bundling from webpack to Vite.
- Runtime asset delivery: moved OpenSCAD JS/WASM assets into the Vite asset graph, removed legacy public runtime artifacts, standardized runtime asset URL handling, and aligned service worker generation with the new build.
- Hardening: enforced true production-mode Vite builds, completed contributor/deployment/security documentation, normalized compile/render error UX, tightened external source loading rules, cleaned up third-party notices, removed stale shipped assets, and improved accessibility semantics across the shell.

## 2025-08 to 2026-01

Library build and compatibility maintenance.

- Library packaging: replaced the older Makefile-driven library flow with a metadata-driven library build pipeline centered on `libs-config.json`.
- Stability: repaired follow-up issues from the library-build refactor, including test failures and accidental config churn.
- Compatibility: disabled Monaco on Android user agents to avoid unsupported editor behavior on that platform.
- Repo maintenance: added a pull request template and continued routine GitHub Actions dependency updates.

## 2025-01 to 2025-04

Module baseline and CI/runtime maintenance.

- Modules: migrated the codebase from CommonJS to ESM.
- Export behavior: switched the default export target to STL.
- WASM and test stability: updated the default WASM build URL and adjusted Puppeteer sandboxing for CI reliability.
- CI platform: merged Node 24 and Ubuntu 24.04 runner compatibility work.

## 2024-10 to 2024-12

Offline support, export overhaul, and major viewer/customizer expansion.

- Offline/PWA: added Workbox-based offline support and service worker generation, then tightened precache filtering.
- WASM lifecycle: pinned the runtime to the last known-good WASM build and documented support for custom WASM builds.
- Viewer and export pipeline: removed `react-stl-viewer`, aligned viewer orientation with OpenSCAD, added synchronized axes and quick views, improved lighting, defaulted exports to GLB during this period, and added/fixed 3MF and multimaterial export flows.
- Interaction model: restored settings, added render-complete sound, made F5/F6 shortcuts global, improved demo loading, preserved filenames through export, and allowed editing of bundled files again.
- URL and app flow: moved URL updates to `history.replaceState`, added basic URL loading support, and expanded end-to-end coverage for library-backed models and customizer flows.
- Worker and loading behavior: replaced Rollup with webpack for the web worker and added blurhash-based loading previews.

## 2024-07 to 2024-09

Customizer and asset-pipeline expansion.

- Customizer: introduced the customizer experience and follow-up style fixes.
- Asset packaging: added `build-openscad-wasm.sh`, removed the old inline worker artifact, and fixed WASM shell-script safety issues.
- Libraries and fonts: added the lasercut library, shipped Noto font support, and tuned bundled font scope to avoid oversized archives.
- CI and polish: added the first GitHub Actions build workflow and fixed several HTML, CSS, and homepage-link issues.

## 2024-05 to 2024-06

WASM refresh, library growth, and URL/runtime improvements.

- WASM: refreshed the bundled OpenSCAD snapshot to the 2024-05-29 build, then switched to always building against the latest snapshot before later pinning behavior changed again.
- Libraries: added brailleSCAD, boltsparts, and OpenSCAD-Snippet, plus related documentation links.
- URL state: compressed fragment state with gzip and standardized library naming around BelfrySCAD/BOSL2.
- Mobile and editor compatibility: disabled Monaco on iOS and improved the fallback/editor experience there.
- File resolution: fixed TS issues, stopped skipping NopSCAD tests, rendered files from their original path so relative imports would resolve correctly, and corrected bundled-file line offsets.

## 2023-10 to 2024-03

Dependency and packaging maintenance on the original app architecture.

- Styling: bundled PrimeReact CSS locally instead of relying on external links.
- Libraries: added `pathbuilder` and `openscad_attachable_text3d`.
- Runtime fix: repaired missing `src/wasm/openscad.js` resolution.

## 2023-03 to 2023-08

Initial public web playground launch.

- Foundation: created the first React + TypeScript application skeleton, established licensing files, and wired initial dependency download/build behavior.
- Editing and execution: added the Monaco-based SCAD editor with autocomplete, initial syntax checking, preview vs. full render flow, logs/widgets, and early filesystem/worker refactors.
- Viewer stack: introduced the original STL preview path via `react-stl-viewer`.
- State and UX: added URL-fragment state persistence, localStorage persistence for installed PWAs, mobile/iOS layout fixes, help/actions/settings UI, bundled examples, asset prefetching, library metadata, and download warnings.
- File handling: standardized running user work from `/home`, adjusted how bundled files were copied/executed, and repaired autocomplete and builtins coverage around those filesystem changes.
- Build and compatibility: switched the project to webpack, hardened WASM fetching, based downloads on the current SCAD filename, pinned PrimeReact for compatibility, and updated the WASM archive link.

## 2023-03-24

Project inception.

- Initial commit created the repository.
