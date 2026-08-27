import { describe, expect, it } from 'vitest';

import { DEFAULT_FACE_COLOR } from '../common.ts';
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

// Face colors as OpenSCAD's Manifold backend actually emits them: an RGB (or
// RGBA, for `color(c, alpha)`) suffix on the face line, 0-255 per channel. The
// CGAL backend emits no suffix at all.
const TRI_VERTS = ['0 0 0', '1 0 0', '0 1 0', '0 0 1'].join('\n');
const twoFaces = (a: string, b: string) => `OFF 4 2 0\n${TRI_VERTS}\n${a}\n${b}\n`;

describe('parseOff face colors', () => {
  it('reads an RGB face color and normalizes it to 0..1', () => {
    const poly = parseOff(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 0 255'));
    expect(poly.hasSourceColors).toBe(true);
    expect(poly.colors).toEqual([
      [0, 128 / 255, 0, 1],
      [0, 0, 1, 1],
    ]);
    expect(poly.faces.map((f) => f.colorIndex)).toEqual([0, 1]);
  });

  it('carries the alpha channel of an RGBA face color', () => {
    const poly = parseOff(twoFaces('3 0 1 2 0 128 0 127', '3 0 1 3 0 0 255'));
    expect(poly.colors[0]).toEqual([0, 128 / 255, 0, 127 / 255]);
    expect(poly.colors[1]).toEqual([0, 0, 1, 1]);
  });

  it('flags a model whose faces are all ONE explicit color (#258 regression)', () => {
    // The viewer used to gate per-vertex colors on `colors.length > 1`, so a
    // model with a single `color()` fell back to the default cameo yellow.
    const poly = parseOff(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 128 0'));
    expect(poly.colors).toHaveLength(1);
    expect(poly.hasSourceColors).toBe(true);
  });

  it('does not flag a colorless model, and defaults its faces', () => {
    const poly = parseOff(twoFaces('3 0 1 2', '3 0 1 3'));
    expect(poly.hasSourceColors).toBe(false);
    expect(poly.colors).toEqual([DEFAULT_FACE_COLOR]);
  });

  it('flags a partly-colored model (OpenSCAD fills the rest with its default)', () => {
    const poly = parseOff(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 249 215 44'));
    expect(poly.hasSourceColors).toBe(true);
    expect(poly.colors).toHaveLength(2);
  });

  it('reads a color suffix on a triangulated quad face', () => {
    const poly = parseOff(`OFF 4 1 0\n${TRI_VERTS}\n4 0 1 2 3 0 128 0\n`);
    expect(poly.faces).toHaveLength(2); // fan-triangulated
    expect(poly.hasSourceColors).toBe(true);
    expect(poly.faces.every((f) => f.colorIndex === 0)).toBe(true);
  });
});
