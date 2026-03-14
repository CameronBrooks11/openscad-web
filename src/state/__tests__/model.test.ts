// T1 — Model state mutation unit tests
// Verifies that the correct runner functions are called (or not called) in
// response to state transitions.  No real BrowserFS or WASM runtime is used.

import { Model } from '../model.ts';
import { State } from '../app-state.ts';
import { defaultSourcePath, defaultModelColor } from '../initial-state.ts';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports
// ---------------------------------------------------------------------------

// Mock the heavy runner actions so no Worker / WASM is touched.
// checkSyntax and render are "turnable" factory functions: f(args) => g({now}) => Promise
jest.mock('../../runner/actions.ts', () => {
  const makeDelayable = (resolvedValue: unknown) =>
    jest.fn().mockReturnValue(jest.fn().mockResolvedValue(resolvedValue));
  return {
    checkSyntax: makeDelayable({ logText: '', markers: [], parameterSet: undefined }),
    render: makeDelayable({
      outFile: new File(['content'], 'test.glb', { type: 'model/gltf-binary' }),
      logText: '',
      markers: [],
      elapsedMillis: 0,
    }),
    getDefaultCompileArgs: jest.fn().mockReturnValue(['--backend=manifold']),
  };
});

// Mock heavy IO that model.render() uses after a successful compile (avoided
// because the mock render resolves immediately but we still need the symbols).
jest.mock('../../io/import_off.ts', () => ({ parseOff: jest.fn() }));

// ---------------------------------------------------------------------------
// Import mocked actions so we can inspect call counts.
// ---------------------------------------------------------------------------
import { checkSyntax as _mockCheckSyntax, render as _mockRender } from '../../runner/actions.ts';

const mockCheckSyntax = _mockCheckSyntax as jest.Mock;
const mockRender = _mockRender as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid State without calling createInitialState (needs matchMedia). */
function createTestState(content = 'cube(10);'): State {
  return {
    params: {
      activePath: defaultSourcePath,
      sources: [{ path: defaultSourcePath, content }],
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
      } as State['view']['layout'],
      color: defaultModelColor,
      showAxes: true,
      lineNumbers: false,
    },
  };
}

/** Minimal FS stub — only the methods model.ts actually calls. */
const makeMockFs = () => ({
  readFileSync: jest.fn((_path: string) => new Uint8Array(0)),
  writeFile: jest.fn(),
  isFile: jest.fn(() => false),
});

