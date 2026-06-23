// Issue #62 (slice): the File System Access write-back handle is scoped to the
// source it was opened for (Model-instance state keyed by path), not a global
// "last opened" handle. This prevents saveProject() from writing one source's
// content back into a different file's local handle.

import { Model } from '../model.ts';
import { State } from '../app-state.ts';
import { defaultModelColor } from '../initial-state.ts';
import { HostAdapter } from '../web-host-adapter.ts';

vi.mock('../../runner/actions.ts', () => {
  const makeDelayable = (resolved: unknown) =>
    vi.fn().mockReturnValue(vi.fn().mockResolvedValue(resolved));
  return {
    createSyntaxDelayable: () =>
      makeDelayable({ logText: '', markers: [], parameterSet: undefined }),
    createRenderDelayable: () =>
      makeDelayable({
        outFile: new File([''], 't.off'),
        logText: '',
        markers: [],
        elapsedMillis: 0,
      }),
    createRenderExportDelayable: () => makeDelayable({}),
  };
});
vi.mock('../../io/import_off.ts', () => ({ parseOff: vi.fn() }));

// Control archive contents without depending on real JSZip in jsdom.
vi.mock('jszip', () => ({ default: { loadAsync: vi.fn() } }));
import JSZip from 'jszip';
import { fakeZip } from './fake-zip.ts';
const mockLoadAsync = (JSZip as unknown as { loadAsync: ReturnType<typeof vi.fn> }).loadAsync;

function makeFs() {
  return {
    readFileSync: vi.fn(() => new Uint8Array(0)),
    writeFile: vi.fn(),
    isFile: vi.fn(() => false),
  } as unknown as FS;
}

function singleSourceState(path: string): State {
  return {
    params: {
      activePath: path,
      sources: [{ kind: 'text', path, content: 'cube(1);' }],
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

function mockHost(): HostAdapter {
  return {
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
    download: vi.fn(),
    downloadBlob: vi.fn(),
    playCompletionChime: vi.fn(),
    baseUrl: vi.fn(() => 'http://localhost/'),
  };
}

/** Stub the Chromium picker so openLocalFile() resolves to a handle for `name`. */
function stubPicker(name: string, content: string) {
  const writable = {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const handle = {
    getFile: vi.fn().mockResolvedValue({ name, text: vi.fn().mockResolvedValue(content) }),
    createWritable: vi.fn().mockResolvedValue(writable),
  };
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue([handle]),
  });
  return { handle, writable };
}

describe('FSAPI handle scoping (#62)', () => {
  afterEach(() => {
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  it('saves the active FSAPI-opened source back through its own handle', async () => {
    const { writable } = stubPicker('demo.scad', 'cube(10);');
    const host = mockHost();
    const model = new Model(
      makeFs(),
      singleSourceState('/home/demo.scad'),
      undefined,
      undefined,
      host,
    );

    expect(await model.openFileViaFSAPI()).toBe(true);
    await model.saveProject();

    expect(writable.write).toHaveBeenCalledWith('cube(10);');
    expect(host.downloadBlob).not.toHaveBeenCalled();
  });

  it('saves a lone binary asset via buildZip — never as 0-byte text (#121)', async () => {
    const host = mockHost();
    const state = singleSourceState('/home/part.stl');
    // A single binary `local` source: bytes on the FS, no inline text content.
    state.params.sources = [{ kind: 'local', path: '/home/part.stl' }];
    const model = new Model(makeFs(), state, undefined, undefined, host);

    await model.saveProject();

    // The text shortcut (which would download a 0-byte file or truncate via a
    // handle) must NOT run; it routes through buildZip instead. JSZip is mocked
    // here, so buildZip surfaces an error rather than the silent 0-byte save.
    expect(host.downloadBlob).not.toHaveBeenCalled();
    expect(model.state.error).toBeTruthy();
  });

  it('does not reuse a stale handle after a ZIP import replaces the project', async () => {
    const { writable } = stubPicker('a.scad', 'cube(10);');
    const host = mockHost();
    const model = new Model(
      makeFs(),
      singleSourceState('/home/a.scad'),
      undefined,
      undefined,
      host,
    );

    // Open /home/a.scad via FSAPI — registers a write-back handle for that path.
    await model.openFileViaFSAPI();

    // Importing an archive with a different single file replaces the project.
    mockLoadAsync.mockResolvedValue(fakeZip({ 'b.scad': 'sphere(5);' }));
    await model.importProjectZip(new ArrayBuffer(0));
    expect(model.state.params.activePath).toBe('/home/b.scad');

    // Saving the imported source must NOT write back through a.scad's handle;
    // with no handle for the active path it falls back to a download.
    await model.saveProject();
    expect(writable.write).not.toHaveBeenCalled();
    expect(host.downloadBlob).toHaveBeenCalled();
  });

  it('drops the handle even when the imported archive reuses the opened path', async () => {
    const { writable } = stubPicker('a.scad', 'cube(10);');
    const host = mockHost();
    const model = new Model(
      makeFs(),
      singleSourceState('/home/a.scad'),
      undefined,
      undefined,
      host,
    );

    await model.openFileViaFSAPI();

    // Archive reuses the same path — its content is a *different* file, so the
    // original FSAPI handle must not survive to receive it.
    mockLoadAsync.mockResolvedValue(fakeZip({ 'a.scad': 'sphere(5);' }));
    await model.importProjectZip(new ArrayBuffer(0));
    expect(model.state.params.activePath).toBe('/home/a.scad');

    await model.saveProject();
    expect(writable.write).not.toHaveBeenCalled();
    expect(host.downloadBlob).toHaveBeenCalled();
  });
});
