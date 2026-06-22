# Compile lifecycle

A "compile" is any OpenSCAD invocation: a syntax/parameter check, a preview
render, a full render, or an export pass. They all flow through the same
pipeline and share one persistent Web Worker.

## Request flow

```mermaid
sequenceDiagram
  participant M as CompileCoordinator / ExportService
  participant A as actions (checkSyntax/render/renderExport)
  participant S as scheduler (turnIntoDelayableExecution)
  participant R as openscad-runner
  participant W as Web Worker (WASM)

  M->>A: render(args)({ now })  (revision stamped on the request)
  A->>S: debounce + supersede
  Note over S: prior delayed/running call is cancelled<br/>and its promise settled (rejected)
  S->>A: job() runs after the delay (or immediately if now)
  A->>R: spawnOpenSCAD(invocation, priority)
  R->>R: cancel lower-priority pending jobs
  R->>W: postMessage(CompileRequest, generation g)
  W->>W: FIFO queue — one compile at a time:<br/>fresh WASM runtime, mount libs, callMain (synchronous)
  W-->>R: stdout/stderr/result/error (tagged by id, revision echoed)
  R->>R: drop messages from a stale worker generation
  R-->>A: OpenSCADInvocationResults
  A->>M: RenderOutput { outFile, diagnostics, revision, ... }
  M->>M: apply only if still current (per-kind sequence + source revision)
```

## Scheduling and supersession

`turnIntoDelayableExecution` (`src/utils.ts`) debounces rapid calls and ensures
**every** returned promise settles exactly once — resolved, failed, or rejected
with a cancellation when superseded or killed. Each call owns its own timer and
canceller; the shared "live" canceller is identity-checked so a finished job
can't clobber a newer one. See [ADR 0003](./adr/0003-deterministic-scheduler.md).

Priorities (`syntax < preview < render < export`) let a higher-priority request
discard lower-priority **pending** jobs. Because `callMain` is synchronous, a
job already executing in the worker cannot be interrupted mid-flight.

Preview/render share one delayable instance; **export has its own** (so an
automatic preview can't supersede an in-progress format conversion, and export
is submitted at `export` priority). Inside the worker, a **serial FIFO queue**
runs exactly one compile at a time: the async setup of a job (FS init, library
mount, WASM creation, source fetch) cannot interleave with another's, and each
job's stdout/stderr callbacks close over its own request id and output buffer —
so concurrent requests can't cross-attribute output. A `cancel` message drops a
still-queued job; an actively-running synchronous `callMain` is uninterruptible.

## Timeout and worker recovery

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Busy: postMessage(compile)
  Busy --> Idle: result / error
  Busy --> Recycling: COMPILE_TIMEOUT_MS elapsed
  Recycling --> Idle: terminate worker, bump generation,<br/>reject pending, lazily recreate
```

A compile that produces no result within `COMPILE_TIMEOUT_MS` means the worker is
wedged (a synchronous `callMain` cannot be cancelled). The runner terminates the
worker, bumps a **generation** counter, rejects the pending jobs bound to that
generation, and lazily creates a clean worker on the next request. The generation
counter makes late messages from a terminated worker no-ops. See
[ADR 0002](./adr/0002-worker-timeout-recovery.md).

## Staleness defense (four layers)

A result can arrive after it is no longer wanted (user kept typing, switched
files, or triggered a higher-priority job). Stale results are dropped at four
independent layers:

1. **Worker generation** — messages from a terminated worker are ignored
   (`openscad-runner`).
2. **Scheduler settlement** — a superseded call's promise rejects rather than
   resolving with stale output (`turnIntoDelayableExecution`).
3. **Per-kind sequence guard** — `CompileCoordinator` (preview/render/syntax) and
   `ExportService` (export, via a `_exportSeq` token) apply a result only if it is
   still the latest call of that kind, so a stale call can't clobber the
   `previewing`/`rendering`/`checkingSyntax`/`exporting` flags a newer call owns.
4. **Source revision** — `Model.setState` bumps a monotonic source revision when
   `params.sources` changes; each preview/render request is stamped with the
   revision at request time and echoed back, and `CompileCoordinator` drops a
   result whose revision no longer matches. This catches the case where the
   sources changed but no newer compile of the same kind owns the spinner (e.g.
   after `newFile()`). See [ADR 0004](./adr/0004-defer-source-union.md).

## Arguments and diagnostics

`buildOpenScadArgs` (`src/runner/actions.ts`) is the single source of truth for
the OpenSCAD command line; every compile path builds through it.
`output-parser` turns OpenSCAD's stderr into host-neutral `Diagnostic`s, each
carrying the compiler-reported file `path`; the editor groups them by path and
applies each group to the matching Monaco model, so a multi-file project shows a
file's diagnostics on its own model. See
[ADR 0001](./adr/0001-host-neutral-diagnostics.md).
