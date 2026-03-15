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

  it('kill() before timeout prevents job from executing', () => {
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

    // kill before the 1000ms timeout fires
    promise.kill();

    // advance all timers — job must NOT run
    vi.runAllTimers();

    expect(executed).toBe(false);
    expect(job).not.toHaveBeenCalled();
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
