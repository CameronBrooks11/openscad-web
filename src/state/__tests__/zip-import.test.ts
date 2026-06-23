// Regression coverage for issue #50: importProjectZip must reject archive
// entries that would escape /home, and import well-formed archives normally.

import { Model } from '../model.ts';
import { State } from '../app-state.ts';
import { defaultSourcePath, defaultModelColor } from '../initial-state.ts';
import {
  MAX_COMPRESSED_ZIP_BYTES,
  MAX_PROJECT_FILE_COUNT,
  MAX_PROJECT_TOTAL_BYTES,
} from '../../fs/project-path.ts';

vi.mock('../../runner/actions.ts', () => {
  const makeDelayable = (resolvedValue: unknown) =>
    vi.fn().mockReturnValue(vi.fn().mockResolvedValue(resolvedValue));
  return {
    checkSyntax: makeDelayable({ logText: '', markers: [], parameterSet: undefined }),
    render: makeDelayable({
      outFile: new File([''], 't.off'),
      logText: '',
      markers: [],
      elapsedMillis: 0,
    }),
  };
});
vi.mock('../../io/import_off.ts', () => ({ parseOff: vi.fn() }));

// Control archive contents deterministically without depending on JSZip's own
// name handling.
vi.mock('jszip', () => ({ default: { loadAsync: vi.fn() } }));
import JSZip from 'jszip';
import { fakeErrorEntry, fakeZip } from './fake-zip.ts';
const mockLoadAsync = (JSZip as unknown as { loadAsync: ReturnType<typeof vi.fn> }).loadAsync;

function makeMockFs() {
  return {
    readFileSync: vi.fn(() => new Uint8Array(0)),
    writeFile: vi.fn(),
    writeBytes: vi.fn(),
    mkdirSync: vi.fn(),
    isFile: vi.fn(() => false),
  };
}

