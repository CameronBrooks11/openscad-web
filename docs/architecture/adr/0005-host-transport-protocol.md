# ADR 0005 — Host transport and session protocol

**Status:** Accepted for L0 (#126); L1 sketch is non-binding direction (#123)

## Context

The reusable `osc-geometry-viewer` is model-independent, so a read-only viewer can
be embedded in a VS Code webview (or any host). Doing that needs a host↔app message
transport. The existing embed protocol (`src/embed/protocol.ts`, ADR-less, #63) is
versioned, validated, origin-checked, and `requestId`-aware, but it is
iframe-specific, its message set is narrow (`setModel`/`setVar`/`getVars`/
`getArtifact`), and its acknowledgements fire immediately rather than on operation
completion — so a host cannot get a deterministic terminal result correlated to its
request. That is acceptable for a loosely-coupled embed UI but insufficient for a
VS Code project/compiler integration or an MCP tool call.

We want one logical protocol that a read-only viewer can use now and that grows into
a full host-neutral session protocol later, without a breaking rework — and without
continuing to expand the iframe-specific embed protocol.

## Decision

Define a **transport-agnostic, layered** protocol with a shared, versioned envelope.

### Envelope (shared by all layers and transports)

```
Inbound  (host → app):  { protocolVersion, type, opId?, sessionId?, ...payload }
Response (app → host):  { protocolVersion, type, opId, ok: true,  ...result }
                     |  { protocolVersion, type, opId, ok: false, code, reason }
Event    (app → host):  { protocolVersion, type, ...payload }   // uncorrelated
```

- `opId` correlates a **response** (the deterministic completion, not an early ack)
  to its request. Events (e.g. `camera-change`) carry none.
- `sessionId` is optional now (single session if omitted) and load-bearing in L1.
- Strict inbound validation, per-field size limits, and (for `postMessage`) an
  origin check — reusing the embed protocol's machinery, generalized into a shared
  `src/protocol/` core. The embed protocol rebinds onto that core; its message set is
  not expanded.

### Layer 0 — Viewer transport (built now)

Pure display; no compile, no artifacts.

- host→viewer: `setGeometry{offText}`, `setViewerSettings{color?,showAxes?,active?}`,
  `setCamera{camera}`, `dispose{}`.
- viewer→host: `ready{protocolVersion,capabilities}` (handshake),
  `geometry-loaded{thumbhash?}` (opt-in), `camera-change{camera}`,
  `error{code,reason,opId?}`.

Maps 1:1 onto `osc-geometry-viewer` (a new imperative `setCamera()` and a
`generateThumbnails` toggle). A dedicated viewer-only build entry implements the L0
host side with **no** Monaco, BrowserFS, OpenSCAD WASM, global `Model`, or service
worker.

### Layer 1 — Session protocol (non-binding sketch; finalized at Gate B, #123)

- Session: implicit per-connection or explicit `createSession`/`disposeSession`.
- Project: `setProject{files}`, `updateFile`, `removeFile`, `setEntryPoint`.
- Operations (each correlated, terminal): `syntaxCheck`, `preview`, `render`,
  `export{format}`, `cancel{opId}`.
- Queries: `getDiagnostics`, `getArtifact{artifactId}`, `getLogs`.
- Values validated by a shared `OpenScadValue` type before `-D` building (#122).
- Each committed output → `{artifactId, operationId, sourceRevision, format,
mediaType, size}`; `getArtifact(artifactId)` returns the exact bytes that op
  produced. L0's `setCamera`/viewer events are the viewer-facing subset of L1.

### Transport bindings

- **iframe / VS Code webview:** `postMessage` + origin/targetOrigin checks; the
  webview host is the same code as the iframe host.
- **MCP:** each L1 op → one tool; `opId` ↔ tool-call id; terminal response → tool
  result; `artifactId` for retrieval. (This is why L1 ops are request→terminal-
  response rather than ack+event.)
- **tests:** an in-process adapter calls the op handlers directly — no transport.

## Consequences

- The read-only viewer ships against a contract that does not need a breaking
  envelope change to become the full session protocol.
- The deterministic-terminal-response model fixes the embed protocol's ack-≠-
  completion and uncorrelated-`renderComplete` gaps before they become MCP input.
- One envelope/validation core, three+ bindings (embed, viewer, future session/MCP,
  tests). The embed protocol is preserved, not expanded.
- L1, sessions, artifact identity, and the backend topology remain parked behind
  Gate B/C (#123) — this ADR fixes only the shape so they slot in without rework.
