import { describe, expect, it } from 'vitest';

import { DURABLE_SCHEMA_VERSION, validateDurableState } from '../durable-state.ts';

const BASE = 'http://localhost/';

// A minimal well-formed durable blob; spread overrides onto params/view per test.
function blob(
  over: { params?: object; view?: object; preview?: unknown; schemaVersion?: unknown } = {},
) {
  return {
    schemaVersion: DURABLE_SCHEMA_VERSION,
    params: {
      activePath: '/home/main.scad',
      sources: [{ path: '/home/main.scad', content: 'cube();' }],
      features: ['lazy-union'],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
      ...over.params,
    },
    view: {
      layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
      color: '#abcdef',
      ...over.view,
    },
    ...('preview' in over ? { preview: over.preview } : {}),
    ...('schemaVersion' in over ? { schemaVersion: over.schemaVersion } : {}),
  };
}

describe('validateDurableState', () => {
  it('passes a well-formed blob through, classifying flat sources into the union', () => {
    const state = validateDurableState(blob(), { baseUrl: BASE });
    expect(state.params.activePath).toBe('/home/main.scad');
    expect(state.params.sources).toEqual([
      { kind: 'text', path: '/home/main.scad', content: 'cube();' },
    ]);
    expect(state.view.layout.mode).toBe('multi');
    expect(state.view.color).toBe('#abcdef');
  });

  it('drops vars that are not OpenSCAD-valid, keeping the valid ones', () => {
    const state = validateDurableState(
      blob({ params: { vars: { good: 3, bad: { a: 1 }, inf: Infinity, vec: [1, 2] } } }),
      { baseUrl: BASE },
    );
    expect(state.params.vars).toEqual({ good: 3, vec: [1, 2] });
  });

  it('defaults an unknown enum and rejects an unknown backend', () => {
    const state = validateDurableState(
      blob({ params: { exportFormat3D: 'not-a-format', backend: 'wgpu' } }),
      { baseUrl: BASE },
    );
    expect(state.params.exportFormat3D).toBe('stl'); // fell back to the default
    expect(state.params.backend).toBeUndefined(); // unknown backend dropped
  });

  it('drops a malformed camera but keeps a well-formed one', () => {
    const bad = validateDurableState(blob({ view: { camera: { position: [1, 2] } } }), {
      baseUrl: BASE,
    });
    expect(bad.view.camera).toBeUndefined();

    const ok = validateDurableState(
      blob({ view: { camera: { position: [1, 2, 3], target: [0, 0, 0], zoom: 1.5 } } }),
      { baseUrl: BASE },
    );
    expect(ok.view.camera).toEqual({ position: [1, 2, 3], target: [0, 0, 0], zoom: 1.5 });
  });

  it('preserves the autoCompile tri-state (absent stays undefined, not false)', () => {
    expect(validateDurableState(blob(), { baseUrl: BASE }).params.autoCompile).toBeUndefined();
    expect(
      validateDurableState(blob({ params: { autoCompile: false } }), { baseUrl: BASE }).params
        .autoCompile,
    ).toBe(false);
  });

  it('reads legacy data with no schemaVersion (treated as the same shape)', () => {
    const legacy = blob({ schemaVersion: undefined });
    delete (legacy as { schemaVersion?: unknown }).schemaVersion;
    const state = validateDurableState(legacy, { baseUrl: BASE });
    expect(state.params.sources).toHaveLength(1);
    expect(state.view.layout.mode).toBe('multi');
  });

  it('reads a newer schemaVersion best-effort rather than discarding it', () => {
    const state = validateDurableState(blob({ schemaVersion: DURABLE_SCHEMA_VERSION + 5 }), {
      baseUrl: BASE,
    });
    expect(state.params.activePath).toBe('/home/main.scad');
  });

  it('throws on an irrecoverable blob (no layout mode) so callers fall back to defaults', () => {
    expect(() => validateDurableState({ params: {}, view: {} }, { baseUrl: BASE })).toThrow();
    expect(() => validateDurableState({}, { baseUrl: BASE })).toThrow();
  });

  it('drops one out-of-policy source URL without discarding its valid siblings', () => {
    // A cross-origin remote (e.g. saved before an origin change) must NOT take the
    // whole durable state down with it — it degrades to a path-only source.
    const state = validateDurableState(
      blob({
        params: {
          sources: [
            { path: '/home/main.scad', content: 'cube();' },
            { path: '/home/remote.scad', url: 'https://evil.example.com/x.scad' },
          ],
        },
      }),
      { baseUrl: BASE },
    );
    expect(state.params.sources).toHaveLength(2);
    // The valid text sibling survives intact.
    expect(state.params.sources[0]).toEqual({
      kind: 'text',
      path: '/home/main.scad',
      content: 'cube();',
    });
    // The disallowed remote lost its URL (degraded), not the whole state.
    expect(JSON.stringify(state.params.sources[1])).not.toContain('evil.example.com');
  });
});