/** Flush microtasks + one macrotask tick so async methods (processSource, checkSyntax…) resolve. */
async function nextTicks(n = 3) {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let model: Model;
let mockFs: ReturnType<typeof makeMockFs>;
let stateHistory: State[];

beforeEach(() => {
  jest.clearAllMocks();

  // Stub browser globals that model.ts uses
  Object.defineProperty(global, 'URL', {
    value: { createObjectURL: jest.fn(() => 'blob:fake-url'), revokeObjectURL: jest.fn() },
    writable: true,
    configurable: true,
  });

  mockFs = makeMockFs();
  stateHistory = [];

  const state = createTestState();
  model = new Model(mockFs as unknown as FS, state, (s) => stateHistory.push(s), undefined);
});

// ---------------------------------------------------------------------------
// describe: render triggering
// ---------------------------------------------------------------------------

describe('Model — render triggering', () => {
  it('uses an immediate preview render during init', async () => {
    model.init();
    await nextTicks();

    expect(mockRender).toHaveBeenCalledTimes(1);
    const scheduledRender = mockRender.mock.results[0]?.value as jest.Mock | undefined;
    expect(scheduledRender).toBeDefined();
    expect(scheduledRender).toHaveBeenCalledWith({ now: true });
  });

  it('delays the initial syntax check until the boot preview has settled', async () => {
    let resolveRender: ((value: unknown) => void) | undefined;
    const pendingRender = new Promise((resolve) => {
      resolveRender = resolve;
    });
    const scheduledRender = jest.fn().mockImplementation(() => pendingRender);
    mockRender.mockReturnValueOnce(scheduledRender);

    model.init();
    await nextTicks(1);

    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(scheduledRender).toHaveBeenCalledWith({ now: true });
    expect(mockCheckSyntax).not.toHaveBeenCalled();

    resolveRender?.({
      outFile: new File(['content'], 'test.glb', { type: 'model/gltf-binary' }),
      logText: '',
      markers: [],
      elapsedMillis: 0,
    });
    await nextTicks();

    expect(mockCheckSyntax).toHaveBeenCalledTimes(1);
  });

  it('does not re-render when only viewstate changes (showAxes, layout)', async () => {
    // Directly mutate a view-only field — processSource should NOT be triggered
    model.mutate((s) => {
      s.view.showAxes = false;
    });
    await nextTicks();
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockCheckSyntax).not.toHaveBeenCalled();
  });

  it('triggers render when source content changes', async () => {
    model.source = 'sphere(5);';
    await nextTicks();
    expect(mockRender).toHaveBeenCalled();
    const scheduledRender = mockRender.mock.results[0]?.value as jest.Mock | undefined;
    expect(scheduledRender).toBeDefined();
    expect(scheduledRender).toHaveBeenCalledWith({ now: false });
  });

  it('triggers syntax check when source changes', async () => {
    model.source = 'sphere(5);';
    await nextTicks();
    expect(mockCheckSyntax).toHaveBeenCalled();
  });

  it('does not trigger render when new source is empty', async () => {
    model.source = '';
    await nextTicks();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('triggers render when activePath changes via openFile', async () => {
    // Pre-populate the second source so openFile can switch to it
    model.mutate((s) => {
      s.params.sources = [
        ...s.params.sources,
        { path: '/home/other.scad', content: 'cylinder(5,3);' },
      ];
    });
    jest.clearAllMocks(); // reset call counts after the above mutation

    model.openFile('/home/other.scad');
    await nextTicks();
    expect(mockRender).toHaveBeenCalled();
  });

  it('uses svg render format for non-scad 2D resources', async () => {
    model.mutate((s) => {
      s.params.sources = [
        ...s.params.sources,
        { path: '/home/image.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      ];
    });
    jest.clearAllMocks();

    model.openFile('/home/image.svg');
    await nextTicks();

    expect(mockRender).toHaveBeenCalled();
    const firstRenderArgs = mockRender.mock.calls[0]?.[0];
    expect(firstRenderArgs.renderFormat).toBe('svg');
  });

  it('uses the selected 2D export format for non-scad 2D resources', async () => {
    model.mutate((s) => {
      s.params.exportFormat2D = 'dxf';
      s.params.sources = [
        ...s.params.sources,
        { path: '/home/image.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      ];
    });
    jest.clearAllMocks();

    model.openFile('/home/image.svg');
    await nextTicks();

    expect(mockRender).toHaveBeenCalled();
    const firstRenderArgs = mockRender.mock.calls[0]?.[0];
    expect(firstRenderArgs.renderFormat).toBe('dxf');
  });
});

// ---------------------------------------------------------------------------
// describe: setVar
// ---------------------------------------------------------------------------

describe('Model — setVar', () => {
  it('updates vars in state', () => {
    model.setVar('size', 20);
    expect(model.state.params.vars).toEqual({ size: 20 });
  });

  it('triggers a preview render when a var changes', async () => {
    model.setVar('size', 20);
    await nextTicks();
    expect(mockRender).toHaveBeenCalled();
    // Should be called with isPreview: true
    const renderCall = mockRender.mock.calls[0][0];
    expect(renderCall.isPreview).toBe(true);
  });

  it('also triggers render when var is set to a different value', async () => {
    model.setVar('size', 10);
    jest.clearAllMocks();
    model.setVar('size', 20);
    await nextTicks();
    expect(mockRender).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// describe: format changes
// ---------------------------------------------------------------------------

describe('Model — format changes', () => {
  it('setFormats updates exportFormat3D in state', () => {
    model.setFormats(undefined, 'off');
    expect(model.state.params.exportFormat3D).toBe('off');
  });

  it('setFormats updates exportFormat2D in state', () => {
    model.setFormats('dxf', undefined);
    expect(model.state.params.exportFormat2D).toBe('dxf');
  });

  it('does not trigger render on 3D format-only change', async () => {
    // the new format is used on the next user-initiated render.
    model.setFormats(undefined, 'off');
    await nextTicks();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('triggers an immediate preview render when the active 2D export format changes', async () => {
    model.mutate((s) => {
      s.is2D = true;
    });
    jest.clearAllMocks();

    model.setFormats('dxf', undefined);
    await nextTicks();

    expect(mockRender).toHaveBeenCalledTimes(1);
    const renderCall = mockRender.mock.calls[0]?.[0];
    expect(renderCall.renderFormat).toBe('dxf');
    const scheduledRender = mockRender.mock.results[0]?.value as jest.Mock | undefined;
    expect(scheduledRender).toHaveBeenCalledWith({ now: true });
  });
});
