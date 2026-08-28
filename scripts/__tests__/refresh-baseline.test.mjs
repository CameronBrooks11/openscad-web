// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  nearestRankPercentile,
  aggregateSection,
  assertCiProfiles,
  assertGatedMetricsPresent,
} from '../perf/refresh-baseline.mjs';

describe('nearestRankPercentile', () => {
  it('returns an observed value, never an interpolation', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(values).toContain(nearestRankPercentile(values, 90));
    expect(values).toContain(nearestRankPercentile(values, 37));
  });

  it('uses ceil(p/100 * n) as the rank', () => {
    // n=15, p90 -> ceil(13.5) = 14th smallest = index 13.
    const values = Array.from({ length: 15 }, (_, i) => i);
    expect(nearestRankPercentile(values, 90)).toBe(13);
  });

  it('is order independent', () => {
    expect(nearestRankPercentile([9, 1, 5, 3, 7], 90)).toBe(
      nearestRankPercentile([1, 3, 5, 7, 9], 90),
    );
  });

  it('returns the extremes at the extremes', () => {
    expect(nearestRankPercentile([4, 8], 100)).toBe(8);
    expect(nearestRankPercentile([4, 8], 1)).toBe(4);
  });

  it('handles a single-element sample', () => {
    expect(nearestRankPercentile([7], 90)).toBe(7);
    expect(nearestRankPercentile([7], 1)).toBe(7);
  });

  it('is exact for non-integer percentiles', () => {
    // Math.ceil((p / 100) * n) drifts here because p/100 is not representable
    // in binary; the integer form must not.
    expect(
      nearestRankPercentile(
        Array.from({ length: 50 }, (_, i) => i),
        14,
      ),
    ).toBe(6);
    expect(
      nearestRankPercentile(
        Array.from({ length: 25 }, (_, i) => i),
        28,
      ),
    ).toBe(6);
  });

  it('throws on an empty sample instead of returning undefined', () => {
    expect(() => nearestRankPercentile([], 90)).toThrow(/empty sample/);
  });
});

describe('aggregateSection', () => {
  const runs = [{ metrics: { a: 10, b: 1 } }, { metrics: { a: 20, b: 2 } }, { metrics: { a: 30 } }];

  it('keeps a metric present in every run', () => {
    expect(aggregateSection(runs, 'metrics', 90).metrics.a).toBe(30);
  });

  it('reports a dropped metric rather than dropping it silently', () => {
    // A dropped metric is never compared again, because compare-baseline.mjs
    // iterates baseline metrics. Silence here is how a metric stops being
    // gated with nothing on screen to say so.
    const result = aggregateSection(runs, 'metrics', 90);
    expect(result.metrics).not.toHaveProperty('b');
    expect(result.dropped).toEqual(['b']);
  });

  it('treats an explicit null as absent — aggregate-baseline.mjs writes null', () => {
    const withNull = [{ m: { x: 1 } }, { m: { x: null } }];
    const result = aggregateSection(withNull, 'm', 90);
    expect(result.metrics).not.toHaveProperty('x');
    expect(result.dropped).toEqual(['x']);
  });

  it('treats NaN and Infinity as absent', () => {
    expect(aggregateSection([{ m: { x: Number.NaN } }], 'm', 90).dropped).toEqual(['x']);
    expect(aggregateSection([{ m: { x: Number.POSITIVE_INFINITY } }], 'm', 90).dropped).toEqual([
      'x',
    ]);
  });

  it('rounds to one decimal, matching the capture pipeline', () => {
    const r = [{ m: { x: 1.234 } }, { m: { x: 1.235 } }];
    expect(aggregateSection(r, 'm', 50).metrics.x).toBe(1.2);
  });
});

