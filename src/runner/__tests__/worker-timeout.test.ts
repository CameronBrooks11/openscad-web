// Regression coverage for issue #47: a hung OpenSCAD worker must be recovered.
//
// callMain() is a synchronous WASM call. If it wedges, the worker can process no
// further messages, so the runner must terminate and recreate it on timeout
// rather than leaving every subsequent compile blocked on a dead worker.
//
// A real stuck worker never responds to ANY message, so the FakeWorker here
// hangs per-instance: a worker created in "hang" mode answers nothing until it
// is terminated and a fresh worker is created.

// The runner's per-job timeout (kept in sync with SOFT/COMPILE timeout in the runner).
const TIMEOUT_MS = 30_000;

type WorkerResponseMessage = {
  type: 'result';
  id: string;
  exitCode: number;
  outputs: [string, Uint8Array][];
  mergedOutputs: unknown[];
  elapsedMillis: number;
};

const createdWorkers: FakeWorker[] = [];
let nextWorkerHangs = false;

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly hangs: boolean;
  terminated = false;

  constructor() {
    this.hangs = nextWorkerHangs;
    createdWorkers.push(this);
  }

  postMessage(msg: { type: string; id: string }) {
    if (msg.type !== 'compile') return;
    if (this.hangs) return; // a wedged worker never answers any message
    const response: WorkerResponseMessage = {
      type: 'result',
      id: msg.id,
      exitCode: 0,
      outputs: [],
      mergedOutputs: [],
      elapsedMillis: 0,
    };
    setTimeout(() => this.onmessage?.({ data: response } as MessageEvent), 0);
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
  nextWorkerHangs = false;
  ({ spawnOpenSCAD } = await import('../openscad-runner.ts'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker timeout recovery (#47)', () => {
  it('terminates a wedged worker on timeout and recovers on the next compile', async () => {
    nextWorkerHangs = true;
    const hung = spawnOpenSCAD({ mountArchives: false, args: ['a.scad'] }, () => {});
    const hungOutcome = hung.then(
      () => 'resolved',
      (e) => e as Error,
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);

    const err = await hungOutcome;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/timed out/i);

    // The wedged worker must have been terminated (not left running).
    expect(createdWorkers[0].terminated).toBe(true);

    // The next compile must run on a fresh worker and succeed.
    nextWorkerHangs = false;
    const next = spawnOpenSCAD({ mountArchives: false, args: ['b.scad'] }, () => {});
    await vi.advanceTimersByTimeAsync(10);
    const result = await next;

    expect(result.exitCode).toBe(0);
    expect(createdWorkers).toHaveLength(2); // a clean worker was created lazily
    expect(createdWorkers[1].terminated).toBe(false);
  });

  it('ignores a late response from a terminated worker generation', async () => {
    nextWorkerHangs = true;
    const hung = spawnOpenSCAD({ mountArchives: false, args: ['a.scad'] }, () => {});
    const hungOutcome = hung.then(
      () => 'resolved',
      (e) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
    await hungOutcome;

    const oldWorker = createdWorkers[0];
    expect(oldWorker.terminated).toBe(true);

    // A message arriving late from the terminated worker must be ignored, not throw.
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
