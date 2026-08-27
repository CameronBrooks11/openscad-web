import { describe, expect, it } from 'vitest';

import { parseOff } from '../../../io/import_off.ts';
import { offToBufferGeometry } from '../off-loader.ts';

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

  it('always emits position and normal attributes', () => {
    const geometry = load(twoFaces('3 0 1 2', '3 0 1 3'));
    expect(geometry.getAttribute('position').count).toBe(6);
    expect(geometry.getAttribute('normal').count).toBe(6);
  });
});