describe('assertGatedMetricsPresent', () => {
  const complete = {
    metrics: { appBootstrapMillis: 1, firstCompileFromBootstrapMillis: 1 },
    warmMetrics: { appBootstrapMillis: 1, firstCompileFromBootstrapMillis: 1 },
  };

  it('accepts a baseline carrying every gated metric', () => {
    expect(() => assertGatedMetricsPresent(complete)).not.toThrow();
  });

  it('refuses a baseline missing a gated metric', () => {
    expect(() =>
      assertGatedMetricsPresent({
        ...complete,
        metrics: { firstCompileFromBootstrapMillis: 1 },
      }),
    ).toThrow(/metrics\.appBootstrapMillis/);
  });

  it('refuses when a gated metric is absent from EVERY input', () => {
    // The earlier negative form ("nothing dropped was gated") missed this: a
    // name absent from every run never enters the dropped set, so it vanished
    // silently and the gate stopped checking it.
    expect(() => assertGatedMetricsPresent({ metrics: {}, warmMetrics: {} })).toThrow(
      /gated metric/,
    );
  });

  it('refuses a wholly empty baseline', () => {
    expect(() => assertGatedMetricsPresent({})).toThrow(/gated metric/);
  });

  it('is section-aware', () => {
    // warmMetrics carries its own gated copies; a cold-only baseline is not enough.
    expect(() => assertGatedMetricsPresent({ metrics: complete.metrics, warmMetrics: {} })).toThrow(
      /warmMetrics/,
    );
  });

  it('does not care about diagnostic metrics', () => {
    expect(() => assertGatedMetricsPresent(complete)).not.toThrow();
  });

  it('refuses a gated metric that is present but unusable', () => {
    // compare-baseline.mjs skips a negative or non-finite metric, so presence
    // alone is not enough -- a negative baseline would silently stop gating.
    for (const bad of [-42, Number.NaN, Number.POSITIVE_INFINITY, '295.7', null]) {
      expect(() =>
        assertGatedMetricsPresent({
          ...complete,
          metrics: { ...complete.metrics, appBootstrapMillis: bad },
        }),
      ).toThrow(/metrics\.appBootstrapMillis/);
    }
  });

  it('accepts a legitimate zero', () => {
    // workerLibraryMount really does measure ~0.1ms; the 5ms budget floor
    // covers it, so zero must not be mistaken for missing.
    expect(() =>
      assertGatedMetricsPresent({
        ...complete,
        metrics: { ...complete.metrics, appBootstrapMillis: 0 },
      }),
    ).not.toThrow();
  });
});

describe('assertCiProfiles', () => {
  const ci = [{ environment: { profile: 'ci-Linux' } }];
  const local = [{ environment: { profile: 'local-headless' } }];

  it('accepts CI captures', () => {
    expect(assertCiProfiles(ci)).toEqual(['ci-Linux']);
  });

  it('refuses a workstation capture — the #278 root cause', () => {
    expect(() => assertCiProfiles(local)).toThrow(/non-CI captures/);
  });

  it('refuses a mixed set', () => {
    expect(() => assertCiProfiles([...ci, ...local])).toThrow(/local-headless/);
  });

  it('honours an explicit assumed profile for pre-fix artifacts', () => {
    expect(assertCiProfiles(local, { assumeProfile: 'ci-Linux' })).toEqual(['ci-Linux']);
  });

  it('will not let --assume-profile launder a local capture', () => {
    // Without this the flag fully inverts the guard it is attached to.
    expect(() => assertCiProfiles(local, { assumeProfile: 'local-headless' })).toThrow(
      /must name a specific CI profile/,
    );
    expect(() => assertCiProfiles(local, { assumeProfile: 'my-laptop' })).toThrow(
      /must name a specific CI profile/,
    );
  });

  it("rejects 'ci-unknown', which a workstation can produce", () => {
    // capture-baseline.mjs yields ci-unknown for CI=true with RUNNER_OS unset,
    // so it passes a bare ci-* prefix check while being no evidence at all.
    const unknown = [{ environment: { profile: 'ci-unknown' } }];
    expect(() => assertCiProfiles(unknown)).toThrow(/non-CI captures/);
    expect(() => assertCiProfiles(local, { assumeProfile: 'ci-unknown' })).toThrow(
      /not ci-unknown/,
    );
  });

  it('treats a missing profile as non-CI', () => {
    expect(() => assertCiProfiles([{}])).toThrow(/unknown/);
  });
});
