import type { State } from '../../state/app-state.ts';

jest.mock('../../state/model-context.ts', () => ({
  getModel: jest.fn(),
}));

jest.mock('../viewer/ThreeScene.ts', () => ({
  NAMED_POSITIONS: [{ name: 'Diagonal' }],
  ThreeScene: jest.fn().mockImplementation(() => ({
    applyCameraState: jest.fn(),
    dispose: jest.fn(),
    loadGeometry: jest.fn(),
    resize: jest.fn(),
    setAxesVisible: jest.fn(),
    setCameraPosition: jest.fn(),
    setModelColor: jest.fn(),
    start: jest.fn(),
  })),
}));

jest.mock('../../io/image_hashes.ts', () => ({
  blurHashToImage: jest.fn(() => 'data:image/png;base64,blur'),
  imageToThumbhash: jest.fn(async () => 'thumbhash'),
  imageToBlurhash: jest.fn(async () => 'blurhash'),
  thumbHashToImage: jest.fn(() => 'data:image/png;base64,thumb'),
}));

import { getModel } from '../../state/model-context.ts';
import './osc-viewer-panel.ts';

type FakeModel = EventTarget & {
  state: State;
  mutate: jest.Mock<void, [(state: State) => void]>;
};

function createState(output: State['output']): State {
  return {
    params: {
      activePath: '/home/playground.scad',
      sources: [{ path: '/home/playground.scad', content: 'square(10);' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
    },
    view: {
      layout: {
        mode: 'multi',
        editor: true,
        viewer: true,
        customizer: false,
      },
      color: '#f9d72c',
      showAxes: true,
      lineNumbers: false,
    },
    is2D: output?.outFile.name.endsWith('.svg') || output?.outFile.name.endsWith('.dxf'),
    output,
  };
}

function createFakeModel(state: State): FakeModel {
  const model = new EventTarget() as FakeModel;
  model.state = state;
  model.mutate = jest.fn((mutator) => {
    mutator(model.state);
  });
  return model;
}

describe('osc-viewer-panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  it('renders inline SVG output instead of the 3D canvas', async () => {
    (getModel as jest.Mock).mockReturnValue(
      createFakeModel(
        createState({
          isPreview: true,
          outFile: new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'shape.svg', {
            type: 'image/svg+xml',
          }),
          outFileURL: 'blob:svg-preview',
          elapsedMillis: 12,
          formattedElapsedMillis: '12 ms',
          formattedOutFileSize: '1 KB',
        }),
      ),
    );

    const element = document.createElement('osc-viewer-panel');
    document.body.appendChild(element);
    await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;

    const svg = element.querySelector('[data-testid="viewer-svg"]') as HTMLImageElement | null;
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('src')).toBe('blob:svg-preview');
    expect(element.querySelector('[data-testid="viewer-canvas"]')).toBeNull();
    expect(element.querySelector('button[title="Diagonal view"]')).toBeNull();
  });

  it('renders a DXF placeholder instead of the 3D canvas', async () => {
    (getModel as jest.Mock).mockReturnValue(
      createFakeModel(
        createState({
          isPreview: true,
          outFile: new File(['0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n'], 'shape.dxf', {
            type: 'application/octet-stream',
          }),
          outFileURL: 'blob:dxf-preview',
          elapsedMillis: 14,
          formattedElapsedMillis: '14 ms',
          formattedOutFileSize: '1 KB',
        }),
      ),
    );

    const element = document.createElement('osc-viewer-panel');
    document.body.appendChild(element);
    await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;

    const placeholder = element.querySelector('[data-testid="viewer-dxf-placeholder"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain('DXF exported');
    expect(element.querySelector('[data-testid="viewer-canvas"]')).toBeNull();
    expect(element.querySelector('button[title="Diagonal view"]')).toBeNull();
  });
});
