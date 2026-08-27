export type Vertex = {
  x: number;
  y: number;
  z: number;
};

/** Face color as sRGB + alpha, each channel normalized to 0..1.
 *  sRGB is the space OFF face colors and 3MF `displaycolor` are written in;
 *  converting to Three.js' linear working space happens at the renderer
 *  boundary (see `off-loader.ts`), not here. */
export type Color = [number, number, number, number];

export type Face = {
  vertices: [number, number, number];
  colorIndex: number;
};

export type IndexedPolyhedron = {
  vertices: Vertex[];
  faces: Face[];
  colors: Color[];
  /**
   * True when at least one face in the source carried an explicit color, i.e.
   * the model used `color()`. `colors` is never empty — a face with no color
   * gets `DEFAULT_FACE_COLOR`, and `export_3mf.ts` relies on that entry existing
   * — so `colors.length` cannot answer this: a model that is entirely one
   * `color()` yields exactly one entry, indistinguishable from a colorless one.
   */
  hasSourceColors: boolean;
};

export const DEFAULT_FACE_COLOR: Color = [0xf9 / 255, 0xd7 / 255, 0x2c / 255, 1];
