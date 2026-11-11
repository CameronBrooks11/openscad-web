import * as THREE from 'three';

import {
  cappedPixelRatio,
  createModelMaterial,
  MAX_PIXEL_RATIO,
  NAMED_POSITIONS,
} from '../ThreeScene.ts';
import { offToBufferGeometry } from '../off-loader.ts';
import { parseOff } from '../../../io/import_off.ts';
import { VIEWER_NAMED_VIEWS } from '../../../protocol/viewer-transport.ts';

describe('cappedPixelRatio (#61)', () => {
  it('caps high device-pixel-ratios at the maximum', () => {
    expect(cappedPixelRatio(3)).toBe(MAX_PIXEL_RATIO);
    expect(cappedPixelRatio(4, 2)).toBe(2);
  });

  it('passes through ratios at or below the cap', () => {
    expect(cappedPixelRatio(1)).toBe(1);
    expect(cappedPixelRatio(1.5)).toBe(1.5);
    expect(cappedPixelRatio(2)).toBe(2);
  });

  it('falls back to 1 for invalid ratios', () => {
    expect(cappedPixelRatio(0)).toBe(1);
    expect(cappedPixelRatio(-2)).toBe(1);
    expect(cappedPixelRatio(NaN)).toBe(1);
  });
});

// The protocol can't import the viewer (lint fence), so VIEWER_NAMED_VIEWS
// duplicates the viewer's NAMED_POSITIONS names. Pin them together so the L0
// `setNamedView` tokens can never drift from what the viewer actually applies.
describe('named-view tokens (#188)', () => {
  it('VIEWER_NAMED_VIEWS matches the viewer NAMED_POSITIONS names exactly', () => {
    expect([...VIEWER_NAMED_VIEWS]).toEqual(NAMED_POSITIONS.map((p) => p.name));
  });
});

// Geometry comes from the real OFF pipeline so these pin the contract between
// the loader's color attribute / groups and the material set built for them.
describe('createModelMaterial (#282)', () => {
  const VERTS = ['0 0 0', '1 0 0', '0 1 0', '0 0 1'].join('\n');
  const geometryFor = (a: string, b: string) =>
    offToBufferGeometry(parseOff(`OFF 4 2 0\n${VERTS}\n${a}\n${b}\n`));

  it('gives a fully opaque model one opaque material, as before', () => {
    for (const geometry of [
      geometryFor('3 0 1 2', '3 0 1 3'),
      geometryFor('3 0 1 2 0 128 0', '3 0 1 3 0 0 255 255'),
    ]) {
      const material = createModelMaterial(geometry, 0xf9d72c);
      expect(Array.isArray(material)).toBe(false);
      expect((material as THREE.Material).transparent).toBe(false);
      expect((material as THREE.Material).depthWrite).toBe(true);
    }
  });

  it('makes color(c, alpha) faces render translucent', () => {
    const geometry = geometryFor('3 0 1 2 0 128 0 102', '3 0 1 3 0 128 0 102');
    const materials = createModelMaterial(geometry, 0xf9d72c);
    expect(Array.isArray(materials)).toBe(true);
    // Every group must resolve to a translucent, vertex-colored material that
    // does not occlude what is behind it.
    for (const group of geometry.groups) {
      const material = (materials as THREE.MeshPhongMaterial[])[group.materialIndex!];
      expect(material.transparent).toBe(true);
      expect(material.vertexColors).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
  });

  it('keeps the opaque faces of a mixed model opaque and depth-writing', () => {
    const geometry = geometryFor('3 0 1 2 0 128 0 127', '3 0 1 3 0 0 255');
    const materials = createModelMaterial(geometry, 0xf9d72c) as THREE.MeshPhongMaterial[];
    const byGroup = geometry.groups.map((g) => materials[g.materialIndex!]);
    expect(byGroup.map((m) => m.transparent)).toEqual([false, true]);
    expect(byGroup.map((m) => m.depthWrite)).toEqual([true, false]);
    for (const m of byGroup) expect(m.vertexColors).toBe(true);
  });
});
