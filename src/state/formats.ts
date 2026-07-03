export const VALID_RENDER_FORMATS = {
  off: true,
  svg: true,
};
export const VALID_EXPORT_FORMATS_2D = {
  svg: true,
  dxf: true,
};
export const VALID_EXPORT_FORMATS_3D = {
  stl: true,
  off: true,
  glb: true,
  '3mf': true,
};

/** Any exportable format, 2D or 3D — the host-facing export surface (#216). */
export type ExportFormat =
  keyof typeof VALID_EXPORT_FORMATS_2D | keyof typeof VALID_EXPORT_FORMATS_3D;

export function is2DFormatExtension(ext: string) {
  return ext === 'svg' || ext === 'dxf';
}

const supportedImportExtensions = new Set([
  'stl',
  'off',
  'dxf',
  'nef3',
  '3mf',
  'amf',
  'svg',
  'obj',
]);

export function isSupportedImportExtension(ext: string) {
  return supportedImportExtensions.has(ext);
}