function baseState(): State {
  return {
    params: {
      activePath: defaultSourcePath,
      sources: [{ kind: 'text', path: defaultSourcePath, content: 'cube(1);' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
      autoCompile: false,
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

describe('importProjectZip validation (#50)', () => {
  let model: Model;
  let mockFs: ReturnType<typeof makeMockFs>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(global, 'URL', {
      value: { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() },
      writable: true,
      configurable: true,
    });
    mockFs = makeMockFs();
    model = new Model(mockFs as unknown as FS, baseState(), undefined, undefined);
  });

  it('imports a well-formed archive into /home', async () => {
    mockLoadAsync.mockResolvedValue(fakeZip({ 'main.scad': 'cube(2);', 'lib/util.scad': 'x' }));

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).toHaveBeenCalledWith('/home/main.scad', 'cube(2);');
    expect(mockFs.writeFile).toHaveBeenCalledWith('/home/lib/util.scad', 'x');
    expect(model.state.params.activePath).toBe('/home/main.scad');
  });

  it('creates parent directories (mkdir -p) for nested archive entries', async () => {
    mockLoadAsync.mockResolvedValue(fakeZip({ 'a/b/c.scad': 'x' }));

    await model.importProjectZip(new ArrayBuffer(0));

    // Parents created outermost-first before the nested file is written.
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/home');
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/home/a');
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/home/a/b');
    expect(mockFs.writeFile).toHaveBeenCalledWith('/home/a/b/c.scad', 'x');
    const dirOrder = mockFs.mkdirSync.mock.calls.map((c) => c[0]);
    expect(dirOrder).toEqual(['/home', '/home/a', '/home/a/b']);
    expect(model.state.error).toBeUndefined();
  });

  it('rejects a traversal entry and writes nothing outside the project root', async () => {
    mockLoadAsync.mockResolvedValue(fakeZip({ '../../evil.scad': 'pwned' }));

    await model.importProjectZip(new ArrayBuffer(0));

    // No write may reference a traversal path...
    for (const call of mockFs.writeFile.mock.calls) {
      expect(String(call[0])).not.toContain('..');
    }
    // ...the whole import is rejected with a surfaced error.
    expect(model.state.error).toBeTruthy();
  });

  it('rejects an absolute-path entry', async () => {
    mockLoadAsync.mockResolvedValue(fakeZip({ '/etc/passwd': 'x' }));

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('rejects the whole archive atomically when any entry is unsafe', async () => {
    // A valid file alongside a traversal entry: nothing should be written.
    mockLoadAsync.mockResolvedValue(fakeZip({ 'main.scad': 'cube(1);', '../evil.scad': 'pwned' }));

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('rejects duplicate normalized paths', async () => {
    mockLoadAsync.mockResolvedValue(fakeZip({ 'main.scad': 'a', './main.scad': 'b' }));

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('rejects an archive with too many files', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i <= MAX_PROJECT_FILE_COUNT; i++) entries[`f${i}.scad`] = 'x';
    mockLoadAsync.mockResolvedValue(fakeZip(entries));

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('rejects an archive whose compressed size exceeds the cap, before parsing', async () => {
    await model.importProjectZip(new ArrayBuffer(MAX_COMPRESSED_ZIP_BYTES + 1));

    // The cap is checked up front, so JSZip is never asked to parse the buffer.
    expect(mockLoadAsync).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('rejects an archive that exceeds the uncompressed size limit', async () => {
    mockLoadAsync.mockResolvedValue(
      fakeZip({ 'big.scad': 'x'.repeat(MAX_PROJECT_TOTAL_BYTES + 1) }),
    );

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('aborts when entries cumulatively exceed the uncompressed limit', async () => {
    // Each entry fits on its own, but together they blow the budget — the second
    // entry's stream aborts as the running total crosses the limit.
    const half = 'x'.repeat(Math.ceil(MAX_PROJECT_TOTAL_BYTES / 2) + 1);
    mockLoadAsync.mockResolvedValue(fakeZip({ 'a.scad': half, 'b.scad': half }));

    await model.importProjectZip(new ArrayBuffer(0));

    // The whole import is rejected before the write phase, so nothing is written.
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('imports a binary entry as a content-less local source, writing the bytes uncorrupted', async () => {
    // A .stl alongside a .scad that references it. The STL must reach the FS as
    // raw bytes (writeBytes), not a UTF-8-decoded string.
    const stl = new Uint8Array([0, 65, 200, 255, 0, 128]);
    mockLoadAsync.mockResolvedValue(
      fakeZip({ 'main.scad': 'import("part.stl");', 'part.stl': stl }),
    );

    await model.importProjectZip(new ArrayBuffer(0));

    // The text .scad is written via writeFile; the binary asset via writeBytes,
    // byte-exact.
    expect(mockFs.writeFile).toHaveBeenCalledWith('/home/main.scad', 'import("part.stl");');
    expect(mockFs.writeBytes).toHaveBeenCalledTimes(1);
    const [bytePath, bytes] = mockFs.writeBytes.mock.calls[0];
    expect(bytePath).toBe('/home/part.stl');
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(stl));

    // The binary asset is a content-less `local` source; the .scad is the active
    // text entry.
    const sources = model.state.params.sources;
    const stlSource = sources.find((s) => s.path === '/home/part.stl');
    expect(stlSource?.kind).toBe('local');
    expect('content' in (stlSource ?? {})).toBe(false);
    expect(model.state.params.activePath).toBe('/home/main.scad');
  });

  it('rejects when an entry fails to decompress (stream error)', async () => {
    mockLoadAsync.mockResolvedValue({
      files: { 'bad.scad': fakeErrorEntry(new Error('corrupt entry')) },
    });

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('wraps a non-Error stream failure into an Error', async () => {
    mockLoadAsync.mockResolvedValue({
      files: { 'bad.scad': fakeErrorEntry('plain string failure') },
    });

    await model.importProjectZip(new ArrayBuffer(0));

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('tolerates a writeFile failure and still loads the sources', async () => {
    mockLoadAsync.mockResolvedValue(fakeZip({ 'main.scad': 'cube(3);', 'lib/util.scad': 'y' }));
    mockFs.writeFile.mockImplementation((p: string) => {
      if (p.includes('/lib/')) throw new Error('ENOENT'); // missing parent dir in the VFS
    });

    await model.importProjectZip(new ArrayBuffer(0));

    expect(model.state.params.sources.map((s) => s.path)).toEqual([
      '/home/main.scad',
      '/home/lib/util.scad',
    ]);
    expect(model.state.error).toBeUndefined();
  });
});
