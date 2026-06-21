// Issue #59 (slice): Model routes browser side effects through a HostAdapter
// instead of touching the DOM/window directly.

import { Model } from '../model.ts';
import { State } from '../app-state.ts';
import { WebHostAdapter } from '../web-host-adapter.ts';
import { defaultSourcePath, defaultModelColor } from '../initial-state.ts';

vi.mock('../../runner/actions.ts', () => {
  const makeDelayable = (resolved: unknown) =>
    vi.fn().mockReturnValue(vi.fn().mockResolvedValue(resolved));
  return {
    checkSyntax: makeDelayable({ logText: '', markers: [], parameterSet: undefined }),
    render: makeDelayable({
      outFile: new File(['off-bytes'], 'out.off'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    }),
  };
});
vi.mock('../../io/import_off.ts', () => ({ parseOff: vi.fn() }));

function makeFs() {
  return {
    readFileSync: vi.fn(() => new Uint8Array(0)),
    writeFile: vi.fn(),
    isFile: vi.fn(() => false),
  } as unknown as FS;
}

function baseState(): State {
  return {
    params: {
      activePath: defaultSourcePath,
      sources: [{ path: defaultSourcePath, content: 'cube(1);' }],
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

function mockHost() {
  return {
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
    download: vi.fn(),
    playCompletionChime: vi.fn(),
    baseUrl: vi.fn(() => 'http://localhost/'),
  };
}

describe('WebHostAdapter', () => {
  it('exposes the host operations without throwing in a DOM environment', () => {
    const host = new WebHostAdapter();
    const url = host.createObjectURL(new Blob(['x']));
    expect(typeof url).toBe('string');
    expect(() => host.revokeObjectURL(url)).not.toThrow();
    expect(() => host.playCompletionChime()).not.toThrow(); // no #complete-sound element -> no-op
    expect(typeof host.baseUrl()).toBe('string');
  });
});

describe('Model routes side effects through the host (#59)', () => {
  it('plays the completion chime on a full render, not a preview', async () => {
    const host = mockHost();
    const model = new Model(makeFs(), baseState(), undefined, undefined, host);

    await model.render({ isPreview: false, now: true });
    expect(host.playCompletionChime).toHaveBeenCalledTimes(1);
    expect(host.createObjectURL).toHaveBeenCalled();

    host.playCompletionChime.mockClear();
    await model.render({ isPreview: true, now: true });
    expect(host.playCompletionChime).not.toHaveBeenCalled();
  });

  it('downloads via the host when re-exporting an existing OFF output', async () => {
    const host = mockHost();
    const state = baseState();
    state.is2D = false;
    state.params.exportFormat3D = 'off';
    state.output = {
      isPreview: false,
      outFile: new File(['off'], 'model.off'),
      outFileURL: 'blob:existing',
      elapsedMillis: 1,
      formattedElapsedMillis: '1ms',
      formattedOutFileSize: '3 bytes',
    } as State['output'];
    const model = new Model(makeFs(), state, undefined, undefined, host);

    await model.export();
    expect(host.download).toHaveBeenCalledWith('blob:existing', 'model.off');
  });
});
