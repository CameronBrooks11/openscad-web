// Tests for utils.ts — BUG-7 (debounce kill) and BUG-9 (isInStandaloneMode)

import { turnIntoDelayableExecution, AbortablePromise, isInStandaloneMode } from '../utils.ts';

// ---------------------------------------------------------------------------
// BUG-7 — kill() must cancel a pending (not-yet-started) execution
// ---------------------------------------------------------------------------

describe('turnIntoDelayableExecution – kill cancels pending timeout (BUG-7)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('kill() before timeout prevents job from executing', () => {
    let executed = false;
    const job = jest.fn(() =>
      AbortablePromise<void>((res) => {
        executed = true;
        res();
        return () => {};
      })
    );

    const delayable = turnIntoDelayableExecution(1000, job);
    const promise = delayable()({ now: false });

    // kill before the 1000ms timeout fires
    promise.kill();

    // advance all timers — job must NOT run
    jest.runAllTimers();

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
      value: jest.fn().mockImplementation((query: string) => ({
        matches: standaloneMatches && query === '(display-mode: standalone)',
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
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
