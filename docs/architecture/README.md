# Architecture overview

OpenSCAD Web is a fully client-side application: a Lit UI shell, a Monaco editor,
a Three.js viewer, and a persistent Web Worker that runs OpenSCAD compiled to
WebAssembly against a BrowserFS virtual filesystem. There is no server component.

This document describes how the pieces fit together and the dependency
boundaries the code is being shaped toward. It reflects the code as it is, and
calls out where a boundary is intended but not yet fully realized.

## Layers

```mermaid
flowchart TD
  subgraph hosts[UI hosts - Lit components]
    shell[osc-app-shell / embed / customizer shells]
    editor[osc-editor-panel - Monaco]
    viewer[osc-viewer-panel]
    footer[osc-footer]
  end

  subgraph state[Application state - src/state]
    model[Model - EventTarget controller]
    appstate[State / Source / app-state]
    fragment[fragment-state - URL persistence]
    urlmode[url-mode]
  end

  subgraph runner[Compile pipeline - src/runner]
    actions[actions - checkSyntax / render / buildOpenScadArgs]
    runnercore[openscad-runner - worker lifecycle, scheduler, timeouts]
    protocol[worker-protocol]
    parser[output-parser]
    worker[[openscad-worker - WASM in a Web Worker]]
  end

  subgraph core[Host-neutral core]
    diag[diagnostics]
    projpath[fs/project-path - path validation]
    fs[fs/filesystem - BrowserFS]
  end

  subgraph viewercore[Viewer core - src/components/viewer]
    three[ThreeScene]
    off[off-loader]
  end

  subgraph editorpkg[Editor package - src/language]
    lang[OpenSCAD language registration]
    adapter[diagnostic-markers - Diagnostic to Monaco]
  end

  hosts --> state
  state --> runner
  state --> core
  viewer --> viewercore
  editor --> editorpkg
  runner --> core
  actions --> parser --> diag
  editor --> diag
  footer --> diag
  adapter --> diag
```

## Module map

| Area             | Path                       | Responsibility                                                                                                                    |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap        | `src/index.ts`             | Parse boot mode, init BrowserFS, construct `Model`, mount the shell                                                               |
| State            | `src/state/`               | `Model` (central `EventTarget` controller), `State`/`Source`, URL persistence, url-mode, deep-mutate                              |
| Compile pipeline | `src/runner/`              | Worker lifecycle + scheduler + timeouts, arg building, the in-worker WASM driver, the worker protocol, stderr→diagnostics parsing |
| Diagnostics      | `src/diagnostics.ts`       | Host-neutral `Diagnostic` type + severity helpers                                                                                 |
| Filesystem       | `src/fs/`                  | BrowserFS canonical mounts, demand-loaded libraries, `project-path` validation                                                    |
| Runtime          | `src/runtime/`             | Asset URL resolution, bounded asset fetching, service worker, boot config                                                         |
| Viewer core      | `src/components/viewer/`   | `ThreeScene` (framework-free Three.js wrapper), OFF loader                                                                        |
| Editor package   | `src/language/`            | Monaco language registration, `Diagnostic`→Monaco marker adapter                                                                  |
| UI               | `src/components/elements/` | Lit components (shells, editor/viewer/customizer panels, footer)                                                                  |
| IO               | `src/io/`                  | OFF import, 3MF export, image hashing                                                                                             |

## Dependency boundaries

The cleanup epic is moving the codebase toward a clean separation between a
host-neutral core and the UI host(s). The current state of each rule:

- **No editor library in domain/runner.** ✅ Enforced by convention today —
  `src/state` and `src/runner` contain no `monaco-editor` import. Diagnostics
  flow as the host-neutral `Diagnostic` type; the editor converts to Monaco
  markers via `src/language/diagnostic-markers.ts` at its boundary.
- **Untrusted input is validated centrally.** ✅ `fs/project-path` validates and
  bounds imported archive paths; `runtime/fetch-asset` bounds and status-checks
  asset fetches; `external-source` enforces the URL policy; `actions.formatValue`
  validates customizer values before building `-D` args.
- **Viewer core is framework-free.** ✅ `ThreeScene` has no Lit/`Model`
  dependency. ⚠️ `osc-viewer-panel` still reaches into the global `Model`; making
  it a thin adapter over a model-independent `osc-geometry-viewer` is tracked in
  #60.
- **Domain is free of direct DOM access.** ⚠️ Not yet — `Model` plays the
  completion chime via `document`, and `utils` owns browser download/IO helpers.
  Extracting a web-host adapter is tracked in #59.

See the [ADRs](./adr/) for the decisions behind these boundaries, and
[compile-lifecycle.md](./compile-lifecycle.md) for how a compile flows end to end.
