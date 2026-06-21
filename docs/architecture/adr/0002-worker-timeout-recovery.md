# ADR 0002 — Worker timeout recovery

**Status:** Accepted (#47)

## Context

The runner used a two-tier timeout: a 30s "soft" timeout rejected the job and
**cleared** the 60s "hard" timeout, which was the only path that recycled the
worker. Because `OpenSCADRuntime.callMain()` is a synchronous WASM call, a wedged
`callMain` could never process the posted cancel message, and the soft path's
clearing of the hard timeout meant the worker was never recycled. The result: a
permanently blocked worker, with every subsequent request posted to it.

## Decision

Recover the worker at timeout. A single `COMPILE_TIMEOUT_MS` per job; on timeout
the runner:

1. terminates the wedged worker and lazily recreates a clean one on the next
   request;
2. bumps a `_workerGeneration` counter so late messages from the terminated
   worker are ignored;
3. rejects the jobs bound to that generation with a clear error.

Queued-job cancellation (priority supersession, explicit abort) remains a
distinct, non-terminating path — only a wedged or crashed worker triggers a
teardown, which the crash handler now shares.

## Consequences

- A hung `callMain` is recovered; the next compile succeeds on a fresh worker.
- No code path disables the recovery mechanism.
- A fresh worker pays WASM init again, but the `.wasm` is browser-cached so the
  cost is small relative to never recovering.
