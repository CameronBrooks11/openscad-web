// Tests for fragment-state.ts — BUG-5 (showAxes key nesting), BUG-6 (async buildUrl),
// and T2 (Phase 3 round-trip coverage)

import {
  readStateFromFragment,
  buildUrlForStateParams,
  encodeStateParamsAsFragment,
} from '../state/fragment-state.ts';
import { contentOf } from '../state/project-source.ts';

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
  async function loadInitialState() {
    return (await import('../state/initial-state.ts')).createInitialState;
  }

  function mockMatchMedia() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  it('preserves all key state fields through gzip+base64 encode/decode cycle', async () => {
    mockMatchMedia();
    const createInitialState = await loadInitialState();

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
    expect(contentOf(restored!.params.sources[0])).toBe('cube(10);');
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
  it('returns a Promise (not a string with "[object Promise]" in it)', async () => {
    // Mock matchMedia so createInitialState doesn't throw
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const createInitialState = await import('../state/initial-state.ts').then(
      ({ createInitialState: importedCreateInitialState }) => importedCreateInitialState,
    );
    const state = createInitialState(null, { content: 'cube(10);' });
    const result = buildUrlForStateParams(state);
    // Before fix: result is a string (sync return), and it contains '[object Promise]'
    // After fix: result is a Promise
    expect(result).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// T2 — Additional round-trip and encoding tests (Phase 3)
// ---------------------------------------------------------------------------

describe('fragment-state — edge cases (T2)', () => {
  it('returns null for an empty fragment string', async () => {
    window.location.hash = '';
    const state = await readStateFromFragment();
    // Empty hash → no serialized state → returns null
    expect(state).toBeNull();
  });

  it('returns null for a malformed/corrupt fragment string', async () => {
    window.location.hash = '#' + encodeURIComponent('this-is-not-valid-gzip-base64!!!');
    const state = await readStateFromFragment();
    // Should not throw; corrupt data is caught and null is returned
    expect(state).toBeNull();
  });

  it('produces a fragment string that survives encodeURIComponent round-trip', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const createInitialState = await import('../state/initial-state.ts').then(
      ({ createInitialState: importedCreateInitialState }) => importedCreateInitialState,
    );
    const state = createInitialState(null, { content: 'sphere(5);' });

    const fragment = await encodeStateParamsAsFragment(state);
    // The fragment must be decodable after URI encoding/decoding
    const uriEncoded = encodeURIComponent(fragment);
    const decoded = decodeURIComponent(uriEncoded);
    expect(decoded).toBe(fragment);
  });

  it('blank fragment produces a state with empty source content', async () => {
    window.location.hash = '#blank';
    const state = await readStateFromFragment();
    expect(state).not.toBeNull();
    expect(contentOf(state!.params.sources[0])).toBe('');
  });

  it('src= fragment produces state with the given source', async () => {
    window.location.hash = '#src=' + encodeURIComponent('cylinder(5, 3);');
    const state = await readStateFromFragment();
    expect(contentOf(state!.params.sources[0])).toBe('cylinder(5, 3);');
  });

  it('rejects legacy #url fragments that target cross-origin sources', async () => {
    window.location.hash = '#url=' + encodeURIComponent('https://example.com/model.scad');
    const state = await readStateFromFragment();
    expect(state).toBeNull();
  });

  it('canonicalizes same-origin relative source URLs during fragment decode', async () => {
    const fragment = encodeURIComponent(
      JSON.stringify({
        params: {
          activePath: '/test.scad',
          features: [],
          sources: [{ path: '/test.scad', url: './fixtures/test.scad' }],
          exportFormat2D: 'svg',
          exportFormat3D: 'stl',
        },
        view: {
          logs: false,
          layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
          color: '#aabbcc',
          showAxes: true,
          lineNumbers: false,
        },
      }),
    );
    window.location.hash = '#' + fragment;

    const state = await readStateFromFragment();

    {
      const s0 = state!.params.sources[0];
      expect(s0.kind === 'remote' ? s0.url : undefined).toBe('http://localhost/fixtures/test.scad');
    }
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility fixtures (#56). These pin the EXISTING on-the-wire
// fragment shape so a later Source→ProjectSource migration cannot silently
// break shared/bookmarked URLs. Each closes a previously-untested boundary:
// .url round-trip, multiple sources, the uncompressed-legacy fallback, and the
// legacy source/sourcePath reconstruction.
// ---------------------------------------------------------------------------

describe('fragment backward-compat fixtures (#56)', () => {
  function mockMatchMedia() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  /** Set the hash to an uncompressed, URI-encoded JSON fragment (legacy format). */
  function setLegacyJsonHash(obj: unknown) {
    window.location.hash = '#' + encodeURIComponent(JSON.stringify(obj));
  }

  const baseView = {
    logs: false,
    layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
    color: '#aabbcc',
    showAxes: true,
    lineNumbers: false,
  };

  it('preserves a loaded remote source (url + content) through gzip round-trip', async () => {
    mockMatchMedia();
    const createInitialState = (await import('../state/initial-state.ts')).createInitialState;
    const state = createInitialState(null, { content: 'cube(10);' });
    // A same-origin absolute url is canonicalized to itself (no drift).
    state.params.sources = [
      { kind: 'text', path: '/main.scad', content: 'include <lib.scad>' },
      {
        kind: 'remote',
        path: '/lib.scad',
        url: 'http://localhost/lib.scad',
        content: 'module lib(){}',
      },
    ];

    history.replaceState(null, '', '#' + (await encodeStateParamsAsFragment(state)));
    const restored = await readStateFromFragment();

    expect(restored?.params.sources).toEqual([
      { kind: 'text', path: '/main.scad', content: 'include <lib.scad>' },
      {
        kind: 'remote',
        path: '/lib.scad',
        url: 'http://localhost/lib.scad',
        content: 'module lib(){}',
      },
    ]);
  });

  it('preserves an unloaded remote and an archive source through gzip round-trip', async () => {
    mockMatchMedia();
    const createInitialState = (await import('../state/initial-state.ts')).createInitialState;
    const state = createInitialState(null, { content: 'cube(10);' });
    // The two discriminant edges most at risk in a future union migration: a
    // url-only remote (no content yet) and a trailing-slash archive directory.
    state.params.sources = [
      { kind: 'remote', path: '/r.scad', url: 'http://localhost/r.scad' },
      { kind: 'archive', path: '/lib/', url: 'http://localhost/lib.zip' },
    ];

    history.replaceState(null, '', '#' + (await encodeStateParamsAsFragment(state)));
    const restored = await readStateFromFragment();

    expect(restored?.params.sources).toEqual([
      { kind: 'remote', path: '/r.scad', url: 'http://localhost/r.scad' },
      { kind: 'archive', path: '/lib/', url: 'http://localhost/lib.zip' },
    ]);
  });

  it('preserves multiple sources and their order through gzip round-trip', async () => {
    mockMatchMedia();
    const createInitialState = (await import('../state/initial-state.ts')).createInitialState;
    const state = createInitialState(null, { content: 'a' });
    state.params.sources = [
      { kind: 'text', path: '/a.scad', content: 'a();' },
      { kind: 'text', path: '/b.scad', content: 'b();' },
      { kind: 'text', path: '/c.scad', content: 'c();' },
    ];

    history.replaceState(null, '', '#' + (await encodeStateParamsAsFragment(state)));
    const restored = await readStateFromFragment();

    expect(restored?.params.sources.map((s) => s.path)).toEqual(['/a.scad', '/b.scad', '/c.scad']);
    expect(restored?.params.sources.map((s) => contentOf(s))).toEqual(['a();', 'b();', 'c();']);
  });

  it('encodes the fragment with flat, kind-less sources (bookmarked-URL compatibility)', async () => {
    mockMatchMedia();
    const createInitialState = (await import('../state/initial-state.ts')).createInitialState;
    const state = createInitialState(null, { content: 'cube(10);' });
    state.params.sources = [
      { kind: 'text', path: '/a.scad', content: 'a();' },
      { kind: 'remote', path: '/r.scad', url: 'http://localhost/r.scad' },
    ];

    // Decode the gzip+base64 fragment back to its raw JSON and assert the
    // serialized sources are the FLAT shape (no `kind`), so URLs shared by this
    // build remain readable by older deploys and vice versa.
    const fragment = await encodeStateParamsAsFragment(state);
    const raw = new TextDecoder().decode(
      await new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from(atob(fragment), (c) => c.charCodeAt(0)));
            controller.close();
          },
        }).pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer(),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.params.sources).toEqual([
      { path: '/a.scad', content: 'a();' },
      { path: '/r.scad', url: 'http://localhost/r.scad' },
    ]);
    expect(raw).not.toContain('"kind"');
  });

  it('decodes an uncompressed (legacy, non-gzip) JSON fragment', async () => {
    setLegacyJsonHash({
      params: {
        activePath: '/legacy.scad',
        features: [],
        sources: [{ path: '/legacy.scad', content: 'legacy();' }],
        exportFormat2D: 'svg',
        exportFormat3D: 'stl',
      },
      view: baseView,
    });

    const state = await readStateFromFragment();

    expect(state?.params.activePath).toBe('/legacy.scad');
    expect(state?.params.sources).toEqual([
      { kind: 'text', path: '/legacy.scad', content: 'legacy();' },
    ]);
  });

  it('reconstructs sources from the legacy source + sourcePath fields', async () => {
    setLegacyJsonHash({
      params: {
        // No `sources` array — only the pre-array legacy shape.
        source: 'cube(1);',
        sourcePath: '/old.scad',
        features: [],
        exportFormat2D: 'svg',
        exportFormat3D: 'stl',
      },
      view: baseView,
    });

    const state = await readStateFromFragment();

    expect(state?.params.sources).toEqual([
      { kind: 'text', path: '/old.scad', content: 'cube(1);' },
    ]);
  });

  it('falls back to the default source path when legacy sourcePath is absent', async () => {
    setLegacyJsonHash({
      params: {
        source: 'cube(2);',
        features: [],
        exportFormat2D: 'svg',
        exportFormat3D: 'stl',
      },
      view: baseView,
    });

    const state = await readStateFromFragment();

    expect(state?.params.sources).toEqual([
      { kind: 'text', path: '/home/playground.scad', content: 'cube(2);' },
    ]);
  });
});
