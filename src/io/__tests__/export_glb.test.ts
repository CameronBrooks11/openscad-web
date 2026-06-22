import { describe, expect, it } from 'vitest';

import { exportGLB } from '../export_glb.ts';
import type { IndexedPolyhedron } from '../common.ts';

// A unit tetrahedron: 4 vertices, 4 triangular faces.
function tetrahedron(colors: IndexedPolyhedron['colors']): IndexedPolyhedron {
  return {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    ],
    faces: [
      { vertices: [0, 1, 2], colorIndex: 0 },
      { vertices: [0, 1, 3], colorIndex: 0 },
      { vertices: [0, 2, 3], colorIndex: 0 },
      { vertices: [1, 2, 3], colorIndex: 0 },
    ],
    colors,
  };
}

// Parse the JSON chunk (chunk 0) out of a GLB container.
// Layout: 12-byte header, then [uint32 chunkLength][uint32 chunkType='JSON'][bytes].
function readGlbJson(buffer: ArrayBuffer): {
  nodes: Array<{ rotation?: number[]; matrix?: number[] }>;
} {
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(buffer, 20, jsonLength);
  return JSON.parse(new TextDecoder().decode(jsonBytes));
}

// GLB header: magic 'glTF' (0x46546C67 LE), version, total length.
function readGlbHeader(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  return {
    magic: String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]),
    version: view.getUint32(4, true),
    length: view.getUint32(8, true),
  };
}

describe('exportGLB', () => {
  it('produces a valid binary glTF (GLB) for a single-color mesh', async () => {
    const glb = await exportGLB(tetrahedron([[0.9, 0.2, 0.1, 1]]));
    expect(glb).toBeInstanceOf(ArrayBuffer);
    const header = readGlbHeader(glb);
    expect(header.magic).toBe('glTF');
    expect(header.version).toBe(2);
    // The declared length must match the actual byte length.
    expect(header.length).toBe(glb.byteLength);
  });

  it('produces a valid GLB for a multi-color mesh (per-vertex colors)', async () => {
    const glb = await exportGLB(
      tetrahedron([
        [0.9, 0.2, 0.1, 1],
        [0.1, 0.2, 0.9, 1],
      ]),
    );
    const header = readGlbHeader(glb);
    expect(header.magic).toBe('glTF');
    expect(header.version).toBe(2);
    expect(glb.byteLength).toBeGreaterThan(12);
  });

  it('rotates Z-up OpenSCAD geometry to glTF Y-up via the node transform', async () => {
    const glb = await exportGLB(tetrahedron([[0.5, 0.5, 0.5, 1]]));
    const { nodes } = readGlbJson(glb);
    // GLTFExporter writes the node transform as a column-major matrix. A −90°
    // rotation about X maps local +Z (OpenSCAD up) to world +Y (glTF up).
    const matrix = nodes?.[0]?.matrix;
    expect(matrix).toBeDefined();
    const expected = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) expect(matrix![i]).toBeCloseTo(expected[i], 5);
  });
});
