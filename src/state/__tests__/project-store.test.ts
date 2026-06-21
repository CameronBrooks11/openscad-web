import { ProjectStore } from '../project-store.ts';
import type { Source } from '../app-state.ts';

function makeFs(files: Record<string, string> = {}) {
  const written: Record<string, string> = {};
  return {
    fs: {
      readFileSync: vi.fn((path: string) => {
        if (!(path in files)) throw new Error(`ENOENT ${path}`);
        return new TextEncoder().encode(files[path]);
      }),
      writeFile: vi.fn((path: string, content: string) => {
        written[path] = content;
      }),
    } as unknown as FS,
    written,
  };
}

describe('ProjectStore (#57)', () => {
  it('reads and replaces the active source content', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: Source[] = [
      { path: '/a.scad', content: 'A' },
      { path: '/b.scad', content: 'B' },
    ];
    expect(store.activeContent(sources, '/b.scad')).toBe('B');
    expect(store.activeContent(sources, '/missing')).toBe('');

    const updated = store.withActiveContent(sources, '/a.scad', 'A2');
    expect(updated.find((s) => s.path === '/a.scad')?.content).toBe('A2');
    expect(updated.find((s) => s.path === '/b.scad')?.content).toBe('B');
  });

  it('openFile returns null when the path is already active', () => {
    const store = new ProjectStore(makeFs().fs);
    expect(store.openFile([{ path: '/a.scad', content: 'A' }], '/a.scad', '/a.scad')).toBeNull();
  });

  it('openFile drops the previous active source when it is unmodified vs disk', () => {
    const store = new ProjectStore(makeFs({ '/a.scad': 'A', '/b.scad': 'B' }).fs);
    const next = store.openFile([{ path: '/a.scad', content: 'A' }], '/a.scad', '/b.scad');
    expect(next).not.toBeNull();
    expect(next!.activePath).toBe('/b.scad');
    expect(next!.sources.map((s) => s.path)).toEqual(['/b.scad']); // /a.scad dropped, /b.scad added
    expect(next!.sources[0].content).toBe('B');
  });

  it('openFile keeps the previous active source when it was modified', () => {
    const store = new ProjectStore(makeFs({ '/a.scad': 'ON_DISK', '/b.scad': 'B' }).fs);
    const next = store.openFile([{ path: '/a.scad', content: 'EDITED' }], '/a.scad', '/b.scad');
    expect(next!.sources.map((s) => s.path)).toEqual(['/a.scad', '/b.scad']);
  });

  it('openFile does not re-read a source already in the set', () => {
    const { fs } = makeFs({ '/a.scad': 'A' });
    const store = new ProjectStore(fs);
    const sources: Source[] = [
      { path: '/a.scad', content: 'A' },
      { path: '/b.scad', content: 'B' },
    ];
    const next = store.openFile(sources, '/a.scad', '/b.scad');
    expect(next!.activePath).toBe('/b.scad');
    // /b.scad already present, so it is not read from disk.
    expect(fs.readFileSync).not.toHaveBeenCalledWith('/b.scad');
  });

  it('newFile picks a unique untitled name', () => {
    const store = new ProjectStore(makeFs().fs);
    expect(store.newFile([]).activePath).toBe('/home/untitled.scad');
    const taken: Source[] = [{ path: '/home/untitled.scad', content: '' }];
    const next = store.newFile(taken);
    expect(next.activePath).toBe('/home/untitled-2.scad');
    expect(next.sources.map((s) => s.path)).toContain('/home/untitled-2.scad');
  });

  it('addFile writes to the fs and replaces any existing same-path source', () => {
    const { fs, written } = makeFs();
    const store = new ProjectStore(fs);
    const next = store.addFile([{ path: '/home/x.scad', content: 'old' }], '/home/x.scad', 'new');
    expect(written['/home/x.scad']).toBe('new');
    expect(next.activePath).toBe('/home/x.scad');
    expect(next.sources.filter((s) => s.path === '/home/x.scad')).toHaveLength(1);
    expect(next.sources[0].content).toBe('new');
  });

  // Note: buildZip (real JSZip -> Blob) is exercised in production via saveProject;
  // ZIP import/export validation is covered by zip-import.test.ts. JSZip's input
  // type-check rejects jsdom's Uint8Array, so a buildZip round-trip isn't unit-
  // testable here without a real browser.
});
