// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { AbortablePromise } from '../utils.ts';
import { Source } from '../state/app-state.ts';
import { mountDemandLibraries } from '../fs/filesystem.ts';
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
  inputs?: Source[];
  args: string[];
  outputPaths?: string[];
};

export type OpenSCADInvocationResults = {
  exitCode?: number;
  error?: string;
  outputs?: [string, Uint8Array][];
  mergedOutputs: MergedOutputs;
  elapsedMillis: number;
  perf?: CompilePerfStats;
};

export type ProcessStreams = { stderr: string } | { stdout: string };
export type OpenSCADInvocationCallback = { result: OpenSCADInvocationResults } | ProcessStreams;

// ---------------------------------------------------------------------------
// R6 — Priority levels (higher number = higher priority)
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
// R3 — Persistent singleton Worker
// ---------------------------------------------------------------------------
type PendingJob = {
  resolve: (r: OpenSCADInvocationResults) => void;
  reject: (e: Error) => void;
  streamsCallback: (ps: ProcessStreams) => void;
  priority: number;
  startTime: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

const _pending = new Map<string, PendingJob>();
let _nextId = 0;
let _worker: Worker | null = null;
// Identifies the current worker. Bumped whenever the worker is torn down so that
// late messages from a terminated worker cannot resolve or affect newer jobs.
let _workerGeneration = 0;
let _firstCompileRequested = false;
let _firstCompileCompleted = false;

// A compile that has not produced a result within this window means the worker
// is wedged (callMain is synchronous and cannot be interrupted), so the worker
// is terminated and recreated rather than left blocking all future work.
const COMPILE_TIMEOUT_MS = 30_000;

function getWorker(): Worker {
  if (!_worker) {
    const generation = _workerGeneration;
    _worker = createOpenSCADWorker();
    _worker.onmessage = (e: MessageEvent<WorkerResponse>) => handleWorkerMessage(e, generation);
    _worker.onerror = handleWorkerError;
  }
  return _worker;
}

// Terminate the current worker and reject every job bound to it. The next
// request lazily creates a clean worker (getWorker). This is the recovery path
// for a wedged or crashed worker.
function recycleWorker(reason: string): void {
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
  _workerGeneration++;
  for (const [, job] of _pending) {
    clearJobTimers(job);
    job.reject(new Error(reason));
  }
  _pending.clear();
}

function handleWorkerMessage(e: MessageEvent<WorkerResponse>, generation: number): void {
  // Ignore messages from a worker generation that has since been terminated.
  if (generation !== _workerGeneration) return;
  const msg = e.data;
  const job = _pending.get(msg.id);
  if (!job) return; // stale response — job was cancelled or timed out

  if (msg.type === 'result') {
    const r = msg as CompileResult;
    recordCompilePerf(job, r.perf);
    clearJobTimers(job);
    _pending.delete(r.id);
    job.resolve({
      exitCode: r.exitCode,
      outputs: r.outputs,
      mergedOutputs: r.mergedOutputs,
      elapsedMillis: r.elapsedMillis,
      perf: r.perf,
    });
  } else if (msg.type === 'error') {
    const r = msg as CompileError;
    recordCompilePerf(job, r.perf);
    clearJobTimers(job);
    _pending.delete(r.id);
    job.resolve({
      exitCode: undefined,
      error: r.message,
      mergedOutputs: r.mergedOutputs,
      elapsedMillis: r.elapsedMillis,
      perf: r.perf,
    });
  } else if (msg.type === 'stdout') {
    const r = msg as CompileStdout;
    job.streamsCallback({ stdout: r.text });
  } else if (msg.type === 'stderr') {
    const r = msg as CompileStderr;
    job.streamsCallback({ stderr: r.text });
  }
}

function handleWorkerError(e: ErrorEvent): void {
  console.error('OpenSCAD worker crashed:', e.message);
  recycleWorker('Worker crashed: ' + e.message);
}

function clearJobTimers(job: PendingJob): void {
  if (job.timeoutHandle != null) clearTimeout(job.timeoutHandle);
}

function recordCompilePerf(job: PendingJob, perf?: CompilePerfStats): void {
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
  if (!_firstCompileCompleted) {
    _firstCompileCompleted = true;
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

// Discard a job without terminating the worker (R6 cancel path)
function cancelJobById(id: string, reason = 'Cancelled'): void {
  const job = _pending.get(id);
  if (!job) return;
  clearJobTimers(job);
  _pending.delete(id);
  _worker?.postMessage({ type: 'cancel', id } satisfies CancelRequest);
  job.reject(new Error(reason));
}

export function spawnOpenSCAD(
  invocation: OpenSCADInvocation,
  streamsCallback: (ps: ProcessStreams) => void,
  priority: JobPriority = 'render',
): AbortablePromise<OpenSCADInvocationResults> {
  const id = String(++_nextId);
  const worker = getWorker();
  if (!_firstCompileRequested) {
    _firstCompileRequested = true;
    markPerf('osc:first-compile-request');
  }

  // R6 — cancel all lower-priority pending jobs when a higher-priority job arrives
  const incomingPriority = PRIORITY[priority];
  for (const [pendingId, pendingJob] of _pending) {
    if (pendingJob.priority < incomingPriority) {
      cancelJobById(pendingId, 'Superseded by higher-priority job');
    }
  }

  return AbortablePromise<OpenSCADInvocationResults>((resolve, reject) => {
    const job: PendingJob = {
      resolve,
      reject,
      streamsCallback,
      priority: incomingPriority,
      startTime: performance.now(),
      timeoutHandle: null,
    };

    // Timeout: the worker has produced no result in time. Because callMain is a
    // synchronous WASM call, a wedged worker can process neither this job nor any
    // queued or future request — so reject this job and recycle the worker so the
    // next request runs on a clean one. recycleWorker() rejects the remaining
    // pending jobs (which are stuck behind this one on the same worker).
    job.timeoutHandle = setTimeout(() => {
      const stuck = _pending.get(id);
      if (!stuck) return; // already resolved, cancelled, or superseded
      clearJobTimers(stuck);
      _pending.delete(id);
      reject(new Error(`Compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s`));
      console.warn(`[runner] Compile ${id} timed out after ${COMPILE_TIMEOUT_MS / 1000}s`);
      recycleWorker('Worker recycled after timeout');
    }, COMPILE_TIMEOUT_MS);

    _pending.set(id, job);

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
    };
    worker.postMessage(request);

    return () => cancelJobById(id);
  });
}

// ---------------------------------------------------------------------------
// F4 — On-demand fallback for missing libraries
// ---------------------------------------------------------------------------

/**
 * Pattern that matches OpenSCAD's "Can't open library" error in stderr.
 * Example: "Can't open library 'MCAD/involute_gears.scad'."
 */
const MISSING_LIBRARY_RE = /Can't open library '([^']+)'/;

/**
 * Dispatches a compile job and, if it fails because of a missing library that is
 * known to the registry, mounts that library on-demand and retries once.
 *
 * This covers cases where the static `use <...>` parser in the worker missed a
 * dynamically-constructed library path.
 */
export async function compileWithFallback(
  invocation: OpenSCADInvocation,
  streamsCallback: (ps: ProcessStreams) => void,
  priority: JobPriority = 'render',
): Promise<OpenSCADInvocationResults> {
  let result = await spawnOpenSCAD(invocation, streamsCallback, priority);

  if (result.exitCode !== 0) {
    // Inspect stderr lines for a missing-library error
    const stderrText = result.mergedOutputs
      .filter((o) => 'stderr' in o)
      .map((o) => (o as { stderr: string }).stderr)
      .join('\n');
    const match = stderrText.match(MISSING_LIBRARY_RE);
    if (match) {
      const missingPath = match[1]; // e.g. "MCAD/involute_gears.scad"
      const topLevel = missingPath.split('/')[0];
      const needed = await mountDemandLibraries([`use <${missingPath}>`]);
      if (needed.includes(topLevel)) {
        // Retry once with the library now mounted
        result = await spawnOpenSCAD(invocation, streamsCallback, priority);
      }
    }
  }

  return result;
}
