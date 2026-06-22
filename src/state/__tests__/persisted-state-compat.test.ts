import { describe, expect, it } from 'vitest';

import type { ProjectFileSystem } from '../../fs/project-filesystem.ts';
import type { Source, State } from '../app-state.ts';
import { readPersistedState, writePersistedState } from '../persisted-state.ts';

// An in-memory stand-in for the BrowserFS home partition.
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: ProjectFileSystem = {
    readFileSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(value);
    },
    writeFile(path: string, content: string) {
      files.set(path, content);
    },
  };
  return { fs, files };
}

function baseState(sources: Source[]): State {
  return {
    params: {
      activePath: sources[0]?.path ?? '/home/playground.scad',
      sources,
      features: ['lazy-union'],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
    },
    view: {
      layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
      color: '#f9d72c',
      showAxes: true,
      lineNumbers: false,
    },
    preview: { thumbhash: 'abc' },
  };
}

const STATE_PATH = '/home/state.json';

describe('persisted-state on-disk compatibility (#56)', () => {
  it('round-trips every source shape verbatim (flat keys, order preserved)', () => {
    const sources: Source[] = [
      { path: '/home/main.scad', content: 'cube(10);' },
      { path: '/home/loaded.scad', url: 'http://localhost/loaded.scad', content: 'module a(){}' },
      { path: '/home/unloaded.scad', url: 'http://localhost/unloaded.scad' },
      { path: '/home/lib/', url: 'http://localhost/lib.zip' },
    ];
    const { fs } = fakeFs();

    writePersistedState(fs, baseState(sources));
    const restored = readPersistedState(fs);

    expect(restored?.params.sources).toEqual(sources);
  });

  it('reads a hand-written legacy on-disk state.json with flat sources', () => {
    // Exactly the bytes an existing standalone user has on disk today.
    const legacy = JSON.stringify({
      params: {
        activePath: '/home/playground.scad',
        sources: [
          { path: '/home/playground.scad', content: 'sphere(5);' },
          { path: '/home/remote.scad', url: 'http://localhost/remote.scad' },
        ],
        features: ['lazy-union'],
        exportFormat2D: 'svg',
        exportFormat3D: 'stl',
      },
      view: {
        layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
        color: '#000',
      },
      preview: undefined,
    });
    const { fs } = fakeFs({ [STATE_PATH]: legacy });

    const restored = readPersistedState(fs);

    expect(restored?.params.sources).toEqual([
      { path: '/home/playground.scad', content: 'sphere(5);' },
      { path: '/home/remote.scad', url: 'http://localhost/remote.scad' },
    ]);
  });

  it('writes the durable slice as flat JSON with no discriminant keys', () => {
    const { fs, files } = fakeFs();
    writePersistedState(fs, baseState([{ path: '/home/a.scad', content: 'cube();' }]));

    const onDisk = JSON.parse(files.get(STATE_PATH)!);
    expect(Object.keys(onDisk).sort()).toEqual(['params', 'preview', 'view']);
    expect(onDisk.params.sources).toEqual([{ path: '/home/a.scad', content: 'cube();' }]);
    // No `kind` discriminant must leak onto disk.
    expect(JSON.stringify(onDisk)).not.toContain('"kind"');
  });

  it('persists only the durable slice (drops transient runtime fields)', () => {
    const { fs, files } = fakeFs();
    const state = baseState([{ path: '/home/a.scad', content: 'cube();' }]);
    state.rendering = true;
    state.error = 'boom';
    state.output = { isPreview: true } as State['output'];

    writePersistedState(fs, state);
    const onDisk = JSON.parse(files.get(STATE_PATH)!);

    expect(onDisk).not.toHaveProperty('rendering');
    expect(onDisk).not.toHaveProperty('error');
    expect(onDisk).not.toHaveProperty('output');
  });

  it('returns null when state.json is missing or corrupt', () => {
    expect(readPersistedState(fakeFs().fs)).toBeNull();
    expect(readPersistedState(fakeFs({ [STATE_PATH]: 'not json{' }).fs)).toBeNull();
  });
});
