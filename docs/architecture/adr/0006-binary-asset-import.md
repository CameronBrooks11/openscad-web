# ADR 0006 — Binary-asset import (FS-backed `local` sources)

**Status:** Accepted — implements the deferred feature from ADR 0004 / #121.

## Context

OpenSCAD models can reference non-`.scad` binary assets: `import("part.stl")`,
`surface("height.png")`, `import("data.dxf")`, etc. The byte path was hardened in
#120 (`fetchSource` passes `Uint8Array` through uncorrupted; `WireSource` allows
binary `content`; `BinarySource`/`LocalSource` exist in the union), but nothing
**produces** a binary source end to end, so such models fail to compile.

Two facts constrain the design:

1. **Serialization is deploy-critical and text-only.** `fragment-state` encodes
   sources into shareable model URLs and persisted `state.json` (JSON). A
   `BinarySource` (in-memory bytes) cannot be JSON-serialized and must never
   reach that boundary — `SerializableSource = Exclude<ProjectSource, BinarySource>`
   already enforces this at the type level (ADR 0004).
2. **The worker FS is fresh per job.** Each compile gets a new WASM instance whose
   FS mounts only `/libraries` + `/fonts` (read-only ZipFS). A `local` source
   under `/home` (content lives on the _host_ BrowserFS, not inlined) currently
   reaches the worker content-less, so the worker's FS has no such file and the
   `import(...)` fails (`openscad-worker.ts` logs "File … does not exist").

## Decision

Model binary assets as **FS-backed `local` sources**, consistent with how
`#path=` deep-link files already work — bytes live on the host BrowserFS at the
source's `path`; the source object carries only `{ kind: 'local', path }`.

The byte path is the delicate part. An adversarial design review plus an
empirical BrowserFS test established the corrections below; the high-level
decision is unchanged but the corruption traps it routes binary through must all
be fixed together (a half-done version silently mangles assets):

- **BrowserFS needs a `Buffer`, not a bare `Uint8Array`.** Verified empirically:
  `fs.writeFile(path, uint8array)` writes **all-zero** bytes, and
  `fs.writeFileSync(path, uint8array)` throws; only `fs.writeFile(path,
BFSRequire('buffer').Buffer.from(uint8array))` round-trips byte-exact. So the
  byte write is done by a small **fs-layer** helper (`writeBytes`) that performs
  the `Buffer.from` conversion using BrowserFS's own `Buffer` — domain code never
  touches BrowserFS internals. `ProjectFileSystem` gains an optional
  `writeBytes(path, Uint8Array)`; `writeFile` stays text.
- **Import must read bytes, not a UTF-8 string, for binary entries.** `importZip`
  currently decodes every entry via `internalStream('string')` (a lossy
  `TextDecoder`, budget in UTF-16 units). Binary entries instead stream through a
  byte reader (`internalStream('uint8array')`, budget in `byteLength`) and are
  written via `writeBytes`; the source recorded is `local`.
- **Classification leans binary for the unknown.** A shared `isProbablyTextPath`
  predicate (lower-cased extension; known text set `.scad/.txt/.csv/.json/.svg/…`)
  decides text vs. binary. Anything unknown is treated as **binary**, because
  misclassifying binary-as-text corrupts silently while text-as-binary is
  harmless (the exact bytes still land on the FS and `import()` reads them; only
  the in-editor text view is lost).

The concrete consumer changes, then, are:

1. **`openLocalFile` gains a binary path.** Today it is `.scad`-only
   (`file.text()`, picker `accept` `{'text/plain': ['.scad']}`). It widens to read
   `file.arrayBuffer()` for non-text files, widen the picker filter, and route the
   bytes through the binary-aware import path.

2. **`processSource` must not text-decode a binary active source.** The
   coordinator currently materializes any content-less active source via
   `TextDecoder().decode(...)` and writes it back as a `text` source. A binary
   `local` active file (e.g. the user selects an imported `.stl`, or
   `openFileViaFSAPI` makes it active) must be **skipped** here — treated like
   `archive`: left content-less so its bytes flow through the worker-transfer path
   instead of being decoded to garbage.

3. **The compile coordinator materializes referenced `local` `/home` sources.**
   Each `local` source whose path is **not** under `/libraries`/`/fonts` (a
   user-project file the worker's fresh FS lacks) has its bytes read from the host
   FS (`fetchSource`) and attached as `WireSource` `content: Uint8Array`. This runs
   on the **final** `sources` array — _after_ the non-`.scad` active-file wrapper
   (which replaces `sources` with `[loader, ...filtered]`) — so the kept binary
   asset is materialized. Library/font `local` sources stay content-less (the
   worker has them via read-only mounts). The worker side is unchanged: it already
   writes received bytes via `fetchSource` → `writeFile`.

   **Structured clone, not transferable.** The request is sent by plain
   `postMessage` (copy). The bytes must NOT be added to a transfer list:
   `asUint8Array` returns a view aliasing BrowserFS's internal buffer, so
   transferring would detach and corrupt the host FS's copy — fatal since the FS
   is re-read every (fresh) job. The copy cost is real (a referenced asset is
   re-sent on every compile, bounded by the source-size caps from #150); accepted
   as the cost of the per-job-FS model.

4. **A missing `/home` asset is a loud, user-facing error.** If a non-mount
   `local` source has no bytes on the host FS (a shared-URL/`state.json` reload
   carries the path but not the bytes), the coordinator surfaces an explicit
   "asset not available" error rather than letting the worker log a cryptic
   `console.error` and compile a broken model.

5. **Serialization is untouched.** A binary asset serializes as a `local` source
   = `{ path }` only (no bytes), exactly like an on-disk `#path=` file. The
   shareable-URL / `state.json` shape is byte-identical to today; no migration.

## Consequences

- **Binary assets behave like `local` sources:** present in the session and, in
  standalone mode, on the persisted BrowserFS; **not** embedded in shareable URLs
  (a fresh load from a shared URL has only the path, not the bytes). This matches
  existing `local`/`#path=` semantics and keeps shared URLs small and text-only.
  Embedding bytes in URLs (base64) is explicitly rejected — it bloats URLs and
  re-introduces binary into the text-only serialization boundary.
- The worker transfer carries asset bytes per job (the FS is fresh each time);
  this is unavoidable given the per-job FS model and bounded by the existing
  source-size limits.
- No UI affordance imports a project yet (the editor's "Upload" item is disabled),
  so the first consumer is `importProjectZip` + tests; a future import button
  reuses the same path.

## Alternatives considered

- **Session-only `BinarySource` in state.** Simpler (no FS write), but binary is
  lost on reload even in standalone mode, and a `BinarySource` in `state.params`
  risks leaking into the serialization boundary (the type exclusion would have to
  be defended at every call site). Rejected for fragility on the deploy-critical
  path.
- **Base64 in the URL fragment.** Rejected (see Consequences).
