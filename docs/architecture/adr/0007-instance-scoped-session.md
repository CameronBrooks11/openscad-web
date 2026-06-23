# ADR 0007 — Instance-scoped `OpenScadSession` (Gate B core)

**Status:** Proposed — design pass for #123, pending approval before implementation.
Revised after an adversarial design review (scope narrowed; scheduler/perf/provider
corrections folded in).

## Context

Everything that drives a compile is **module-level singleton state**, so the app
can run exactly one logical session:

- **`model-context.ts`** — a single `_model`; `setModel()` once at boot,
  `getModel()` from ~13 Lit elements' `connectedCallback` across three boot modes
  (app / customizer / embed, `index.ts:76-159`).
- **`openscad-runner.ts`** — module-level `_pending` map, `_nextId`, `_worker`,
  `_workerGeneration`, `_firstCompileRequested/Completed`, and the queue/exec
  timeout timers (#137/#139). One worker, one id space, one pending map per page.
- **`actions.ts`** — `checkSyntax` / `render` / `renderExport` are module-level
  `turnIntoDelayableExecution(...)` instances; each closes over its own
  `cancelLive`, so a newer call cancels the previous one **globally**.

Two independent sessions on one page (the Gate B target) would cross-cancel each
other's compiles, collide in the shared id space, and read each other's pending
entries. This is the **deploy-critical compile path** — every preview/render
flows through it and merges auto-deploy live — so the refactor must preserve
single-session behavior byte-for-byte while making N sessions _possible_.

Gate A (the read-only viewer transport, ADR 0005) shipped and does not depend on
this — it needs no compile.

## Scope (deliberately narrow)

This ADR covers **only session isolation** — the load-bearing core of Gate B:
make N independent compile sessions possible, with real teardown. The other
#123 items are genuinely independent refactors with a _different_ blast radius
(serialization / migration, not session lifetime) and are **deferred to their
own ADRs** so they don't ride along on this one:

- **Layer-1 `CompileCommand`/`CompileResult` contract + immutable artifact
  identity** → future ADR. Not needed for isolation; per-session workers already
  correlate by `request.id` within their own serial queue.
- **Shared `OpenScadValue` type/validator + persisted `schemaVersion`** → future
  ADR. These touch URL / embed / **persistence serialization** — the ADR-0004
  deploy-safety surface — and deliver zero isolation value.

Kept here (it _is_ the session): the **in-memory** State-container split that
extracts the session-owned slice. It does **not** change the persisted/fragment
shape.

## Decision

Introduce an instance-scoped **`OpenScadSession`** owning all compile state,
behind a `CompileBackend` boundary, migrated in behavior-preserving slices. A
single default session is constructed at boot, identical to today; the point is
that _nothing_ is module-global, so a second session is fully isolated and can
be torn down.

### Ownership target

```
OpenScadSession
├── model: Model                                  // session-owned domain state
├── backend: CompileBackend                       // the WASM-worker engine instance
└── schedulers: { syntax, render, export }        // exactly three (see below)
```

**Schedulers — exactly three, mirroring today's delayables.** Preview and full
render deliberately share ONE `render` delayable so they supersede each other
("only one geometry compile live at a time", `actions.ts:309-311`;
`CompileCoordinator.render` drives both through it, `compile-coordinator.ts:265`).
`renderExport` is a **distinct** instance so an auto-preview never cancels an
in-flight export (and the #149 export-kill ownership, already per-`Model` on
`ExportService._activeRender`, is preserved). The session therefore owns
`{ syntax, render (=preview+full, shared), export }` — NOT a separate preview
scheduler, and `render` ≠ `renderExport`.

### `CompileBackend` interface (the engine boundary)

The browser-WASM runner becomes one _instance_ implementing this; a future
native backend implements the same shape without touching callers:

```ts
interface CompileBackend {
  spawn(invocation: OpenSCADInvocation, onStreams, priority): AbortablePromise<Results>;
  cancel(id: string): void;
  dispose(): void; // terminate worker, clear timers, reject pending — real teardown
}
```

`WasmWorkerBackend` holds what are today the module globals — its own `Worker`,
`pending`, `nextId`, `generation`, and the queue/exec-timeout timers (#137/#139
logic moves in unchanged). `dispose()` makes session teardown real (today the
worker leaks for the page lifetime).

**Page-global boot metrics stay page-global.** `_firstCompileRequested/Completed`
gate the once-per-page perf marks (`osc:first-compile-*`, and the
`app-bootstrap` measure against `index.ts:69`'s start). These must NOT become
per-session — a second backend would re-fire the page-global mark names and
re-measure boot against a start that already happened. Keep a page-global
"first compile of the page" guard for the boot marks, separate from any
per-session bookkeeping.

## Implementation strategy — behavior-preserving slices

Each slice is a separately-reviewable, merge-on-green PR; the default singleton
session keeps the app identical until the provider slice. Ordered by risk:

1. **`WasmWorkerBackend`** — wrap the module-level runner state in a class.
   `spawnOpenSCAD`/`cancelJobById` stay as module functions delegating to a
   default instance, so `worker-timeout.test.ts` and `compile-pipeline.test.ts`
   pass **unmodified**. The _entire_ timer cluster (`armQueueTimer`,
   `failTimedOutJob`, `handleWorkerMessage` with the `generation` stale-guard and
   the peer re-arm loop, `recycleWorker`, `getWorker`) flips to `this.*`
   atomically — no callback may retain a module reference (split-brain). Add a
   test asserting two backends have independent `pending` / `nextId` /
   `generation`. _Largest blast radius (every compile), but mechanically simple
   and the best-covered slice._
2. **Per-session schedulers** — move the three delayables off module scope into
   the session, consumed by `CompileCoordinator` / `ExportService` (already
   per-`Model`, so this achieves per-model scheduler isolation on its own). Keep
   `render` and `renderExport` distinct.
3. **`OpenScadSession` + provider** — owns backend + schedulers + Model. Replace
   the `getModel()` global-default with a real provider (Lit `@lit/context` or a
   `context-request` DOM-ancestor lookup): one root provider per shell whose
   default resolves to the same singleton (byte-identical single-session
   behavior). Migrate **all ~13 consumers in this one slice** — no lingering
   global fallback — and make resolution **throw when ambiguous** rather than
   silently binding to a default (a silent bind to the wrong session is the exact
   leak Gate B prevents). Add a per-boot-mode (app/customizer/embed) smoke test.
   _Highest deploy-regression likelihood — weakest existing coverage, rewires
   live UI across three boot modes._
4. **In-memory State-container split** — extract the session-owned slice
   (sources / active / output / diagnostics / revision) into `OpenScadSession`,
   leaving view/layout/persistence and the persisted shape untouched.
   **Resolution (2026-06-23): satisfied by current session ownership; no separate
   State-container split required.** `OpenScadSession` owns the session's `Model`,
   compile backend, schedulers and artifacts, and the two-session isolation test
   proves that state and execution do not cross session boundaries. A further
   structural split would touch the UI and persistence surfaces without adding
   functional isolation. Revisit only when a concrete consumer requires
   independently managed state slices.
5. **Isolation tests** — two independent sessions: a cancel / diagnostic /
   artifact in one must not affect the other; plus one headless complete project
   operation. (Must land with slice 3 — the session is unobservable without it.)

## Consequences

- Real session teardown (`dispose()`) — fixes the page-lifetime worker leak.
- A native `CompileBackend` becomes a drop-in later (without this ADR's scope).
- **N persistent workers cost.** Each session keeps its own `Worker` +
  BrowserFS + library/font mounts for its lifetime (the per-job WASM instance
  recreation is _not_ the cost; N idle workers + N mount caches + N first-compile
  warmups are). Scope assumption: **N is a small handful**. If N ever grows,
  add idle-reclaim wired to the new `dispose()` — out of scope here, noted.
- `operationId` is per-session today (safe: each session owns its worker, which
  correlates by `request.id` in its own serial queue). When the deferred Layer-1
  / artifact-identity ADR lands, switch to globally-unique (UUID / session-
  prefixed) ids so a future multiplexed/native backend can't collide on `"1"`.
- Serialization shape is **unchanged** — the split extracts in-memory ownership,
  not the persisted shape. Same deploy-safety bar as ADR 0004/0006.

## Alternatives considered

- **Keep singletons, tag every job with a session id.** Tagging the shared
  `_pending`/schedulers lets jobs coexist but not the _cancel-the-previous_
  semantics, and leaves the worker shared — one crash/`recycleWorker` rejects
  _all_ sessions' pending jobs (`openscad-runner.ts:150-154`). Per-session
  workers give a proper fault domain. Rejected.
- **Big-bang rewrite.** One PR replacing all module state. Rejected: unreviewable
  and un-bisectable on the deploy-critical compile path.
- **Do all of #123 in one ADR** (sessions + Layer-1 + OpenScadValue +
  schemaVersion + artifact identity). Rejected: bundles serialization-migration
  blast radius with session-lifetime work for zero isolation benefit; split into
  this ADR + follow-up ADRs.
