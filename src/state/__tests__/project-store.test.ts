import { ProjectStore } from '../project-store.ts';
import { contentOf, type SerializableSource } from '../project-source.ts';

function makeFs(files: Record<string, string> = {}) {
  const written: Record<string, string> = {};
  const writtenBytes: Record<string, Uint8Array> = {};
  return {
    fs: {
      readFileSync: vi.fn((path: string) => {
        if (!(path in files)) throw new Error(`ENOENT ${path}`);
        return new TextEncoder().encode(files[path]);
      }),
      writeFile: vi.fn((path: string, content: string) => {
        written[path] = content;
      }),
      writeBytes: vi.fn((path: string, content: Uint8Array) => {
        writtenBytes[path] = content;
      }),
    } as unknown as FS,
    written,
    writtenBytes,
  };
}

describe('ProjectStore (#57)', () => {
  it('reads and replaces the active source content', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: SerializableSource[] = [
      { kind: 'text', path: '/a.scad', content: 'A' },
      { kind: 'text', path: '/b.scad', content: 'B' },
    ];
    expect(store.activeContent(sources, '/b.scad')).toBe('B');
    expect(store.activeContent(sources, '/missing')).toBe('');

    const updated = store.withActiveContent(sources, '/a.scad', 'A2');
    expect(contentOf(updated.find((s) => s.path === '/a.scad')!)).toBe('A2');
    expect(contentOf(updated.find((s) => s.path === '/b.scad')!)).toBe('B');
  });

  it('addBinaryFile writes bytes and records a content-less local source', () => {
    const { fs, written, writtenBytes } = makeFs();
    const store = new ProjectStore(fs);
    const bytes = new Uint8Array([0, 65, 200, 255]);

    const next = store.addBinaryFile(
      [{ kind: 'text', path: '/a.scad', content: 'A' }],
      '/p.stl',
      bytes,
    );

    expect(Array.from(writtenBytes['/p.stl'])).toEqual(Array.from(bytes));
    expect(written['/p.stl']).toBeUndefined(); // not written as text
    const added = next.sources.find((s) => s.path === '/p.stl');
    expect(added).toEqual({ kind: 'local', path: '/p.stl' });
    expect(next.activePath).toBe('/p.stl');
  });

  it('openFile returns null when the path is already active', () => {
    const store = new ProjectStore(makeFs().fs);
    expect(
      store.openFile([{ kind: 'text', path: '/a.scad', content: 'A' }], '/a.scad', '/a.scad'),
    ).toBeNull();
  });

  it('openFile drops the previous active source when it is unmodified vs disk', () => {
    const store = new ProjectStore(makeFs({ '/a.scad': 'A', '/b.scad': 'B' }).fs);
    const next = store.openFile(
      [{ kind: 'text', path: '/a.scad', content: 'A' }],
      '/a.scad',
      '/b.scad',
    );
    expect(next).not.toBeNull();
    expect(next!.activePath).toBe('/b.scad');
    expect(next!.sources.map((s) => s.path)).toEqual(['/b.scad']); // /a.scad dropped, /b.scad added
    expect(contentOf(next!.sources[0])).toBe('B');
  });

  it('openFile keeps the previous active source when it was modified', () => {
    const store = new ProjectStore(makeFs({ '/a.scad': 'ON_DISK', '/b.scad': 'B' }).fs);
    const next = store.openFile(
      [{ kind: 'text', path: '/a.scad', content: 'EDITED' }],
      '/a.scad',
      '/b.scad',
    );
    expect(next!.sources.map((s) => s.path)).toEqual(['/a.scad', '/b.scad']);
  });

  it('openFile does not re-read a source already in the set', () => {
    const { fs } = makeFs({ '/a.scad': 'A' });
    const store = new ProjectStore(fs);
    const sources: SerializableSource[] = [
      { kind: 'text', path: '/a.scad', content: 'A' },
      { kind: 'text', path: '/b.scad', content: 'B' },
    ];
    const next = store.openFile(sources, '/a.scad', '/b.scad');
    expect(next!.activePath).toBe('/b.scad');
    // /b.scad already present, so it is not read from disk.
    expect(fs.readFileSync).not.toHaveBeenCalledWith('/b.scad');
  });

  it('newFile picks a unique untitled name', () => {
    const store = new ProjectStore(makeFs().fs);
    expect(store.newFile([]).activePath).toBe('/home/untitled.scad');
    const taken: SerializableSource[] = [
      { kind: 'text', path: '/home/untitled.scad', content: '' },
    ];
    const next = store.newFile(taken);
    expect(next.activePath).toBe('/home/untitled-2.scad');
    expect(next.sources.map((s) => s.path)).toContain('/home/untitled-2.scad');
  });

  it('addFile writes to the fs and replaces any existing same-path source', () => {
    const { fs, written } = makeFs();
    const store = new ProjectStore(fs);
    const next = store.addFile(
      [{ kind: 'text', path: '/home/x.scad', content: 'old' }],
      '/home/x.scad',
      'new',
    );
    expect(written['/home/x.scad']).toBe('new');
    expect(next.activePath).toBe('/home/x.scad');
    expect(next.sources.filter((s) => s.path === '/home/x.scad')).toHaveLength(1);
    expect(contentOf(next.sources[0])).toBe('new');
  });

  // Note: buildZip (real JSZip -> Blob) is exercised in production via saveProject;
  // ZIP import/export validation is covered by zip-import.test.ts. JSZip's input
  // type-check rejects jsdom's Uint8Array, so a buildZip round-trip isn't unit-
  // testable here without a real browser.
});

