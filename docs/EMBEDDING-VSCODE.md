# Embedding the viewer in a VS Code extension

This document is for the author of the **separate VS Code extension repo** that
shows OpenSCAD geometry in a webview. It describes how to consume the
distributable viewer artifact produced by this repo and how to speak its Layer-0
(L0) protocol. It is the host-neutral counterpart to [EMBED.md](./EMBED.md) (the
iframe/`postMessage` integration) — the **same `viewer.html` runs in both** an
iframe and a VS Code webview; only the transport binding differs, and it is
auto-selected at runtime.

§1–5 cover the **read-only viewer** (L0). [§6](#6-the-session-compile-artifact)
covers the separate **compile-capable session artifact** (`dist-session`) that runs
the OpenSCAD WASM engine in the webview and speaks the Layer-1 (L1) session
protocol — vendor it instead of the viewer when you need live `.scad` compilation.

The extension itself is a **separate codebase**. The boundary between the two
repos is exactly: the built viewer assets + the L0 protocol. Nothing in this repo
depends on VS Code (`@types/vscode` is not a dependency), and the extension never
loads viewer code from GitHub Pages or `main` at runtime — it **vendors a pinned
artifact**.

See: [ADR 0005](./architecture/adr/0005-host-transport-protocol.md) (the transport
protocol), the read-only viewer epic (#143).

---

## 1. The distributable artifact

```bash
npm run build:viewer   # in this repo → dist-viewer/
```

`dist-viewer/` is the artifact, intentionally minimal (~0.6 MB, mostly Three.js):

```
dist-viewer/
├── viewer.html                 # relative asset URLs (./assets/…) — webview-safe
├── assets/
│   ├── viewer-<hash>.js         # the viewer entry + controller + transports
│   └── three-<hash>.js          # Three.js
├── protocol/                    # the L0 protocol, compiled for the extension
│   ├── index.js / index.d.ts    # the barrel — import these
│   ├── viewer-transport.js / .d.ts
│   └── envelope.js / .d.ts
└── viewer-manifest.json         # versioned, hashed integrity manifest
```

It contains **no** Monaco, BrowserFS, OpenSCAD WASM, service worker, or app
shell, and **no** OpenSCAD library zips — the viewer needs none of them at
runtime (enforced by `scripts/verify-viewer-bundle.mjs`). The build uses a
**relative base** (`./assets/…`) so the assets resolve under an opaque
`vscode-webview://…` origin; the Pages build's absolute `/openscad-web/…` URLs
would not.

### `viewer-manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "viewerVersion": "0.1.0",        // this repo's package version
  "protocolVersion": 1,            // VIEWER_PROTOCOL_VERSION (the pin)
  "sourceCommit": "<sha>",         // + "-dirty" if built from an unclean tree
  "builtAt": "<iso8601>",
  "files": {                       // every shipped file (excl. the manifest)
    "viewer.html": { "bytes": 870, "sha256": "…" },
    "assets/viewer-<hash>.js": { "bytes": …, "sha256": "…" },
    "protocol/index.js": { "bytes": …, "sha256": "…" }
    // …
  },
  "allowlist": ["assets/", "protocol/", "viewer.html", "viewer-manifest.json"]
}
```

**On ingest, the extension should assert:** the manifest's `protocolVersion`
matches the `VIEWER_PROTOCOL_VERSION` it imported, every shipped file is on the
`allowlist`, and every `sha256` recomputes. That makes a corrupt/partial copy or
a version skew fail loudly at build/test time rather than at runtime.

### How the extension obtains the artifact

Pick one; pin to a `sourceCommit` + the hashes either way:

- **Git submodule** of this repo + run `npm run build:viewer` in CI, copy
  `dist-viewer/` into the VSIX.
- **Release asset** — zip `dist-viewer/` and attach it to a tagged release; the
  extension downloads + verifies the manifest at build time (not at runtime).
- **Vendored copy** — commit `dist-viewer/` into the extension repo, refreshed by
  a script that re-runs `build:viewer` and checks the manifest.

Do **not** download viewer code at activation, load it from Pages, or let the
viewer and protocol versions float independently.

---

## 2. Loading `viewer.html` in a webview

```ts
const panel = vscode.window.createWebviewPanel('openscadViewer', 'OpenSCAD Viewer', column, {
  enableScripts: true,
  // Restrict the webview to the packaged viewer dir only.
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'viewer')],
  // Default OFF: on reveal, re-push geometry (cheap, it lives extension-side) +
  // camera. Enable only if profiling shows re-render latency is unacceptable.
  retainContextWhenHidden: false,
});
```

### Asset URLs

`viewer.html` ships **relative** URLs, so either:

- **`<base href>`** (simplest): inject `<base href="${webview.asWebviewUri(viewerDir)}/">`
  (trailing slash required) into the HTML before assigning it. The `./assets/…`
  URLs and the ES-module import graph then resolve against the webview resource
  root.
- **Per-URL rewrite**: replace each `src`/`href` with
  `webview.asWebviewUri(Uri.joinPath(viewerDir, relPath))`.

### CSP

A strict, per-load-nonce CSP works; note the directives the viewer actually needs
(and one it does **not**):

```
default-src 'none';
script-src ${webview.cspSource} 'nonce-${nonce}';
style-src ${webview.cspSource} 'unsafe-inline';
img-src ${webview.cspSource} data: blob:;
connect-src ${webview.cspSource};
```

- **No `wasm-unsafe-eval`** — the viewer bundle contains no WASM (gate-enforced).
- `style-src … 'unsafe-inline'` is required: `viewer.html` has an inline `<style>`
  block and the Lit/Three components set inline styles.
- `img-src … data: blob:` covers canvas/texture data URLs.

---

## 3. The transport (auto-selected)

`viewer.html` picks its transport at runtime: it uses the **VS Code webview
binding** when `acquireVsCodeApi` is present, else the iframe parent-frame
binding. You do **not** configure this — just load the page in a webview.

The webview binding sends with `acquireVsCodeApi().postMessage(...)` and receives
`window` `message` events with **no origin/sender check** — the webview channel
itself is the trust boundary (the extension host is the only sender). The viewer
still validates every payload against the protocol, so malformed messages are
rejected with a correlated `error`.

On the extension side: `panel.webview.postMessage(msg)` to send,
`panel.webview.onDidReceiveMessage(handler)` to receive.

---

## 4. Speaking the L0 protocol

Import the types + the version pin from the vendored protocol:

```ts
import { VIEWER_PROTOCOL_VERSION, type ViewerInbound } from '<vendored>/protocol/index.js'; // .d.ts ships alongside
```

### Handshake (avoid the listen-before-ready race)

The viewer posts `ready` as the **last** step of init (after its listener is
attached). **Wait for `ready` before the first `setGeometry`** (or queue outbound
messages until it arrives) — it is the only race-free signal the page's listener
is live. Assert the version on `ready`:

```ts
panel.webview.onDidReceiveMessage((m) => {
  if (m.type === 'ready') {
    if (m.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
      // version skew — surface a clear error; do not proceed.
      return;
    }
    // m.capabilities: ['setGeometry','setViewerSettings','setCamera','setNamedView','dispose']
    sendGeometry(offText);
  }
});
```

### Messages

All messages carry `protocolVersion`; inbound may carry `opId` / `sessionId` for
correlation.

**Host → viewer (inbound):**

| Type                | Payload                                                                      | Notes                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `setGeometry`       | `{ offText }`                                                                | OFF text (≤ 64 MiB). Acked `geometry-set`; render outcome follows.                                                      |
| `setViewerSettings` | `{ color?, showAxes?, active?, background?, showControls? }`                 | Only provided fields apply. Acked `viewer-settings-set`.                                                                |
| `setCamera`         | `{ camera: { position:[x,y,z], target:[x,y,z], zoom } }`                     | Raw pose. Acked `camera-set`.                                                                                           |
| `setNamedView`      | `{ view }` (`VIEWER_NAMED_VIEWS`: Diagonal/Front/Right/Back/Left/Top/Bottom) | **Fit-aware** preset — frames the model to its bounds viewer-side (no host-side bounds needed). Acked `named-view-set`. |
| `dispose`           | `{}`                                                                         | Tears down the viewer. Acked `disposed`.                                                                                |

**Viewer → host (outbound), all `protocolVersion`-stamped:**

| Type                                              | Payload                   | Meaning                                                                                                                               |
| ------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                                           | `{ capabilities }`        | Init complete; handshake signal.                                                                                                      |
| `geometry-set`                                    | `{ opId? }`               | `setGeometry` **accepted** (parse/render follows).                                                                                    |
| `geometry-loaded`                                 | `{ thumbhash?, opId? }`   | Geometry rendered (terminal, correlated to the `setGeometry` opId).                                                                   |
| `viewer-settings-set` / `camera-set` / `disposed` | `{ opId? }`               | Synchronous acks.                                                                                                                     |
| `camera-change`                                   | `{ camera }`              | User orbited/zoomed (unsolicited).                                                                                                    |
| `error`                                           | `{ code, reason, opId? }` | A rejected message (e.g. `unsupported-version`, `invalid-payload`) or a `render-error` (malformed OFF), correlated to the failing op. |

So a geometry round-trip is: `setGeometry` → `geometry-set` (accepted) →
`geometry-loaded` (rendered) **or** `error` `render-error` (bad OFF).

> **OFF input is currently trusted geometry from your own pipeline.** Before
> exposing arbitrary user `.off` files, harden the OFF parser (validate counts /
> face indices / vertex+triangle budgets) and reduce the size limit — see the
> epic's notes.

---

## 5. The Extension Development Host smoke test

Use `@vscode/test-electron`. Assert the **message round-trip**, not pixels:
post a fixture OFF, expect `geometry-set` then `geometry-loaded` (or a known
`error`). A successful round-trip exercises the real Three.js render path without
a pixel readback.

WebGL headless caveat (current): Chromium ≥ 130 dropped the automatic SwiftShader
fallback, so headless CI needs `--enable-unsafe-swiftshader` /
`--use-angle=swiftshader` (under `xvfb-run` on Linux). Make the gate tolerant of
GL-unavailable runners — assert the round-trip reaches _either_ `geometry-loaded`
_or_ a known `error` — and reserve the strict `geometry-loaded` assertion for a
GPU-capable job.

---

## 6. The session (compile) artifact

Everything above is the **read-only** viewer: the extension already holds OFF
geometry and just displays it. To compile `.scad` **inside** the webview — feed it
a project, get geometry back — vendor the separate **session artifact**
(`dist-session`, built by `npm run build:session`, gated by
`scripts/verify-session-bundle.mjs`). It is the compile-capable sibling of
`dist-viewer`: same relocatable, relative-URL, vendor-and-pin model, but it carries
the OpenSCAD WASM + compile worker + BrowserFS and an **embedded** geometry viewer.

Why a second artifact and not a flag on the viewer: the viewer artifact is
gate-enforced to contain **no** WASM/worker/BrowserFS (so its CSP can stay strict);
the session artifact is gate-enforced to contain them (and to **not** leak the
editor shell or a service worker). The two never merge.

### What it ships

```
dist-session/
  session.html                 # entry; relative URLs (load exactly like viewer.html)
  assets/                       # session chunk, three, openscad.wasm, openscad-worker-*.js
  libraries/                    # OpenSCAD library zips + fonts.zip (fetched at compile time)
  protocol/                     # the L1 session protocol, compiled (session.js + .d.ts)
  session-manifest.json         # hashed integrity manifest (verify like viewer-manifest.json)
