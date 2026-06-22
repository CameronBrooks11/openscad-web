// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { globToRegExp, evaluateBudgets } from '../check-bundle-budgets.mjs';

describe('globToRegExp', () => {
  it('matches a hashed filename and is anchored', () => {
    const re = globToRegExp('assets/index-*.js');
    expect(re.test('assets/index-CTYg1Ic3.js')).toBe(true);
    expect(re.test('assets/index-CTYg1Ic3.css')).toBe(false);
    expect(re.test('x/assets/index-a.js')).toBe(false); // anchored
  });

  it('does not let * cross a path separator', () => {
    expect(globToRegExp('assets/index-*.js').test('assets/sub/index-a.js')).toBe(false);
  });
});

describe('evaluateBudgets', () => {
  const files = ['assets/index-AAAA.js', 'assets/index-AAAA.css', 'assets/openscad-BBBB.wasm'];
  const sizes = {
    'assets/index-AAAA.js': 900,
    'assets/index-AAAA.css': 100,
    'assets/openscad-BBBB.wasm': 2800,
  };
  const sizeOf = (f) => sizes[f] ?? 0;

  it('passes when every artifact is within budget', () => {
    const { failed, rows } = evaluateBudgets({
      files,
      sizeOf,
      budgets: [{ label: 'js', pattern: 'assets/index-*.js', maxGzipKB: 1024 }],
    });
    expect(failed).toBe(false);
    expect(rows[0]).toMatchObject({ status: 'ok', files: 1, actualKB: 900 });
  });

  it('fails when an artifact exceeds its budget', () => {
    const { failed, rows } = evaluateBudgets({
      files,
      sizeOf,
      budgets: [{ label: 'wasm', pattern: 'assets/openscad-*.wasm', maxGzipKB: 2048 }],
    });
    expect(failed).toBe(true);
    expect(rows[0].status).toBe('OVER');
  });

  it('fails when a pattern matches no file (renamed/removed chunk)', () => {
    const { failed, rows } = evaluateBudgets({
      files,
      sizeOf,
      budgets: [{ label: 'missing', pattern: 'assets/gone-*.js', maxGzipKB: 9999 }],
    });
    expect(failed).toBe(true);
    expect(rows[0].status).toBe('NO MATCH');
  });

  it('does not fail in report mode even when over budget', () => {
    const { failed } = evaluateBudgets({
      files,
      sizeOf,
      reportOnly: true,
      budgets: [{ label: 'js', pattern: 'assets/index-*.js', maxGzipKB: 1 }],
    });
    expect(failed).toBe(false);
  });
});
