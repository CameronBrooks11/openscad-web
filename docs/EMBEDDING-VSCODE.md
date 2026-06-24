# Embedding the viewer in a VS Code extension

This document is for the author of the **separate VS Code extension repo** that
shows OpenSCAD geometry in a webview. It describes how to consume the
distributable viewer artifact produced by this repo and how to speak its Layer-0
(L0) protocol. It is the host-neutral counterpart to [EMBED.md](./EMBED.md) (the
iframe/`postMessage` integration) — the **same `viewer.html` runs in both** an
iframe and a VS Code webview; only the transport binding differs, and it is
auto-selected at runtime.

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

## 6. Out of scope (future)

Live `.scad` preview (compile `.scad` → OFF and feed it to this same viewer host)
depends on a separate **session webview** build — see the live-`.scad` session
architecture issue. The read-only viewer host documented here is unchanged by
that later milestone.
