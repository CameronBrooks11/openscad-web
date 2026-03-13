import { getViewerOutputMode } from './viewer-output-mode.ts';

describe('getViewerOutputMode', () => {
  it('uses the 3D viewer for OFF outputs', () => {
    expect(getViewerOutputMode('model.off')).toBe('three');
  });

  it('uses the SVG viewer for SVG outputs', () => {
    expect(getViewerOutputMode('profile.svg')).toBe('svg');
  });

  it('uses the DXF placeholder for DXF outputs', () => {
    expect(getViewerOutputMode('profile.dxf')).toBe('dxf');
  });

  it('matches extensions case-insensitively', () => {
    expect(getViewerOutputMode('PROFILE.SVG')).toBe('svg');
    expect(getViewerOutputMode('PROFILE.DXF')).toBe('dxf');
  });

  it('defaults to the 3D viewer when no output exists yet', () => {
    expect(getViewerOutputMode()).toBe('three');
  });
});
