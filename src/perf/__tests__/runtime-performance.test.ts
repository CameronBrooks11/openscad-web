import {
  clearPerfSnapshot,
  getPerfSnapshot,
  markPerf,
  measurePerf,
  recordPerfDuration,
} from '../runtime-performance.ts';

describe('runtime-performance', () => {
  afterEach(() => {
    clearPerfSnapshot();
  });

  it('records marks and derived measures in the global snapshot', () => {
    markPerf('osc:test-start');
    markPerf('osc:test-end');

    const duration = measurePerf('osc:test-measure', 'osc:test-start', 'osc:test-end');
    const snapshot = getPerfSnapshot();

    expect(duration).not.toBeNull();
    expect(snapshot.marks['osc:test-start']).toBeDefined();
    expect(snapshot.marks['osc:test-end']).toBeDefined();
    expect(snapshot.metrics.some((metric) => metric.name === 'osc:test-measure')).toBe(true);
  });

  it('records explicit durations with detail payloads', () => {
    recordPerfDuration('osc:worker-wasm-init', 12.5, { coldStart: true });

    const snapshot = getPerfSnapshot();
    expect(snapshot.metrics).toContainEqual(
      expect.objectContaining({
        name: 'osc:worker-wasm-init',
        kind: 'duration',
        duration: 12.5,
        detail: { coldStart: true },
      }),
    );
  });

  it('returns null when asked to measure unknown marks', () => {
    expect(measurePerf('osc:missing', 'osc:nope-a', 'osc:nope-b')).toBeNull();
  });

  it('keeps the snapshot bounded to the most recent metrics', () => {
    for (let i = 0; i < 550; i += 1) {
      recordPerfDuration(`osc:metric-${i}`, i);
    }

    const snapshot = getPerfSnapshot();
    expect(snapshot.metrics).toHaveLength(500);
    expect(snapshot.metrics[0]?.name).toBe('osc:metric-50');
    expect(snapshot.metrics.at(-1)?.name).toBe('osc:metric-549');
  });
});
