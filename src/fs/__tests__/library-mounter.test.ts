import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the BrowserFS + asset boundary so the mounter can be exercised in
// isolation, with no real filesystem or network (criterion 3 of #62).
vi.mock('../../runtime/browserfs-runtime.ts', () => ({
  getBrowserFS: () => ({
    FileSystem: {
      // createBFSBackend('ZipFS', …) resolves to this fake backend.
      ZipFS: { Create: (_opts: unknown, cb: (e: unknown, i: unknown) => void) => cb(null, {}) },
    },
    BFSRequire: () => ({ Buffer: { from: (b: unknown) => b } }),
  }),
}));
vi.mock('../../runtime/asset-urls.ts', () => ({
  resolveRuntimeAssetUrl: (s: string) => `/${s}`,
}));
vi.mock('../../runtime/fetch-asset.ts', () => ({
  fetchAssetBytes: vi.fn(async () => new Uint8Array([1])),
}));
vi.mock('../zip-archives.generated.ts', () => ({
  zipArchives: [
    { name: 'demo', zipPath: 'libraries/demo.zip', mountPath: '/libraries/demo' },
    { name: 'extra', zipPath: 'libraries/extra.zip', mountPath: '/libraries/extra' },
    {
      name: 'flat',
      zipPath: 'libraries/flat.zip',
      mountPath: '/libraries/flat',
      symlinks: { 'flat.scad': 'flat.scad' },
    },
  ],
}));

import { fetchAssetBytes } from '../../runtime/fetch-asset.ts';
import { LibraryMounter, symlinkLibraries } from '../filesystem.ts';

const mockFetch = fetchAssetBytes as ReturnType<typeof vi.fn>;
const fakeRoot = () => ({ mount: vi.fn(), umount: vi.fn() });

