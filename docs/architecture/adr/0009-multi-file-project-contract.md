# ADR 0009 — Multi-file project contract (text-first MVP)

**Status:** Accepted — the multi-file project contract item of #123 / Gate B.
Built as the host-drivable project/compiler API; the binary-asset scope decision
(#121) is recorded here.

## Context

Gate B (#123) needs a host-drivable project/compiler API so a future host (VS
Code webview, embed, MCP) can drive the engine deterministically. The app already
manages multiple files — `State.params.sources: SerializableSource[]` with
`activePath` as the entry point — but only through editor-driven methods
(`newFile` / `openFile` / `importProjectZip` / `set source`). What was missing is
a **typed, deterministic, headlessly-testable** contract independent of the UI.

ADR 0005 sketched the Layer-1 session ops (`setProject` / `updateFile` /
`removeFile` / `setEntryPoint` / `cancel`) as a **non-binding** target; ADR 0007
shipped the instance-scoped `OpenScadSession`; ADR 0008 added the terminal
`OperationResult` with immutable artifact identity. This ADR finalizes the
project ops on top of those.

## Decision

- **`ProjectContract`** = `setProject` / `updateFile` / `removeFile` /
  `setEntryPoint` / `cancel`, as typed **in-process methods on `OpenScadSession`**
  delegating to `Model`. Additive over the existing `sources` / `activePath`
  state — the editor and the existing file methods are unchanged.
- **Determinism** reuses the existing machinery — each op funnels through one
  `Model.mutate` (one revision bump, one `'state'` event) then drives
  `processSource`, so the supersession-seq + revision-stale-drop guards drop a
  superseded in-flight compile. No new locking. `removeFile` re-points the entry
  deterministically (`main.scad` → first `.scad` → first; a fresh empty file when
  the last one goes — `activePath` never dangles).
- **Observability.** Terminal `OperationResult`s (success-with-artifact, error,
  cancelled) are surfaced on the `Model`'s `'operation'` event, correlated on
  `operationId` (ADR 0008). `cancel()` kills the in-flight render/syntax/export
  jobs, each surfacing exactly one `cancelled` result and clearing its spinner.
- **Text files first; binary assets deferred (#121).** `ProjectFile.content` is
  `string` only; `setProject` / `updateFile` produce only `{kind:'text'}` sources,
  and `updateFile` refuses to overwrite a binary `local` asset.
- **No wire protocol yet.** The in-process binding **is** the contract. A future
  `src/protocol/session-transport.ts` maps the ADR-0005 envelope onto these
  methods 1:1 (`{type:'setProject'} → setProject(…)`, `opId ↔ operationId`,
  terminal `OperationResult → response`). Shipping a postMessage binding now —
  with no host consuming it — would be a consumer-less protocol.

### Why binary is deferred (the #121 decision)

OpenSCAD binary project assets (an `.stl`/`.png` referenced via `import()` /
`surface()`) are a **net-new feature**, not a regression: the byte-correct fetch
path was hardened in #120, but there is no end-to-end producer of binary project
_input_ (the editor reads text, the worker request carries text, the contract is
text). A text-`.scad` MVP unblocks the VS Code on-ramp now. The `ProjectFile`
shape **widens later without breaking** the text signatures — to a discriminated
`{ path; content: string } | { path; bytes: Uint8Array }` routed through the
existing `ProjectStore.addBinaryFile` + `materializeBinarySources` (ADR 0006).

## Consequences

- A stable, deterministic, headlessly-tested project API for the VS Code / embed /
  MCP on-ramp (the headless complete-project-operation test + the two-session
  isolation test both land with it).
- Binary project assets stay editor/ZIP-only (those paths unchanged); the contract
  cannot yet _add_ a binary file.
- Slices, each behavior-preserving + adversarially reviewed + merge-on-green:
  project mutators (#168), `cancel()` + observability (#169), session surface +
  headless capstone (#170).

## Migration & deploy safety

Additive: the existing editor / `newFile` / `importProjectZip` / `openFile` /
`set source` paths are byte-identical; the `'operation'` event has no UI listener;
the commit path (state mutations, object-URL revoke #145, completion chime, export
token #125/#149, revision stale-drop #56/#99) is unchanged. Same deploy bar as
ADR 0007/0008.
