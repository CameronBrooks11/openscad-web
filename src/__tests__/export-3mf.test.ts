import UZIP from 'uzip';
import chroma from 'chroma-js';
import { export3MF } from '../io/export_3mf.ts';
import type { IndexedPolyhedron } from '../io/common.ts';

describe('export3MF', () => {
  const sampleData: IndexedPolyhedron = {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
    faces: [{ vertices: [0, 1, 2], colorIndex: 0 }],
    colors: [[1, 0, 0, 1] as [number, number, number, number]],
  };

  const readBlobAsArrayBuffer = (blob: Blob): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });

  it('writes a valid build UUID attribute (no stray brace)', async () => {
    const blob = export3MF(sampleData);
    const zip = UZIP.parse(await readBlobAsArrayBuffer(blob)) as Record<string, Uint8Array>;
    const modelXml = new TextDecoder().decode(zip['3D/3dmodel.model']);

    expect(modelXml).toContain('<build p:UUID="');
    expect(modelXml).not.toMatch(/<build p:UUID="[^"]*}">/);
  });

  it('does not emit debug console logs when extruder colors are provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      export3MF(sampleData, [chroma('#ff0000')]);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