```

`session-manifest.json` mirrors `viewer-manifest.json` (§1): `schemaVersion`,
`sessionVersion`, `protocolVersion` (the `SESSION_PROTOCOL_VERSION` source of
truth), `sourceCommit`, per-file `sha256`, and an `allowlist`. Verify it on ingest
the same way — it covers the multi-MB WASM and the zips, so a corrupt or
partial vendor is caught before load.

### Loading + CSP (the deltas vs the viewer)

Load `session.html` exactly as `viewer.html` (§2): inject a `<base href>` for the
relative URLs, restrict `localResourceRoots` to the session dir. Prefer
`retainContextWhenHidden: true` here — a live compile session holds worker + WASM +
FS state that is expensive to rebuild on every reveal.

The CSP needs two directives the viewer's does **not**, because this bundle
actually compiles WASM in a worker:

```
default-src 'none';
script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';
worker-src blob:;
style-src ${webview.cspSource} 'unsafe-inline';
img-src ${webview.cspSource} data: blob:;
connect-src ${webview.cspSource};
```

- **`'wasm-unsafe-eval'`** — required to `WebAssembly.instantiate` the OpenSCAD
  engine (the viewer needs none).
- **`worker-src blob:`** — the worker is instantiated from a same-origin `blob:`
  URL. Under a webview the packaged worker/asset URLs are cross-origin to the
  `vscode-webview://` document, so `new Worker(crossOriginUrl)` is SOP-blocked; the
  bundle instead `fetch`es the worker script (allowed) and runs it from a blob.