/** Minimal in-memory Node-compat sync FS for applyRuntimeLibraries. */
function fakeFs() {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>(['/libraries']);
  const fs = {
    files,
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
    writeFileSync: (p: string, content: string) => {
      files.set(p, content);
    },
    writeBytes: (p: string, bytes: Uint8Array) => {
      files.set(p, bytes);
    },
    readdirSync: (p: string) => {
      const prefix = `${p}/`;
      const entries = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) entries.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...entries];
    },
    lstatSync: (p: string) => {
      const isDir = dirs.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`));
      if (!isDir && !files.has(p)) throw new Error('ENOENT');
      return { isDirectory: () => isDir && !files.has(p) };
    },
    statSync: (p: string) => fs.lstatSync(p),
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    rmdirSync: (p: string) => {
      dirs.delete(p);
    },
  };
  return fs;
}

describe('LibraryMounter (#62 Slice D)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts a library referenced via a use<>/include<> directive', async () => {
    const root = fakeRoot();
    const mounted = await new LibraryMounter(root).mountDemandLibraries(['use <demo/foo.scad>']);
    expect(mounted).toEqual(['demo']);
    expect(root.mount).toHaveBeenCalledTimes(1);
    expect(root.mount).toHaveBeenCalledWith('/libraries/demo', expect.anything());
  });

  it('does not re-fetch or re-mount an already-mounted library (instance cache)', async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    await m.mountDemandLibraries(['use <demo>']);
    await m.mountDemandLibraries(['use <demo>']);
    expect(root.mount).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent mounts of the same library to one fetch + mount', async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    await Promise.all([
      m.mountDemandLibraries(['use <demo>']),
      m.mountDemandLibraries(['include <demo>']),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(root.mount).toHaveBeenCalledTimes(1);
  });

  it('force-mounts extraNames and skips unknown libraries silently', async () => {
    const root = fakeRoot();
    const mounted = await new LibraryMounter(root).mountDemandLibraries(['use <nope>'], ['extra']);
    expect(mounted).toEqual(['extra']);
    expect(root.mount).toHaveBeenCalledTimes(1);
    expect(root.mount).toHaveBeenCalledWith('/libraries/extra', expect.anything());
  });

  it('preloadAll mounts every registered archive', async () => {
    const root = fakeRoot();
    await new LibraryMounter(root).preloadAll();
    expect(root.mount).toHaveBeenCalledTimes(3); // demo + extra + flat (mock registry)
  });

  it('treats an "already taken" mount (racing thread) as success', async () => {
    const root = {
      mount: vi.fn(() => {
        throw new Error('Mount point /libraries/demo is already taken');
      }),
    };
    const mounted = await new LibraryMounter(root).mountDemandLibraries(['use <demo>']);
    expect(mounted).toEqual(['demo']);
  });

  it('rethrows a non-"already taken" mount error', async () => {
    const root = {
      mount: vi.fn(() => {
        throw new Error('disk full');
      }),
    };
    await expect(new LibraryMounter(root).mountDemandLibraries(['use <demo>'])).rejects.toThrow(
      'disk full',
    );
  });
});

describe('runtime user libraries (ADR 0010 / #195)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a runtime library shadows the bundled archive: no fetch, still resolves', async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    m.applyRuntimeLibraries(fakeFs(), [
      { name: 'demo', files: [{ path: 'foo.scad', content: '// mine' }] },
    ]);
    const mounted = await m.mountDemandLibraries(['use <demo/foo.scad>']);
    expect(mounted).toContain('demo');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(root.mount).not.toHaveBeenCalled();
  });

  it('shadowing an ALREADY-MOUNTED bundled archive unmounts it; unshadow restores demand-mounting', async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    await m.mountDemandLibraries(['use <demo/x.scad>']); // bundled demo mounts
    expect(root.mount).toHaveBeenCalledTimes(1);

    m.applyRuntimeLibraries(fakeFs(), [{ name: 'demo', files: [] }]);
    expect(root.umount).toHaveBeenCalledWith('/libraries/demo');

    // Unshadow: an empty set removes the runtime copy; the bundled archive is
    // demand-mountable again (a fresh fetch + mount).
    m.applyRuntimeLibraries(fakeFs(), []);
    await m.mountDemandLibraries(['use <demo/x.scad>']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(root.mount).toHaveBeenCalledTimes(2);
  });

  it('replacing the set deletes previously-owned files (no stale leftovers)', () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    const fs = fakeFs();
    m.applyRuntimeLibraries(fs, [
      {
        name: 'MyLib',
        files: [
          { path: 'a.scad', content: 'a' },
          { path: 'sub/extra.scad', content: 'x' },
        ],
      },
    ]);
    expect(fs.files.has('/libraries/MyLib/sub/extra.scad')).toBe(true);

    m.applyRuntimeLibraries(fs, [{ name: 'MyLib', files: [{ path: 'a.scad', content: 'a2' }] }]);
    expect(fs.files.get('/libraries/MyLib/a.scad')).toBe('a2');
    expect(fs.files.has('/libraries/MyLib/sub/extra.scad')).toBe(false);
  });

  it('shadowing a custom-symlink-map bundled name is reported as a diagnostic', () => {
    const m = new LibraryMounter(fakeRoot());
    const { customSymlinkShadows } = m.applyRuntimeLibraries(fakeFs(), [
      { name: 'flat', files: [{ path: 'flat.scad', content: '//' }] },
      { name: 'MyLib', files: [] },
    ]);
    expect(customSymlinkShadows).toEqual(['flat']);
  });

  it('runtime libraries are included in every demand result, even unreferenced (sibling deps)', async () => {
    const m = new LibraryMounter(fakeRoot());
    m.applyRuntimeLibraries(fakeFs(), [{ name: 'SiblingDep', files: [] }]);
    const mounted = await m.mountDemandLibraries(['cube(1);']); // no directives at all
    expect(mounted).toContain('SiblingDep');
  });

  it("a runtime library's own directives demand-mount BUNDLED libraries", async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    m.applyRuntimeLibraries(fakeFs(), [
      { name: 'MyLib', files: [{ path: 'util.scad', content: 'use <demo/std.scad>' }] },
    ]);
    const mounted = await m.mountDemandLibraries(['use <MyLib/util.scad>']);
    expect(mounted).toEqual(expect.arrayContaining(['MyLib', 'demo']));
    expect(root.mount).toHaveBeenCalledWith('/libraries/demo', expect.anything());
  });

  it('bytes files write via writeBytes; text files feed the dep scan', () => {
    const m = new LibraryMounter(fakeRoot());
    const fs = fakeFs();
    const bytes = Uint8Array.from([1, 2]);
    m.applyRuntimeLibraries(fs, [{ name: 'MyLib', files: [{ path: 'part.stl', bytes }] }]);
    expect(fs.files.get('/libraries/MyLib/part.stl')).toBe(bytes);
  });
});

describe('symlinkLibraries with runtime names (ADR 0010)', () => {
  it('a runtime name gets the default /<name> symlink and never consults the registry', async () => {
    const symlink = vi.fn(async () => {});
    // 'TotallyUnknown' is not in zipArchives — would THROW without runtime awareness.
    const failures = await symlinkLibraries(
      ['TotallyUnknown'],
      { symlink },
      '/libraries',
      '/',
      new Set(['TotallyUnknown']),
    );
    expect(symlink).toHaveBeenCalledWith('/libraries/TotallyUnknown', '/TotallyUnknown');
    expect(failures).toEqual([]);
  });

  it('a runtime name shadowing a custom-map bundled name still gets ONLY the default symlink', async () => {
    const symlink = vi.fn(async () => {});
    await symlinkLibraries(['flat'], { symlink }, '/libraries', '/', new Set(['flat']));
    expect(symlink).toHaveBeenCalledTimes(1);
    expect(symlink).toHaveBeenCalledWith('/libraries/flat', '/flat');
  });

  it('symlink failures are collected, not just console-swallowed', async () => {
    const symlink = vi.fn(async () => {
      throw new Error('EEXIST');
    });
    const failures = await symlinkLibraries(
      ['MyLib'],
      { symlink },
      '/libraries',
      '/',
      new Set(['MyLib']),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/MyLib/);
  });
});

describe('applyRuntimeLibraries failure containment (#195 Phase A review)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('one failing library is skipped + cleaned up; the others still apply', () => {
    const m = new LibraryMounter(fakeRoot());
    const fs = fakeFs();
    const goodBefore = { name: 'Good', files: [{ path: 'g.scad', content: '//' }] };
    const bad = {
      name: 'Bad',
      files: [
        { path: 'ok.scad', content: '//' },
        { path: 'boom.scad', content: 'x' },
      ],
    };
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (p: string, c: string) => {
      if (p.endsWith('boom.scad')) throw new Error('ENOTDIR');
      origWrite(p, c);
    };

    const { failures } = m.applyRuntimeLibraries(fs, [goodBefore, bad]);

    expect(failures).toEqual([{ name: 'Bad', reason: 'ENOTDIR' }]);
    // The failing library's PARTIAL files were removed; it is not registered.
    expect(fs.files.has('/libraries/Bad/ok.scad')).toBe(false);
    expect([...m.runtimeNames()]).toEqual(['Good']);
    expect(fs.files.has('/libraries/Good/g.scad')).toBe(true);
  });

  it('a failed umount aborts THAT library without touching the mount bookkeeping', async () => {
    const root = {
      mount: vi.fn(),
      umount: vi.fn(() => {
        throw new Error('umount failed');
      }),
    };
    const m = new LibraryMounter(root);
    await m.mountDemandLibraries(['use <demo/x.scad>']); // bundled demo mounted
    const { failures } = m.applyRuntimeLibraries(fakeFs(), [{ name: 'demo', files: [] }]);
    expect(failures[0]).toMatchObject({ name: 'demo' });
    // Bookkeeping intact: demo still counts as mounted (the ZipFS still owns
    // the path), and it is NOT registered as a runtime library.
    expect([...m.runtimeNames()]).toEqual([]);
    const mounted = await m.mountDemandLibraries(['use <demo/x.scad>']);
    expect(mounted).toEqual(['demo']); // still served by the bundled mount
    expect(root.mount).toHaveBeenCalledTimes(1); // no re-mount attempted
  });

  it('text-suffix BYTES files feed the dep scan (ADR 0010 §5)', async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    const scad = 'use <demo/std.scad>';
    m.applyRuntimeLibraries(fakeFs(), [
      {
        name: 'MyLib',
        files: [{ path: 'util.scad', bytes: Uint8Array.from(scad, (c) => c.charCodeAt(0)) }],
      },
    ]);
    const mounted = await m.mountDemandLibraries([]);
    expect(mounted).toEqual(expect.arrayContaining(['MyLib', 'demo']));
  });

  it('runtimeDeps reset between applies (a replaced lib stops demanding its old deps)', async () => {
    const root = fakeRoot();
    const m = new LibraryMounter(root);
    m.applyRuntimeLibraries(fakeFs(), [
      { name: 'A', files: [{ path: 'a.scad', content: 'use <demo/x.scad>' }] },
    ]);
    m.applyRuntimeLibraries(fakeFs(), [{ name: 'A', files: [{ path: 'a.scad', content: '//' }] }]);
    const mounted = await m.mountDemandLibraries([]);
    expect(mounted).toEqual(['A']); // demo no longer demanded
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
