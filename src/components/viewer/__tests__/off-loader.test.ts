import { describe, expect, it } from 'vitest';

import { parseOff } from '../../../io/import_off.ts';
import { OPAQUE_GROUP, offToBufferGeometry, TRANSLUCENT_GROUP } from '../off-loader.ts';

const VERTS = ['0 0 0', '1 0 0', '0 1 0', '0 0 1'].join('\n');
const twoFaces = (a: string, b: string) => `OFF 4 2 0\n${VERTS}\n${a}\n${b}\n`;

/** The sRGB electro-optical transfer function, written out independently of
 *  Three.js so the test checks the conversion rather than restating the call. */
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const load = (off: string) => offToBufferGeometry(parseOff(off));

describe('offToBufferGeometry', () => {
  it('emits no color attribute for a colorless model', () => {
    // The viewer then paints it with its single default material.
    expect(load(twoFaces('3 0 1 2', '3 0 1 3')).getAttribute('color')).toBeUndefined();
  });

  it('emits a color attribute when the model used ONE color() (#258 regression)', () => {
    const geometry = load(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 128 0'));
    expect(geometry.getAttribute('color')).toBeDefined();
  });

  it('emits a color attribute for a multi-color model', () => {
    const geometry = load(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 0 255'));
    expect(geometry.getAttribute('color')).toBeDefined();
  });

  it('converts sRGB face colors into the renderer working space (#258)', () => {
    // Three.js converts `material.color` from sRGB for us but reads a `color`
    // attribute as already linear, so an unconverted attribute rendered washed
    // out next to the same color applied as a material.
    const color = load(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 128 0')).getAttribute('color')!;
    expect(color.getX(0)).toBeCloseTo(0, 5);
    expect(color.getY(0)).toBeCloseTo(srgbToLinear(128 / 255), 5);
    expect(color.getZ(0)).toBeCloseTo(0, 5);
    // Guard against a silent regression to passing sRGB straight through.
    expect(color.getY(0)).not.toBeCloseTo(128 / 255, 3);
  });

  it('gives every vertex of a face that face color', () => {
    const color = load(twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 0 255'))!.getAttribute('color')!;
    const green = srgbToLinear(128 / 255);
    for (const i of [0, 1, 2]) expect(color.getY(i)).toBeCloseTo(green, 5);
    for (const i of [3, 4, 5]) expect(color.getZ(i)).toBeCloseTo(1, 5);
  });

  describe('alpha from color(c, alpha) (#282)', () => {
    // What OpenSCAD's Manifold backend writes for `color("green", 0.4)`: a 4th
    // channel on the face line, 0.4 * 255 rounded down.
    const GREEN_04 = '0 128 0 102';

    it('carries alpha into a 4-component color attribute', () => {
      const color = load(twoFaces(`3 0 1 2 ${GREEN_04}`, `3 0 1 3 ${GREEN_04}`)).getAttribute(
        'color',
      )!;
      expect(color.itemSize).toBe(4);
      for (let i = 0; i < color.count; i++) expect(color.getW(i)).toBeCloseTo(102 / 255, 5);
    });

    it('keeps alpha linear while converting RGB from sRGB', () => {
      // Alpha is coverage, not a color channel: sRGB-decoding it as well would
      // make 0.4 render as ~0.13.
      const color = load(twoFaces(`3 0 1 2 ${GREEN_04}`, `3 0 1 3 ${GREEN_04}`)).getAttribute(
        'color',
      )!;
      expect(color.getY(0)).toBeCloseTo(srgbToLinear(128 / 255), 5);
      expect(color.getW(0)).not.toBeCloseTo(srgbToLinear(102 / 255), 3);
    });

    it('gives a 3-channel face alpha 1 in a file that mixes 3- and 4-channel faces', () => {
      // Manifold writes RGB for color(c) and RGBA for color(c, a) in one file.
      const geometry = load(twoFaces('3 0 1 2 0 0 255', `3 0 1 3 ${GREEN_04}`));
      const color = geometry.getAttribute('color')!;
      expect(color.itemSize).toBe(4);
      const alphas = Array.from({ length: color.count }, (_, i) => color.getW(i));
      expect(alphas.filter((a) => a === 1)).toHaveLength(3);
      expect(alphas.filter((a) => Math.abs(a - 102 / 255) < 1e-6)).toHaveLength(3);
    });

    it('splits opaque and translucent faces into two draw groups, opaque first', () => {
      // Translucent face listed FIRST in the file, so the order is the loader's.
      const geometry = load(twoFaces(`3 0 1 2 ${GREEN_04}`, '3 0 1 3 0 0 255'));
      expect(geometry.groups).toEqual([
        { start: 0, count: 3, materialIndex: OPAQUE_GROUP },
        { start: 3, count: 3, materialIndex: TRANSLUCENT_GROUP },
      ]);
      const color = geometry.getAttribute('color')!;
      for (const i of [0, 1, 2]) expect(color.getW(i)).toBe(1);
      for (const i of [3, 4, 5]) expect(color.getW(i)).toBeCloseTo(102 / 255, 5);
      // Positions travel with their face: the opaque face (0 1 3) is now first.
      expect(geometry.getAttribute('position').getZ(2)).toBe(1);
    });

    it('emits only the translucent group when every face is translucent', () => {
      const geometry = load(twoFaces(`3 0 1 2 ${GREEN_04}`, `3 0 1 3 ${GREEN_04}`));
      expect(geometry.groups).toEqual([{ start: 0, count: 6, materialIndex: TRANSLUCENT_GROUP }]);
    });

    it('leaves a fully opaque model as it was: 3 components, no groups', () => {
      // An explicit alpha of 255 is opaque too and must not opt into blending.
      for (const off of [
        twoFaces('3 0 1 2 0 128 0', '3 0 1 3 0 0 255'),
        twoFaces('3 0 1 2 0 128 0 255', '3 0 1 3 0 0 255'),
      ]) {
        const geometry = load(off);
        expect(geometry.getAttribute('color')!.itemSize).toBe(3);
        expect(geometry.groups).toEqual([]);
      }
    });
  });

  it('always emits position and normal attributes', () => {
    const geometry = load(twoFaces('3 0 1 2', '3 0 1 3'));
    expect(geometry.getAttribute('position').count).toBe(6);
    expect(geometry.getAttribute('normal').count).toBe(6);
  });
});