describe('ProjectStore — multi-file project contract (#123)', () => {
  it('setProject canonicalizes relative paths, writes text, and picks main.scad', () => {
    const { fs, written } = makeFs();
    const store = new ProjectStore(fs);

    const next = store.setProject([
      { path: 'a.scad', content: 'cube(1);' },
      { path: 'main.scad', content: 'use <a.scad>' },
    ]);

    expect(next.sources).toEqual([
      { kind: 'text', path: '/home/a.scad', content: 'cube(1);' },
      { kind: 'text', path: '/home/main.scad', content: 'use <a.scad>' },
    ]);
    expect(next.activePath).toBe('/home/main.scad'); // main.scad wins the entry rule
    expect(written['/home/a.scad']).toBe('cube(1);');
    expect(written['/home/main.scad']).toBe('use <a.scad>');
  });

  it('setProject honors an explicit entryPoint and falls back when it is unknown', () => {
    const store = new ProjectStore(makeFs().fs);
    const files = [
      { path: 'a.scad', content: 'A' },
      { path: 'b.scad', content: 'B' },
    ];
    expect(store.setProject(files, 'b.scad').activePath).toBe('/home/b.scad');
    // Unknown entryPoint → the rule (first .scad, since no main.scad).
    expect(store.setProject(files, 'nope.scad').activePath).toBe('/home/a.scad');
  });

  it('setProject rejects an unsafe path before writing anything (atomic)', () => {
    const { fs, written } = makeFs();
    const store = new ProjectStore(fs);
    expect(() =>
      store.setProject([
        { path: 'ok.scad', content: 'A' },
        { path: '../escape.scad', content: 'B' },
      ]),
    ).toThrow();
    expect(written['/home/ok.scad']).toBeUndefined(); // nothing written
  });

  it('setProject rejects an unsafe entryPoint before writing anything (atomic)', () => {
    const { fs, written } = makeFs();
    const store = new ProjectStore(fs);
    expect(() => store.setProject([{ path: 'ok.scad', content: 'A' }], '../escape.scad')).toThrow();
    expect(written['/home/ok.scad']).toBeUndefined(); // entryPoint validated before writes
  });

  it('setProject accepts an already-/home/-prefixed entryPoint (idempotent canonicalization)', () => {
    const store = new ProjectStore(makeFs().fs);
    const next = store.setProject(
      [
        { path: '/home/a.scad', content: 'A' },
        { path: 'b.scad', content: 'B' },
      ],
      '/home/b.scad',
    );
    expect(next.sources.map((s) => s.path)).toEqual(['/home/a.scad', '/home/b.scad']);
    expect(next.activePath).toBe('/home/b.scad');
  });

  it('setProject with no files yields one fresh empty file (always-an-active-file)', () => {
    const next = new ProjectStore(makeFs().fs).setProject([]);
    expect(next.sources).toHaveLength(1);
    expect(next.activePath).toBe('/home/untitled.scad');
    expect(contentOf(next.sources[0])).toBe('');
  });

  it('updateFile replaces an existing file and appends a new one, active unchanged', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: SerializableSource[] = [
      { kind: 'text', path: '/home/main.scad', content: 'M' },
      { kind: 'text', path: '/home/a.scad', content: 'A' },
    ];
    const replaced = store.updateFile(sources, 'a.scad', 'A2');
    expect(contentOf(replaced.find((s) => s.path === '/home/a.scad')!)).toBe('A2');
    expect(replaced).toHaveLength(2);

    const appended = store.updateFile(sources, 'b.scad', 'B');
    expect(appended).toHaveLength(3);
    expect(appended.find((s) => s.path === '/home/b.scad')).toEqual({
      kind: 'text',
      path: '/home/b.scad',
      content: 'B',
    });
  });

  it('removeFile re-points the entry deterministically when the active file goes', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: SerializableSource[] = [
      { kind: 'text', path: '/home/a.scad', content: 'A' },
      { kind: 'text', path: '/home/main.scad', content: 'M' },
    ];
    // Removing the active a.scad re-points to main.scad (the rule).
    const next = store.removeFile(sources, '/home/a.scad', 'a.scad');
    expect(next.sources.map((s) => s.path)).toEqual(['/home/main.scad']);
    expect(next.activePath).toBe('/home/main.scad');

    // Removing a non-active file keeps the active path.
    const keep = store.removeFile(sources, '/home/main.scad', 'a.scad');
    expect(keep.activePath).toBe('/home/main.scad');
  });

  it('updateFile refuses to overwrite a binary local asset with text', () => {
    const { fs, written } = makeFs();
    const store = new ProjectStore(fs);
    const sources: SerializableSource[] = [
      { kind: 'text', path: '/home/main.scad', content: 'M' },
      { kind: 'local', path: '/home/logo.png' },
    ];
    expect(() => store.updateFile(sources, 'logo.png', 'oops')).toThrow();
    expect(written['/home/logo.png']).toBeUndefined(); // bytes not clobbered
  });

  it('removeFile re-points to the first remaining file when no .scad survives', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: SerializableSource[] = [
      { kind: 'text', path: '/home/a.scad', content: 'A' },
      { kind: 'text', path: '/home/notes.txt', content: 'N' },
    ];
    const next = store.removeFile(sources, '/home/a.scad', 'a.scad');
    expect(next.sources.map((s) => s.path)).toEqual(['/home/notes.txt']);
    expect(next.activePath).toBe('/home/notes.txt'); // fell through to paths[0]
  });

  it('removeFile of the last file yields a fresh empty file', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: SerializableSource[] = [{ kind: 'text', path: '/home/only.scad', content: 'X' }];
    const next = store.removeFile(sources, '/home/only.scad', 'only.scad');
    expect(next.sources).toHaveLength(1);
    expect(next.activePath).toBe('/home/untitled.scad');
    expect(contentOf(next.sources[0])).toBe('');
  });

  it('removeFile of an absent path is a no-op (same array reference)', () => {
    const store = new ProjectStore(makeFs().fs);
    const sources: SerializableSource[] = [{ kind: 'text', path: '/home/a.scad', content: 'A' }];
    const next = store.removeFile(sources, '/home/a.scad', 'ghost.scad');
    expect(next.sources).toBe(sources); // unchanged reference → caller no-ops
  });
});
