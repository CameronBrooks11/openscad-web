import { describe, expect, it } from 'vitest';

import { parseOff } from '../import_off.ts';

// A unit cube: 8 vertices, 6 quad faces (each fan-triangulated to 2 triangles).
const CUBE_BODY = [
  '-0.5 -0.5 -0.5',
  '0.5 -0.5 -0.5',
  '0.5 0.5 -0.5',
  '-0.5 0.5 -0.5',
  '-0.5 -0.5 0.5',
  '0.5 -0.5 0.5',
  '0.5 0.5 0.5',
  '-0.5 0.5 0.5',
  '4 0 1 2 3',
  '4 7 6 5 4',
  '4 0 4 5 1',
  '4 1 5 6 2',
  '4 2 6 7 3',
  '4 3 7 4 0',
].join('\n');

describe('parseOff', () => {
  it('parses the same-line header form ("OFF 8 6 12", as OpenSCAD exports)', () => {
    const poly = parseOff(`OFF 8 6 12\n${CUBE_BODY}\n`);
    expect(poly.vertices).toHaveLength(8);
    expect(poly.faces).toHaveLength(12); // 6 quads → 12 triangles
  });

  it('parses the canonical multi-line header form ("OFF" on its own line) (#188 regression)', () => {
    // Previously rejected: bare "OFF" matched the same-line branch and read empty
    // counts, throwing "invalid vertex or face counts".
    const poly = parseOff(`OFF\n8 6 12\n${CUBE_BODY}\n`);
    expect(poly.vertices).toHaveLength(8);
    expect(poly.faces).toHaveLength(12);
  });

  it('produces identical geometry from both header forms', () => {
    expect(parseOff(`OFF\n8 6 12\n${CUBE_BODY}\n`)).toEqual(parseOff(`OFF 8 6 12\n${CUBE_BODY}\n`));
  });

  it('tolerates comments and blank lines between header and counts', () => {
    const poly = parseOff(`OFF\n# a comment\n\n8 6 12\n${CUBE_BODY}\n`);
    expect(poly.vertices).toHaveLength(8);
  });

  it('rejects a missing header and malformed counts', () => {
    expect(() => parseOff('8 6 12\n0 0 0\n')).toThrow(/missing OFF header/);
    expect(() => parseOff('OFF\nnot counts\n')).toThrow(/invalid vertex or face counts/);
  });
});
