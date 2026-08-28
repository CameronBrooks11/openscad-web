// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  nearestRankPercentile,
  aggregateSection,
  assertCiProfiles,
  assertNoGatedDrops,
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

describe('assertNoGatedDrops', () => {
  it('refuses to drop a gated metric — that silently un-gates CI', () => {
    expect(() => assertNoGatedDrops('metrics', ['appBootstrapMillis'])).toThrow(/gated metric/);
    expect(() => assertNoGatedDrops('warmMetrics', ['firstCompileFromBootstrapMillis'])).toThrow(
      /gated metric/,
    );
  });

  it('allows a diagnostic metric to drop', () => {
    expect(() => assertNoGatedDrops('metrics', ['editorMountMillis'])).not.toThrow();
  });

  it('is section-aware — the same name is gated in one section only where listed', () => {
    expect(() => assertNoGatedDrops('metrics', ['appBootstrapMillis'])).toThrow();
    expect(() => assertNoGatedDrops('notASection', ['appBootstrapMillis'])).not.toThrow();
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
      /must name a CI profile/,
    );
    expect(() => assertCiProfiles(local, { assumeProfile: 'my-laptop' })).toThrow(
      /must name a CI profile/,
    );
  });

  it('treats a missing profile as non-CI', () => {
    expect(() => assertCiProfiles([{}])).toThrow(/unknown/);
  });
});
