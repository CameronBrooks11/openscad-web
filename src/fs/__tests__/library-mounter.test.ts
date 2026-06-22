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
  ],
}));

import { fetchAssetBytes } from '../../runtime/fetch-asset.ts';
import { LibraryMounter } from '../filesystem.ts';

const mockFetch = fetchAssetBytes as ReturnType<typeof vi.fn>;
const fakeRoot = () => ({ mount: vi.fn() });

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
    expect(root.mount).toHaveBeenCalledTimes(2);
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
