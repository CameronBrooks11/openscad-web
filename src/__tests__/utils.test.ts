// Tests for utils.ts — BUG-7 (debounce kill) and BUG-9 (isInStandaloneMode)

import {
  turnIntoDelayableExecution,
  AbortablePromise,
  fetchSource,
  isInStandaloneMode,
} from '../utils.ts';

// ---------------------------------------------------------------------------
// BUG-7 — kill() must cancel a pending (not-yet-started) execution
// ---------------------------------------------------------------------------

describe('turnIntoDelayableExecution – kill cancels pending timeout (BUG-7)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('kill() before timeout prevents job from executing and rejects the promise', async () => {
    let executed = false;
    const job = vi.fn(() =>
      AbortablePromise<void>((res) => {
        executed = true;
        res();
        return () => {};
      }),
    );

    const delayable = turnIntoDelayableExecution(1000, job);
    const promise = delayable()({ now: false });
    const outcome = promise.then(
      () => 'resolved',
      (e) => (e as Error).message,
    );

    // kill before the 1000ms timeout fires
    promise.kill();

    // advance all timers — job must NOT run
    await vi.runAllTimersAsync();

    expect(executed).toBe(false);
    expect(job).not.toHaveBeenCalled();
    // The promise must settle (rejected) rather than leak as a pending orphan.
    expect(await outcome).toBe('Cancelled');
  });
});

// ---------------------------------------------------------------------------
// #48 — deterministic settlement and supersession
// ---------------------------------------------------------------------------

describe('turnIntoDelayableExecution – settlement & supersession (#48)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type JobController = {
    resolve: (v: string) => void;
    reject: (e: unknown) => void;
    wasKilled: () => boolean;
  };

  function makeJob() {
    const controllers: JobController[] = [];
    const job = vi.fn((..._args: unknown[]) => {
      let resolveFn!: (v: string) => void;
      let rejectFn!: (e: unknown) => void;
      let killed = false;
      const p = AbortablePromise<string>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
        return () => {
          killed = true;
          reject(new Error('Cancelled'));
        };
      });
      controllers.push({ resolve: resolveFn, reject: rejectFn, wasKilled: () => killed });
      return p;
    });
    return { job, controllers };
  }

  const outcome = (p: Promise<string>) =>
    p.then(
      (v) => `res:${v}`,
      (e) => `rej:${e instanceof Error ? e.message : String(e)}`,
    );

  it('rejects a superseded delayed call without ever running its job', async () => {
    const { job } = makeJob();
    const delayable = turnIntoDelayableExecution(1000, job);

    const first = outcome(delayable('a')({ now: false }));
    delayable('b')({ now: false }).catch(() => {}); // supersedes the first before either runs

    expect(await first).toBe('rej:Cancelled');
    expect(job).not.toHaveBeenCalled(); // still inside the debounce window
  });

  it('runs only the latest delayed call after the debounce delay', async () => {
    const { job, controllers } = makeJob();
    const delayable = turnIntoDelayableExecution(1000, job);

    outcome(delayable('a')({ now: false }));
    const second = outcome(delayable('b')({ now: false }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(job).toHaveBeenCalledTimes(1);
    expect(job).toHaveBeenCalledWith('b');

    controllers[0].resolve('B');
    expect(await second).toBe('res:B');
  });

  it('rejects a superseded running call and resolves only the newer one', async () => {
    const { job, controllers } = makeJob();
    const delayable = turnIntoDelayableExecution(0, job);

    const first = outcome(delayable('a')({ now: true })); // runs immediately
    const second = outcome(delayable('b')({ now: true })); // supersedes & kills the first

    expect(controllers[0].wasKilled()).toBe(true);
    expect(await first).toBe('rej:Cancelled');

    controllers[1].resolve('B');
    expect(await second).toBe('res:B');
  });

  it('settles exactly once — a late resolve of a superseded job is ignored', async () => {
    const { job, controllers } = makeJob();
    const delayable = turnIntoDelayableExecution(0, job);

    const first = outcome(delayable('a')({ now: true }));
    delayable('b')({ now: true }).catch(() => {}); // supersede → first rejects Cancelled

    expect(await first).toBe('rej:Cancelled');
    controllers[0].resolve('late'); // must not flip the already-settled promise
    expect(await first).toBe('rej:Cancelled');
  });

  it('keeps a running job cancellable after an earlier job finishes (no clobber race)', async () => {
    const { job, controllers } = makeJob();
    const delayable = turnIntoDelayableExecution(0, job);

    delayable('a')({ now: true }).catch(() => {}); // job 0 runs
    delayable('b')({ now: true }).catch(() => {}); // supersedes/kills job 0; job 1 runs
    expect(controllers[0].wasKilled()).toBe(true);

    // Let job 0's settlement/finally flush — in the buggy version this nulled the
    // shared kill signal and left job 1 uncancellable.
    await vi.advanceTimersByTimeAsync(0);

    delayable('c')({ now: true }).catch(() => {}); // must still be able to supersede/kill job 1
    expect(controllers[1].wasKilled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG-9 — isInStandaloneMode() must work on non-iOS (matchMedia fallback)
// ---------------------------------------------------------------------------

describe('isInStandaloneMode (BUG-9)', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
    // Remove the standalone property if it was added
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window.navigator as any).standalone;
    } catch {
      // read-only in some environments — ignore
    }
  });

  function mockMatchMedia(standaloneMatches: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: standaloneMatches && query === '(display-mode: standalone)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  it('returns true when matchMedia reports display-mode: standalone', () => {
    mockMatchMedia(true);
    // Ensure iOS property is absent
    Object.defineProperty(window.navigator, 'standalone', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(isInStandaloneMode()).toBe(true);
  });

  it('returns false when neither matchMedia nor navigator.standalone is set', () => {
    mockMatchMedia(false);
    Object.defineProperty(window.navigator, 'standalone', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(isInStandaloneMode()).toBe(false);
  });
});

describe('fetchSource external URL policy', () => {
  const originalFetch = global.fetch;
  const fsStub = { readFileSync: vi.fn() } as unknown as FS;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('resolves same-origin relative text URLs against the provided base URL', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('cube(1);\r\nsphere(2);', {
        headers: { 'content-length': '19' },
      }),
    ) as typeof fetch;

    const data = await fetchSource(
      fsStub,
      { path: '/home/playground.scad', url: './models/example.scad' },
      { baseUrl: 'https://example.com/app/' },
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/app/models/example.scad',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(new TextDecoder().decode(data)).toBe('cube(1);\nsphere(2);');
  });

  it('rejects cross-origin source URLs for generic source loading', async () => {
    await expect(
      fetchSource(
        fsStub,
        { path: '/home/playground.scad', url: 'https://example.com/model.scad' },
        { baseUrl: 'http://localhost:4000/' },
      ),
    ).rejects.toThrow('source URL must be same-origin relative/absolute.');
  });
});
