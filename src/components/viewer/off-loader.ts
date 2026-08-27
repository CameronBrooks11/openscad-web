// off-loader.ts — converts parsed OFF geometry to a Three.js BufferGeometry.
// Uses the existing parseOff() from import_off.ts — no re-parsing.

import * as THREE from 'three';
import { IndexedPolyhedron, Color } from '../../io/common.ts';

/**
 * Build a BufferGeometry from a pre-parsed OFF IndexedPolyhedron.
 * Faces are already triangulated by parseOff(); we just flatten them into
 * position / normal / color attribute arrays.
 *
 * Returns a geometry with per-face flat normals and, when the model used
 * `color()` at all, per-vertex color attributes. Color is keyed off
 * `hasSourceColors` rather than the number of distinct colors: a model that is
 * entirely one `color()` has exactly one, and gating on `colors.length > 1`
 * dropped it back to the viewer's default material (#258).
 */
export function offToBufferGeometry(data: IndexedPolyhedron): THREE.BufferGeometry {
  const { vertices, faces, colors, hasSourceColors } = data;

  const positions: number[] = [];
  const normals: number[] = [];
  const vertColors: number[] = [];
  // OFF face colors are sRGB; Three.js reads a `color` attribute as already
  // being in the renderer's linear working space (unlike `material.color`,
  // which it converts for us). Convert here or colors render washed out.
  const linear = hasSourceColors ? colors.map(toLinear) : [];

  for (const face of faces) {
    const [i0, i1, i2] = face.vertices;
    const a = vertices[i0];
    const b = vertices[i1];
    const c = vertices[i2];

    // Flat face normal (cross-product of two edges)
    const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const ac = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
    const n = new THREE.Vector3().crossVectors(ab, ac).normalize();

    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);

    if (hasSourceColors) {
      const [r, g, b_] = linear[face.colorIndex] ?? linear[0];
      vertColors.push(r, g, b_, r, g, b_, r, g, b_);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (hasSourceColors) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertColors, 3));
  }
  return geometry;
}

/** sRGB (0..1) → the renderer's linear working space. Alpha is not carried by
 *  the `color` attribute, so it is dropped here (#282). */
function toLinear([r, g, b]: Color): [number, number, number] {
  const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}
