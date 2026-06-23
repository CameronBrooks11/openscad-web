// Regression coverage for issue #47 (recover a wedged worker) and #137 (the
// timeout must distinguish queue-wait from execution, and a job waiting behind
// legitimate compiles must not be recycled).
//
// callMain() is a synchronous WASM call. If it wedges, the worker can process no
// further messages, so the runner must terminate and recreate it on timeout. The
// worker runs jobs in a serial FIFO queue and reports `started` on dequeue; the
// host charges queue-wait and execution against separate budgets and treats any
// `started` as forward progress that re-arms still-queued jobs' queue timers.

// Kept in sync with the runner: QUEUE_TIMEOUT_MS and the per-op EXEC budgets.
const QUEUE_TIMEOUT_MS = 60_000;
const SYNTAX_EXEC_MS = 20_000;

type Mode = 'normal' | 'hang-silent' | 'hang-after-started';

const createdWorkers: FakeWorker[] = [];
let nextWorkerMode: Mode = 'normal';
let nextJobDurationMs = 0;

// A FakeWorker that faithfully serializes: it processes one queued job at a time,
// posting `started` on dequeue and `result` after `jobDurationMs`, then pumps the
// next. `hang-silent` never answers; `hang-after-started` posts `started` then
// wedges (stays busy forever, like an infinite callMain).
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly mode: Mode;
  readonly jobDurationMs: number;
  terminated = false;
  private queue: string[] = [];
  private busy = false;

  constructor() {
    this.mode = nextWorkerMode;
    this.jobDurationMs = nextJobDurationMs;
    createdWorkers.push(this);
  }

  postMessage(msg: { type: string; id: string }) {
    if (msg.type !== 'compile') return;
    if (this.mode === 'hang-silent') return; // never answers any message
    this.queue.push(msg.id);
    this.pump();
  }

  private pump() {
    if (this.busy || this.terminated) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    this.busy = true;
    if (this.terminated) return;
    this.onmessage?.({ data: { type: 'started', id } } as MessageEvent);
    if (this.mode === 'hang-after-started') return; // wedge: never frees the worker
    setTimeout(() => {
      if (this.terminated) return;
      this.onmessage?.({
        data: { type: 'result', id, exitCode: 0, outputs: [], mergedOutputs: [], elapsedMillis: 0 },
      } as MessageEvent);
      this.busy = false;
      this.pump();
    }, this.jobDurationMs);
  }

  terminate() {
    this.terminated = true;
  }
}

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).Worker = FakeWorker;
});

let spawnOpenSCAD: typeof import('../openscad-runner.ts').spawnOpenSCAD;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  createdWorkers.length = 0;
  nextWorkerMode = 'normal';
  nextJobDurationMs = 0;
  ({ spawnOpenSCAD } = await import('../openscad-runner.ts'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker timeout recovery (#47, #137)', () => {
  it('recycles a worker that never reports a job started (queue-wait timeout)', async () => {
    nextWorkerMode = 'hang-silent';
    const hung = spawnOpenSCAD({ mountArchives: false, args: ['a.scad'] }, () => {});
    const hungOutcome = hung.then(
      () => 'resolved',
      (e) => e as Error,
    );

    await vi.advanceTimersByTimeAsync(QUEUE_TIMEOUT_MS + 100);

    const err = await hungOutcome;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/timed out.*waiting to run/i);
    expect(createdWorkers[0].terminated).toBe(true);

    // The next compile runs on a fresh worker and succeeds.
    nextWorkerMode = 'normal';
    const next = spawnOpenSCAD({ mountArchives: false, args: ['b.scad'] }, () => {});
    await vi.advanceTimersByTimeAsync(10);
    const result = await next;
    expect(result.exitCode).toBe(0);
    expect(createdWorkers).toHaveLength(2);
    expect(createdWorkers[1].terminated).toBe(false);
  });

  it('recycles a worker that reports started then wedges, at the execution budget', async () => {
    nextWorkerMode = 'hang-after-started';
    // A syntax check has the shortest execution budget.
    const hung = spawnOpenSCAD({ mountArchives: false, args: ['a.scad'] }, () => {}, 'syntax');
    const outcome = hung.then(
      () => 'resolved',
      (e) => e as Error,
    );

    // It must NOT survive past its (short) execution budget, even though the
    // larger queue-wait budget has not elapsed — proving `started` switched timers.
    await vi.advanceTimersByTimeAsync(SYNTAX_EXEC_MS + 100);

    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/execution budget/i);
    expect(createdWorkers[0].terminated).toBe(true);
  });

  it('does not recycle jobs that legitimately wait behind earlier compiles', async () => {
    // Three same-priority (non-superseding) exports, each running 35s, serialize:
    // they finish at ~35s, ~70s, ~105s. The third waits ~70s in the queue — well
    // past the 60s queue budget measured from its own submission. It must NOT be
    // recycled (and must not take the healthy running compile down with it),
    // because each `started` re-arms the still-queued jobs' queue timers.
    nextJobDurationMs = 35_000;
    const jobs = [0, 1, 2].map((i) =>
      spawnOpenSCAD({ mountArchives: false, args: [`m${i}.scad`] }, () => {}, 'export'),
    );

    await vi.advanceTimersByTimeAsync(3 * 35_000 + 1_000);

    const results = await Promise.all(jobs);
    expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
    expect(createdWorkers).toHaveLength(1);
    expect(createdWorkers[0].terminated).toBe(false);
  });

  it('ignores a late response from a terminated worker generation', async () => {
    nextWorkerMode = 'hang-silent';
    const hung = spawnOpenSCAD({ mountArchives: false, args: ['a.scad'] }, () => {});
    const hungOutcome = hung.then(
      () => 'resolved',
      (e) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(QUEUE_TIMEOUT_MS + 100);
    await hungOutcome;

    const oldWorker = createdWorkers[0];
    expect(oldWorker.terminated).toBe(true);

    expect(() =>
      oldWorker.onmessage?.({
        data: {
          type: 'result',
          id: '1',
          exitCode: 0,
          outputs: [],
          mergedOutputs: [],
          elapsedMillis: 0,
        },
      } as MessageEvent),
    ).not.toThrow();
  });
});
