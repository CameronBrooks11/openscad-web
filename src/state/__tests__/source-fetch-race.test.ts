// Regression coverage for issue #49: an in-flight source fetch must write its
// content back to the file it was fetched for — never whichever file happens to
// be active when the fetch resolves.

import { Model } from '../model.ts';
import { State } from '../app-state.ts';
import { defaultModelColor } from '../initial-state.ts';

// Avoid touching the real runner (Worker/WASM) and heavy IO.
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
    getDefaultCompileArgs: vi.fn().mockReturnValue(['--backend=manifold']),
  };
});
vi.mock('../../io/import_off.ts', () => ({ parseOff: vi.fn() }));

// Controllable fetchSource; everything else in utils stays real.
vi.mock('../../utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils.ts')>();
  return { ...actual, fetchSource: vi.fn() };
});

import { fetchSource } from '../../utils.ts';

const mockFetchSource = fetchSource as ReturnType<typeof vi.fn>;

type FetchController = { resolve: (data: Uint8Array) => void; reject: (e: unknown) => void };

function makeMockFs() {
  return {
    readFileSync: vi.fn(() => new Uint8Array(0)),
    writeFile: vi.fn(),
    isFile: vi.fn(() => false),
  };
}

function stateWithUrlSources(): State {
  return {
    params: {
      activePath: '/a.scad',
      sources: [
        { path: '/a.scad', url: 'a.scad' },
        { path: '/b.scad', url: 'b.scad' },
      ],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
      autoCompile: false, // keep the test focused on the fetch write-back
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

async function flush(n = 4) {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

describe('source fetch write-back race (#49)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(global, 'URL', {
      value: { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  it('writes fetched content to the originally requested file after the active file changes', async () => {
    const controllers = new Map<string, FetchController>();
    mockFetchSource.mockImplementation(
      (_fs: unknown, src: { path: string }) =>
        new Promise<Uint8Array>((resolve, reject) => {
          controllers.set(src.path, { resolve, reject });
        }),
    );

    const model = new Model(
      makeMockFs() as unknown as FS,
      stateWithUrlSources(),
      undefined,
      undefined,
    );

    // Start fetching /a.scad (the active file).
    model.init();
    await flush();
    expect(controllers.has('/a.scad')).toBe(true);

    // Switch to /b.scad while /a.scad's fetch is still in flight.
    model.openFile('/b.scad');
    await flush();
    expect(model.state.params.activePath).toBe('/b.scad');

    // /a.scad's fetch now resolves.
    controllers.get('/a.scad')!.resolve(new TextEncoder().encode('A_CONTENT'));
    await flush();

    const sources = model.state.params.sources;
    const a = sources.find((s) => s.path === '/a.scad');
    const b = sources.find((s) => s.path === '/b.scad');

    // Content landed in /a.scad...
    expect(a?.content).toBe('A_CONTENT');
    // ...and NOT in the now-active /b.scad.
    expect(b?.content ?? null).not.toBe('A_CONTENT');
  });
});
