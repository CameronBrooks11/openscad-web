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
    hasSourceColors: true,
  };

  const readBlobAsArrayBuffer = (blob: Blob): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });

  const readModelXml = async (data: IndexedPolyhedron = sampleData) => {
    const zip = UZIP.parse(await readBlobAsArrayBuffer(export3MF(data))) as Record<
      string,
      Uint8Array
    >;
    return new TextDecoder().decode(zip['3D/3dmodel.model']);
  };

  it('writes each base material in sRGB, not scaled-down near-black (#285)', async () => {
    // `Color` is 0..1 per channel and chroma.rgb wants 0..255, so passing the
    // components straight through turned green (0, 128, 0) into #000100 and made
    // every material in every export indistinguishably dark.
    const green: [number, number, number, number] = [0, 128 / 255, 0, 1];
    const xml = await readModelXml({ ...sampleData, colors: [green] });

    expect(xml).toContain('displaycolor="#008000"');
    expect(xml).not.toContain('displaycolor="#000100"');
  });

  it('keeps displaycolor 6-digit for a translucent color', async () => {
    // chroma emits #RRGGBBAA once alpha < 1. Alpha was always clamped away here
    // before, so holding the format steady keeps slicers reading what they did.
    const halfGreen: [number, number, number, number] = [0, 128 / 255, 0, 0.5];
    const xml = await readModelXml({ ...sampleData, colors: [halfGreen] });

    expect(xml).toContain('displaycolor="#008000"');
  });

  it('writes one base material per distinct color', async () => {
    const xml = await readModelXml({
      ...sampleData,
      colors: [
        [0, 128 / 255, 0, 1],
        [0, 0, 1, 1],
      ],
    });

    expect(xml).toContain('displaycolor="#008000"');
    expect(xml).toContain('displaycolor="#0000ff"');
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
