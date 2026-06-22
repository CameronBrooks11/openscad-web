// OFF → GLB (binary glTF) export. Reuses the viewer's OFF→BufferGeometry
// builder so exported geometry matches what is shown on screen, wraps it in a
// scene, and serializes with Three.js' GLTFExporter.
//
// Three.js (and GLTFExporter) is heavy; this module is dynamically imported by
// the export service only when GLB is requested, so it never loads on the eager
// path.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

import { DEFAULT_FACE_COLOR, type IndexedPolyhedron } from './common.ts';
import { offToBufferGeometry } from '../components/viewer/off-loader.ts';

/**
 * Serialize a parsed OFF polyhedron to a binary glTF (.glb) byte array.
 *
 * Colors: a multi-color model carries per-vertex colors (the geometry's `color`
 * attribute); a single-color model has none, so the material's base color is set
 * from the model's one face color. The geometry is rotated −90° about X so the
 * OpenSCAD Z-up model becomes glTF's Y-up convention, i.e. it stands upright in
 * standard glTF viewers (Blender, model-viewer, three.js loaders).
 */
export async function exportGLB(data: IndexedPolyhedron): Promise<ArrayBuffer> {
  const geometry = offToBufferGeometry(data);
  const hasMultiColor = data.colors.length > 1;

  const [r, g, b] = data.colors[0] ?? DEFAULT_FACE_COLOR;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: hasMultiColor,
    color: hasMultiColor ? 0xffffff : new THREE.Color(r, g, b),
    metalness: 0,
    roughness: 1,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // OpenSCAD is Z-up; glTF is Y-up. Bake the conversion into the node transform.
  mesh.rotation.x = -Math.PI / 2;

  const scene = new THREE.Scene();
  scene.add(mesh);

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true });
  // With `binary: true`, GLTFExporter resolves to an ArrayBuffer (the .glb).
  return result as ArrayBuffer;
}
