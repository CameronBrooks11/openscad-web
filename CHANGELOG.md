# Changelog

Formal versioned releases are tracked below, newest first. History before `0.2.0`
was backfilled from git on 2026-03-15 and is grouped by delivery window rather than
release (changelog upkeep and tagging had lapsed between `0.1.0` and `0.2.0`).

## [Unreleased]

### Fixed

- OFF import: canonical multi-line headers (`OFF` on its own line, counts on the
  next — as emitted by Meshlab and many tools) are no longer rejected with
  "invalid vertex or face counts". The same-line form (`OFF 8 6 12`, as OpenSCAD
  exports) is unchanged.

### Added

- L1 session protocol (`src/protocol/session-transport.ts`, #191): a host-neutral
  wire protocol for driving an `OpenScadSession`'s `ProjectContract` from a webview
  — `setProject`/`updateFile`/`removeFile`/`setEntryPoint`/`cancel`/`dispose`
  inbound, with validation + DoS caps, and a push-stream `operation-result`
  outbound. Versioned by `SESSION_PROTOCOL_VERSION` (distinct from the result
  payload's `L1_PROTOCOL_VERSION`). The DOM-free L1 data types (`OperationResult`
  family, `Diagnostic`, `ArtifactRef`, `ProjectFile`) moved into
  `src/protocol/session-contract.ts` (re-exported from their prior homes) so the
  protocol stays self-contained and distributable.
- L0 protocol: a fit-aware `setNamedView` inbound message (`VIEWER_NAMED_VIEWS`:
  Diagonal/Front/Right/Back/Left/Top/Bottom) that frames the model to its bounds
  viewer-side, so a host (e.g. a VS Code extension) can offer camera presets
  without knowing the geometry's scale. Additive — advertised in
  `ready.capabilities`, no protocol-version bump. [#188]

## [0.2.0] - 2026-06-23

The first release since versioning lapsed at `0.1.0` (2026-04-05) — it captures ~127
merged PRs. Headline work: the foundation for a read-only VS Code geometry viewer
(host-neutral viewer + Layer-0 protocol, distributable as a pinned artifact), an
instance-scoped multi-session compile engine, a large `Model` decomposition, and a
broad correctness/security hardening pass. The app still self-describes as Alpha;
each merge continues to auto-deploy to GitHub Pages.

### Added — read-only viewer foundation

- Layer-0 viewer transport over a shared envelope/validation core, versioned by `VIEWER_PROTOCOL_VERSION` (ADR 0005). [#133, #134]
- Model-independent `osc-geometry-viewer` with imperative `setCamera`, optional thumbnails, theme CSS vars, and `background`/`showControls` settings. [#135, #140, #181]
- `ViewerController` + pluggable transports (iframe parent, VS Code webview, in-process), with correlated acks and `event.source`/origin hardening. [#141, #142, #180, #182]
- Standalone, distributable viewer build (`build:viewer`) with a hashed integrity manifest, the L0 protocol exported as a portable artifact, and a VS Code embedding guide. [#136, #183, #184, #185]

### Added — multi-session engine & Layer-1 contract (Gate B)

- Instance-scoped `OpenScadSession` replacing the global model singleton, with per-session compile schedulers and WASM worker backends, plus a two-session isolation capstone (ADR 0007). [#154, #156–#160]
- Layer-1 compile contract with stable artifact identity, a per-session artifact store, `getArtifact` by id, terminal `OperationResult`s, a project-mutation API, and `cancel()` (ADR 0008). [#161–#171]

### Added — product features

- OFF→GLB export via Three.js `GLTFExporter`. [#118]
- Binary-asset import end-to-end (read-only in the editor, excluded from syntax inputs). [#152, #155]
- Versioned, validated `postMessage` embed protocol with origin hardening; URL-fragment round-trip of backend/autoCompile/camera. [#92, #115]
- PWA update-available reload prompt instead of a forced reload. [#79, #93]

### Changed — architecture & refactors

- Decomposed the monolithic `Model` into `ProjectStore`, `ExportService`, `CompileCoordinator`, `LayoutController`, a `HostAdapter` side-effect seam, and typed `ProjectSource` unions; scoped persistence to a debounced durable-state seam. [#88–#105, #166, #167]
- Domain code now depends on a narrow `ProjectFileSystem`; diagnostics are host-neutral (Monaco removed from the domain). [#81, #97]
- Enforced architectural import boundaries and a no-DOM rule for the compile/state engine via lint; boot chunk-splitting (Monaco/Three) + deferred shell imports; semantic color-token palette. [#106, #107, #108, #109]

### Fixed — robustness, lifecycle & correctness

- Runner: recover a wedged worker on timeout, deterministic debounce/supersede, split queue-wait vs execution budgets, per-job output routing, source-revision stamping to drop stale results. [#72, #73, #99, #111, #139]
- Compile/export: recheck staleness after data-url reads, revoke leaked blob URLs, dedicated export channel, cancel in-flight render on supersede, settle every terminal path. [#112, #117, #127, #130, #149]
- State/persistence: flush on tab hide/close, roll back deep mutations on throw, revoke object URLs on manual download. [#145, #147, #148]
- Editor/diagnostics: paste via Ctrl/Cmd+V, dispose project-scoped Monaco models, route markers per model/source path. [#70, #116, #129, #146]
- Service worker: order the CacheFirst large-asset route before the broad stale-while-revalidate. [#144]

### Security

- Validate and bound imported ZIP archives; enforce import size limits while streaming (not after buffering); harden runtime asset fetches; validate customizer values before building `-D` args. [#75, #76, #77, #150]

### Build, CI & tooling

- Unified `ok` CI gate + conservative dependabot auto-merge; gzipped bundle-size budgets; per-module coverage thresholds; Firefox e2e smoke matrix + nested-ZIP project e2e; routine dependency updates. [#87, #94, #96, #151]

### Docs

- Architecture/boundary/lifecycle docs and ADRs 0005/0007/0008 (+ project-contract decisions); service-worker precache rationale. [#84, #114, #131, #132, #154, #161, #171]

### Chore

- Removed the last fork-me ribbon remnant and neutralized the default model's welcome comment. [#186]

## [0.1.0] - 2026-04-05

Tagged release snapshot; no changelog was recorded at the time. The backfilled
history below covers the work it contained.

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
