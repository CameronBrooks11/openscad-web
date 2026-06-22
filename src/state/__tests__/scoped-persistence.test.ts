// Regression coverage for issue #58: persistence is scoped to the durable slice
// (params/view/preview), debounced, and serialized. Transient mutations
// (rendering flags, logs, errors, output) must not trigger writes.

import { Model } from '../model.ts';
import { State } from '../app-state.ts';
import { defaultSourcePath, defaultModelColor } from '../initial-state.ts';

vi.mock('../../runner/actions.ts', () => {
  const makeDelayable = (resolved: unknown) =>
    vi.fn().mockReturnValue(vi.fn().mockResolvedValue(resolved));
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
      sources: [{ kind: 'text', path: defaultSourcePath, content: 'cube(1);' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
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

describe('scoped persistence (#58)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeModel() {
    const persister = { set: vi.fn().mockResolvedValue(undefined) };
    const model = new Model(makeFs(), baseState(), undefined, persister);
    return { model, persister };
  }

  it('does not persist on a transient-only mutation', async () => {
    const { model, persister } = makeModel();
    model.mutate((s) => {
      s.rendering = true;
      s.currentRunLogs = [['stdout', 'working']];
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(persister.set).not.toHaveBeenCalled();
  });

  it('persists a durable mutation after the debounce', async () => {
    const { model, persister } = makeModel();
    model.mutate((s) => (s.view.showAxes = false));
    expect(persister.set).not.toHaveBeenCalled(); // debounced
    await vi.advanceTimersByTimeAsync(600);
    expect(persister.set).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid durable mutations into a single write of the latest state', async () => {
    const { model, persister } = makeModel();
    model.mutate((s) => (s.view.color = '#111111'));
    model.mutate((s) => (s.view.color = '#222222'));
    model.mutate((s) => (s.view.color = '#333333'));
    await vi.advanceTimersByTimeAsync(600);
    expect(persister.set).toHaveBeenCalledTimes(1);
    expect(persister.set.mock.calls[0][0].view.color).toBe('#333333');
  });

  it('does not re-persist when only transient state changes after a durable write', async () => {
    const { model, persister } = makeModel();
    model.mutate((s) => (s.view.showAxes = false));
    await vi.advanceTimersByTimeAsync(600);
    expect(persister.set).toHaveBeenCalledTimes(1);

    model.mutate((s) => (s.previewing = true));
    model.mutate((s) => (s.error = 'boom'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(persister.set).toHaveBeenCalledTimes(1); // no extra write
  });

  it('swallows persister errors without throwing', async () => {
    const { model, persister } = makeModel();
    persister.set.mockRejectedValueOnce(new Error('disk full'));
    model.mutate((s) => (s.view.showAxes = false));
    await expect(vi.advanceTimersByTimeAsync(600)).resolves.not.toThrow();
  });

  it('serializes overlapping writes: a change during an in-flight write is persisted after', async () => {
    const resolvers: Array<() => void> = [];
    const set = vi.fn().mockImplementation(() => new Promise<void>((r) => resolvers.push(r)));
    const model = new Model(makeFs(), baseState(), undefined, { set });

    // Write A starts and stays in-flight (its promise is unresolved).
    model.mutate((s) => (s.view.color = '#aaaaaa'));
    await vi.advanceTimersByTimeAsync(600);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].view.color).toBe('#aaaaaa');

    // Change B arrives while A is in-flight — must not start a second write yet.
    model.mutate((s) => (s.view.color = '#bbbbbb'));
    await vi.advanceTimersByTimeAsync(600);
    expect(set).toHaveBeenCalledTimes(1);

    // Resolve A → the coalesced follow-up writes the latest (B).
    resolvers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1][0].view.color).toBe('#bbbbbb');
  });
});