- **`connect-src ${webview.cspSource}`** covers the runtime `fetch`es of the worker
  script, the `.wasm`, and the library zips — all from the session dir.
- **No COOP/COEP headers.** The engine is single-threaded WASM (no
  `SharedArrayBuffer`), so cross-origin isolation is **not** required — do not add
  them.

### Speaking the L1 session protocol

Import from the vendored session protocol (not the viewer's `index.js`):

```ts
import { SESSION_PROTOCOL_VERSION, type SessionInbound } from '<vendored>/protocol/session.js'; // .d.ts ships alongside
```

The handshake is the same shape as §4: wait for `ready` (its `capabilities` are the
inbound command names) and assert `protocolVersion === SESSION_PROTOCOL_VERSION`
before sending. Then **drive a project** rather than push geometry:

- **Host → session:** `setProject { files:[{path,content}], entryPoint? }`,
  `updateFile { path, content }`, `removeFile { path }`, `setEntryPoint { path }`,
  `cancel`, `dispose`.
- **Session → host:** `ready`, `operation-result { result }` (a **push stream** —
  one edit fans out to multiple terminal results; correlate by the nested
  `result.operationId` / `kind` / `sourceRevision`, **not** 1:1 with commands),
  and `error { code, reason }`.

Geometry is **not** sent over the wire: the session renders it **in-process** into
its embedded viewer. The `operation-result` carries an `artifact` _reference_
(id + format), not bytes; retrieving exported bytes (STL/3MF) to save to disk is a
later, separate message (tracked by the export issue in the epic).

> Compiling arbitrary `.scad` runs the full OpenSCAD engine on host-supplied input.
> Push only files the user opened/trusts; the protocol caps file count/size, but
> the compiler itself is the trust boundary.
