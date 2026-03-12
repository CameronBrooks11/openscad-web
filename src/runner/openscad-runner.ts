// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { AbortablePromise } from "../utils.ts";
import { Source } from "../state/app-state.ts";
import {
  CompileRequest,
  CancelRequest,
  WorkerResponse,
  CompileResult,
  CompileError,
  CompileStdout,
  CompileStderr,
  MergedOutput,
} from "./worker-protocol.ts";

export type MergedOutputs = MergedOutput[];

// Kept for consumers (actions.ts, output-parser.ts) that reference these types
export type OpenSCADInvocation = {
  mountArchives: boolean,
  inputs?: Source[],
  args: string[],
  outputPaths?: string[],
}

export type OpenSCADInvocationResults = {
  exitCode?: number,
  error?: string,
  outputs?: [string, Uint8Array][],
  mergedOutputs: MergedOutputs,
  elapsedMillis: number,
};

export type ProcessStreams = { stderr: string } | { stdout: string };
export type OpenSCADInvocationCallback = { result: OpenSCADInvocationResults } | ProcessStreams;

// ---------------------------------------------------------------------------
// R6 — Priority levels (higher number = higher priority)
// ---------------------------------------------------------------------------
export type JobPriority = 'export' | 'render' | 'preview' | 'syntax';
const PRIORITY: Record<JobPriority, number> = {
  export: 0,
  render: 1,
  preview: 2,
  syntax: 3,
};

// ---------------------------------------------------------------------------
// R3 — Persistent singleton Worker
// ---------------------------------------------------------------------------
type PendingJob = {
  resolve: (r: OpenSCADInvocationResults) => void;
  reject: (e: Error) => void;
  streamsCallback: (ps: ProcessStreams) => void;
  priority: number;
  startTime: number;
  softTimeoutHandle: ReturnType<typeof setTimeout> | null;
  hardTimeoutHandle: ReturnType<typeof setTimeout> | null;
};

const _pending = new Map<string, PendingJob>();
let _nextId = 0;
let _worker: Worker | null = null;

// Timeout thresholds
const SOFT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 60_000;

function getWorker(): Worker {
  if (!_worker) {
    console.log('[runner] Worker created');
    _worker = new Worker('./openscad-worker.js');
    _worker.onmessage = handleWorkerMessage;
    _worker.onerror = handleWorkerError;
  }
  return _worker;
}

function handleWorkerMessage(e: MessageEvent<WorkerResponse>): void {
  const msg = e.data;
  const job = _pending.get(msg.id);
  if (!job) return; // stale response — job was cancelled or timed out

  if (msg.type === 'result') {
    const r = msg as CompileResult;
    clearJobTimers(job);
    _pending.delete(r.id);
    job.resolve({
      exitCode: r.exitCode,
      outputs: r.outputs,
      mergedOutputs: r.mergedOutputs,
      elapsedMillis: r.elapsedMillis,
    });
  } else if (msg.type === 'error') {
    const r = msg as CompileError;
    clearJobTimers(job);
    _pending.delete(r.id);
    job.resolve({
      exitCode: undefined,
      error: r.message,
      mergedOutputs: r.mergedOutputs,
      elapsedMillis: r.elapsedMillis,
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
  // Reject all pending jobs and reset the worker
  for (const [, job] of _pending) {
    clearJobTimers(job);
    job.reject(new Error('Worker crashed: ' + e.message));
  }
  _pending.clear();
  _worker = null; // will be recreated on next request
}

function clearJobTimers(job: PendingJob): void {
  if (job.softTimeoutHandle != null) clearTimeout(job.softTimeoutHandle);
  if (job.hardTimeoutHandle != null) clearTimeout(job.hardTimeoutHandle);
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
      softTimeoutHandle: null,
      hardTimeoutHandle: null,
    };

    // Soft timeout: reject promise, discard late response.
    // Must also clear the hard-timeout timer — if we don't, the hard-timeout
    // fires later and recycles the worker even though this job is already gone,
    // interrupting any unrelated compile that started in the meantime.
    job.softTimeoutHandle = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        clearTimeout(job.hardTimeoutHandle ?? undefined);
        job.hardTimeoutHandle = null;
        _worker?.postMessage({ type: 'cancel', id } satisfies CancelRequest);
        reject(new Error(`Compile timed out after ${SOFT_TIMEOUT_MS / 1000}s`));
      }
    }, SOFT_TIMEOUT_MS);

    // Hard timeout: recycle worker if it remains blocked.
    // Guard on _pending.has(id): the job may have been resolved, cancelled, or
    // soft-timed-out already — in that case we must NOT recycle the worker.
    job.hardTimeoutHandle = setTimeout(() => {
      if (!_pending.has(id)) return; // job already finished — nothing to do
      if (_worker) {
        console.warn('[runner] Hard timeout reached — recycling worker');
        _worker.terminate();
        _worker = null;
      }
      // Clear any residual jobs
      for (const [, j] of _pending) {
        clearJobTimers(j);
        j.reject(new Error('Worker recycled after hard timeout'));
      }
      _pending.clear();
    }, HARD_TIMEOUT_MS);

    _pending.set(id, job);

    const request: CompileRequest = {
      type: 'compile',
      id,
      sources: (invocation.inputs ?? []).map(s => ({
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

