// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { AbortablePromise } from '../utils.ts';
import type { WireSource } from '../state/project-source.ts';
import { markPerf, measurePerf, recordPerfDuration } from '../perf/runtime-performance.ts';
import { createOpenSCADWorker } from './worker-bootstrap.ts';
import {
  CompileRequest,
  CancelRequest,
  WorkerResponse,
  CompileResult,
  CompileError,
  CompilePerfStats,
  CompileStdout,
  CompileStderr,
  MergedOutput,
} from './worker-protocol.ts';

export type MergedOutputs = MergedOutput[];

// Kept for consumers (actions.ts, output-parser.ts) that reference these types
export type OpenSCADInvocation = {
  mountArchives: boolean;
  inputs?: WireSource[];
  args: string[];
  outputPaths?: string[];
  /** Source/project revision stamped onto the request; echoed on the result. */
  revision?: number;
};

export type OpenSCADInvocationResults = {
  exitCode?: number;
  error?: string;
  outputs?: [string, Uint8Array][];
  mergedOutputs: MergedOutputs;
  elapsedMillis: number;
  perf?: CompilePerfStats;
  /** Revision echoed back from the worker (see OpenSCADInvocation.revision). */
  revision?: number;
};

export type ProcessStreams = { stderr: string } | { stdout: string };
export type OpenSCADInvocationCallback = { result: OpenSCADInvocationResults } | ProcessStreams;

// ---------------------------------------------------------------------------
// Priority levels (higher number = higher priority)
// ---------------------------------------------------------------------------
export type JobPriority = 'export' | 'render' | 'preview' | 'syntax';
// Syntax checking is background bookkeeping; explicit user-triggered work must
// win when the queue is contended.
const PRIORITY: Record<JobPriority, number> = {
  syntax: 0,
  preview: 1,
  render: 2,
  export: 3,
};

const EXPECTED_CANCELLATION_MESSAGES = new Set(['Cancelled', 'Superseded by higher-priority job']);

export function isExpectedJobCancellation(error: unknown): boolean {
  if (error == null) return false;
  const message = error instanceof Error ? error.message : String(error);
  return EXPECTED_CANCELLATION_MESSAGES.has(message);
}

