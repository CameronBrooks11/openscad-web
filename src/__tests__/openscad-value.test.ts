import { describe, expect, it } from 'vitest';

import { formatValue } from '../runner/actions.ts';
import {
  coerceUrlVar,
  coerceUrlVars,
  isOpenScadValue,
  MAX_VALUE_DEPTH,
} from '../openscad-value.ts';

describe('isOpenScadValue', () => {
  it('accepts primitives and nested vectors of them', () => {
    expect(isOpenScadValue('hello')).toBe(true);
    expect(isOpenScadValue(3.14)).toBe(true);
    expect(isOpenScadValue(-7)).toBe(true);
    expect(isOpenScadValue(0)).toBe(true);
    expect(isOpenScadValue(true)).toBe(true);
    expect(isOpenScadValue([1, 2, 3])).toBe(true);
    expect(
      isOpenScadValue([
        [1, 2],
        [3, 4],
      ]),
    ).toBe(true);
    expect(isOpenScadValue(['a', 1, true, [2]])).toBe(true);
    expect(isOpenScadValue([])).toBe(true);
  });

  it('rejects objects, null/undefined, and non-finite numbers', () => {
    expect(isOpenScadValue({ a: 1 })).toBe(false); // OpenSCAD has no dict type
    expect(isOpenScadValue(null)).toBe(false);
    expect(isOpenScadValue(undefined)).toBe(false);
    expect(isOpenScadValue(NaN)).toBe(false);
    expect(isOpenScadValue(Infinity)).toBe(false);
    expect(isOpenScadValue(-Infinity)).toBe(false);
    expect(isOpenScadValue(() => 1)).toBe(false);
    expect(isOpenScadValue(Symbol('x'))).toBe(false);
    expect(isOpenScadValue(10n)).toBe(false);
  });

  it('rejects an object or non-finite nested inside a vector', () => {
    expect(isOpenScadValue([1, { a: 1 }])).toBe(false);
    expect(isOpenScadValue([1, NaN, 3])).toBe(false);
    expect(isOpenScadValue([1, [2, null]])).toBe(false);
  });

  it('bounds array nesting at MAX_VALUE_DEPTH', () => {
    const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);
    expect(isOpenScadValue(nest(MAX_VALUE_DEPTH))).toBe(true);
    expect(isOpenScadValue(nest(MAX_VALUE_DEPTH + 1))).toBe(false);
  });
});

describe('isOpenScadValue agrees with the args builder (no divergence)', () => {
  // The refactor's core guarantee: a value accepted by the boundary validator is
  // exactly a value the `-D` formatter can render, and vice versa. Cross-check the
  // two against a battery so they can never drift apart.
  const formatThrows = (v: unknown) => {
    try {
      formatValue(v);
      return false;
    } catch {
      return true;
    }
  };
  const nest = (depth: number, leaf: unknown): unknown =>
    depth === 0 ? leaf : [nest(depth - 1, leaf)];

  const battery: unknown[] = [
    'a',
    '',
    0,
    -3.14,
    1e308,
    true,
    false,
    [1, 2, 3],
    [['a', 1], [true]],
    [],
    nest(MAX_VALUE_DEPTH, 1),
    nest(MAX_VALUE_DEPTH, []), // empty array exactly at the depth limit (the edge)
    nest(MAX_VALUE_DEPTH + 1, 1),
    {},
    { a: 1 },
    null,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    () => 1,
    [1, {}],
    [1, NaN],
  ];

  it('isOpenScadValue(v) === !formatValue-throws(v) for every battery value', () => {
    for (const v of battery) {
      expect(isOpenScadValue(v)).toBe(!formatThrows(v));
    }
  });
});

describe('coerceUrlVar', () => {
  it('maps true/false strings to booleans', () => {
    expect(coerceUrlVar('true')).toBe(true);
    expect(coerceUrlVar('false')).toBe(false);
  });

  it('maps finite numeric strings to numbers', () => {
    expect(coerceUrlVar('3.14')).toBe(3.14);
    expect(coerceUrlVar('-7')).toBe(-7);
    expect(coerceUrlVar('0')).toBe(0);
  });

  it('keeps non-finite and non-numeric strings as strings (the args-builder-safe choice)', () => {
    // 'Infinity'/'NaN' must NOT become numbers — the args builder rejects those.
    expect(coerceUrlVar('Infinity')).toBe('Infinity');
    expect(coerceUrlVar('NaN')).toBe('NaN');
    expect(coerceUrlVar('hello')).toBe('hello');
    expect(coerceUrlVar('')).toBe(''); // empty stays empty string, not 0
    expect(coerceUrlVar('  ')).toBe('  ');
  });

  it('every coerced value is a valid OpenScadValue', () => {
    for (const raw of ['true', 'false', '3.14', 'Infinity', 'NaN', '', 'hello']) {
      expect(isOpenScadValue(coerceUrlVar(raw))).toBe(true);
    }
  });
});

describe('coerceUrlVars', () => {
  it('coerces each entry of a flat string map', () => {
    expect(coerceUrlVars({ a: 'true', b: '2', c: 'x' })).toEqual({ a: true, b: 2, c: 'x' });
  });
});
