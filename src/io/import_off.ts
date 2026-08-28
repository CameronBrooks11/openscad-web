import { Color, DEFAULT_FACE_COLOR, Face, IndexedPolyhedron, Vertex } from './common';

/** A bare integer token. `0.5`, `1.0` and `1e-3` are float; `128`, `0`, `1` are not. */
const INTEGER_LITERAL = /^[+-]?\d+$/;

/** A face color as written, before the file's scale is known. */
type RawColor = { rgb: [number, number, number]; alpha: number | null };

export function parseOff(content: string): IndexedPolyhedron {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) throw new Error('Empty OFF file');

  let counts: string;
  let currentLine = 0;
  if (/^OFF\s+\S/.test(lines[0])) {
    // Header and counts on the same line: "OFF 8 6 12".
    counts = lines[0].substring(3).trim();
    currentLine = 1;
  } else if (lines[0] === 'OFF' && lines.length > 1) {
    // Canonical multi-line form: "OFF" alone, counts on the next line.
    counts = lines[1];
    currentLine = 2;
  } else {
    throw new Error('Invalid OFF file: missing OFF header');
  }

  const [numVertices, numFaces] = counts.split(/\s+/).map(Number);
  if (isNaN(numVertices) || isNaN(numFaces))
    throw new Error('Invalid OFF file: invalid vertex or face counts');

  if (currentLine + numVertices + numFaces > lines.length)
    throw new Error('Invalid OFF file: not enough lines');

  const vertices: Vertex[] = [];
  for (let i = 0; i < numVertices; i++) {
    const parts = lines[currentLine + i].split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some(isNaN))
      throw new Error(`Invalid OFF file: invalid vertex at line ${currentLine + i + 1}`);
    vertices.push({ x: parts[0], y: parts[1], z: parts[2] });
  }
  currentLine += numVertices;

  const colorMap = new Map<string, number>();
  let hasSourceColors = false;

  // Channels are kept on the source scale here and normalized once, after the
  // last face line, because the scale is a property of the file rather than of
  // any one face (see `sawFloatChannel` below). `null` marks an entry that is
  // already normalized (`DEFAULT_FACE_COLOR`) and must not be rescaled.
  const rawColors: (RawColor | null)[] = [];
  let sawFloatChannel = false;

  const faces: Face[] = [];
  for (let i = 0; i < numFaces; i++) {
    // The raw tokens are kept alongside the numbers: the OFF spec tells integer
    // from float colors by the TOKEN, not the value ("three or four integers |
    // RGB ... 0..255" vs "three or four floating-point numbers | RGB ... 0..1"
    // -- Geomview OOGL manual), and `Number()` throws that distinction away.
    const tokens = lines[currentLine + i].split(/\s+/);
    const parts = tokens.map(Number);
    const numVerts = parts[0];
    const vertices = parts.slice(1, numVerts + 1);
    // A face line may carry a trailing color: RGB (numVerts + 4 fields) or
    // RGBA (numVerts + 5). OpenSCAD's Manifold backend emits RGB for `color(c)`
    // and RGBA for `color(c, alpha)`; the CGAL backend emits none.
    // Only finite channels are trusted: `.map(Number)` turns a trailing comment
    // or junk into NaN and `1e999` into Infinity, either of which would reach the
    // GPU as a broken color attribute. Vertex lines are validated the same way
    // below.
    const rgb = parts.slice(numVerts + 1, numVerts + 4);
    const hasFaceColor = rgb.length === 3 && rgb.every(Number.isFinite);
    if (hasFaceColor) hasSourceColors = true;
    // Alpha is judged separately so a non-numeric 4th field (e.g. a Geomview
    // trailing comment after an RGB triple) means "no alpha" rather than
    // discarding an otherwise valid color.
    const alpha = parts[numVerts + 4];
    const hasAlpha = Number.isFinite(alpha);
    if (hasFaceColor) {
      // Any non-integer literal in any channel makes the whole FILE float --
      // one producer writes one file, and deciding per face would render two
      // faces of the same encoding differently depending on their values.
      const channels = tokens.slice(numVerts + 1, numVerts + (hasAlpha ? 5 : 4));
      if (channels.some((token) => !INTEGER_LITERAL.test(token))) sawFloatChannel = true;
    }
    // A missing alpha is left null rather than defaulted to 255 here: "fully
    // opaque" is 255 on the integer scale and 1 on the float scale, and which
    // one applies is not known until the last face line has been read.
    const color: RawColor | null = hasFaceColor
      ? { rgb: [rgb[0], rgb[1], rgb[2]], alpha: hasAlpha ? alpha : null }
      : null;
    if (vertices.length < 3)
      throw new Error(
        `Invalid OFF file: face at line ${currentLine + i + 1} must have at least 3 vertices`,
      );

    const colorKey = color ? `${color.rgb.join(',')},${color.alpha}` : '';
    let colorIndex = colorMap.get(colorKey);
    if (colorIndex == null) {
      colorIndex = rawColors.length;
      rawColors.push(color);
      colorMap.set(colorKey, colorIndex);
    }

    if (vertices.length == 3) {
      faces.push({
        vertices: vertices as [number, number, number],
        colorIndex,
      });
    } else {
      // Triangulate the face
      for (let j = 1; j < vertices.length - 1; j++) {
        faces.push({
          vertices: [vertices[0], vertices[j], vertices[j + 1]],
          colorIndex,
        });
      }
    }
  }

  // One scale for the file. Integer is the default: it is what OpenSCAD writes,
  // and a file whose channels are all integer literals is integer per the spec
  // even when every value happens to be 0 or 1. That last case (`1 0 0` --
  // near-black, or red written without decimal points?) is genuinely
  // undecidable; reading it as integer keeps the behaviour predictable and
  // matches MeshLab and OpenMesh, which apply the same lexical test.
  const scale = sawFloatChannel ? 1 : 255;
  const colors: Color[] = rawColors.map((color) =>
    color === null
      ? DEFAULT_FACE_COLOR
      : ([
          color.rgb[0] / scale,
          color.rgb[1] / scale,
          color.rgb[2] / scale,
          color.alpha === null ? 1 : color.alpha / scale,
        ] as Color),
  );

  return { vertices, faces, colors, hasSourceColors };
}
