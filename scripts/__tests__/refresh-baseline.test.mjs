// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  nearestRankPercentile,
  aggregateSection,
  assertCiProfiles,
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

  it('clamps to the ends rather than reading out of bounds', () => {
    expect(nearestRankPercentile([4, 8], 100)).toBe(8);
    expect(nearestRankPercentile([4, 8], 1)).toBe(4);
  });

  it('throws on an empty sample instead of returning undefined', () => {
    expect(() => nearestRankPercentile([], 90)).toThrow(/empty sample/);
  });
});

describe('aggregateSection', () => {
  const runs = [{ metrics: { a: 10, b: 1 } }, { metrics: { a: 20, b: 2 } }, { metrics: { a: 30 } }];

  it('drops a metric that is missing from any run', () => {
    // Averaging over the runs that do have it would set a budget from a
    // different population; treating it as 0 would pin the budget to the 5ms
    // floor and fail every later run.
    expect(aggregateSection(runs, 'metrics', 90)).not.toHaveProperty('b');
  });

  it('keeps a metric present in every run', () => {
    expect(aggregateSection(runs, 'metrics', 90).a).toBe(30);
  });

  it('rounds to one decimal, matching the capture pipeline', () => {
    const r = [{ m: { x: 1.234 } }, { m: { x: 1.235 } }];
    expect(aggregateSection(r, 'm', 50).x).toBe(1.2);
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

  it('treats a missing profile as non-CI', () => {
    expect(() => assertCiProfiles([{}])).toThrow(/unknown/);
  });
});
