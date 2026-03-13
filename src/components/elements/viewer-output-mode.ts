export type ViewerOutputMode = 'three' | 'svg' | 'dxf';

export function getViewerOutputMode(fileName?: string): ViewerOutputMode {
  const normalized = fileName?.toLowerCase() ?? '';

  if (normalized.endsWith('.svg')) return 'svg';
  if (normalized.endsWith('.dxf')) return 'dxf';
  return 'three';
}
