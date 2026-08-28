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

  it('ignores non-numeric color fields instead of emitting NaN colors', () => {
    // Third-party OFF only -- our own compiler never writes this. Unguarded,
    // `.map(Number)` made these NaN and the viewer built a color attribute full
    // of NaN, which reaches the GPU as garbage.
    const poly = parseOff(twoFaces('3 0 1 2 foo bar baz', '3 0 1 3'));
    expect(poly.hasSourceColors).toBe(false);
    expect(poly.colors).toEqual([DEFAULT_FACE_COLOR]);
    expect(poly.colors.flat().every(Number.isFinite)).toBe(true);
  });

  it('rejects a non-finite color channel, which isNaN alone would let through', () => {
    const poly = parseOff(twoFaces('3 0 1 2 1e999 0 0', '3 0 1 3'));
    expect(poly.hasSourceColors).toBe(false);
    expect(poly.colors.flat().every(Number.isFinite)).toBe(true);
  });

  it('keeps an RGB triple whose 4th field is not a number (trailing comment)', () => {
    // Judging alpha separately keeps the color; an all-or-nothing check over
    // four fields would drop a valid green here and render cameo yellow.
    const poly = parseOff(twoFaces('3 0 1 2 0 128 0 # green', '3 0 1 3 0 128 0'));
    expect(poly.hasSourceColors).toBe(true);
    expect(poly.colors).toEqual([[0, 128 / 255, 0, 1]]);
  });

  it('reads a color suffix on a triangulated quad face', () => {
    const poly = parseOff(`OFF 4 1 0\n${TRI_VERTS}\n4 0 1 2 3 0 128 0\n`);
    expect(poly.faces).toHaveLength(2); // fan-triangulated
    expect(poly.hasSourceColors).toBe(true);
    expect(poly.faces.every((f) => f.colorIndex === 0)).toBe(true);
  });
});

// The OFF spec tells integer 0..255 from float 0..1 by the TOKEN, not the value:
// "three or four integers | RGB ... 0..255" vs "three or four floating-point
// numbers | RGB ... 0..1" (Geomview OOGL manual). #287.
describe('parseOff float 0..1 face colors (#287)', () => {
  const oneFace = (face: string) => `OFF 4 1 0\n${TRI_VERTS}\n${face}\n`;

  it('reads a float channel on its own scale, not divided by 255', () => {
    // The filed bug: 0.5 became 0.00196, i.e. near-black.
    const poly = parseOff(oneFace('3 0 1 2 0.5 0.5 0.5'));
    expect(poly.colors[0]).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it('reads 1.0 0.0 0.0 as red, not as 1/255 near-black', () => {
    // A value-based rule ("any channel has a fractional part") gets this wrong,
    // and it is the form Geomview's own binary example and Antiprism emit.
    expect(parseOff(oneFace('3 0 1 2 1.0 0.0 0.0')).colors[0]).toEqual([1, 0, 0, 1]);
  });

  it('defaults a float color to fully opaque, not to 255', () => {
    expect(parseOff(oneFace('3 0 1 2 0.25 0.5 0.75')).colors[0][3]).toBe(1);
  });

  it('reads float alpha on the float scale', () => {
    expect(parseOff(oneFace('3 0 1 2 0.0 1.0 0.0 0.4')).colors[0]).toEqual([0, 1, 0, 0.4]);
  });

  it('decides once per file, so one float channel makes the whole file float', () => {
    // Deciding per face would render two faces of the same encoding differently
    // depending on their values.
    const poly = parseOff(twoFaces('3 0 1 2 1 0 0', '3 0 1 3 0.5 0.5 0.5'));
    expect(poly.colors[0]).toEqual([1, 0, 0, 1]);
    expect(poly.colors[1]).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it('keeps a mixed-literal channel set on the float scale', () => {
    // MeshLab and OpenMesh test only the first channel and would misread this.
    expect(parseOff(oneFace('3 0 1 2 1 0.5 0')).colors[0]).toEqual([1, 0.5, 0, 1]);
  });

  it('leaves OpenSCAD integer output exactly as before', () => {
    const poly = parseOff(twoFaces('3 0 1 2 0 128 0 127', '3 0 1 3 249 215 44'));
    expect(poly.colors[0]).toEqual([0, 128 / 255, 0, 127 / 255]);
    expect(poly.colors[1]).toEqual([249 / 255, 215 / 255, 44 / 255, 1]);
  });

  it('reads an all-0/1 integer file as integer, the predictable reading', () => {
    // Genuinely undecidable -- `1 0 0` is near-black as integers and red as
    // floats-without-decimals. Integer keeps behaviour predictable and matches
    // MeshLab and OpenMesh, which apply the same lexical test. Asserted so the
    // choice is visible and a change to it is deliberate.
    expect(parseOff(oneFace('3 0 1 2 1 0 0')).colors[0]).toEqual([1 / 255, 0, 0, 1]);
  });

  it('does not treat a trailing comment as a float channel', () => {
    // The #284 behaviour: a non-numeric 4th field means "no alpha", and the
    // token must not be mistaken for a non-integer literal either.
    const poly = parseOff(oneFace('3 0 1 2 0 128 0 # green'));
    expect(poly.colors[0]).toEqual([0, 128 / 255, 0, 1]);
  });
});