// ---------------------------------------------------------------------------
// Worker backend
// ---------------------------------------------------------------------------
type PendingJob = {
  resolve: (r: OpenSCADInvocationResults) => void;
  reject: (e: Error) => void;
  streamsCallback: (ps: ProcessStreams) => void;
  priority: number;
  /** Execution budget (ms) applied once the worker reports the job `started`. */
  execTimeoutMs: number;
  /** True once the worker reports this job `started` (now on the execution clock). */
  started: boolean;
  startTime: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

// Two independent budgets (the worker runs jobs in a serial FIFO queue, so a
// single submission-to-result timer would charge a job for time it spent merely
// waiting behind another compile):
//   - QUEUE: submission → the worker reports `started`. Generous, because a job
//     can legitimately wait behind earlier compiles; exceeding it means the
//     worker is wedged before it could even begin this job, so recycle it.
//   - EXECUTION (per operation): `started` → result. Charged only to the running
//     compile. A wedged synchronous callMain trips this and recycles the worker.
const QUEUE_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS: Record<JobPriority, number> = {
  syntax: 20_000,
  preview: 30_000,
  render: 60_000,
  export: 60_000,
};

function clearJobTimers(job: PendingJob): void {
  if (job.timeoutHandle != null) clearTimeout(job.timeoutHandle);
}

// Page-global, NOT per-backend: these gate the once-per-page first-compile perf
// marks (the bootstrap measure starts at `osc:app-bootstrap-start`, set once in
// index.ts). A second backend must consult — not re-fire — them, or it would
// re-measure boot against a start that already elapsed. See ADR 0007.
let _pageFirstCompileRequested = false;
let _pageFirstCompileCompleted = false;

/**
 * The compile engine boundary: submit a compile, cancel one, tear the engine
 * down. The browser-WASM runner is one implementation; a future native backend
 * implements the same shape without touching callers (ADR 0007).
 */
export interface CompileBackend {
  spawn(
    invocation: OpenSCADInvocation,
    streamsCallback: (ps: ProcessStreams) => void,
    priority?: JobPriority,
  ): AbortablePromise<OpenSCADInvocationResults>;
  cancel(id: string, reason?: string): void;
  dispose(): void;
}

/**
 * The browser-WASM compile engine: owns one persistent Worker plus the pending
 * jobs, id space, worker generation, and queue/exec timeout timers that drive
 * it. Instance-scoped so independent sessions get fully isolated engines (ADR
 * 0007). The app runs one backend per session; `spawnOpenSCAD` + `defaultBackend`
 * remain for the direct-importing runner tests.
 */
export class WasmWorkerBackend implements CompileBackend {
  /** @internal Pending jobs by id; exposed for cross-instance isolation tests. */
  readonly pending = new Map<string, PendingJob>();
  /** @internal Monotonic job id counter (per backend). */
  nextId = 0;
  /** @internal Current worker identity; bumped on recycle/dispose so late
   *  messages from a terminated worker cannot affect newer jobs. */
  generation = 0;
  private worker: Worker | null = null;

  // Arm (or re-arm) a job's queue-wait timer. The queue timer is a worker-liveness
  // check: it is reset whenever any job reports `started` (forward progress), so it
  // fires only if the worker makes no progress at all for the window — a wedge —
  // not merely because a job waited a long time behind legitimate compiles.
  private armQueueTimer(id: string, job: PendingJob): void {
    if (job.timeoutHandle != null) clearTimeout(job.timeoutHandle);
    job.timeoutHandle = setTimeout(
      () =>
        this.failTimedOutJob(
          id,
          `Compile timed out after ${QUEUE_TIMEOUT_MS / 1000}s waiting to run`,
        ),
      QUEUE_TIMEOUT_MS,
    );
  }

  // Fail a timed-out job and recycle the (presumed wedged) worker. Shared by the
  // queue-wait and execution timers.
  private failTimedOutJob(id: string, reason: string): void {
    const stuck = this.pending.get(id);
    if (!stuck) return; // already resolved, cancelled, or superseded
    clearJobTimers(stuck);
    this.pending.delete(id);
    stuck.reject(new Error(reason));
    console.warn(`[runner] ${reason} (compile ${id})`);
    this.recycleWorker('Worker recycled after timeout');
  }

  private getWorker(): Worker {
    if (!this.worker) {
      const generation = this.generation; // snapshot: pins this worker's identity
      this.worker = createOpenSCADWorker();
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
        this.handleWorkerMessage(e, generation);
      this.worker.onerror = (e: ErrorEvent) => this.handleWorkerError(e);
    }
    return this.worker;
  }

  // Terminate the current worker and reject every job bound to it. The next
  // request lazily creates a clean worker (getWorker). This is the recovery path
  // for a wedged or crashed worker.
  private recycleWorker(reason: string): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.generation++;
    for (const [, job] of this.pending) {
      clearJobTimers(job);
      job.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private handleWorkerMessage(e: MessageEvent<WorkerResponse>, generation: number): void {
    // Ignore messages from a worker generation that has since been terminated.
    if (generation !== this.generation) return;
    const msg = e.data;
    const job = this.pending.get(msg.id);
    if (!job) return; // stale response — job was cancelled or timed out

    if (msg.type === 'started') {
      // The job left the queue and is executing: replace the queue-wait timer with
      // the execution budget so the compile gets its full allowance regardless of
      // how long it waited in the queue.
      job.started = true;
      if (job.timeoutHandle != null) clearTimeout(job.timeoutHandle);
      job.timeoutHandle = setTimeout(
        () =>
          this.failTimedOutJob(
            msg.id,
            `Compile exceeded its ${job.execTimeoutMs / 1000}s execution budget`,
          ),
        job.execTimeoutMs,
      );
      // Forward progress: re-arm the queue-wait window for every still-queued job,
      // so a job merely waiting behind legitimate compiles is never recycled (and
      // never takes the healthy running compile down with it).
      for (const [otherId, other] of this.pending) {
        if (other === job || other.started) continue;
        this.armQueueTimer(otherId, other);
      }
    } else if (msg.type === 'result') {
      const r = msg as CompileResult;
      this.recordCompilePerf(job, r.perf);
      clearJobTimers(job);
      this.pending.delete(r.id);
      job.resolve({
        exitCode: r.exitCode,
        outputs: r.outputs,
        mergedOutputs: r.mergedOutputs,
        elapsedMillis: r.elapsedMillis,
        perf: r.perf,
        revision: r.revision,
      });
    } else if (msg.type === 'error') {
      const r = msg as CompileError;
      this.recordCompilePerf(job, r.perf);
      clearJobTimers(job);
      this.pending.delete(r.id);
      job.resolve({
        exitCode: undefined,
        error: r.message,
        mergedOutputs: r.mergedOutputs,
        elapsedMillis: r.elapsedMillis,
        perf: r.perf,
        revision: r.revision,
      });
    } else if (msg.type === 'stdout') {
      const r = msg as CompileStdout;
      job.streamsCallback({ stdout: r.text });
    } else if (msg.type === 'stderr') {
      const r = msg as CompileStderr;
      job.streamsCallback({ stderr: r.text });
    }
  }

  private handleWorkerError(e: ErrorEvent): void {
    console.error('OpenSCAD worker crashed:', e.message);
    this.recycleWorker('Worker crashed: ' + e.message);
  }

  private recordCompilePerf(job: PendingJob, perf?: CompilePerfStats): void {
    recordPerfDuration('osc:compile-roundtrip', performance.now() - job.startTime);
    if (perf?.workerFsInitMillis != null) {
      recordPerfDuration('osc:worker-fs-init', perf.workerFsInitMillis);
    }
    if (perf?.workerLibraryMountMillis != null) {
      recordPerfDuration('osc:worker-library-mount', perf.workerLibraryMountMillis);
    }
    if (perf?.workerWasmInitMillis != null) {
      recordPerfDuration('osc:worker-wasm-init', perf.workerWasmInitMillis);
    }
    if (perf?.workerJobMillis != null) {
      recordPerfDuration('osc:worker-job-total', perf.workerJobMillis);
    }
    if (!_pageFirstCompileCompleted) {
      _pageFirstCompileCompleted = true;
      markPerf('osc:first-compile-complete');
      measurePerf(
        'osc:first-compile-from-bootstrap',
        'osc:app-bootstrap-start',
        'osc:first-compile-complete',
      );
      measurePerf(
        'osc:first-compile-roundtrip',
        'osc:first-compile-request',
        'osc:first-compile-complete',
      );
    }
  }

  /** Discard a job without terminating the worker (queued-job cancel path). */
  cancel(id: string, reason = 'Cancelled'): void {
    const job = this.pending.get(id);
    if (!job) return;
    clearJobTimers(job);
    this.pending.delete(id);
    this.worker?.postMessage({ type: 'cancel', id } satisfies CancelRequest);
    job.reject(new Error(reason));
  }

  spawn(
    invocation: OpenSCADInvocation,
    streamsCallback: (ps: ProcessStreams) => void,
    priority: JobPriority = 'render',
  ): AbortablePromise<OpenSCADInvocationResults> {
    const id = String(++this.nextId);
    const worker = this.getWorker();
    if (!_pageFirstCompileRequested) {
      _pageFirstCompileRequested = true;
      markPerf('osc:first-compile-request');
    }

    // cancel all lower-priority pending jobs when a higher-priority job arrives
    const incomingPriority = PRIORITY[priority];
    for (const [pendingId, pendingJob] of this.pending) {
      if (pendingJob.priority < incomingPriority) {
        this.cancel(pendingId, 'Superseded by higher-priority job');
      }
    }

    return AbortablePromise<OpenSCADInvocationResults>((resolve, reject) => {
      const job: PendingJob = {
        resolve,
        reject,
        streamsCallback,
        priority: incomingPriority,
        execTimeoutMs: EXEC_TIMEOUT_MS[priority],
        started: false,
        startTime: performance.now(),
        timeoutHandle: null,
      };

      // Queue-wait timeout: the worker has not even reported this job `started`
      // within the window. Because callMain is a synchronous WASM call, a wedged
      // worker can process neither this job nor any queued or future request — so
      // reject this job and recycle the worker. The timer is re-armed to the
      // execution budget once the worker reports `started` (see handleWorkerMessage),
      // so queue time is never charged against the compile's own allowance.
      this.armQueueTimer(id, job);

      this.pending.set(id, job);

      const request: CompileRequest = {
        type: 'compile',
        id,
        sources: (invocation.inputs ?? []).map((s) => ({
          path: s.path,
          content: s.content,
          url: s.url,
        })),
        args: invocation.args,
        outputPaths: invocation.outputPaths ?? [],
        mountArchives: invocation.mountArchives,
        revision: invocation.revision,
      };
      worker.postMessage(request);

      return () => this.cancel(id);
    });
  }

  /** Tear down this backend: terminate its worker, clear timers, reject pending.
   *  Makes session teardown real (the previous singleton leaked for the page
   *  lifetime). Same effect as a recycle, with no re-arm. */
  dispose(): void {
    this.recycleWorker('Backend disposed');
  }
}

// The app's single compile engine. `spawnOpenSCAD` delegates here so the public
// surface is byte-identical to the previous module-singleton; a second session
// constructs its own `WasmWorkerBackend` (later slices).
const defaultBackend = new WasmWorkerBackend();

export function spawnOpenSCAD(
  invocation: OpenSCADInvocation,
  streamsCallback: (ps: ProcessStreams) => void,
  priority: JobPriority = 'render',
): AbortablePromise<OpenSCADInvocationResults> {
  return defaultBackend.spawn(invocation, streamsCallback, priority);
}
