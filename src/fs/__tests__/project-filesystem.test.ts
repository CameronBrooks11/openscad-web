import { describe, expect, it } from 'vitest';

import type { ProjectFileSystem } from '../project-filesystem.ts';
import { ProjectStore } from '../../state/project-store.ts';
import { fetchSource } from '../../utils.ts';

// A minimal in-memory implementation providing ONLY the two methods of the
// contract — note the absence of any `as FS` cast. If a domain consumer is ever
// re-widened back to the full ambient BrowserFS `FS`, these constructions stop
// compiling, which is the regression this file guards (#62 Slice B).
function memFs(initial: Record<string, string> = {}): ProjectFileSystem {
  const files = new Map(Object.entries(initial));
  return {
    readFileSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(value);
    },
    writeFile(path: string, content: string) {
      files.set(path, content);
    },
  };
}

describe('ProjectFileSystem contract (#62 Slice B)', () => {
  it('ProjectStore operates on a bare two-method filesystem', () => {
    const store = new ProjectStore(memFs({ '/a.scad': 'A' }));
    const snapshot = store.openFile([{ path: '/x.scad', content: 'x' }], '/x.scad', '/a.scad');
    // openFile reads /a.scad through readFileSync and adds it to the sources.
    expect(snapshot?.activePath).toBe('/a.scad');
    expect(snapshot?.sources.find((s) => s.path === '/a.scad')?.content).toBe('A');
  });

  it('ProjectStore.newFile writes through the contract', () => {
    const fs = memFs();
    const store = new ProjectStore(fs);
    const snapshot = store.newFile([]);
    // The new empty file is readable back through the same fs instance.
    expect(new TextDecoder().decode(fs.readFileSync(snapshot.activePath))).toBe('');
  });

  it('fetchSource reads bytes through the narrow contract', async () => {
    const bytes = await fetchSource(memFs({ '/a.scad': 'cube();' }), { path: '/a.scad' });
    expect(new TextDecoder().decode(bytes)).toBe('cube();');
  });
});
