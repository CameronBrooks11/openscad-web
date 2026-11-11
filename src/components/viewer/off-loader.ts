// off-loader.ts — converts parsed OFF geometry to a Three.js BufferGeometry.
// Uses the existing parseOff() from import_off.ts — no re-parsing.

import * as THREE from 'three';
import { IndexedPolyhedron, Color, Face } from '../../io/common.ts';

/** Draw-group material slots, used only when the model has translucent faces. */
export const OPAQUE_GROUP = 0;
export const TRANSLUCENT_GROUP = 1;

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
 *
 * Translucency (#282): when any face color has alpha < 1, the `color`
 * attribute is RGBA rather than RGB, and the faces are reordered into two draw
 * groups -- opaque faces first (`OPAQUE_GROUP`), translucent ones after
 * (`TRANSLUCENT_GROUP`) -- so the opaque part can keep writing depth while the
 * translucent part is blended over it. Empty groups are omitted. A model with
 * no translucent face is built exactly as before: RGB, one implicit group.
 */
export function offToBufferGeometry(data: IndexedPolyhedron): THREE.BufferGeometry {
  const { vertices, faces, colors, hasSourceColors } = data;

  // OFF face colors are sRGB; Three.js reads a `color` attribute as already
  // being in the renderer's linear working space (unlike `material.color`,
  // which it converts for us). Convert here or colors render washed out.
  const linear = hasSourceColors ? colors.map(toLinear) : [];
  const faceColor = (face: Face) => linear[face.colorIndex] ?? linear[0];
  const isTranslucent = (face: Face) => faceColor(face)[3] < 1;

  const translucent = hasSourceColors ? faces.filter(isTranslucent) : [];
  const withAlpha = translucent.length > 0;
  const ordered = withAlpha ? [...faces.filter((f) => !isTranslucent(f)), ...translucent] : faces;
  const channels = withAlpha ? 4 : 3;

  const positions: number[] = [];
  const normals: number[] = [];
  const vertColors: number[] = [];

  for (const face of ordered) {
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
      const rgba = faceColor(face).slice(0, channels);
      vertColors.push(...rgba, ...rgba, ...rgba);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (hasSourceColors) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertColors, channels));
  }
  if (withAlpha) {
    const opaqueVerts = (ordered.length - translucent.length) * 3;
    if (opaqueVerts > 0) geometry.addGroup(0, opaqueVerts, OPAQUE_GROUP);
    geometry.addGroup(opaqueVerts, translucent.length * 3, TRANSLUCENT_GROUP);
  }
  return geometry;
}

/** sRGB (0..1) -> the renderer's linear working space. Alpha is coverage, not
 *  a color channel, so it passes through unconverted. */
function toLinear([r, g, b, a]: Color): Color {
  const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b, a];
}
