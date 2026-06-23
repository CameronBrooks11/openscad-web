import { describe, expect, it } from 'vitest';

import { bubbleUpDeepMutations } from '../deep-mutate.ts';

describe('bubbleUpDeepMutations — structural sharing (characterization)', () => {
  it('returns the same root identity when nothing changes', () => {
    const o = { a: 1, nested: { b: 2 } };
    const result = bubbleUpDeepMutations(o, () => {});
    expect(result).toBe(o);
    expect(result.nested).toBe(o.nested);
  });

  it('bumps only the root identity on a change; descendants stay in place', () => {
    // The recursion is for change *detection*: only the root is rebuilt, while
    // nested objects keep their identity and are mutated in place (see the
    // model.ts comment — sources identity is reassigned by callers, not here).
    const o = { left: { x: 1 }, right: { y: 2 } };
    const leftBefore = o.left;
    const rightBefore = o.right;
    const result = bubbleUpDeepMutations(o, (s) => {
      s.left.x = 99;
    });
    expect(result).not.toBe(o); // root changed
    expect(result.left).toBe(leftBefore); // same ref, mutated in place
    expect(result.right).toBe(rightBefore); // untouched sibling unchanged
    expect(result.left.x).toBe(99);
  });

  it('detects added and removed keys as changes', () => {
    const added = bubbleUpDeepMutations({ a: 1 } as { a: number; b?: number }, (s) => {
      s.b = 2;
    });
    expect(added.b).toBe(2);

    const removed = bubbleUpDeepMutations({ a: 1, b: 2 } as { a: number; b?: number }, (s) => {
      delete s.b;
    });
    expect('b' in removed).toBe(false);
  });
});

describe('bubbleUpDeepMutations — rollback on a throwing callback (#122)', () => {
  it('leaves the tree untouched and rethrows when the callback throws', () => {
    const o = { view: { color: '#000', axes: true }, params: { activePath: '/a' } };
    const err = new Error('boom');
    expect(() =>
      bubbleUpDeepMutations(o, (s) => {
        s.view.color = '#fff'; // partial edit before the throw
        throw err;
      }),
    ).toThrow(err);

    // The live object is reverted to exactly its original values.
    expect(o.view.color).toBe('#000');
    expect(o.view.axes).toBe(true);
    expect(o.params.activePath).toBe('/a');
  });

  it('restores keys the callback added before throwing', () => {
    const o = { a: 1 } as { a: number; b?: number };
    expect(() =>
      bubbleUpDeepMutations(o, (s) => {
        s.b = 2;
        throw new Error('x');
      }),
    ).toThrow();
    expect('b' in o).toBe(false);
  });

  it('restores keys the callback deleted before throwing', () => {
    const o = { a: 1, b: 2 } as { a: number; b?: number };
    expect(() =>
      bubbleUpDeepMutations(o, (s) => {
        delete s.b;
        throw new Error('x');
      }),
    ).toThrow();
    expect(o.b).toBe(2);
  });

  it('restores array contents and length mutated before throwing', () => {
    const o = { items: [{ id: 1 }, { id: 2 }] };
    const original = o.items;
    expect(() =>
      bubbleUpDeepMutations(o, (s) => {
        s.items.push({ id: 3 });
        s.items[0].id = 999;
        throw new Error('x');
      }),
    ).toThrow();
    expect(o.items).toBe(original); // same array reference, restored
    expect(o.items.length).toBe(2);
    expect(o.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it('restores original key order after a deleted key is rolled back', () => {
    // Order matters: a later successful persist compares JSON.stringify of the
    // durable slice, so a reordered key would cause a spurious write.
    const o = { a: 1, b: 2, c: 3 } as { a: number; b?: number; c: number };
    expect(() =>
      bubbleUpDeepMutations(o, (s) => {
        delete s.b;
        throw new Error('x');
      }),
    ).toThrow();
    expect(Object.keys(o)).toEqual(['a', 'b', 'c']);
    expect(JSON.stringify(o)).toBe('{"a":1,"b":2,"c":3}');
  });

  it('still applies the mutation normally when the callback does not throw', () => {
    const o = { n: 1 };
    const result = bubbleUpDeepMutations(o, (s) => {
      s.n = 5;
    });
    expect(result.n).toBe(5);
  });
});
