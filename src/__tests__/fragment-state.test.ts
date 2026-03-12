// Tests for fragment-state.ts — BUG-5 (showAxes key nesting) and BUG-6 (async buildUrl)

import { readStateFromFragment, buildUrlForStateParams, encodeStateParamsAsFragment } from '../state/fragment-state.ts';

// ---------------------------------------------------------------------------
// BUG-5 — readStateFromFragment reads view?.layout?.showAxis instead of view?.showAxes
// ---------------------------------------------------------------------------

describe('readStateFromFragment – view.showAxes / lineNumbers (BUG-5)', () => {
  function setLocationHash(obj: object) {
    // jsdom supports direct hash setter; do not try to redefine window.location
    window.location.hash = encodeURIComponent(JSON.stringify(obj));
  }

  const baseParams = {
    activePath: '/test.scad',
    features: [],
    sources: [{ path: '/test.scad', content: 'cube(10);' }],
    exportFormat2D: 'svg',
    exportFormat3D: 'stl',
  };

  const baseLayout = { mode: 'multi', editor: true, viewer: true, customizer: false };

  it('preserves showAxes=false (not clobbered to default true)', async () => {
    setLocationHash({
      params: baseParams,
      view: {
        showAxes: false,
        lineNumbers: false,
        logs: false,
        layout: baseLayout,
        color: '#aabbcc',
      },
    });
    const state = await readStateFromFragment();
    // BUG: reads view?.layout?.showAxis (undefined) → validateBoolean(undefined, ()=>true) = true
    // Fix: reads view?.showAxes (false) → validateBoolean(false, ()=>true) = false
    expect(state?.view.showAxes).toBe(false);
  });

  it('preserves lineNumbers=true (not clobbered to default false)', async () => {
    setLocationHash({
      params: baseParams,
      view: {
        showAxes: true,
        lineNumbers: true,
        logs: false,
        layout: baseLayout,
        color: '#aabbcc',
      },
    });
    const state = await readStateFromFragment();
    // BUG: reads view?.layout?.lineNumbers (undefined) → validateBoolean(undefined, ()=>false) = false
    // Fix: reads view?.lineNumbers (true) → validateBoolean(true, ()=>false) = true
    expect(state?.view.lineNumbers).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG-6 — buildUrlForStateParams is sync but encodeStateParamsAsFragment is async
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Round-trip: encodeStateParamsAsFragment → readStateFromFragment
// ---------------------------------------------------------------------------

describe('round-trip: encodeStateParamsAsFragment → readStateFromFragment', () => {
  function mockMatchMedia() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
  }

  it('preserves all key state fields through gzip+base64 encode/decode cycle', async () => {
    mockMatchMedia();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createInitialState } = require('../state/initial-state.ts');

    const state = createInitialState(null, { content: 'cube(10);' });
    // Override non-default values to verify round-trip fidelity for each field.
    state.params.exportFormat2D = 'dxf';
    state.params.exportFormat3D = 'off';
    state.params.vars = { size: 20 };
    state.view.showAxes = false;
    state.view.lineNumbers = true;
    state.view.color = '#ff0000';
    // Use single-layout to exercise layout.focus round-trip
    state.view.layout = { mode: 'single' as const, focus: 'viewer' as const };

    const fragment = await encodeStateParamsAsFragment(state);
    // Replicate exactly what writeStateInFragment does in the real app
    history.replaceState(null, '', '#' + fragment);

    const restored = await readStateFromFragment();

    expect(restored?.params.activePath).toBe('/home/playground.scad');
    expect(restored?.params.sources?.[0].content).toBe('cube(10);');
    expect(restored?.params.exportFormat2D).toBe('dxf');
    expect(restored?.params.exportFormat3D).toBe('off');
    expect(restored?.params.vars).toEqual({ size: 20 });
    expect(restored?.view.showAxes).toBe(false);
    expect(restored?.view.lineNumbers).toBe(true);
    expect(restored?.view.color).toBe('#ff0000');
    expect(restored?.view.layout.mode).toBe('single');
    expect((restored?.view.layout as { focus?: string }).focus).toBe('viewer');
  });
});

describe('buildUrlForStateParams – must be async (BUG-6)', () => {
  it('returns a Promise (not a string with "[object Promise]" in it)', () => {
    // Import createInitialState lazily to avoid window.matchMedia issues at module load
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createInitialState } = require('../state/initial-state.ts');

    // Mock matchMedia so createInitialState doesn't throw
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });

    const state = createInitialState(null, { content: 'cube(10);' });
    const result = buildUrlForStateParams(state);
    // Before fix: result is a string (sync return), and it contains '[object Promise]'
    // After fix: result is a Promise
    expect(result).toBeInstanceOf(Promise);
  });
});
